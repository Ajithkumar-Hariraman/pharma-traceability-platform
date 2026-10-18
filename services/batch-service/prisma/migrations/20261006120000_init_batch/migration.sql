-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'RECALLED', 'CLOSED');

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "gtinId" UUID NOT NULL,
    "lotNumber" VARCHAR(200) NOT NULL,
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_organizationId_status_idx" ON "Batch"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Batch_productId_idx" ON "Batch"("productId");

-- CreateIndex
CREATE INDEX "Batch_gtinId_idx" ON "Batch"("gtinId");

-- CreateIndex
CREATE INDEX "Batch_status_idx" ON "Batch"("status");

-- CreateIndex
CREATE INDEX "Batch_lotNumber_idx" ON "Batch"("lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_gtinId_lotNumber_key" ON "Batch"("gtinId", "lotNumber");


-- Enforce valid lot normalization and chronology even for concurrent writes.
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_lotNumber_check" CHECK (length("lotNumber") > 0 AND "lotNumber" = btrim("lotNumber"));
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_dates_check" CHECK ("manufactureDate" IS NULL OR "expiryDate" IS NULL OR "expiryDate" > "manufactureDate");
