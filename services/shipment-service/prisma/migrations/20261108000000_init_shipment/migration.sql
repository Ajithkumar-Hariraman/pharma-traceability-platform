-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'READY', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shipmentNumber" VARCHAR(100) NOT NULL,
    "sourceFacilityId" UUID NOT NULL,
    "destinationFacilityId" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "dispatchedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentContent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "referenceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shipment_organizationId_status_createdAt_idx" ON "Shipment"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Shipment_organizationId_sourceFacilityId_idx" ON "Shipment"("organizationId", "sourceFacilityId");

-- CreateIndex
CREATE INDEX "Shipment_organizationId_destinationFacilityId_idx" ON "Shipment"("organizationId", "destinationFacilityId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_organizationId_shipmentNumber_key" ON "Shipment"("organizationId", "shipmentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_organizationId_id_key" ON "Shipment"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ShipmentContent_organizationId_kind_referenceId_idx" ON "ShipmentContent"("organizationId", "kind", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentContent_shipmentId_kind_referenceId_key" ON "ShipmentContent"("shipmentId", "kind", "referenceId");

-- AddForeignKey
ALTER TABLE "ShipmentContent" ADD CONSTRAINT "ShipmentContent_organizationId_shipmentId_fkey" FOREIGN KEY ("organizationId", "shipmentId") REFERENCES "Shipment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

