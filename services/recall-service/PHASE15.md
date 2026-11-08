# DynamoDB verification projection

PostgreSQL remains authoritative in each owning service. Outbox → Kafka → the
verification consumer → DynamoDB provides a durable, eventually consistent read
projection. Redis remains L1. No AWS resources or IAM are provisioned here.

## Keys and data

The table has string partition key `PK` and string sort key `SK`, with no GSI.
Unit keys are `ORG#<organizationId>#GTIN#<normalized GTIN>` and
`SERIAL#<normalized serial>`. Organization belongs in the key because identity
and verification are tenant scoped. Normal reads use strongly consistent GetItem,
never Scan. A second direct GetItem reads `ORG#<organizationId>` / `GENERATION`.
That marker fences snapshots created before a relevant event. No fan-out query
or secondary index is required.

Each unit stores organization, GTIN, serial, serialized item, product, GTIN and
batch IDs; product name, lot, expiry, product/GTIN/batch/serialization statuses,
active recall and recall ID, verification status, public response, snapshot
revision, projection version, updatedAt, lastEventId and lastEventTime. Only the
existing public verification response leaves the service. Keys and serials are
not logged. Structured logs report event IDs/types, conditional outcomes, read
hits/misses, fallback and latency.

## Rules, ordering and cache correctness

The consumer enriches events through authenticated owner APIs, and uses the same
authoritative decision method as verification and rebuild. It does not interpret
historical payloads as current state. Commission, quarantine, decommission,
recall activate, close and cancel all refresh current owner state. Multiple
active recalls are resolved by the existing Recall database query, including
batch recall and expiry precedence. Shipment and aggregation do not change the
current verification decision and are ignored.

Every relevant event rotates the DynamoDB organization generation, refreshes
units, and rotates the Redis generation before and after processing. Serialization
refreshes its single unit; recalls traverse organization units in pages of 50.
Generation rotation deliberately makes other snapshots unusable until repaired.
This avoids stale VALID reads during partial fan-out, with some extra fallback
reads. Kafka heartbeats continue during long handlers. A failed write or reference
read retries the event; offsets are not acknowledged before successful completion.
Redis failure retains retry behavior after attempting durable projection work.
DynamoDB failure does not stop Redis invalidation attempted before projection
processing.

Conditional PutItem accepts only a higher snapshot-start millisecond revision.
Equal revisions are rejected safely. Older/duplicate events read current state,
so their event timestamp is diagnostic, not an ordering source. Concurrent earlier
snapshots cannot replace later-started snapshots. Generation fencing prevents
pre-event work from becoming usable after an event. Delivery remains at least
once; duplicate delivery may rotate generations and repeat owner reads. This is
not exactly-once processing or a global PostgreSQL transaction across services.

Redis hit → return; miss → validated DynamoDB snapshot and matching generation →
cache response; absent, malformed, expired, stale or unavailable projection →
existing authoritative path → best-effort projection repair → Redis. Authoritative
failures preserve existing downstream errors. No infrastructure error creates a
VALID result. DynamoDB snapshots expire logically after 30 seconds. Snapshot
verifiedAt is retained through Redis, whose age checks prevent extending snapshot
freshness. Expiry is also checked at read time. Product/GTIN/Batch currently lack
change events: their changes can remain visible late for up to the configured
Redis TTL (default 30 seconds), and DynamoDB snapshots are limited to 30 seconds.
Kafka lag and cross-service reads introduce additional eventual-consistency
windows; there is no claim of instantaneous recall consistency. Direct Recall
commands retain synchronous Redis invalidation.

## Local setup and administration

Copy the new settings from `.env.example` into the recall service environment.
Enable `VERIFICATION_PROJECTION_ENABLED=true`. Local endpoint and credentials
are explicit environment settings. Without an endpoint, the AWS SDK uses its
normal AWS endpoint/credential provider chain. Never use local credentials in
production. Request abort deadlines and one SDK attempt bound fallback latency.

From repository root:

```sh
pnpm infra:up
pnpm build
pnpm --filter @pharma/recall-service projection:init
pnpm --filter @pharma/recall-service projection:rebuild <organizationId> <userId> - 1
```

Initialization is idempotent and uses CreateTable only in this explicit command.
It is never run by application startup. Rebuild requires a valid internal identity
secret and owner URLs, and uses the service-owned Recall database plus bounded
Serialization API traversal; it never reads another service database. Arguments
are organization UUID, operator UUID, optional `after` UUID (`-` means beginning),
and page budget (1–100, default 1). Each page contains at most 50 rows and each
item is processed sequentially. JSON output includes nextCursor or null when
complete. Persist nextCursor externally and resume with it. Re-running from the
beginning is safe. Failed invocations may be repeated from their input cursor.
New UUIDs inserted behind a traversal cursor require another pass; this is not
an atomic snapshot export. Run rebuild per organization. Event recall fan-out is
bounded in memory but total work scales with organization size; large tenants
may eventually need a durable work queue. Long rebuilds may finish with early
snapshots beyond freshness; those are safely refreshed by subsequent reads.

DynamoDB Local persists in a Docker volume. Application credentials/table/region
are environment driven. The local SDK accesses loopback port 8000 by default in
the example. Override DYNAMODB_PORT and DYNAMODB_ENDPOINT together if needed.

## Validation smoke

`tests/phase15-smoke.cjs` uses real Kafka, DynamoDB Local and Redis with deterministic
owner API/database fixtures. It publishes commissioning and recall events,
checks DynamoDB and Redis behavior, rejects an older conditional write, and
checks a refused DynamoDB connection falls back to the authoritative fixtures.
It does not claim a full live service commissioning/Outbox transaction smoke.
Run after table initialization, setting AWS_REGION, AWS_ACCESS_KEY_ID,
AWS_SECRET_ACCESS_KEY, DYNAMODB_ENDPOINT and REDIS_URL to local values:

```sh
node tests/phase15-smoke.cjs
```

Snapshot revisions use application clocks; hosts should have synchronized clocks.
Equal-millisecond writes are conservatively rejected, potentially causing a
projection miss and authoritative repair rather than accepting an ambiguous
replacement. Generation markers and freshness checks keep rejected or stale
snapshots from being used after invalidation.
