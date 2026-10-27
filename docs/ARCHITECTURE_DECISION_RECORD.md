# Architecture Decision Record (ADR)

Version 1.0 (Phase 2) — 2026-10-27
Status: **Accepted for Phase 3**, except where marked *Conditional* (depends on an open user input).
Evidence base: package metadata checked on the npm registry on 2026-10-27 (versions, peer dependencies, published contents); the tenant-context spike (`spikes/tenant-context`, TR-0003); the schema draft tests (TR-0002). Vendor pricing pages could not be reached from this environment (network policy), so hosting costs in `COST_MODEL.md` come from third-party sources and are marked as such.

Each entry: context → options considered → decision → consequences → how it will be verified.

---

## ADR-01 Runtime: Node.js LTS
- **Options:** Node.js, Bun, Deno.
- **Decision:** Node.js. Production and CI target the current Active LTS line (Node 24 at the time of writing); code must also run on Node ≥ 22.22 (the dev container has 22.22.0; `react-router` 8.5 requires ≥ 22.22, found by CI run #9, which raised the earlier ≥ 22.18 floor).
- **Why:** widest library support (pg, Fastify, Playwright), predictable LTS schedule. Node 22 leaves maintenance in 2027, during the pilot window, so it is not the production target. (Release-schedule dates are from general knowledge; confirm on nodejs.org when setting up CI.)
- **Verify:** CI matrix runs on the newest Node 22 and Node 24.

## ADR-02 Language and tooling
- **Decision:** TypeScript **6.0.x** (pinned), `strict`. pnpm workspaces. ESLint 10 + typescript-eslint 8 (flat config). Prettier.
- **Why TS 6 and not 7.0:** `typescript-eslint@8.72.1` declares `typescript: >=4.8.4 <6.1.0` (verified via npm), so TS 7 would leave linting unsupported. Revisit when typescript-eslint supports TS 7.
- **Consequence:** one language across web, API, worker and domain logic (NFR-3).

## ADR-03 Repository layout (modular monolith, NFR-2)
```
apps/
  web/            React SPA (Vite)
  api/            Fastify HTTP API (one deployable)
  worker/         Background job runner (same codebase, separate process)
packages/
  domain/         Pure logic, no I/O: tax engine, allocation, IMEI, numbering formats, metric definitions
  modules/        One folder per business module (auth, tenancy, rbac, catalogue, inventory, purchasing,
                  ocr, pos, ledger, crm, reports, creative, integrations, messaging, agents, billing, audit)
                  each exposing a public index.ts; internals not importable from other modules
  db/             Migrations (SQL), Kysely types, withTenant(), DB roles
  contracts/      Zod schemas shared by API and web (request/response types)
  adapters/       Provider interfaces + implementations + mocks (storage, email, sms, whatsapp, llm, ocr, …)
  config/         Shared ESLint/TS/Vitest config
spikes/           Throwaway experiments (not shipped)
```
- **Boundary enforcement:** ESLint `no-restricted-imports` patterns forbid `packages/modules/*/src/**` imports from outside the module; a CI check fails on violations.
- **Alternatives:** Nx/Turborepo (extra tooling, can add later for caching); microservices (rejected, D-003).

## ADR-04 HTTP API: Fastify 5 + Zod 4
- **Options:** Fastify, NestJS, Hono, Express.
- **Decision:** Fastify 5.12 with `fastify-type-provider-zod` 7 and Zod 4.6 schemas from `packages/contracts`.
- **Why:** mature Node-native plugins for cookies, CSRF, helmet-style headers, rate limiting and multipart; schema-first routes give validation and typed handlers; good performance. NestJS adds a DI framework we do not need; Hono's strengths are edge runtimes, which we are not using; Express lacks built-in schema validation.
- **Rules:** every route declares `config.permission` (or `public: true`) and a Zod schema for params, query and body; unknown fields are rejected (NFR-3, FR-RBAC-1 AC2).

## ADR-05 Frontend: React SPA with Vite
- **Options:** Vite SPA, Next.js, React Router framework mode.
- **Decision:** React 19 + Vite 8 SPA, React Router 8 (library mode), TanStack Query 5, Tailwind CSS 4, React Aria Components 1.22 for accessible primitives (WCAG 2.2 AA target, NFR-1).
- **Why:** the product is an authenticated app with no SEO need, so SSR adds server complexity, CSP friction and another runtime that holds tenant data. Serving the SPA and API from **one origin** (`/` and `/api`) keeps cookies `SameSite` and lets the CSP disallow inline scripts. A public marketing site, if needed, will be a separate static site.
- **Verify:** Playwright + axe checks on core screens at 360/768/1280 px (NFR-1).

## ADR-06 Database access and migrations
- **Options:** Kysely, Drizzle, Prisma, raw `pg`; migrations: Kysely Migrator, node-pg-migrate, Prisma Migrate, Drizzle Kit.
- **Decision:** **Kysely 0.29 + node-postgres 8.23.** Migrations are **reviewed `.sql` files** run by Kysely's built-in `Migrator` (each migration's `.ts` wrapper executes its sibling SQL file).
- **Why:** the design depends on things ORMs abstract away: RLS policies, forced RLS, triggers, composite foreign keys, column-level grants and transaction-local `set_config`. Kysely is a typed query builder with first-class raw SQL and explicit transactions; the spike used it successfully. SQL migrations keep policies and triggers reviewable verbatim. node-pg-migrate 9 ships SQL-file support only under a `legacy/` path (seen in its published package), so it was not chosen. Better Auth also uses Kysely internally (ADR-09).
- **Types:** generated from the migrated database in CI (e.g. kysely-codegen), checked in.
- **Verify:** migration up from empty in CI + the schema checks (TR-0002 suite becomes DB tests).

