-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "eventId" VARCHAR(200) NOT NULL,
    "organizationId" UUID NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "envelopeHash" CHAR(64) NOT NULL,
    "traceEventId" UUID NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEvent_traceEventId_key" ON "ProcessedEvent"("traceEventId");

-- CreateIndex
CREATE INDEX "ProcessedEvent_organizationId_processedAt_idx" ON "ProcessedEvent"("organizationId", "processedAt");

-- AddForeignKey
ALTER TABLE "ProcessedEvent" ADD CONSTRAINT "ProcessedEvent_traceEventId_fkey" FOREIGN KEY ("traceEventId") REFERENCES "TraceEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

