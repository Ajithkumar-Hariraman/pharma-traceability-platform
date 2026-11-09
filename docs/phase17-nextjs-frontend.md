# Phase 17 — Next.js frontend

`apps/web` uses Next.js 16 App Router, React and TypeScript. Run `pnpm dev:web` (port 5173); production uses `pnpm --filter @pharma/web build` and `pnpm --filter @pharma/web start`. Copy `apps/web/.env.example` to `.env.local` when overriding the Gateway address. Use a Next.js Node server, rather than an SPA fallback or static export.

## Architecture and rendering

Browser → Next.js transport → NestJS API Gateway → existing microservices. No authentication, validation, authorization, verification or document business APIs were moved out of NestJS.

Root layout and verification metadata are server components. The public verification introduction can be prerendered. Operational workspaces deliberately fetch in client components after the shared session provider finishes cookie refresh and `auth/me`. Access tokens stay in module memory; no tokens are persisted to browser storage or server-rendered props. Protected layouts wait for session resolution and redirect guests to `/login`; the Gateway remains the authorization boundary. Reload and client navigation retain existing refresh/retry/logout behavior. API failures leave a retryable error, rather than granting access.

The generic `/api/[...path]` handler is transport only, using a fixed server-side `API_GATEWAY_URL`. It forwards the original Host, Origin and Sec-Fetch-Site so the Gateway's same-origin checks remain authoritative, forwards HttpOnly Set-Cookie headers, disables caching, and returns a friendly 502 on transport failure. There are no domain-specific Next.js API implementations. It uses a 30-second deadline. [Next.js external rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites) were considered; explicit forwarding preserves the Gateway's original-Host requirement. Production ingress must preserve the public Host and use HTTPS. The Gateway's existing Secure cookie behavior still applies in production.

Only the Gateway origin belongs in frontend configuration; `API_GATEWAY_URL` is server-only and can change on server restart. There are no `NEXT_PUBLIC_*` settings or service credentials in the browser bundle.

## Routes

- `/login`, `/register`, `/organizations`, `/verify`.
- `/organizations/[organizationId]` is the operational overview.
- Organization children: `facilities`, `products`, `batches`, `serials`, `aggregates`, `shipments`, `trace`, `recalls`, `verification`.
- Facilities/products/batches/serials/aggregates/shipments/recalls have `[resourceId]` detail routes.
- Preserved GTIN detail: `products/[productId]/gtins/[gtinId]`, with child `batches`.
- Preserved batch serialization: `batches/[batchId]/serials`.
- Scoped trace: `trace/[scope]/[referenceId]` for `serials`, `batches`, `aggregates`.
- `/` and the former `/dashboard` redirect to `/organizations`. Unknown routes and unsupported trace scopes render Next.js not-found.

Next's router owns navigation and route parameters; reusable React workspaces retain their existing forms, RBAC and API calls. A route change remounts domain state, avoiding stale detail/forms across resource navigation.

## Operational experience

The responsive shell includes organization context, active navigation, account/logout controls, keyboard skip link and mobile menu. The overview uses existing product/batch/aggregate lists, labeling counts as records returned by the API. These list endpoints have no pagination contract; no extra backend counts were added. Shipment and active recall counts use paginated API totals with a one-record page. A global serialized-unit count is intentionally omitted: serial lists are batch-scoped. The serialization landing page offers a batch chooser.

Latest activity uses the trace API's total and ascending pagination to fetch at most three five-record pages, then displays the latest five events in reverse chronological order. Trace history includes event type, action, business step, disposition, timestamps and linked domain references. Existing filters and pagination remain. Metadata is collapsed under technical details and sensitive key names are redacted. This is recorded business-event history, not a separate audit ledger; actor identity and a shipment-specific trace endpoint are not available in the shared trace contract. Shipment contents link to their serial/container histories.

Serial and shipment lifecycle displays highlight the current state without claiming unrecorded transitions. Recall detail emphasizes active warnings and retains actual creation/activation/closure times, scope, classification, document evidence and trace links. Aggregation retains its recursive pallet/case/inner/each tree and native confirmation prompts.

`/verify` is publicly reachable, but lookup remains authenticated and organization-scoped. It provides a clear sign-in boundary and organization chooser; the same validated GTIN/serial form presents VALID, RECALLED, QUARANTINED, DECOMMISSIONED and UNKNOWN outcomes. A service failure never becomes a valid result.

The reusable Phase 16 document component remains attached to products, shipments and recalls. It hashes the selected file, requests a presigned URL, PUTs directly to object storage without cookies, finalizes through the Gateway, and supports list/download/delete/error/retry states. Binary content never passes through Next.js. Keep storage CORS aligned with the browser origin, normally `http://localhost:5173`.

## Validation

`pnpm test:phase17` runs focused DOM tests with jsdom, React DOM, TypeScript's transpiler and the existing Node test runner; it adds no browser automation framework. Tests cover route presence, protected navigation, shell navigation/logout, credential submission, domain navigation, overview data, all verification states, lifecycle status, documents, refresh retry and forwarding cookies/headers. Use `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `git diff --check` for repository checks.

`pnpm test:phase17:smoke` checks a production Next.js server across 15 page routes, invalid routes, metadata, protected initial HTML, and Host/Origin/refresh-cookie forwarding to a temporary Gateway fixture. It starts and stops its own local servers. Build the frontend first.

DOM and HTTP checks are not browser smoke verification. Real login and end-to-end operational/document actions require running the existing services and browser access. No deployment or infrastructure changes belong to this phase.
