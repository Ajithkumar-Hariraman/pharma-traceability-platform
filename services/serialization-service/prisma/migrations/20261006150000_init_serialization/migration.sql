-- CreateEnum
CREATE TYPE "SerializedItemStatus" AS ENUM ('CREATED', 'COMMISSIONED', 'DECOMMISSIONED', 'QUARANTINED');

-- CreateTable
CREATE TABLE "SerializedItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "gtinId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "serialNumber" VARCHAR(100) NOT NULL,
    "status" "SerializedItemStatus" NOT NULL DEFAULT 'CREATED',
    "commissionedAt" TIMESTAMPTZ(3),
    "decommissionedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SerializedItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SerializedItem_organizationId_idx" ON "SerializedItem"("organizationId");

-- CreateIndex
CREATE INDEX "SerializedItem_batchId_idx" ON "SerializedItem"("batchId");

-- CreateIndex
CREATE INDEX "SerializedItem_gtinId_idx" ON "SerializedItem"("gtinId");

-- CreateIndex
CREATE INDEX "SerializedItem_status_idx" ON "SerializedItem"("status");

-- CreateIndex
CREATE INDEX "SerializedItem_serialNumber_idx" ON "SerializedItem"("serialNumber");

-- CreateIndex
CREATE INDEX "SerializedItem_commissionedAt_idx" ON "SerializedItem"("commissionedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SerializedItem_gtinId_serialNumber_key" ON "SerializedItem"("gtinId", "serialNumber");


ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_serialNumber_check" CHECK (length("serialNumber") > 0 AND "serialNumber" = btrim("serialNumber"));
ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_lifecycle_check" CHECK (
  ("status" = 'CREATED' AND "commissionedAt" IS NULL AND "decommissionedAt" IS NULL) OR
  ("status" = 'COMMISSIONED' AND "commissionedAt" IS NOT NULL AND "decommissionedAt" IS NULL) OR
  ("status" = 'DECOMMISSIONED' AND "commissionedAt" IS NOT NULL AND "decommissionedAt" IS NOT NULL AND "decommissionedAt" >= "commissionedAt") OR
  ("status" = 'QUARANTINED' AND "decommissionedAt" IS NULL)
);
