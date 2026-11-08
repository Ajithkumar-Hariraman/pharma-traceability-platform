# Pharma Traceability Platform

Independent NestJS API Gateway (port 3000), NestJS Auth Service (port 3001), Organization Service (port 3002), and React/Vite application (port 5173). Shared packages provide configuration validation, Pino options, and health contracts. Use Node.js 24 and pnpm 10.17.0.

## Local setup

1. Run `pnpm install`.
2. Copy `infrastructure/docker/.env.example` to `.env` in that directory and set a local password. PostgreSQL is bound to localhost port 55432 by default; `POSTGRES_PORT` can override it.
3. Copy each backend's `.env.example` to `.env` beside it. Set Auth's `DATABASE_URL` password and port to match Compose. Generate `JWT_SECRET` with `openssl rand -hex 48`; startup requires at least 32 bytes and no default secret is provided. URL-encode special characters in the password. Set the gateway's `AUTH_SERVICE_URL` to the Auth HTTP address. Set `ORGANIZATION_DB_PASSWORD` in the Docker environment and copy Organization Service's `.env.example` to `.env`, matching its database password and port. Generate one `INTERNAL_IDENTITY_SECRET` with `openssl rand -hex 48` and place it in both the gateway and Organization Service environments. Set `ORGANIZATION_SERVICE_URL` at the gateway. `AUTH_SERVICE_TIMEOUT_MS` defaults to 2000 and accepts 1–30000 milliseconds.
4. Run `pnpm infra:up`, `pnpm db:generate`, `pnpm db:deploy`, `pnpm db:organization:generate`, and `pnpm db:organization:deploy` to apply committed migrations. For an existing PostgreSQL volume, first run `docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.yaml exec -T postgres sh /docker-entrypoint-initdb.d/02-organization.sh` after `pnpm infra:up`.
5. Run `pnpm dev`, or target `pnpm dev:gateway`, `pnpm dev:auth`, or `pnpm dev:web`. If another project occupies a port, override the backend's `PORT` and update the gateway URL accordingly.

The browser calls only `/api/auth/*` through the gateway. Vite proxies `/api` to `API_GATEWAY_URL` (default `http://127.0.0.1:3000`); see `apps/web/.env.example`. Production hosting must serve the SPA with fallback to `index.html` for `/login`, `/register`, `/dashboard`, and `/organizations/*`, route `/api` to the gateway on the same HTTPS origin, and preserve the original Host header for origin checks. Auth Service stays private.

## Persistence boundary

Compose starts one PostgreSQL server with the Auth-owned `auth` database and `auth_owner` development role. Only the Auth Service uses Prisma and holds its database URL. The local role has initialization/migration privileges; deployment credentials must be scoped to the Auth database. Data is stored in a named volume; `pnpm infra:down` stops the server without deleting data. Changing the initialization password does not change credentials in an existing volume.

A singleton Prisma provider connects at startup and disconnects during NestJS shutdown. Startup fails if PostgreSQL cannot be reached. The internal user service normalizes emails and accepts encoded bcrypt/Argon2 hashes. HTTP authentication uses a dedicated Argon2id password service (64 MiB, three iterations, parallelism one). Repository results omit password hashes. The initial migration adds a UUID user model, unique normalized email, ACTIVE/INACTIVE status, timestamps, and database checks for normalized email and encoded hashes. Safe user responses contain only ID, email, and status.

For schema changes, use `pnpm db:migrate --name <description>` in development; `pnpm db:deploy` applies committed migrations without a shadow database. Prisma schema validation handles the CLI URL; the Auth runtime validates `DATABASE_URL` before injecting it into the client. Database check constraints live in SQL migrations because Prisma cannot express them in the model.

## Health and verification

