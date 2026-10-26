# Aggregation Service

Owns containers and current packaging relationships in the `aggregation` PostgreSQL database. Serialized EACH items remain owned by Serialization. Mixed batches and GTINs are supported; container creation accepts only a code and packaging level. Item identifiers, lifecycle, GTIN and batch context are read from the signed Serialization reference API, never from browser context.

Copy `.env.example` to `.env`, configure a unique database password and the existing shared internal identity secret. Set `AGGREGATION_DB_PASSWORD` in `infrastructure/docker/.env` and `AGGREGATION_SERVICE_URL` in the gateway environment.

For an existing PostgreSQL volume:

```sh
pnpm infra:up
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.yaml exec -T postgres sh /docker-entrypoint-initdb.d/06-aggregation.sh
pnpm db:aggregation:generate
pnpm db:aggregation:deploy
pnpm dev:aggregation
```

The gateway authenticates the caller and resolves current organization membership before signing organization and role context. The service verifies the method, path, raw body, timestamp, organization and role signature. ORG_ADMIN and OPERATOR can write; VIEWER can read.

Supported gateway routes under `/api/organizations/:organizationId`:

- `POST /aggregates`: `{ "containerCode": "0000123", "packagingLevel": "INNER" }`
- `GET /aggregates`
- `GET /aggregates/:aggregateId`
- `POST /aggregates/:aggregateId/items`: `{ "serializedItemId": "UUID" }`
- `POST /aggregates/:aggregateId/containers`: `{ "childContainerId": "UUID" }`
- `DELETE /aggregates/:aggregateId/items/:serializedItemId`
- `DELETE /aggregates/:aggregateId/containers/:childAggregateId`
- `GET /aggregates/:aggregateId/hierarchy`
- `GET /serials/:serializedItemId/parent` (container or null)

Only COMMISSIONED items may be newly aggregated. Only ACTIVE parents accept children; child containers must also be ACTIVE. EACH can enter INNER or CASE, INNER can enter CASE or PALLET, and CASE can enter PALLET. Strictly increasing levels exclude cycles. Disaggregation preserves a child container's contents and is allowed even when a parent is inactive. Move a child by disaggregating it and adding it to its new parent; an unsuccessful reattachment leaves it unparented.

Mutations use serializable transactions with bounded conflict retries and a transaction-scoped tenant advisory lock. Unique nullable child columns enforce one current parent globally, including concurrent requests. Deleting a relationship disaggregates it; there is no soft-delete history in this phase. Composite foreign keys enforce tenant consistency, while SQL checks enforce exactly one child source, no self-parenting and trimmed codes. Hierarchy reads use a repeatable database snapshot and retrieve current item status from Serialization; failures return sanitized errors rather than incomplete trees.

Lifecycle validation is a bounded synchronous reference check before the local transaction. It is not a distributed transaction with Serialization. Container status transitions and shipment behavior are outside this phase.