## ADR-07 Tenant context per transaction (D-004, threat T26)
- **Decision:** All tenant work runs through `withTenant(db, ctx, work)`, which opens a transaction and first runs `set_config('app.business_id', …, true)` and `set_config('app.user_id', …, true)`. The context comes only from the authenticated session; malformed values are rejected before reaching the DB. Request handlers never get a raw pool connection.
- Three connection pools / DB roles: `lbgos_app` (tenant requests, RLS), `lbgos_platform` (platform admin routes), `lbgos_auth` (auth module only, ADR-09). The migration/owner role is used only by the migration job.
- If a pooler (e.g. PgBouncer) is added, it must run in **transaction mode**; transaction-local settings are compatible with that.
- **Evidence (TR-0003):** 200 concurrent requests across two tenants on a 3-connection pool saw only their own rows; no context remained on pooled connections after commit or rollback; a negative control showed a session-level `set_config` does leak, so the test can detect leakage; cross-tenant writes are rejected (42501); the platform pool cannot read tenant tables.
- **Locking rules found by the spike:**
  - Invoice numbers are allocated with `UPDATE invoice_series … RETURNING` inside the issuing transaction: 30 concurrent issuers with 6 rollbacks produced exactly `A/0001…A/0024` with no gaps or duplicates.
  - Payment allocation locks the invoice (`FOR UPDATE`) and the payment with `pg_advisory_xact_lock`. `FOR UPDATE` needs UPDATE privilege, which append-only `payments` deliberately lacks. A characterization test shows that **without** these locks two transactions can over-allocate an invoice even with the bounds trigger.

## ADR-08 Background jobs: graphile-worker
- **Options:** graphile-worker 0.18, pg-boss 12, BullMQ (Redis).
- **Decision:** **graphile-worker** on the same PostgreSQL. No Redis in the pilot.
- **Why:** one fewer stateful service to operate, back up and secure; jobs can be enqueued in the same transaction as the business change (atomic "post purchase + queue OCR cleanup"); supports job keys (idempotency), retries with backoff, cron tasks and LISTEN/NOTIFY wake-ups. pg-boss is an equally valid fallback; BullMQ needs Redis.
- **Rules:** every job payload carries `businessId` and `requestedBy`. The worker re-validates them, runs the job through `withTenant`, and re-checks that the requesting user still holds the required permission at execution time. Heavy jobs (OCR, PDF, media) go to a separate worker queue/process with resource limits (FR-OCR-6).
- **Verify:** Phase 3 test that a job without valid tenant context fails closed.
- **Update (D-036, Phase 4):** the first job type (OCR) uses its own job table with SKIP LOCKED claiming instead of graphile-worker; graphile-worker is reconsidered when more job types arrive.

