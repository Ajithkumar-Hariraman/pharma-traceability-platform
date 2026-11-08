# Recall and verification (Phase 13)

Recall Service runs on port 3009 and owns the isolated PostgreSQL `recall` database
and `recall_owner` role. Product, GTIN, Batch and Serial remain owned by their
existing services. Only references are stored; no cross-service foreign keys or
bulk serial updates are introduced.

## Setup

Set `RECALL_DB_PASSWORD` in `infrastructure/docker/.env`. Copy this service's
`.env.example` to `.env`, set its database credentials and the shared
`INTERNAL_IDENTITY_SECRET`, and configure Product, Batch and Serialization origins.
Set `RECALL_SERVICE_URL=http://127.0.0.1:3009` at the Gateway. All other services
retain their existing configuration. Recall requires `EVENT_TRANSPORT=kafka`.

```sh
pnpm infra:up
# Required once for existing PostgreSQL volumes:
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.yaml exec -T postgres sh /docker-entrypoint-initdb.d/09-recall.sh
pnpm db:recall:generate
pnpm db:recall:deploy
pnpm build
pnpm dev:recall
```

Run Product, Batch, Serialization, Gateway, Web and Traceability as usual.
Traceability must use Kafka for asynchronous recall history. Its existing durable
processing ledger consumes Recall events without an additional migration.
Recall readiness checks its database and publisher storage availability; Kafka
outage leaves committed events pending for the standard Outbox retry mechanism.

## Model and integrity

A Recall contains organization, organization-unique recall number, title, reason,
classification (`CLASS_I`, `CLASS_II`, `CLASS_III`), status, product reference,
optional GTIN and batch references, creator, initiation/closure and audit timestamps.
Product is required. Batch is the narrowest scope, followed by GTIN, then Product.
References are checked using signed, tenant-scoped owning-service HTTP APIs during
creation and activation. Inconsistent dimensions are rejected. An inactive product
or closed batch may still need a recall, so recall creation does not require active
catalog status.

Allowed transitions are `DRAFT → ACTIVE`, `DRAFT → CANCELLED`, and `ACTIVE → CLOSED`.
Terminal states cannot reopen. Repeated commands return 409. Conditional updates
inside a PostgreSQL transaction permit one winner per transition. The same
transaction inserts the common version-1 domain envelope into Outbox. A partial
unique index prevents multiple ACTIVE definitions for the same organization and
exact scope. A batch's scope key is independent of whether its GTIN was explicitly
supplied. Different scopes may overlap intentionally; verification checks all
matching active definitions and returns the most recently initiated summary.
Recall closure ends that definition only, and does not change Serialization or
Batch lifecycle state.

## Gateway API

All routes require authentication and organization membership; the public prefix
is `/api`. Internal service routes omit `/api` and require HMAC identity headers
bound to method, path, body, organization, user and role.

| Method | Path after `/api/organizations/:organizationId` | Purpose                              |
| ------ | ----------------------------------------------- | ------------------------------------ |
| POST   | `/recalls`                                      | Create DRAFT                         |
| GET    | `/recalls`                                      | Paginated list                       |
| GET    | `/recalls/:recallId`                            | Detail                               |
| POST   | `/recalls/:recallId/activate`                   | Activate DRAFT                       |
| POST   | `/recalls/:recallId/close`                      | Close ACTIVE                         |
| POST   | `/recalls/:recallId/cancel`                     | Cancel DRAFT                         |
| POST   | `/verification`                                 | Read-only GTIN + serial verification |

Create body: `{ recallNumber, title, reason, severity?, productId, gtinId?, batchId? }`.
Commands accept an empty object. Lists accept `status`, `productId`, `gtinId`,
`batchId`, `from`, `to` (inclusive creation timestamp range), `page` (1–100000),
`pageSize` (1–100, default 25). Results are `{items,total,page,pageSize}` in stable
newest-first order. ORG_ADMIN and OPERATOR can create and execute commands;
VIEWER can read and verify. Verification POST is a read operation for all roles.
Gateway errors are fixed, sanitized messages; responses use `Cache-Control: no-store`.

