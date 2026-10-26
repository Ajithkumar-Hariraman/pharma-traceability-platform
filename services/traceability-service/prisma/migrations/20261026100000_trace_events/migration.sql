-- CreateEnum
CREATE TYPE "TraceEventType" AS ENUM ('OBJECT', 'AGGREGATION', 'TRANSACTION');

-- CreateEnum
CREATE TYPE "TraceAction" AS ENUM ('ADD', 'OBSERVE', 'DELETE');

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "eventId" VARCHAR(200) NOT NULL,
    "eventType" "TraceEventType" NOT NULL,
    "action" "TraceAction" NOT NULL,
    "businessStep" VARCHAR(200),
    "disposition" VARCHAR(200),
    "eventTime" TIMESTAMPTZ(3) NOT NULL,
    "recordTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facilityId" UUID,
    "productId" UUID,
    "gtinId" UUID,
    "batchId" UUID,
    "serializedItemId" UUID,
    "aggregateContainerId" UUID,
    "childContainerId" UUID,
    "parentEventId" UUID,
    "metadata" JSONB,

    CONSTRAINT "TraceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_eventId_key" ON "TraceEvent"("eventId");

-- CreateIndex
CREATE INDEX "TraceEvent_organizationId_eventTime_idx" ON "TraceEvent"("organizationId", "eventTime");

-- CreateIndex
CREATE INDEX "TraceEvent_serializedItemId_eventTime_idx" ON "TraceEvent"("serializedItemId", "eventTime");

-- CreateIndex
CREATE INDEX "TraceEvent_batchId_eventTime_idx" ON "TraceEvent"("batchId", "eventTime");

-- CreateIndex
CREATE INDEX "TraceEvent_aggregateContainerId_eventTime_idx" ON "TraceEvent"("aggregateContainerId", "eventTime");

-- CreateIndex
CREATE INDEX "TraceEvent_childContainerId_eventTime_idx" ON "TraceEvent"("childContainerId", "eventTime");

-- CreateIndex
CREATE INDEX "TraceEvent_eventType_idx" ON "TraceEvent"("eventType");


-- Defense in depth: even owner-issued DML cannot mutate event history accidentally.
CREATE FUNCTION reject_trace_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Trace events are append-only'; END;
$$;
CREATE TRIGGER trace_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "TraceEvent"
FOR EACH STATEMENT EXECUTE FUNCTION reject_trace_mutation();
