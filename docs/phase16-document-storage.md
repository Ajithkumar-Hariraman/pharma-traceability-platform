# Phase 16: document and evidence storage

Product, Recall and Shipment own their document metadata in their existing PostgreSQL databases. Binaries live in private S3-compatible object storage. `@pharma/object-storage` wraps AWS SDK v3 signing, HEAD and DELETE; domain controllers use its shared lifecycle implementation. No binary or permanent storage credentials enter database rows or frontend configuration.

## Local setup

1. Copy the MinIO variables from `infrastructure/docker/.env.example` to the ignored `.env`, using a strong local password. Run `pnpm infra:up` (or start only `minio minio-init` with the same compose/environment arguments).
2. Bucket initialization creates `pharma-documents` and explicitly disables anonymous access. Ports 9000/9001 bind to loopback. Set `DOCUMENT_CORS_ORIGIN` to the exact web origin, normally `http://localhost:5173`. Services run on the host; use a browser-reachable `S3_ENDPOINT=http://127.0.0.1:9000`. A container-only hostname would break browser signatures.
3. Copy the S3 variables from each of Product, Recall and Shipment `.env.example`. Local AWS access/secret values must match the MinIO environment. Never commit credentials.
4. Run `pnpm --filter @pharma/product-service db:deploy`, and the corresponding Recall and Shipment commands.
5. Run `pnpm build`, then `pnpm test:phase16` and `pnpm test:phase16:smoke`. The smoke test uses real PostgreSQL, internal HTTP signatures, and MinIO, with deterministic organization access fixtures. It creates and removes isolated domain fixtures and verifies all three attachment lifecycles. It does not exercise login or the browser UI.

The digest-pinned MinIO image includes `mc`, used by the initialization container. This environment has that image cached. Upstream MinIO registries denied anonymous image pulls during implementation. For a fresh machine, supply `MINIO_IMAGE` with an accessible, reviewed image containing both `minio` and `mc` (or build the official source); no unverified third-party mirror is selected automatically. This is a local development dependency, not a production deployment.

## API and metadata

Gateway routes use `/api/organizations/:organizationId/{products|recalls|shipments}/:domainId/documents`. Internal service paths omit `/api`.

| Method/suffix                | Behavior                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| GET root                     | Up to 200 ACTIVE documents, newest first                                       |
| POST `/uploads`              | Validate metadata, persist PENDING, return signed PUT URL and required headers |
| POST `/:documentId/finalize` | HEAD verifies object, then compare-and-set PENDING to ACTIVE                   |
| GET `/:documentId/download`  | Authorize ownership/status and return signed attachment GET URL                |
| DELETE `/:documentId`        | Admin-only durable deletion intent and idempotent object deletion              |

Upload input: `originalFileName`, domain-specific `category`, `contentType`, positive integer `size`, and base64 SHA-256 `checksum`. Unknown input fields are rejected. Responses exclude object keys and checksums from document metadata. Signed URLs necessarily encode object paths; they are temporary bearer capabilities and must not be logged or shared.

Rows include UUID id, organizationId, bounded domainType/category, domainId, originalFileName, unique objectKey, contentType, size, checksum, status, uploadedBy, createdAt, expiresAt, finalizedAt and deletedAt. Database constraints limit domain/status and require the domain record to exist. Owning service checks enforce the organization/domain association on every operation. No new service/database or domain ownership redesign is introduced.

Keys are `organizations/<organization UUID>/<lowercase fixed domain>/<domain UUID>/<random document UUID>/content`. User filenames never contribute to paths. Original filenames must be bounded safe Unicode letters/numbers and a small punctuation subset; separators, control characters, hidden names and traversal sequences are rejected. Extensions must match the allowed MIME type.

## Lifecycle and security

The gateway resolves current organization membership, signs the complete internal request, bounds dependency calls and sanitizes errors. Domain guards authenticate that signature and bind organization/user/role. The domain checks its own record ownership before accessing document metadata. Administrators and Operators upload/finalize, all organization roles read/download, only administrators delete. Product document uploads allow Operators without changing Product editing permissions. Recall and Shipment attachment permissions do not depend on workflow status.

The browser hashes the file using SHA-256 and PUTs directly to S3, forwarding returned headers. The signature binds content type, content length, checksum, document metadata and `If-None-Match: *`. S3 validates checksum; the conditional write prevents replacing already uploaded evidence, including after finalization. The browser supplies Content-Length automatically. Finalization requires exact length/type/document-id/checksum from HEAD. Missing objects remain PENDING, and a failed finalization can be retried with the returned document ID. The UI offers retry during the current page session. Successfully finalized requests are idempotent.

Allowed defaults: PDF, PNG, JPEG, CSV; 10 MiB maximum. Upload expiry defaults to 300 seconds and download expiry to 120 seconds, each capped at 900. Pending TTL defaults to one hour and must exceed upload expiry by at least 60 seconds. Config validates bucket, region, endpoint, path-style, expiry, limits, content types and credential pairing. In AWS omit local endpoint/credentials and use the normal SDK provider chain; no IAM or AWS infrastructure is provisioned here.

Checksum, extension and declared MIME checks establish integrity and consistency, not trustworthiness of document contents. There is no magic-byte inspection, antivirus scanning or OCR. Downloads force attachment disposition. A later scanner can add a quarantine/scan state between PENDING and ACTIVE without changing the browser transfer mechanism. Production must enforce TLS and restrict bucket access to the owning workloads. Presigned PUT is not a substitute for bucket/IAM policy or storage capacity limits.

## Failure and cleanup

Signing/HEAD/delete dependency failures return sanitized 503 errors. Signing is local and does not prove S3 network availability; an outage can first surface in the browser PUT or server HEAD. Metadata persists PENDING if signing or browser upload fails. Retry finalization after a successful PUT, or request a new upload and allow the abandoned row to expire.

Deletion first persists DELETING, which blocks downloads and finalization. Object deletion is idempotent. A failure leaves durable intent, retried by cleanup; a metadata update failure after object deletion remains recoverable. A DELETING tombstone is retained until pending expiry, even after successful object deletion, so a still-valid PUT cannot leave an undetectable orphan. Sweeps repeat object deletion until the presigned upload window has closed, then mark DELETED. Previously issued GET URLs remain usable until expiry unless the object is removed first.

Each owning controller runs a nonoverlapping cleanup sweep every minute, selecting at most 100 stale PENDING or DELETING rows through indexed metadata queries. Compare-and-set claims prevent finalization racing with expiration. Failed deletes retry in later sweeps; there are no bucket scans in requests. Upload requests do not trigger cleanup. DELETED metadata remains as an audit tombstone; retention/purging is an operational follow-up. Out-of-band objects without metadata cannot be detected by this bounded cleanup; production can use offline inventory reconciliation and bucket lifecycle rules. A PUT already in flight at expiry remains a reason for lifecycle/inventory reconciliation; the 60-second minimum grace reduces this race but does not impose a transfer deadline at S3.

The UI includes category/file selection, lists, dates, downloads, administrator deletion, busy/error/empty states and retry finalization. Byte-level upload progress, pagination beyond the first 200 active records, resumable transfers and persistent pending-upload recovery across browser reloads are outside this phase.