Verification body: `{ gtin, serialNumber }`. GTIN uses existing GS1 normalization
and check-digit validation; serial uses the existing immutable identity rules.
Exact, tenant-scoped lookups are added to Product and Serialization behind signed
identity. A serial under a different GTIN or organization is unknown.

## Verification decisions

1. Unknown GTIN or serial returns UNKNOWN.
2. Active matching product, GTIN or batch recall returns RECALLED, including for
   quarantined or decommissioned items. Existing Batch RECALLED status is also
   respected as RECALLED independently of Recall closure.
3. Decommissioned serial returns DECOMMISSIONED.
4. Quarantined serial or batch returns QUARANTINED.
5. VALID requires COMMISSIONED plus ACTIVE product, GTIN and batch, and no known
   past expiry date. The printed expiry date is valid through that UTC calendar day.
6. Remaining existing items return UNKNOWN with an ineligibility explanation.

The response includes result, explanation, normalized GTIN and serial, product
name, lot, expiry, verifiedAt and a recall summary when applicable. It omits internal
IDs, actor and membership data. Missing batch, malformed/mismatched references,
timeout and unavailable dependencies fail closed with HTTP errors (502/503/504 or
404 for a missing required batch), never VALID. Verification does not mutate state,
insert events or require distributed locks. Structured result logs omit pack
identity. Reads across services are point-in-time observations rather than a
cross-service atomic snapshot; callers can reverify after state changes.

## Events and limitations

`recall.activated`, `recall.closed`, `recall.cancelled` use the shared versioned
envelope, Recall aggregate ID, preserved eventId/organizationId, scope references,
reason/classification and occurredAt. Recall ID, number, title, reason and severity
are stored in metadata. The existing asynchronous Outbox publisher sends Kafka
messages to `pharma.domain-events.v1`; Traceability records TRANSACTION/OBSERVE
with `recalling`, `recall_closing`, or `recall_cancelling` business steps. The durable
Traceability ledger suppresses replay effects. Verification reads current Recall
state directly, so Kafka projection lag does not delay recall detection.

Verification is authenticated only in this phase. There is no public endpoint,
Redis rate limiter, cache, or per-request durable audit event. Any future public
endpoint needs explicit abuse controls and a public-data review before exposure.
No last-event fetch is required for a decision; recall detail links to existing
Traceability history (batch scope when available). Product/GTIN history uses the
organization history view. Recall management does not enforce shipment blocking or
serial mutation; those remain separate domain decisions.

Focused tests: `pnpm test:phase13` after `pnpm build`. Tests create isolated schemas
under existing service owners, apply committed migrations and clean them up. They
exercise actual owning-service HTTP lookups, Gateway authorization, PostgreSQL
concurrency/rollback, Kafka publication and durable Traceability replay.

## Phase 14: optional Redis acceleration

PostgreSQL remains authoritative, Kafka transports committed domain events, and
Redis stores disposable verification responses and rate counters. Start Redis with
`pnpm infra:up`. The Compose service uses AOF, a named volume, a health check,
loopback port binding and `unless-stopped`. Change `REDIS_PORT` in the infrastructure
environment and `REDIS_URL` in Recall's environment together if 6379 is occupied.
For a containerized Recall service use `redis://redis:6379`. The URL supports
`rediss://` and credentials for a future managed endpoint; no AWS resources are
created. Keep credentials outside source control. Use a dedicated Redis deployment
and access controls; persistence is development convenience, not business storage.

`@pharma/redis` owns connection lifecycle, bounded connect/command timeouts,
GET, expiring SET, DEL, counters/expiry, generation tokens, atomic rate windows,
and PING. It disables offline queuing so an outage cannot queue old cache writes.
No consumer uses raw Redis connections or key scans. Nest logging is routed through
the service's existing Pino logger and never includes URLs or raw serial numbers.

Verification validates and normalizes input before cache access. Keys contain the
organization, a random generation token, and SHA-256 of the unambiguously encoded
GTIN/serial pair. This isolates tenants and avoids exposing full serials in keys.
A miss uses the existing owning-service reads and Recall database query. Only a
successful decision is cached; reference errors retain existing HTTP error behavior.
Cached JSON is strictly validated for shape, input identity, timestamp/freshness and
expiry before returning. A hit retains the original `verifiedAt` observation time.

