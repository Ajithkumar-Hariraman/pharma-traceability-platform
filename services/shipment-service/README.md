# Shipment Service

Independent NestJS service on port 3008. Prisma owns the `shipment` database as
`shipment_owner`; all facility, serial and container validation uses signed HTTP.
No cross-service database writes or foreign keys are used.

Copy `.env.example` to `.env`, configure the shared internal/trace signing secrets,
and use the same Shipment password as `infrastructure/docker/.env`.
For existing PostgreSQL volumes, run `init-shipment.sh` inside the PostgreSQL
container, then run `pnpm db:shipment:generate` and `pnpm db:shipment:deploy`.
The init script creates the dedicated role/database and synchronizes that role's
password without granting superuser or database-creation privileges.

## API

The Gateway exposes `/api/organizations/:organizationId/shipments`; the service
uses the same path without `/api`. Both enforce signed organization context.
ORG_ADMIN and OPERATOR can write; VIEWER can read.

- `POST /` creates with shipmentNumber, sourceFacilityId, destinationFacilityId.
- `GET /` lists with page/pageSize (maximum 100), status, sourceFacilityId,
  destinationFacilityId.
- `GET /:id` includes direct reference contents.
- `POST /:id/items` or `/containers` adds `{ referenceId }`.
- `DELETE /:id/items/:referenceId` or `/containers/:referenceId` removes a reference.
- `POST /:id/ready`, `/dispatch`, `/in-transit`, `/receive`, `/cancel` are commands.

Contents can change only in CREATED. READY freezes membership. Dispatch requires
READY and revalidates facilities and all contents. Receive accepts DISPATCHED or
IN_TRANSIT. Cancellation accepts CREATED or READY only. RECEIVED and CANCELLED
are terminal. Shipment numbers are unique per organization.

At most 100 direct references are allowed per shipment. References are validated
in batches of 10 with bounded HTTP timeouts. Tenant-scoped PostgreSQL transaction
advisory locks serialize content changes and lifecycle commands. Unique membership
constraints and checks prevent reuse of a direct reference across open shipments;
reservations are released by receipt or cancellation. Nested aggregate membership
remains owned by Aggregation: descendant overlaps and external repackaging are not
locked across services in this phase.

## Trace capture

Dispatch and receipt commit Shipment state, then synchronously capture immutable
TRANSACTION/OBSERVE events. Stable event IDs are `shipment:<id>:dispatch` and
`shipment:<id>:receive`. Metadata includes the shipment number, both facilities
and direct serial/container references. Events appear in organization trace history.

If capture fails, the API returns 503 with `TRACE_CAPTURE_FAILED`,
`businessStateChanged: true`, and the exact event payload. Do not repeat the
lifecycle command. Reconcile by submitting the event through the existing signed
Traceability capture API as `shipment-service`; event IDs make capture retries
idempotent. No Outbox or message broker is involved.

Run `pnpm test:phase10` after building and deploying the local databases. The tests
use real Shipment and Gateway HTTP processes, real Shipment/Traceability databases,
and signed reference-service test boundaries. Immutable trace test events remain
in the test organization's history, following Traceability retention semantics.
