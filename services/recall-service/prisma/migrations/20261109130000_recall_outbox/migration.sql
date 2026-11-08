-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "Recall" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recallNumber" VARCHAR(100) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(4000) NOT NULL,
    "severity" VARCHAR(50) NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "productId" UUID NOT NULL,
    "gtinId" UUID,
    "batchId" UUID,
    "scopeKey" VARCHAR(150) NOT NULL,
    "createdBy" UUID NOT NULL,
    "initiatedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Recall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "eventId" VARCHAR(200) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "organizationId" UUID NOT NULL,
    "aggregateType" VARCHAR(50) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "envelope" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimToken" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "lastError" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recall_organizationId_status_createdAt_idx" ON "Recall"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Recall_organizationId_productId_gtinId_batchId_idx" ON "Recall"("organizationId", "productId", "gtinId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "Recall_organizationId_recallNumber_key" ON "Recall"("organizationId", "recallNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_eventId_key" ON "OutboxEvent"("eventId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_createdAt_idx" ON "OutboxEvent"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_publishedAt_idx" ON "OutboxEvent"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_organizationId_aggregateType_aggregateId_idx" ON "OutboxEvent"("organizationId", "aggregateType", "aggregateId");


-- One active definition per exact scope; different scopes may overlap intentionally.
CREATE UNIQUE INDEX "Recall_active_scope_key" ON "Recall" ("organizationId", "scopeKey") WHERE status = 'ACTIVE';
ALTER TABLE "Recall" ADD CONSTRAINT "Recall_scope_key_check" CHECK (
 "scopeKey" = CASE WHEN "batchId" IS NOT NULL THEN 'batch:' || "batchId"::text WHEN "gtinId" IS NOT NULL THEN 'gtin:' || "gtinId"::text ELSE 'product:' || "productId"::text END
);
ALTER TABLE "Recall" ADD CONSTRAINT "Recall_lifecycle_timestamps" CHECK (
 (status = 'DRAFT' AND "initiatedAt" IS NULL AND "closedAt" IS NULL) OR
 (status = 'CANCELLED' AND "initiatedAt" IS NULL AND "closedAt" IS NULL) OR
 (status = 'ACTIVE' AND "initiatedAt" IS NOT NULL AND "closedAt" IS NULL) OR
 (status = 'CLOSED' AND "initiatedAt" IS NOT NULL AND "closedAt" >= "initiatedAt")
);