Defaults (bounded and validated by shared config):

| Setting                            | Default | Maximum |
| ---------------------------------- | ------- | ------- |
| `REDIS_CONNECT_TIMEOUT_MS`         | 500     | 10000   |
| `REDIS_COMMAND_TIMEOUT_MS`         | 500     | 10000   |
| `VERIFICATION_CACHE_TTL_SECONDS`   | 30      | 300     |
| `VERIFICATION_UNKNOWN_TTL_SECONDS` | 5       | 60      |
| `VERIFICATION_RATE_LIMIT`          | 60      | 100000  |
| `VERIFICATION_RATE_WINDOW_SECONDS` | 60      | 3600    |

All numeric settings have a minimum of 1. VALID, RECALLED, QUARANTINED and
DECOMMISSIONED share the bounded normal TTL; UNKNOWN uses the shorter TTL.
Cache read/write/delete failures fall back to authoritative reads or return the
already computed result. An unavailable owning service never creates a VALID entry.
`/ready` retains database/outbox business readiness and reports `redis: degraded`
without changing the response to 503 solely for optional Redis failure.

### Invalidation and consistency

Consumer startup runs in the background with connection retry, so group joining
does not delay business readiness. `/ready` reports its running state separately.
A dedicated Kafka group `verification-invalidation-v1`, shared by Recall replicas
and distinct from traceability, consumes recall activation/close/cancel and
serialization commissioning/quarantine/decommission events. It rotates the
organization generation. Those events identify internal UUID scopes, not external
GTIN/serial identities, so organization invalidation avoids reverse indexes and
serial enumeration, including for UNKNOWN responses. This trades some cache hit
rate for a simple bounded operation. Unrelated organizations are untouched.

Recall lifecycle commands also rotate the generation after commit, before returning,
to reduce local read-after-command lag. The transactional outbox remains the durable
retry path if this best-effort update fails. Redis invalidation errors propagate to
Messaging's existing heartbeat/retry loop; the offset is not acknowledged until
invalidation succeeds. Malformed events use existing sanitized skip handling.
Duplicate and out-of-order deliveries each create a fresh random token and are safe.
No business consumer-idempotency table is needed for this naturally repeatable side
effect. A missing generation is atomically initialized to a fresh random value:
eviction cannot resurrect a prior namespace. Concurrent fills use the generation
captured before authoritative reads, so late writes into an invalidated namespace
remain unreachable. Old entries expire naturally. Generation keys have no TTL;
there is one per organization seen by verification or invalidation, not one per serial or event.

Invalidation is asynchronous: a committed remote change may be observable only after
Kafka delivery, with TTL bounding stale observations during lag or outage. This is
not a linearizable safety check. Product/GTIN and Batch services currently have no
suitable domain events/outbox; their changes are bounded by the same short TTL.
Extending their durable event producers is a separate change. UTC date expiry is
also checked on cache hits, so a VALID response cannot cross its known expiry date.
Operational decisions requiring fresh authoritative reads must account for this
cache policy. Redis recovery does not imply Kafka has caught up; monitor consumer
readiness status and logs/lag alongside `/ready` and degraded Redis warnings.

### Verification rate limiting

Only the authenticated verification controller applies the limiter, after the signed
internal identity guard. The key hashes organization + authenticated user + endpoint;
no forwarded IP header is trusted and other service routes are unaffected. One atomic
Lua operation increments a counter and sets expiry on the first request. This is a
fixed-duration window starting at the first request, bounded by configured seconds.
Cache hits count as requests. Over-limit responses return 429 and `Retry-After`;
the Gateway preserves both. Redis failure is fail-open for authenticated users.
A future public route can reuse the atomic window helper with a separately trusted
identity and policy. Arbitrary callers cannot supply signed authenticated identities.

Run `pnpm test` for the full suite. Phase 14's real Redis test uses the standard Compose
port 6379 by default; set `PHASE14_REDIS_URL` to use another test Redis URL.
Tests create randomly named keys and clean them up; they never flush a database.

Phase 15 DynamoDB setup, keys, rebuild, consistency and smoke validation: [PHASE15.md](PHASE15.md).