Both backends expose `GET /health` for liveness. Auth's `GET /ready` checks PostgreSQL and returns 503 on failure or a two-second deadline, without connection details. The gateway's `GET /api/auth/health` forwards Auth liveness and maps unavailable, invalid upstream, and timeout responses to 503, 502, and 504. It has no retries or circuit breaker.

Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` with the migrated local database running. Tests use Auth's ignored `.env` or an explicit `DATABASE_URL`, create uniquely named test users, and clean them up. They cover normalization, persistence and uniqueness, readiness, actual gateway-to-Auth forwarding, upstream failures, and shutdown. Format with `pnpm format`.

## Authentication sessions

The gateway exposes `POST /api/auth/register`, `/login`, `/refresh`, `/logout`, and `GET /api/auth/me`. Email is trimmed/lowercased, passwords must contain 12–128 characters, duplicate registration returns 409, and all login failures use the same 401 message. A Nest guard verifies access JWTs and checks that the user remains active.

Access JWTs use HS256, a validated environment secret, fixed issuer/audience, and a 15-minute lifetime. React keeps them only in memory. The gateway places opaque 256-bit refresh tokens in host-only HttpOnly, SameSite=Strict cookies scoped to `/api/auth`; Secure is enabled in production. Refresh tokens never appear in browser JSON or localStorage. Same-origin checks reject cross-origin browser writes. Seven-day refresh sessions store only SHA-256 token digests in PostgreSQL. Refresh atomically revokes the old session and creates the replacement; expired/revoked/reused tokens return 401. The seven-day lifetime renews on rotation.

Browser reload restores the session through the cookie refresh endpoint and verifies `/me`. Concurrent refresh requests within one page share a promise; multiple tabs may require signing in again if they race a rotation. Logout revokes the refresh session, clears the cookie, and removes the in-memory access token. Already issued access JWTs remain valid until their 15-minute expiry; inactive users are rejected immediately. Logout errors remain visible so the user can retry invalidation.

Focused Phase 3 tests cover the complete real gateway/Auth/PostgreSQL flow, cookie flags, Argon2 hashing, active-user checks, protected access, concurrent rotation, replay, expiration, logout, sanitized gateway errors/timeouts, and frontend validation/session API behavior. Organization/facility operations use this authenticated session.

## Organization domain (Phase 4)

`services/organization-service` owns the `organization` database on the same PostgreSQL container. Its non-superuser `organization_owner` login has no Auth database connection permission. It has a separately generated Prisma client in its ignored `generated/client` directory; generating it never overwrites Auth's client. The initialization script creates the role/database idempotently for new or existing volumes. Existing role passwords are preserved; set local `.env` passwords consistently.

The gateway exposes organization create/list/get/patch, nested facility create/list/get/patch, and membership list under `/api/organizations`. It reuses Auth's protected `/me` boundary to verify the JWT subject and active identity, then signs the immutable user ID, method, exact path, timestamp, and JSON body with HMAC-SHA256. Organization Service verifies the signature and a 30-second timestamp window before trusting identity. Browser-supplied identity headers are never forwarded. Keep Auth and Organization Service private; use TLS between services in deployment and share `INTERNAL_IDENTITY_SECRET` only between gateway and Organization Service. This internal contract does not query Auth persistence or copy authentication data. Gateway timeouts use the existing configurable upstream deadline.

Controllers delegate to services, repositories, and Prisma. Organization creation and creator ORG_ADMIN membership share one transaction. Lists include only organizations with a membership for the current user. Centralized guards require membership for all organization resources and ORG_ADMIN for organization/facility writes. OPERATOR and VIEWER can read organizations, facilities, and memberships; operational capabilities are reserved for later phases. Membership writes/invitations have no API in this phase. Facility reads and updates always include the organization ID. GLNs are optional, contain exactly 13 digits when supplied, and are globally unique when present; no checksum or GS1 allocation logic is included.

Generate migrations with `pnpm --filter @pharma/organization-service exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output <migration-file>` for an initial database, then `pnpm db:organization:deploy`. The local Organization role deliberately lacks CREATEDB, so `migrate dev` needs a separately provisioned shadow database or migration credentials. Production deployment uses committed migrations. `pnpm dev:organization` runs the service.

The responsive UI lists organizations, creates organizations, shows organization details and role, creates/lists/edits facility profiles, and lists membership IDs/roles. It hides write controls for non-administrators; backend guards enforce the same boundary independently. Deep links restore the existing browser session. Auth remains the identity owner; membership lists display immutable IDs without copying email/password records.

### Phase 5: Product catalog

Product Service runs on port 3003 (`pnpm dev:product`) and owns the `product`
PostgreSQL database as `product_owner`. Set `PRODUCT_DB_PASSWORD` in the Docker
local environment and configure `services/product-service/.env` from its example.
For existing PostgreSQL volumes, run the idempotent `03-product.sh` initialization
script through Docker Compose after `pnpm infra:up`, then run
`pnpm db:product:generate` and `pnpm db:product:deploy`.

Configure `PRODUCT_SERVICE_URL` in the gateway. Each product request uses the
existing Auth identity boundary and Organization Service's internal access
endpoint to obtain current membership. The gateway signs user, organization,
role, method, path, timestamp and request body; Product Service verifies that
context without connecting to either other service's database.

Products navigation is available within each organization. Administrators can
create/edit products and GTINs; operators and viewers can read them. GTIN input
accepts 8, 12, 13 and 14 numeric digits with a valid GS1 check digit and stores a
14-digit, zero-padded value under a global unique constraint. Packaging levels
are EACH, INNER, CASE and PALLET. A composite database foreign key enforces that
a GTIN belongs to a product in the same organization.

### Phase 6: Batches / lots

Batch Service runs on port 3004 (`pnpm dev:batch`) and owns the `batch` database
as restricted `batch_owner`. Configure its local `.env` using the service
example, set `BATCH_DB_PASSWORD` in the Docker environment, and run
`pnpm infra:up`. For an existing volume, explicitly run `04-batch.sh` through
Docker Compose, followed by `pnpm db:batch:generate` and `pnpm db:batch:deploy`.
Configure `BATCH_SERVICE_URL` in the gateway and `PRODUCT_SERVICE_URL` plus
`PRODUCT_SERVICE_TIMEOUT_MS` in Batch Service.

Batch writes and GTIN-scoped lists validate references using Product Service's
signed internal `/internal/organizations/:organizationId/products/:productId/gtins/:gtinId/validation`
endpoint. Batch Service has no Product or Organization database access.
The gateway checks current organization membership; signed identity binds user,
organization, role, method, path, body and timestamp. Admins and operators can
write batches; viewers can read. Product write permissions remain admin-only.

Lots are trimmed, non-empty, and unique per GTIN. Optional dates use `YYYY-MM-DD`
calendar values; expiry must follow manufacture when both exist. The database
also enforces date ordering. References are immutable on batch edits. Status
may be manually set to ACTIVE, QUARANTINED, EXPIRED, RECALLED or CLOSED, without
automatic expiration or workflow side effects.

Open a GTIN's **View batches** link to create a lot or use an organization's
**Batches** navigation for its complete lot list.

### Phase 7: Serialized units

Serialization Service runs on port 3005 (`pnpm dev:serialization`) and owns the
`serialization` PostgreSQL database as restricted `serialization_owner`.
Configure the service `.env` from its example, set `SERIALIZATION_DB_PASSWORD`
in the Docker environment, then run `pnpm infra:up`. For existing volumes,
explicitly run `05-serialization.sh` through Docker Compose. Generate the client
with `pnpm db:serialization:generate` and apply migrations with
`pnpm db:serialization:deploy`. Configure `SERIALIZATION_SERVICE_URL` in the
gateway and `BATCH_SERVICE_URL` / `BATCH_SERVICE_TIMEOUT_MS` in the new service.

Creation accepts only organization, batch and serial input. Serialization
Service derives product/GTIN IDs from Batch Service's signed internal
`/internal/organizations/:organizationId/batches/:batchId/validation` endpoint.
It never opens other services' databases. Only ACTIVE batches permit creation
or commissioning; other batch statuses remain readable and permit containment
commands on existing items.

Serials are strings: whitespace is trimmed, leading zeroes and case are
preserved, control characters are rejected, and length is limited to 100.
Uniqueness is case-sensitive within a GTIN, including across that GTIN's lots.
Bulk creation accepts `{ "serialNumbers": ["serial-1", "serial-2"] }` with 1–100
entries. Normalized duplicates or any database conflict reject the entire
transaction; no records are skipped or partially created.

Lifecycle commands are explicit: CREATED → COMMISSIONED (sets commissionedAt),
COMMISSIONED → DECOMMISSIONED (sets decommissionedAt), and CREATED or
COMMISSIONED → QUARANTINED (preserves commissioning history). Repeated/invalid
commands return conflict errors. Conditional updates prevent concurrent commands
from both succeeding. Generic PATCH rejects mutations because this phase has no
safe mutable serial metadata. Product, GTIN, batch, serial identity and history
are immutable.

Admins and operators can create, bulk-create, commission and quarantine.
Decommissioning requires ORG_ADMIN; viewers read only. The shared policy is used
by gateway, service and UI. Open **View serials** from a batch profile for lists,
single/bulk forms and lifecycle actions. No EPCIS or aggregation is introduced.

### Phase 9: Traceability history

Traceability Service (`services/traceability-service`, port 3007) owns its separate
`traceability` database as `traceability_owner`. Operational services retain their
current-state ownership. This is an EPCIS-inspired internal model, not EPCIS 2.0
capture/query conformance. No shipping, receiving, Kafka, or outbox is included.

Setup: copy the service environment example, configure a separate random
`TRACE_CAPTURE_SECRET` shared only with trusted capture producers, and set
`TRACEABILITY_DB_PASSWORD` in the Docker environment. Set
`TRACEABILITY_SERVICE_URL` in Gateway and Serialization Service, and the same
capture secret in Serialization Service. Run:

```sh
pnpm install --offline
pnpm infra:up
# Required explicitly for an existing PostgreSQL volume:
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.yaml exec -T postgres sh /docker-entrypoint-initdb.d/07-traceability.sh
pnpm db:traceability:generate
pnpm db:traceability:deploy
pnpm dev:traceability
```

The immutable `TraceEvent` has server UUID, organization, unique producer eventId,
OBJECT/AGGREGATION/TRANSACTION type, ADD/OBSERVE/DELETE action, business step,
disposition, eventTime, server recordTime/createdAt, optional facility/product/GTIN/
batch/serial/container/parent-event references, and extensible JSONB metadata.
`childContainerId` explicitly identifies nested-container events so both parent
and child timelines find them. Cross-service references have no database foreign
keys; producers supply authoritative relationships. The capture schema checks
required serial/aggregation relationships and same-tenant parent events.
TRANSACTION is reserved in the model; no transaction workflow is implemented.

Public read-only routes (all ORG_ADMIN, OPERATOR, VIEWER members):

- `GET /api/organizations/:organizationId/trace/events`
- `GET /api/organizations/:organizationId/trace/events/:eventId` (producer eventId)
- `GET /api/organizations/:organizationId/trace/serials/:serializedItemId`
- `GET /api/organizations/:organizationId/trace/batches/:batchId`
- `GET /api/organizations/:organizationId/trace/aggregates/:aggregateId`

Lists return `{items,total,page,pageSize}`. Defaults: page 1, size 25; maximum
size 100. Timelines order by eventTime, recordTime, then UUID ascending. Filters:
`eventType`, `action`, `from`, `to` (inclusive ISO timestamps with timezone),
`serializedItemId`, `batchId`, `aggregateId`, `page`, `pageSize`. Aggregate queries
include events where that container is parent or child. Membership is checked
by Gateway; signed read context binds the complete path including query string.

Internal-only `POST /internal/organizations/:organizationId/trace/events` accepts
`TraceCapture` from the shared contracts. Capture signatures use
`traceCapturePayload(method,path,timestamp,caller,organizationId,rawBody)` and
`TRACE_CAPTURE_SECRET`, with headers `x-trace-caller`, `x-identity-organization`,
`x-identity-time`, `x-identity-signature`. Only serialization-service (OBJECT) and
aggregation-service (AGGREGATION) callers are recognized; browser identities
cannot capture and Gateway exposes no capture route. Signature lifetime is 30
seconds. Configure a distinct capture secret; Serialization's development
fallback to INTERNAL_IDENTITY_SECRET exists for older environment compatibility.

Duplicate eventIds return the existing event only when normalized payloads match
(including canonical JSON metadata); conflicting duplicates return 409, including
concurrent inserts. Event identity is globally unique. No update/delete APIs are
provided. Database triggers reject UPDATE, DELETE, and TRUNCATE; database owners
can still deliberately change DDL, so this is not tamper-proof archival storage.

Commission, quarantine, and decommission commands commit serialization state,
then synchronously capture OBJECT events. Failure returns 503
`TRACE_CAPTURE_FAILED` with `businessStateChanged: true` and the exact event
payload through Gateway. Do not repeat the business command: inspect its state
and have a trusted producer replay that payload with the same eventId/signature.
Capture may already have succeeded if the response was lost. No automatic replay
or durable reconciliation queue exists; a process crash between commit and capture
can lose history. Kafka + transactional outbox is intentionally deferred.

The UI includes Traceability navigation, paginated event lists, UTC date/type
filters, serial/batch/container timelines, detail metadata, and loading/error/
empty states. Serial and Batch profiles link to Trace History.

**Repository blocker:** Phase 8 aggregation source, schema/migrations, gateway,
UI, shared contracts, and tests are absent in this checkout. Only ignored compiled
JavaScript remains under `services/aggregation-service/dist`, and it references a
missing generated client. No runnable aggregation package can be built or safely
integrated. Traceability accepts and tests all four aggregation event shapes,
but operational aggregation capture and an Aggregate Detail link require the
original Phase 8 source. There is no historical backfill for preexisting actions.
Tests retain append-only records under random test organization IDs.

## Phase 11 — Kafka domain events

`pnpm infra:up` starts the existing PostgreSQL instance, an Apache Kafka 3.9.1
KRaft broker, and a one-shot topic initializer. Kafka has a persistent named
volume and separate internal (`kafka:29092`) and host (`localhost:9092`)
listeners. Host access is bound to loopback. The broker and topic use replication
factor 1 and minimum ISR 1 **for local development only**. Automatic topic creation
is disabled. The initializer creates `pharma.domain-events.v1` with six partitions
and seven days of retention. Check initialization with
`docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.yaml logs kafka-init`.

`@pharma/messaging` owns KafkaJS configuration, lifecycle, publishing, consumption,
boundary validation, domain-to-trace mapping, readiness, and structured logs.
Operational services retain ownership of their databases and reference validation.
Traceability owns its append-only event projection. Phase 12 adds service-owned outbox tables and a Traceability processing ledger, described below.

The version 1 JSON envelope has `eventId`, `eventType`, `eventVersion: 1`,
`organizationId`, `aggregateType`, `aggregateId`, `occurredAt` (ISO 8601),
`producer`, optional `correlationId`, and `payload`. Correlation IDs are copied
when available in capture metadata. Payloads contain domain identities and facts,
not Prisma records or database mutation instructions. Supported names are:

| Producer      | Event types                                                                                                                                | Aggregate          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Serialization | `serialization.commissioned`, `serialization.quarantined`, `serialization.decommissioned`                                                  | `serialized-item`  |
| Aggregation   | `aggregation.item-aggregated`, `aggregation.item-disaggregated`, `aggregation.container-aggregated`, `aggregation.container-disaggregated` | parent `container` |
| Shipment      | `shipment.dispatched`, `shipment.received`                                                                                                 | `shipment`         |

Messages are keyed by `organizationId:aggregateType:aggregateId`, preserving Kafka
partition ordering for each aggregate. Concurrent requests can publish in a
different order than their DB commits; consumers retain business occurrence times.
The schema checks producer/type ownership and aggregate/payload relationships,
rejects unknown envelope/payload fields and versions, and requires trusted serial
relationships for object events. Tenant identity comes exclusively from the
validated envelope; payloads cannot override it. Broker access is a trust boundary:
only trusted service principals should publish. Self-declared producer and tenant
fields do not authenticate a Kafka principal. Enforce broker ACLs and network
access controls when moving to a managed broker.

### Controlled migration

Existing `.env` files continue to use HTTP because `EVENT_TRANSPORT` defaults to
`http`. HTTP capture endpoints, signing and failure responses remain intact.
Aggregation previously had no automatic Traceability capture; in HTTP mode it
continues its existing behavior. To enable asynchronous capture:

1. Start infrastructure, confirm the topic initializer succeeds, and apply all four Phase 12 migrations before starting updated services.
2. Set `EVENT_TRANSPORT=kafka` and `KAFKA_BROKERS=localhost:9092` in Traceability's
   environment and restart it. Set a stable `KAFKA_CONSUMER_GROUP_ID=traceability-v1`.
3. Set the same transport and brokers on the operational services, with a distinct
   `KAFKA_CLIENT_ID` per service (examples are in each `.env.example`), and restart.
4. Monitor `/ready`, publish/capture error logs and consumer lag. Stop or drain
   operational writers before changing their transport. Do not dual-publish
   lifecycle commands or retry a committed command to repair missing traces.

Traceability can consume Kafka and accept existing HTTP captures concurrently.
Switching an operational service back to `http` preserves its proven path; leave
Traceability consumption enabled until Kafka backlog has drained. Before switching to HTTP, drain all operational outboxes while Kafka mode is still enabled; HTTP mode does not run the publisher. Aggregation
requires Kafka for its newly added automatic events. There is no automatic HTTP
fallback on Kafka failure, so failed publishes remain visible and event IDs do
not change between transport retries.

`KAFKA_BROKERS` is required in Kafka mode; there are no default production brokers.
`KAFKA_CLIENT_ID`, `KAFKA_CONSUMER_GROUP_ID`, `KAFKA_CONNECTION_TIMEOUT_MS` (3000)
and `KAFKA_REQUEST_TIMEOUT_MS` (10000) are validated centrally. Traceability requires
Kafka at startup and checks Kafka plus consumer activity in `/ready`. Operational
services in Kafka mode can start while Kafka is unavailable: `/ready` checks their
PostgreSQL connection and running outbox worker with a successful storage poll, and reports worker status.
`/health` remains liveness. Kafka outages and pending retries do not fail business
commands or operational readiness once the business/outbox transaction commits.
Monitor outbox depth, oldest pending age, terminal failures and consumer lag.

For a later MSK move, configure broker addresses, `KAFKA_SSL=true` and optionally
`KAFKA_SASL_MECHANISM` (`plain`, `scram-sha-256`, `scram-sha-512`),
`KAFKA_SASL_USERNAME` and `KAFKA_SASL_PASSWORD` through secret configuration.
SASL requires TLS. The same Kafka protocol is used; IAM authentication is not
implemented in this phase. Provision managed topics separately with appropriate
replication/ISR, retention and ACLs. No MSK/AWS deployment is included.

### Delivery and failure behavior

Producers use all-replica acknowledgement, idempotent Kafka production, one
in-flight request and bounded retries (five retries with backoff). This is not an
exactly-once guarantee across process restarts. Traceability validates again and
maps domain facts into existing OBJECT, AGGREGATION or TRANSACTION captures.
Existing globally unique `eventId` and canonical content checks make identical
replays idempotent and reject conflicting or cross-organization reuse. Existing
organization-scoped reads remain unchanged.

Malformed messages and permanent capture validation/conflict errors are logged
with topic, partition and offset and then skipped, allowing subsequent records to
continue. They remain in Kafka until retention expires; there is no DLQ; successful processing is durably recorded in Traceability.
Operational reconciliation must inspect those logs and original records. Transient
capture failures retry the same message, heartbeat while waiting, and keep that
offset unacknowledged until persistence succeeds. Readiness fails during this
retry. Kafka can redeliver after restart or rebalance; existing capture deduplication
handles that. Shutdown disconnects the consumer and producer.

Run `pnpm build` and `pnpm test:phase11` for focused tests. They require local
Kafka and the existing migrated PostgreSQL databases. The integration test uses
a unique consumer group and randomized organizations, covers real Kafka delivery
and an injected transient database failure, and leaves immutable trace fixtures
in place as earlier trace tests do. Run `pnpm test` for all phases.

## Phase 12 — Transactional Outbox and durable consumption

Kafka mode now commits each business mutation and its original versioned domain
envelope to the **same service-owned PostgreSQL transaction**. Serialization,
Aggregation, and Shipment each own an `OutboxEvent` table. No cross-service
foreign keys or distributed transactions are used. An insertion/commit failure
rolls back both business state and publication intent. No Kafka I/O occurs inside
those transactions, and API commands do not wait for publishing. HTTP mode keeps
the earlier signed synchronous capture behavior and never enqueues the same event.
Direct Kafka capture through the HTTP capture client is rejected; all operational
Kafka events must be enqueued transactionally.

### Schema and delivery semantics

Each outbox stores unique `eventId`, version/type, organization and aggregate
identities, the complete Phase 11 envelope JSON, `status`, `attempts`,
`availableAt`, `claimToken`, `publishedAt`, `lastError`, and timestamps. Indexed
eligibility and retention fields support bounded polling/cleanup. Statuses are
`PENDING`, `PUBLISHING`, `PUBLISHED`, and terminal `FAILED`.

Delivery is **at least once**, not exactly once. The former producer crash window
is closed for Kafka mode: after the database commits, publication intent survives
a process crash or Kafka outage. A successful Kafka publish followed by a crash
before the `PUBLISHED` update can still deliver the same `eventId` again. Duplicate
delivery is expected and safe at the Traceability boundary. PostgreSQL durability,
available storage, eventual recovery of dependencies and operational handling of
exhausted retries remain necessary. HTTP mode still has its historical post-commit
capture gap; it is a compatibility mode, not an outbox-backed transport.

### Publisher, concurrency and shutdown

`@pharma/messaging` shares enqueue, PostgreSQL claiming, retry, publishing and
cleanup behavior. Each operational Prisma lifecycle starts its worker after
application bootstrap and finishes its in-flight send, releases unstarted claims without consuming their retry budgets, and stops before disconnecting its
service database on shutdown. Kafka connection failures at producer startup are
logged and retried on later publications. Traceability startup remains strict.

Each poll atomically claims a bounded batch with `FOR UPDATE SKIP LOCKED`,
increments attempts, and commits a lease and random claim token. Network I/O runs
outside the claim transaction. A heartbeat renews the entire claimed batch while
it publishes. Multiple replicas claim disjoint available rows. Crashed workers'
expired leases can be reclaimed; updates include the claim token so a stale
worker cannot mark or reschedule a newer owner's claim. Network/lease uncertainty
can still produce duplicates, consistent with at-least-once semantics. This phase
does not guarantee strict business commit order across workers or aggregates;
Traceability retains event occurrence times.

Acknowledged events become `PUBLISHED`. Failures persist a fixed, sanitized error
code, retry count and next availability using capped exponential backoff. The
publisher does not log payloads or broker exception text. Logs include event,
organization, aggregate, service, attempt and outcome. Each batch failure/poll is
followed by the configured polling delay; there is no tight retry loop.
After the configured attempt limit, `FAILED` rows stay durable for investigation
and explicit requeue. An expired final lease also becomes `FAILED` because its
publication outcome is uncertain. Do not repeat business commands to repair
publication.

The worker exposes running/last-poll status through operational `/ready`.
An individual retry or exhausted event does not make the whole service unhealthy.
Worker storage failures are logged separately; database connectivity and publisher storage availability are part of
readiness. Alerts should use outbox status counts and age, rather than process
liveness alone. For example, query the service-owned database:

```sql
SELECT status, count(*), min("createdAt") AS oldest
FROM "OutboxEvent" GROUP BY status;
```

After resolving the cause, operators can requeue a bounded, organization-scoped
batch of failed events without changing event IDs or stored envelopes:

```sql
WITH retry AS (
  SELECT id FROM "OutboxEvent"
  WHERE status = 'FAILED' AND "organizationId" = '<organization-uuid>'::uuid
  ORDER BY "createdAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
)
UPDATE "OutboxEvent" o
SET status = 'PENDING', attempts = 0, "availableAt" = now(),
    "claimToken" = NULL, "lastError" = NULL, "updatedAt" = now()