## ADR-09 Authentication: Better Auth, self-hosted — *Conditional on Q3*
- **Options:** managed identity (e.g. Clerk, Auth0, Amazon Cognito, Supabase Auth); self-hosted library (Better Auth, Auth.js); hand-built on primitives.
- **Decision (default unless the user prefers managed):** **Better Auth 1.7**, self-hosted in our PostgreSQL, wrapped behind `packages/modules/auth` so it can be replaced.
  - Server-side DB sessions (revocable, FR-AUTH-1); `two-factor` plugin (TOTP + backup codes, FR-AUTH-3); `@better-auth/passkey` for WebAuthn (should-have); `haveibeenpwned` plugin for the breached-password check (FR-AUTH-2 AC4). Both plugins confirmed present in the published 1.7.14 package.
  - **Password hashing:** Better Auth defaults to scrypt (seen in its published source). We override `password.hash/verify` with **Argon2id** via `@node-rs/argon2` to meet NFR-13.
  - **Telemetry:** default is off in 1.7.14 (`telemetry.enabled` defaults to `false`); we also set it to `false` explicitly and leave the `BETTER_AUTH_TELEMETRY*` variables unset.
  - **Data separation:** Better Auth's tables live in schema `auth`, reachable only through the `lbgos_auth` role used by the auth module. The tenant request role cannot read credential, session or MFA tables. `lbg.users` becomes the profile table keyed by the auth user ID.
  - **Tenancy and permissions stay ours:** Better Auth's organization plugin is **not** used; memberships, roles and permissions remain in `lbg` tables under RLS (FR-RBAC-1).
- **Why:** keeps identity data in our own database in the chosen region, has no per-user pricing, supports mandatory MFA, and fits the Kysely stack. Risks: a younger library than the managed options, and we carry the operational responsibility. Mitigations: wrapper interface, pinned versions, an auth security test suite (Phase 3), and the independent penetration test before launch.
- **If the user chooses managed auth:** only `modules/auth` changes; session revocation, MFA enforcement and data-residency terms must be re-checked for the chosen provider.

## ADR-10 Authorization
- **Decision:** our own RBAC (`ROLES_PERMISSIONS.md`), enforced in a Fastify `onRequest` hook: resolve session → membership in the requested business → effective permissions (60 s cache max, R5) → business/subscription status gate (D-009/D-010) → route permission. Deny by default. Database RLS is the second layer (ADR-07).
- **Verify:** a test enumerates every registered route and fails if a route has neither `permission` nor `public: true`. Cross-tenant tests run per endpoint group.

## ADR-11 Object storage
- **Decision:** S3-compatible API (`@aws-sdk/client-s3`) behind a `StorageAdapter`: private buckets, random object keys prefixed by business ID, presigned GET/PUT URLs that expire in ≤ 15 min (NFR-6), content type set by the server after magic-byte checks, `Content-Disposition: attachment` for downloads. The same adapter works with DigitalOcean Spaces, AWS S3, Cloudflare R2 or MinIO (portability).

## ADR-12 Invoices: print and PDF
- **Decision:** one HTML/CSS template set per paper size (A4, A5, 80 mm, 58 mm) using `@page` print CSS. Browser print uses it directly. PDFs are rendered from the same HTML by headless Chromium (Playwright) in the heavy-job worker, so the PDF matches print preview (FR-PRN-1 AC3).
- **Trade-off:** a larger worker image and more memory. The alternative (pdf-lib/pdfmake) would mean a second layout implementation that drifts from the print version.

## ADR-13 Secrets and encryption
- **Platform secrets** (DB passwords, session secret, KEK): injected as environment secrets by the hosting platform; never in the repo, never sent to the browser.
- **Tenant integration secrets** (FR-HUB-3): envelope encryption with `node:crypto` AES-256-GCM. Each secret gets its own random data key, which is encrypted with a versioned key-encryption key (KEK) held outside the database. Rotation re-wraps data keys. Secrets live in `integration_secrets`, readable only by a dedicated role used by the integrations module.
- **Upgrade path:** use a managed KMS when the hosting choice provides one (e.g. AWS KMS). DigitalOcean has no managed KMS (to re-verify), so on DigitalOcean the KEK is a platform secret. That residual risk is recorded in the threat model (T12).

