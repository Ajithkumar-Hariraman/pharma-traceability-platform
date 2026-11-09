CREATE TABLE "Document" (
 "id" UUID PRIMARY KEY, "organizationId" UUID NOT NULL, "domainType" VARCHAR(16) NOT NULL CHECK ("domainType" = 'PRODUCT'),
 "domainId" UUID NOT NULL, "category" VARCHAR(40) NOT NULL, "originalFileName" VARCHAR(180) NOT NULL,
 "objectKey" VARCHAR(512) NOT NULL UNIQUE, "contentType" VARCHAR(100) NOT NULL, "size" INTEGER NOT NULL CHECK ("size" > 0),
 "checksum" VARCHAR(44) NOT NULL, "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','ACTIVE','DELETING','DELETED')),
 "uploadedBy" UUID NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "finalizedAt" TIMESTAMPTZ(3), "deletedAt" TIMESTAMPTZ(3),
 FOREIGN KEY ("domainId") REFERENCES "Product"("id") ON DELETE RESTRICT
);
CREATE INDEX "Document_organizationId_domainId_status_idx" ON "Document"("organizationId","domainId","status");
CREATE INDEX "Document_status_expiresAt_idx" ON "Document"("status","expiresAt");
