-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- Keep invariants enforceable even when a writer bypasses the service layer.
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_normalized_check"
    CHECK ("email" = lower(btrim("email")) AND "email" <> ''),
  ADD CONSTRAINT "User_password_hash_check"
    CHECK (
      "passwordHash" ~ '^[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}$'
      OR "passwordHash" ~ '^[$]argon2(id|i|d)[$]v=[0-9]+[$]m=[0-9]+,t=[0-9]+,p=[0-9]+[$][A-Za-z0-9+/]+[$][A-Za-z0-9+/]+$'
    );
