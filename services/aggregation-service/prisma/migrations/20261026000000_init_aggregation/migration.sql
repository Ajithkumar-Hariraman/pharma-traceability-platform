-- CreateEnum
CREATE TYPE "PackagingLevel" AS ENUM ('INNER', 'CASE', 'PALLET');

-- CreateEnum
CREATE TYPE "ContainerStatus" AS ENUM ('ACTIVE', 'CLOSED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "ChildType" AS ENUM ('SERIALIZED_ITEM', 'CONTAINER');

-- CreateTable
CREATE TABLE "AggregateContainer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "containerCode" VARCHAR(100) NOT NULL,
    "packagingLevel" "PackagingLevel" NOT NULL,
    "status" "ContainerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AggregateContainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregationRelation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "parentContainerId" UUID NOT NULL,
    "childType" "ChildType" NOT NULL,
    "childSerializedItemId" UUID,
    "childContainerId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AggregationRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AggregateContainer_organizationId_idx" ON "AggregateContainer"("organizationId");

-- CreateIndex
CREATE INDEX "AggregateContainer_packagingLevel_idx" ON "AggregateContainer"("packagingLevel");

-- CreateIndex
CREATE INDEX "AggregateContainer_status_idx" ON "AggregateContainer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AggregateContainer_organizationId_containerCode_key" ON "AggregateContainer"("organizationId", "containerCode");

-- CreateIndex
CREATE UNIQUE INDEX "AggregateContainer_organizationId_id_key" ON "AggregateContainer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AggregationRelation_childSerializedItemId_key" ON "AggregationRelation"("childSerializedItemId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregationRelation_childContainerId_key" ON "AggregationRelation"("childContainerId");

-- CreateIndex
CREATE INDEX "AggregationRelation_organizationId_idx" ON "AggregationRelation"("organizationId");

-- CreateIndex
CREATE INDEX "AggregationRelation_parentContainerId_idx" ON "AggregationRelation"("parentContainerId");

-- AddForeignKey
ALTER TABLE "AggregationRelation" ADD CONSTRAINT "AggregationRelation_organizationId_parentContainerId_fkey" FOREIGN KEY ("organizationId", "parentContainerId") REFERENCES "AggregateContainer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregationRelation" ADD CONSTRAINT "AggregationRelation_childContainerId_fkey" FOREIGN KEY ("childContainerId") REFERENCES "AggregateContainer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "AggregationRelation" ADD CONSTRAINT "child_reference_shape" CHECK (
 ("childType" = 'SERIALIZED_ITEM' AND "childSerializedItemId" IS NOT NULL AND "childContainerId" IS NULL) OR
 ("childType" = 'CONTAINER' AND "childContainerId" IS NOT NULL AND "childSerializedItemId" IS NULL)
);
ALTER TABLE "AggregationRelation" ADD CONSTRAINT "no_self_parent" CHECK ("parentContainerId" <> "childContainerId");
ALTER TABLE "AggregationRelation" ADD CONSTRAINT "child_tenant" FOREIGN KEY ("organizationId", "childContainerId") REFERENCES "AggregateContainer" ("organizationId", "id");
ALTER TABLE "AggregateContainer" ADD CONSTRAINT "container_code_trimmed" CHECK (length("containerCode") > 0 AND "containerCode" = btrim("containerCode"));