## ADR-14 Edge, TLS, WAF and rate limiting
- **Decision:** Cloudflare (or the host's equivalent) in front for TLS, DDoS protection and WAF managed rules; HSTS. App-level rate limits use `@fastify/rate-limit` (supports a custom store) with a **PostgreSQL-backed** counter store, so limits hold across instances without Redis, plus Cloudflare rate-limit rules on `/api/auth/*`.
- **Revisit:** move counters to Redis/Valkey if rate-limit writes become significant DB load.

## ADR-15 Observability
- **Decision:** pino structured JSON logs with `redact` paths for secrets/PII, request ID and tenant ID on every line (NFR-10); `/healthz` (liveness) and `/readyz` (DB + queue); error tracking via a provider chosen in Phase 3, with PII scrubbing (candidates: Sentry, or self-hosted GlitchTip for data residency); external uptime check; alerts on error rate and failed jobs. OpenTelemetry traces later.

## ADR-16 Testing strategy
| Layer | Tool | Notes |
|---|---|---|
| Domain logic (tax, allocation, IMEI, numbering formats) | Vitest 5 + fast-check 4 (property tests) | ≥95% branch coverage for the tax engine (FR-TAX-1 AC5) |
| DB constraints, RLS, migrations | Throwaway PostgreSQL (`scripts/with-throwaway-pg.sh`), SQL checks + Vitest | TR-0002 suite carried forward |
| API integration | Vitest + Fastify `inject` + throwaway DB | Cross-tenant and permission tests per route group |
| End-to-end, responsive, accessibility | Playwright 1.64 + @axe-core/playwright 4.14 | Chromium preinstalled in the dev container; add Firefox/WebKit in CI |
| Concurrency | Spike-style interleaving tests | Numbering, allocation, IMEI sale race (FR-INV-5 AC4) |

## ADR-17 CI/CD
- **Decision:** GitHub Actions on every PR: install (frozen lockfile), lint, typecheck, unit tests, DB tests (PostgreSQL service container or apt install), `scripts/check-docs.sh`, dependency audit (fails on high/critical), secret scanning (e.g. gitleaks), and a build. Actions pinned by commit SHA; least-privilege `GITHUB_TOKEN`. Deploys run from `main` only after checks pass; production deploys need manual approval.
- **Requires the repository owner** to enable branch protection and required checks; this cannot be done from this session.

## ADR-18 Hosting — *Conditional on Q2*
- **Recommendation for the pilot:** DigitalOcean, Bangalore region (BLR1): managed PostgreSQL, App Platform (or Droplets) for the API, worker and static SPA, Spaces for object storage, Cloudflare in front. Main alternative: AWS Mumbai (ap-south-1).
- **Why:** data stays in India (lower latency; simpler data-protection story, though the DPDP Act does not generally require localisation — legal review pending), simple predictable pricing, and managed backups. AWS offers more (KMS, WAF, Multi-AZ) at a higher and less predictable cost. Details, figures and caveats are in `COST_MODEL.md`.
- **Portability:** containers + standard PostgreSQL + S3 API + no provider-specific SDKs outside adapters allow a later move to AWS without app rewrites.

## ADR-19 Email and messaging providers
- **Decision:** adapters only in Phase 3 (console + mock transports for development and tests). The transactional email provider is chosen when a sending domain exists (Q6). Messaging providers are chosen in Phase 7 per `INTEGRATIONS_STATUS.md`.

---

## Decisions this ADR changes or confirms
- D-003 (stack) → **Accepted**, detailed by ADR-01…06, 08.
- D-004 (two-layer tenant isolation) → **Accepted**, with evidence (TR-0002, TR-0003).
- D-005 (integer paise, append-only ledgers) → **Accepted**.
- D-006 (India defaults) → **Accepted**.
- New: D-018 TypeScript 6 pin · D-019 auth schema separation + Argon2id override · D-020 locking rules for numbering and allocation · D-021 no Redis in the pilot · D-022 hosting recommendation pending Q2.