FROM retry WHERE o.id = retry.id;
```

Stop/drain operational writers before transport changes. If Kafka is unavailable,
leave durable outboxes in place and restore publishing before switching to HTTP.
No automatic dual-publication or fallback is enabled.

### Traceability processing transaction

Traceability owns a `ProcessedEvent` table with an `eventId` primary key, tenant,
event type, canonical envelope SHA-256 fingerprint, local trace reference and
processing timestamp. Consumption validates the envelope, takes an event-scoped
PostgreSQL transaction advisory lock, checks the durable receipt, resolves or
creates the immutable trace event, and inserts the receipt **atomically**. The
receipt primary key and existing trace `eventId` unique constraint are the final
concurrency boundaries. No in-memory deduplication is used.

Identical replays return the same effect; changed content or cross-organization
reuse conflicts and is logged/skipped by the existing safe consumer loop. A
matching prior HTTP capture can be resolved without adding a second trace row.
A concurrent HTTP capture winning the trace uniqueness race causes the whole
processing transaction to retry. Transient trace/receipt persistence errors roll
back both and leave Kafka delivery retryable. Malformed messages retain Phase 11's
safe skip/log behavior. Successful processing receipts are retained indefinitely
alongside immutable traces so later replays stay safe after outbox cleanup.

### Configuration and retention

Shared validation bounds all integer configuration. Development defaults:

| Setting                   | Default |        Range |
| ------------------------- | ------: | -----------: |
| `OUTBOX_POLL_INTERVAL_MS` |    1000 |    100–60000 |
| `OUTBOX_BATCH_SIZE`       |      20 |        1–200 |
| `OUTBOX_MAX_ATTEMPTS`     |      20 |       1–1000 |
| `OUTBOX_RETRY_BASE_MS`    |    1000 |    100–60000 |
| `OUTBOX_RETRY_MAX_MS`     |  300000 | base–3600000 |
| `OUTBOX_LEASE_MS`         |   60000 | 3000–3600000 |
| `OUTBOX_RETENTION_DAYS`   |       7 |        1–365 |

Every successful poll cleans a bounded batch of rows whose status is `PUBLISHED`
and whose acknowledgment timestamp is older than retention. `PENDING`,
`PUBLISHING`, `FAILED`, and recently published rows are never deleted by cleanup.
Cleanup also runs on idle polls so it catches up without new business commands.
Tune polling, batch size and retention for event volume; failed events require
operator attention and intentionally remain until resolved.

### Setup and verification

Start existing infrastructure with `pnpm infra:up`, then run:

```sh
pnpm db:serialization:deploy
pnpm db:aggregation:deploy
pnpm db:shipment:deploy
pnpm db:traceability:deploy
pnpm build
pnpm test:phase12
```

The build generates all Prisma clients. Phase 12 publisher/producer tests create
and remove disposable schemas in the relevant service-owned databases so workers
cannot claim unrelated application events. Trace fixtures and durable receipts
remain append-only, as in earlier tests. Focused tests cover transactional rollback,
all producers, durable retries, concurrency, lease fencing/recovery, replay and
consumer rollback, isolation, retention, shutdown and a real Kafka end-to-end flow.
Phase 11 producer tests retain their mapping/isolation coverage and now assert
transactional enqueue and successful commands during Kafka outages, replacing the
superseded direct-publish failure expectation. Run `pnpm test` for all phases.

## Phase 13 — Recall Management and Product Verification

Recall Service (port 3009) owns its database and transactional Outbox. Organization
navigation includes Recalls and Verify product. Authenticated verification checks
GTIN + serial against owning services and active product/GTIN/batch recalls.
See [Recall setup, API, decisions and limitations](services/recall-service/README.md).
Set `RECALL_DB_PASSWORD` in Docker's environment and `RECALL_SERVICE_URL` in the
Gateway, initialize the new database for existing volumes, then run
`pnpm db:recall:generate`, `pnpm db:recall:deploy`, `pnpm build` and
`pnpm test:phase13`. Recall requires Kafka; Traceability must use Kafka to receive
its lifecycle history. There is no public verification endpoint or Redis rate
limiter in this phase.
