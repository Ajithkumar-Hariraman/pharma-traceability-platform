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
