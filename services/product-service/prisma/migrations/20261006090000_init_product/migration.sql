-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PackagingLevel" AS ENUM ('EACH', 'INNER', 'CASE', 'PALLET');

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(4000),
    "manufacturerName" VARCHAR(200),
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GTIN" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "gtin" VARCHAR(14) NOT NULL,
    "packagingLevel" "PackagingLevel" NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GTIN_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_organizationId_status_idx" ON "Product"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_organizationId_key" ON "Product"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "GTIN_gtin_key" ON "GTIN"("gtin");

-- CreateIndex
CREATE INDEX "GTIN_organizationId_idx" ON "GTIN"("organizationId");

-- CreateIndex
CREATE INDEX "GTIN_productId_organizationId_idx" ON "GTIN"("productId", "organizationId");

-- AddForeignKey
ALTER TABLE "GTIN" ADD CONSTRAINT "GTIN_productId_organizationId_fkey" FOREIGN KEY ("productId", "organizationId") REFERENCES "Product"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

