# Decision Log

Format: ID · date · status (Proposed / Accepted / Superseded) · decision · rationale · alternatives considered.
"Proposed" decisions are working assumptions; they become "Accepted" in the Phase 2 architecture decision record.

---

### D-001 · 2026-10-27 · Accepted
**Decision:** Treat the project as greenfield and keep the master prompt file unchanged at the repository root.
**Rationale:** Phase 0 inspection found no code, manifests, migrations, tests or CI — only the prompt file.
**Alternatives:** None applicable.

### D-002 · 2026-10-27 · Accepted
**Decision:** Project memory lives in `/docs/*.md` committed to git, plus a root `CLAUDE.md` that instructs every new session to read it first.
**Rationale:** Required by prompt §13; the cloud session container is ephemeral, so only committed files survive.
**Alternatives:** AI-platform personal memory (rejected — not durable or reviewable).

### D-003 · 2026-10-27 · Accepted (confirmed in Phase 2 — see `ARCHITECTURE_DECISION_RECORD.md`)
**Decision:** Modular monolith in TypeScript: React + TypeScript + Tailwind frontend, TypeScript API backend, PostgreSQL database, background job queue.
**Rationale:** Recommended by the prompt; one deployable unit is simpler and cheaper for a pilot; module boundaries keep later extraction possible.
**Alternatives:** Microservices (rejected for now — premature); non-TS backend (rejected — one language across stack reduces cost).
**Resolved in Phase 2:** Fastify 5 + Zod 4 API; React 19 + Vite 8 SPA; Kysely + node-postgres; SQL migrations via Kysely Migrator; graphile-worker; pnpm workspaces (ADR-01…08).

### D-004 · 2026-10-27 · Accepted (confirmed in Phase 2 — see `ARCHITECTURE_DECISION_RECORD.md`)
**Decision:** Enforce tenant isolation in two layers — service-layer scoping and PostgreSQL Row-Level Security keyed on `business_id` via a per-transaction setting.
**Rationale:** Prompt requires DB-level enforcement where supported; PostgreSQL 16 supports RLS and was verified runnable in this environment.
**Alternatives:** Schema-per-tenant / database-per-tenant (higher operational cost, harder migrations for many small shops; may revisit for large tenants).

### D-005 · 2026-10-27 · Accepted (confirmed in Phase 2 — see `ARCHITECTURE_DECISION_RECORD.md`)
**Decision:** Money stored as integer paise (or `NUMERIC`), never floating point; ledgers append-only with reversal entries.
**Rationale:** Financial accuracy and auditability requirements (prompt §2, §4, §5).
**Alternatives:** Float (rejected — rounding errors).

### D-006 · 2026-10-27 · Accepted (confirmed in Phase 2 — see `ARCHITECTURE_DECISION_RECORD.md`)
**Decision:** Defaults: INR, `Asia/Kolkata`, financial year April–March, all configurable per business.
**Rationale:** Pilot is an Indian mobile shop; prompt references GST and DLT.
**Alternatives:** None — values remain configurable.

### D-007 · 2026-10-27 · Accepted
**Decision:** Local development and tests use native PostgreSQL 16 binaries, not Docker, in this environment.
**Rationale:** Docker daemon is unavailable in the cloud session; PostgreSQL 16 server binaries are present and were verified to run.
**Alternatives:** Docker Compose (still the documented option for developer machines; CI may use service containers).

---
## Phase 1 decisions (2026-10-27)

### D-008 · 2026-10-27 · Accepted
**Decision:** IMEI uniqueness is enforced **per tenant**: within one business, an IMEI (whether stored as IMEI 1 or IMEI 2) can belong to only one serialized-unit record. The same IMEI may exist in different businesses. A unit that is sold and later bought back (trade-in/return) keeps its single record; its history is in the stock ledger.
**Rationale:** The same physical handset can legitimately pass through two shops (resale, trade-in). A platform-wide uniqueness check would reveal to one tenant that another tenant holds the device — a cross-tenant information leak (threat T1).
**Alternatives:** Global uniqueness (rejected — leaks data, blocks legitimate resale); a platform-only duplicate report for fraud review (deferred; would need privacy/legal review).

### D-009 · 2026-10-27 · Accepted
**Decision:** `SUSPENDED` business: Shop Owner can sign in with read-only access and data export; staff cannot sign in; no new transactions, messages, campaigns or agent actions. `REJECTED`: no business-data access (none exists). `CHANGES_REQUESTED`/`PENDING_APPROVAL`: applicant can view/edit only their application.
**Rationale:** Suspension must stop operations but must not hold the shop's own records (invoices needed for tax filing) hostage.
**Alternatives:** Full lock-out (rejected — tax/legal record access concern).

### D-010 · 2026-10-27 · Accepted
**Decision:** Subscription status is a separate dimension: `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELLED` (runs to period end), `EXPIRED`. `PAST_DUE` keeps full access for a configurable grace period (default 7 days); after that, and in `EXPIRED`, the tenant is **read-only + export** (same restrictions as suspension, but without changing business status). Effective access = most restrictive of business status and subscription status.
**Rationale:** Prompt requires separating account status from payment status.
**Alternatives:** Auto-suspending on non-payment (rejected — conflates the two states).

### D-011 · 2026-10-27 · Accepted
**Decision:** MFA (TOTP minimum; WebAuthn/passkeys preferred where available) is **mandatory** for Platform Admins and Shop Owners. Owners enrol during the setup wizard; a business cannot become `ACTIVE` until the owner has MFA. Staff MFA is optional; an owner can require it for all staff.
**Rationale:** Owners can manage users, integrations (credential access), refunds and tax settings — privileged per prompt §11.
**Alternatives:** Optional owner MFA (rejected — owner accounts are high-value targets).

### D-012 · 2026-10-27 · Accepted
**Decision:** Invoice numbers are **gapless and consecutive** per business, per series and per financial year, allocated inside the posting transaction under a row lock. Format is configurable (prefix + FY token + sequence), limited to 16 characters using letters, digits, `-` and `/`. Cancelled invoices keep their number and remain visible.
**Rationale:** Indian GST invoice rules (as commonly understood: unique, consecutive, ≤16 chars per financial year) — **must be confirmed by a tax professional** (Q5).
**Alternatives:** Database sequences (rejected — sequences leave gaps on rollback).

### D-013 · 2026-10-27 · Accepted
**Decision:** Tax computation rules (deterministic, integer paise):
- Each product/variant is flagged tax-inclusive (default for retail MRP pricing) or tax-exclusive.
- Line taxable value is computed after line discount. For inclusive prices: `taxable = round_half_up(gross × 100 / (100 + rate))`, `tax = gross − taxable`.
- Intra-state supply: tax split into CGST and SGST halves; if the half is an odd paisa, CGST takes `floor(tax/2)` and SGST the remainder. Inter-state: IGST = full tax. Place of supply defaults to the shop's state for over-the-counter sales and is editable when a customer GSTIN/state is entered.
- Optional invoice-level round-off to the nearest rupee, shown as a separate "Round off" line.
- Rates are data (versioned with effective dates), never constants in code.
**Rationale:** Deterministic, testable, and consistent with how retail GST invoices are typically presented — **subject to tax-professional review**.
**Alternatives:** Floating-point or per-invoice-only tax calculation (rejected).

### D-014 · 2026-10-27 · Accepted
**Decision:** Payment allocation: a payment is allocated to the invoices the user selects; if none are selected, it is allocated **oldest-outstanding-invoice first (FIFO by invoice date, then invoice number)**. Any unallocated remainder becomes a customer advance (credit balance). Walk-in fully-paid sales may have no customer; any sale leaving a balance due requires a customer record with a mobile number.
**Rationale:** Deterministic and explainable to shop owners; prompt §5 requires deterministic, tested allocation.
**Alternatives:** Proportional allocation (rejected — confusing for small shops).

### D-015 · 2026-10-27 · Accepted
**Decision:** Platform Admin database access uses a **separate database role** that has grants only on platform tables (businesses, applications, plans, subscriptions, platform audit). It has no grants on tenant business tables (products, invoices, customers…). Tenant requests use an application role subject to RLS keyed on `app.business_id`.
**Rationale:** Enforces threat T8 (admin over-access) at the database level, not just in code.
**Alternatives:** One role with an "is admin" session flag (rejected — a single bug or injected setting would expose all tenant data).

### D-016 · 2026-10-27 · Accepted
**Decision:** Cancelling an issued invoice is allowed only with permission `invoices.cancel`, a reason, and within a configurable window (default: same calendar day in the business timezone). Outside the window, corrections use a credit note. Both create reversal stock movements and ledger entries; nothing is deleted.
**Rationale:** Auditable corrections (prompt §4) while staying configurable for compliance review.
**Alternatives:** Free editing of issued invoices (rejected).

### D-017 · 2026-10-27 · Accepted
**Decision:** Cost of goods sold and stock valuation: serialized units use their **actual purchase cost**; non-serialized items use **moving weighted average cost**, recomputed on each purchase posting and snapshotted on each sale movement.
**Rationale:** Phones are individually costed and often bought at different prices; accessories are fungible. Snapshotting makes historical margins reproducible.
**Alternatives:** FIFO layers for non-serialized items (more complex; may revisit if accountant requires).

---
## Phase 2 decisions (2026-10-27)

### D-018 · 2026-10-27 · Accepted
**Decision:** Pin TypeScript 6.0.x; do not adopt TypeScript 7.0 yet.
**Rationale:** `typescript-eslint@8.72.1` (latest) declares peer `typescript >=4.8.4 <6.1.0` (checked on npm, 2026-10-27); TS 7 would leave linting unsupported.
**Alternatives:** TS 7 without type-aware linting (rejected — loses checks such as floating-promise detection). Revisit when typescript-eslint supports TS 7.

### D-019 · 2026-10-27 · Accepted (conditional on Q3)
**Decision:** Self-hosted Better Auth 1.7 behind `modules/auth`; its tables live in schema `auth`, reachable only via role `lbgos_auth`; password hashing overridden to Argon2id (`@node-rs/argon2`); telemetry explicitly disabled; tenancy/RBAC stay in our own tables (organization plugin not used).
**Rationale:** data stays in our DB and region, no per-user fees, supports TOTP and passkeys; credential tables are unreachable from the tenant request role. Better Auth defaults to scrypt (seen in its published source), so the override is required for NFR-13.
**Alternatives:** managed identity (Clerk/Auth0/Cognito/Supabase Auth) — still possible if the user prefers (Q3); Auth.js (weaker built-in MFA support); hand-built auth (more risk).

### D-020 · 2026-10-27 · Accepted
**Decision:** Locking rules: invoice numbers are allocated by `UPDATE invoice_series … RETURNING` inside the issuing transaction; payment allocation locks the invoice row `FOR UPDATE` and the payment with `pg_advisory_xact_lock` (keyed on payment ID).
**Rationale:** spike TR-0003 showed that (a) the update-lock pattern is gapless under concurrency with rollbacks, (b) the bounds trigger alone allows over-allocation by two concurrent transactions, and (c) `FOR UPDATE` requires UPDATE privilege, which append-only `payments` must not have.
**Alternatives:** SERIALIZABLE isolation with retries (heavier, more retry logic); granting UPDATE on payments (rejected — weakens append-only).

### D-021 · 2026-10-27 · Accepted
**Decision:** No Redis/Valkey in the pilot. PostgreSQL serves as database, job queue (graphile-worker) and rate-limit store.
**Rationale:** one stateful service to secure, back up and pay for (COST_MODEL §5).
**Alternatives:** Redis for queue and rate limits (revisit if load requires).

### D-022 · 2026-10-27 · Proposed (needs Q2)
**Decision:** Host the pilot on DigitalOcean BLR1 (managed PostgreSQL, App Platform, Spaces) behind Cloudflare.
**Rationale:** India region, lowest operational complexity, indicative cost ≈ US$45–90/month (third-party pricing, unverified — `COST_MODEL.md`); portable design.
**Alternatives:** AWS Mumbai (more capable incl. KMS/WAF; higher cost and complexity); serverless Postgres + separate container host.

---
## Phase 3 decisions (2026-10-27)

### D-023 · 2026-10-27 · Accepted
**Decision:** Server-side TypeScript (API, worker, packages) runs directly on Node's built-in type stripping, with no build step. `tsc` is used only for typechecking (`noEmit`). Code is restricted to erasable syntax (`erasableSyntaxOnly`, `verbatimModuleSyntax`; no enums, namespaces or parameter properties), and relative imports use explicit `.ts` extensions. Workspace packages export `./src/index.ts`. The web app is still built by Vite.
**Rationale:** verified on Node 22.22 (`process.features.typescript === 'strip'`), including for imports through pnpm-symlinked workspace packages. Removes a build step and source-map mismatch.
**Alternatives:** tsc/tsup/esbuild build to `dist/` (kept as a fallback if a dependency needs non-erasable syntax).

### D-024 · 2026-10-27 · Accepted
**Decision:** Phase 3 proceeds on the default auth choice (D-019, self-hosted Better Auth) without waiting for Q3, isolated in `modules/auth`.
**Rationale:** the prompt says to make a documented choice and continue unless a decision is genuinely blocking; the wrapper keeps a later switch local to one module.

### D-025 · 2026-10-27 · Accepted (deviation from FR-AUTH-3 AC5)
**Decision:** MFA backup codes are stored **encrypted** (with the server secret), not hashed. TOTP secrets are also encrypted.
**Rationale:** Better Auth 1.7.14's two-factor plugin supports only `plain`, `encrypted` or custom encrypt/decrypt for backup codes (checked in its published type definitions); hashing is not offered. Encrypted at rest is the strongest supported option. A test confirms neither the TOTP secret nor any backup code appears in plain text in the database.
**Residual risk:** whoever holds both the database and `SESSION_SECRET` can decrypt them. Revisit if the plugin adds hashing, or replace the codes with a custom implementation.

### D-026 · 2026-10-27 · Accepted
**Decision:** Account lockout: 5 failed sign-ins for one email within 15 minutes block further attempts for that email until the window passes. Recorded per SHA-256 of the normalised email, whether or not the account exists, with an identical 429 response. Per-IP limits come from Better Auth's database-backed rate limiter (10/min sign-in, 10/hour sign-up, 5/hour reset requests, 10/min two-factor). The API strips all client-supplied forwarding headers and passes only Fastify's proxy-aware IP to Better Auth.
**Deviation:** FR-AUTH-4 AC1 says "progressively delayed"; this is a fixed 15-minute window, not a growing delay.

### D-027 · 2026-10-27 · Accepted
**Decision:** The API removes the session token from Better Auth's JSON response bodies (sign-in/sign-up); the browser gets it only in the HttpOnly cookie.
**Rationale:** a script-readable token would defeat HttpOnly if an XSS bug ever existed.

### D-028 · 2026-10-27 · Accepted
**Decision:** Better Auth's tables are created only by reviewed migrations (`0003`), generated with `packages/modules/scripts/generate-auth-schema.ts`. A drift check (`scripts/check-auth-schema.sh`, part of `pnpm test:db`) fails if the configured Better Auth version or plugins need schema changes that no migration provides.

### D-029 · 2026-10-27 · Accepted
**Decision (RBAC and lifecycle details, increment 3.6):**
- Effective permissions are read fresh on every request (no cache, satisfying R5's ≤60 s).
- When several roles grant the same permission, the most permissive limits win (unlimited beats any limit; otherwise the highest value).
- Business-scoped routes are identified by their permission key and must carry `:businessId`. Platform permissions are allowed only under `/api/platform/`. Unknown keys fail at route registration.
- Non-members of a business get **404**, not 403, so business IDs cannot be probed.
- Access modes come from business + subscription status (`@lbgos/domain`):
  - NONE (suspended staff);
  - **CLOSED** (rejected; the applicant can read the application and reason, BR-T3 AC2);
  - APPLICATION (pending; implicit `application.view`/`application.edit`);
  - SETUP (no selling/payments/refunds/outgoing marketing);
  - FULL;
  - READ_ONLY (views, exports, paying the subscription).
- A PAST_DUE grace period is counted from `current_period_end` (no separate past-due timestamp yet).
- Changing a member's roles **revokes all their sessions** (they sign in again with a new session: FR-AUTH-1 AC2 "rotation on privilege change").
- Members cannot change their own roles or deactivate themselves.
- Owners' MFA cannot be reset and their sessions cannot be revoked by staff (FR-AUTH-5 AC2: platform process).
- Reinstatement returns a suspended business to the status it had before suspension.
- Status changes the tenant role is not granted run through narrow SECURITY DEFINER functions (migration 0005). The platform role provisions default roles via `lbg.provision_business` without any grant on tenant tables.

### D-030 · 2026-10-27 · Accepted
**Decision (onboarding details, increment 3.7a):**
- **Invitations:** 256-bit random tokens, emailed as a link; only SHA-256 hashes are stored; single use; 72 h expiry; revocable. Accepting requires being signed in with the invited email. Unusable invitations (not found, expired, used, revoked) all return the same 410, so a token reveals nothing.
- **Trials:** approval (or platform creation) starts a **14-day TRIALING subscription on the Starter plan**. The trial length is a code constant for now (`TRIAL_DAYS`), to become a platform setting.
- **Seed plans:** Starter ₹999, Growth ₹1,999, Pro ₹3,499 per month, flagged `pilot_pricing` with a "to be validated" note. Plan **limits are intentionally empty**: the user/invoice/AI/storage limits are product decisions not yet made, and are not invented here.
- **Activation:** requires a tax profile in addition to the state code and owner MFA.
- **Tax setup:** creates invoice series (sale document by registration type, plus credit and debit notes) for the current financial year in the business timezone. GSTIN format/checksum/state are validated; registration is not verified (no GST portal integration).
- **Timezones:** validated by constructing an `Intl.DateTimeFormat`, because `Intl.supportedValuesOf('timeZone')` lists `Asia/Calcutta` but not `Asia/Kolkata` (found by a failing test).
- **Re-authentication deferred:** FR-TAX-2 AC2's re-authentication for tax-setting changes is not yet enforced for the initial setup step; it is due with tax configuration in Phase 5.

### D-031 · 2026-10-27 · Accepted
**Decision (web app, increment 3.7b):**
- **Static serving:** the API serves the built SPA through its own small static route instead of `@fastify/static`. Paths resolve strictly inside the build directory; dot segments, dotfiles and encoded separators get 404; `/api/*` never falls back to the app shell; fingerprinted `/assets/*` are cached immutably and `index.html` is `no-cache`. A plugin route would also bypass our mandatory `public` declaration.
- **CSP:** stays `script-src 'self'` and `style-src 'self'`, plus **the exact SHA-256 hash of the one stylesheet React Aria Components 1.22 injects** (`touch-action` for pressable elements). No `'unsafe-inline'`. The browser test fails on any CSP violation, so a library change that alters the injected CSS is caught.
- **Browser tests:** run Playwright as a library inside Vitest DB tests, reusing the in-process API harness (captured emails, throwaway DB) instead of a separate test runner. `playwright` is pinned to 1.63.0 to match the browsers preinstalled in the dev container; CI installs the matching Chromium.
- **Accessibility gate:** axe-core with WCAG 2.0/2.1/2.2 A/AA tags; any *serious* or *critical* violation fails. Every screen in the exit flow is audited at 1280, 768 and 360 px, with a horizontal-overflow check.
- **Scope of browser support verified so far:** Chromium only. Firefox/WebKit and real devices are not yet tested (NFR-16).

---
## Phase 4 decisions (2026-10-27)

### D-032 · 2026-10-27 · Accepted
**Decision (catalogue and tax rates, increment 4.1):**
- **Tax-rate versions** share a name (case-insensitive). Periods of one name must not overlap (trigger with an advisory lock, error LB012). A version is immutable except for setting `effective_to` (column grant + trigger, LB013); a rate change is a new version. Variants reference a version; `lbg.effective_tax_rate(rate, date)` resolves the version of that name in force on a date. Names therefore cannot be renamed.
- **No rates are seeded**, not even common GST rates: rates must be entered by the business and verified by a tax professional (FR-TAX-2 AC3, Q5).
- **Deleting vs archiving:** delete is allowed only for records nothing refers to; the database's foreign keys (movements, units, purchase/invoice lines) decide, and the API answers 409 `IN_USE` with "archive instead".
- **Serialized flag** cannot change once any variant has stock movements (trigger, LB014); serialized variants must use the unit `pcs`.
- **Cost visibility:** `purchasePricePaise`/`avgCostPaise` are removed from catalogue responses without `catalogue.cost.view`, and writing a purchase price without it is refused (403). The Inventory role therefore manages the catalogue without seeing costs; it still enters unit costs on purchases (`purchases.create`), where the cost is part of the document.
- **Money arithmetic:** paise as integers, rates as basis points, quantities as thousandths; BigInt intermediates; half-up rounding (`@lbgos/domain` money.ts).

### D-033 · 2026-10-27 · Accepted (tax treatment requires professional verification)
**Decision (purchases and stock, increment 4.2):**
- **Inventory cost and GST:** for a REGULAR GST registrant, inventory cost is the tax-exclusive (taxable) value, since input tax is creditable; for COMPOSITION and UNREGISTERED businesses the tax is part of cost. Serialized units get the line cost split exactly across units (floor, remainder to the last); non-serialized stock uses moving weighted average (D-017).
- **Purchase tax:** per line, `round_half_up(taxable × rate)`, CGST/SGST split per D-013; IGST when the supplier's state differs from the business state (unknown supplier state → intra-state). The rate is the version in force on the supplier invoice date.
- **Stock buckets:** stock movements carry a bucket (AVAILABLE, INSPECTION, DAMAGED, REPAIR). Only AVAILABLE is sellable; RECLASSIFY pairs move stock between buckets. This lets returned goods be counted without being sellable (FR-INV-6).
- **Stock levels:** a projection per variant and bucket, written only by a SECURITY DEFINER trigger on `stock_movements` (the app role can read it, not write it). The trigger's upsert row-locks the level, so concurrent decrements serialise; it refuses negative stock unless the business allows it, and never for serialized units or non-AVAILABLE buckets (LB015).
- **Reversal:** allowed only while every unit is IN_STOCK and non-serialized stock suffices. Units become REVERSED and their IMEIs are released (a restrictive RLS delete policy allows deleting IMEIs of REVERSED units only), because reversal means the goods never entered stock as recorded. The weighted average cost is not recomputed on reversal.
- **Duplicate supplier invoices** are checked case-insensitively among POSTED purchases of the same supplier; an override needs a reason of ≥ 10 characters and is stored and audited. The partial unique index remains the race-proof backstop.

### D-034 · 2026-10-27 · Accepted
**Decision (adjustments and approvals, increment 4.3):**
- **Adjustment kinds:** QUANTITY (signed, non-serialized, AVAILABLE), DAMAGE (non-serialized write-off as damaged), UNIT_WRITE_OFF (IN_STOCK/DAMAGED unit → WRITTEN_OFF) and CORRECTION (REVERSAL of an adjustment-type movement without a unit). Purchase movements are corrected by reversing the purchase; unit status corrections are not offered yet.
- **Who:** holders of `inventory.adjust.approve` execute directly (audited). Holders of only `inventory.adjust.request` create an approval request.
- **Approvals module (generic):** stores the action payload as canonical JSON with its SHA-256; the decider must send the hash they reviewed. The owning module supplies an executor per action type; execution runs in the approving transaction inside a savepoint, so a failing execution is recorded as EXECUTION_FAILED with an error code while the decision is kept. Requests expire after 72 h (lazily marked EXPIRED on read/decision). The request row is immutable apart from its state machine (trigger, LB017).
- **R3:** a requester cannot approve their own request while any other active member holds the required permission; a sole holder may, and the audit event says so.
- **Cancel route** uses `inventory.adjust.request` because adjustments are the only approval action so far; it will move to a general permission when other action types arrive.

### D-035 · 2026-10-27 · Accepted
**Decision (inspection and stock reports, increment 4.4):**
- **Inspection outcomes** move stock between buckets with RECLASSIFY pairs: RESTOCK → AVAILABLE, DAMAGED → DAMAGED, REPAIR → REPAIR, REPAIRED (back from repair) → INSPECTION; RETURN_TO_SUPPLIER is a PURCHASE_RETURN out of stock. Each outcome is an append-only `inspections` row referenced by its movements. A supplier credit for goods returned is **not** recorded yet (supplier returns as documents come later).
- **Sales for reports** = SALE movements net of SALE_RETURN. Ages are counted from the last sale, or from the first receipt (PURCHASE/OPENING/positive ADJUSTMENT) if never sold.
- **Reorder suggestion:** lead-time demand is computed as sold × lead ÷ window with one half-up rounding (not by rounding the daily average first); "on order" is 0 until purchase orders exist, and the report says so. Defaults: 30-day window, 7-day lead time, overridable per request.
- **Lookup order:** exact barcode, then SKU (case-insensitive), then IMEI (only for callers with `inventory.view`).

### D-036 · 2026-10-27 · Accepted (revisits ADR-08 for now)
**Decision (uploads and OCR, increment 4.5):**
- **Job runner:** OCR jobs are queued in `lbg.ocr_jobs` itself and claimed with `FOR UPDATE SKIP LOCKED` through one narrow SECURITY DEFINER function, processed one at a time by the API process (`server.ts`), with stale-job recovery and at most 3 retries. **graphile-worker (ADR-08) is deferred** until there are several job types (scheduled reports, campaigns, agents): the job row is needed anyway as the user-visible status, and one job type does not justify another schema and process yet. ADR-08's rules are kept: the job carries business and requester, and the requester's `ocr.scan` permission and business mode are re-checked when the job runs.
- **Isolation:** each job's file checks, OCR adapter and parsing run in a `worker_threads` Worker with a heap limit (`OCR_MAX_MEMORY_MB`, default 256) and a wall-clock timeout (`OCR_TIMEOUT_MS`, default 30 s). This bounds memory and time; it is **not** an OS sandbox. A separate container with no egress is the target before real parsers/decoders are added (Phase 9 review).
- **Uploads:** raw `application/octet-stream` bodies on one route with its own size limit (no multipart dependency); type by magic bytes only; dimensions and page counts read from headers without decoding; HEIC refused with guidance because no converter is configured.
- **Storage:** `StorageAdapter` with a private local directory (`UPLOAD_DIR`, default `.data/uploads`, git-ignored) and an in-memory store for tests; S3-compatible storage with short-lived signed URLs when hosting is chosen (Q2). Downloads go through an authenticated route: images inline, PDFs as attachments, always with a sandbox CSP and `nosniff`.
- **OCR adapter:** only a **mock** adapter exists (fixture text from PNG tEXt chunks or simple PDF strings). It is labelled as not being OCR everywhere it appears. A real engine needs a provider decision (Q4).
- **Parsing and review:** deterministic parsers produce fields with confidence level and source line; values not in the text stay empty. Every field below high confidence, heuristic guesses (supplier name) and fields with problems must be confirmed: the server refuses "Create" until all of them are listed as confirmed. "Create" makes a DRAFT purchase in the same transaction that completes the job; posting stays separate.
- **Structuring hook (for a future model):** output must pass a strict schema, may only fill fields the parser left empty, and only with values that appear verbatim in the OCR text; anything else is discarded and the job is marked for manual entry. OCR text is passed only as data and is not stored.

### D-037 · 2026-10-27 · Accepted
**Decision (web screens, increment 4.6):**
- **`member` pseudo-permission:** routes any active member may call (so far only the business overview) declare `permission: 'member'`. Like business permissions it requires `:businessId`, answers 404 to non-members and is unavailable until the business is set up (APPLICATION/CLOSED modes keep their existing behaviour). It exists because staff roles without `business.settings.view` could not open their own business.
- **Permission-aware screens:** the overview returns the member's usable permissions (role grants filtered by the business mode), and the web app shows only the screens and forms they can use. This is a convenience; every route still enforces its own permission.
- **Wide tables** scroll inside a focusable, labelled region on small screens; selects and fieldsets are constrained to the page width.
- **Scanner input:** scanner fields are ordinary text inputs submitted with Enter (USB/Bluetooth scanners type like keyboards). Camera scanning uses the browser's `BarcodeDetector` when it exists and is hidden otherwise; no third-party barcode library is added.

---
## Phase 5 decisions (2026-10-27)

### D-038 · 2026-10-27 · Accepted (tax rules need professional verification)
**Decision (engines, increment 5.1):**
- **Invoice discount apportioning:** in proportion to each line's value *after its own line discount*; shares are floored and the leftover paise go to the last lines with room. A line never receives more discount than its value.
- **Inclusive prices with cess:** taxable = round_half_up(net × 10000 / (10000 + GST bp + cess bp)); the tax is the rest of the net amount; GST = round_half_up(taxable × rate), capped at that tax, and cess takes the remainder. (D-013 did not cover cess; this is an assumption for review.)
- **Round-off:** to the nearest rupee, half up (+50 paise rounds up), shown separately; range −49…+50 paise.
- **Rate 0** covers nil-rated, exempt and zero-rated lines alike in the engine; their labelling on documents is a template matter for review.
- **Number formats:** `{PREFIX}`, `{FY}` ("26-27"), `{FYLONG}` ("2026-27"), `{SEQ:n}` (n = 1–8). Default `{PREFIX}{FY}/{SEQ:4}`, e.g. `EX26-27/0042`. A format is refused when its longest possible rendering exceeds 16 characters; a sequence that outgrows its digits stops with SERIES_EXHAUSTED instead of producing a longer number.
- **Coverage gate:** the domain package's test script enforces ≥ 95 % branch/line/function/statement coverage on the money modules (FR-TAX-1 AC5).

### D-039 · 2026-10-27 · Accepted
**Decision (customers, numbering, re-authentication, increment 5.2):**
- **Re-authentication** = a session created by a sign-in less than **10 minutes** ago (`freshAuth` route option; FR-TAX-2 AC2). Applied to tax rates, the tax profile and number settings. Otherwise 403 `REAUTH_REQUIRED`, and the user signs in again (password + TOTP for owners).
- **Numbering settings** (prefix, format) live in `business_settings`. A series takes them when it is created (first document of a type in a financial year). Saving new settings also updates series that have not issued a number; a series that has issued numbers keeps its format until the next financial year, so numbers within a series never change style.
- **Customers:** mobile numbers are normalised to E.164 (Indian 10-digit, 0-, 91- and +91-prefixed forms; other countries with +) and unique per business; a duplicate returns the existing customer's ID so checkout can reuse it. A GSTIN's first two digits set the customer's state.
- **Cancellation window and round-off** settings are stored now (`cancel_window_days` default 0 = same business day, `round_off` default on) for use from 5.3/5.5.

### D-040 · 2026-10-27 · Accepted
**Decision (selling and issuing, increment 5.3):**
- **A draft invoice is the cart.** It stores what the cashier entered (items, units, quantities, prices, discounts, customer). Tax rate in force, place of supply, document type and all amounts are derived from current facts on every save and again inside the issuing transaction, so the issued document reflects the facts at issue time. Held carts do not reserve stock.
- **Issuing is one transaction:** lock the draft; lock the customer (serialises use of their advance) and the units in ID order; re-price; refuse on any problem; check the total the cashier confirmed (`TOTAL_CHANGED` otherwise); write line snapshots with COGS; SALE movements in variant order (avoids deadlocks); units SOLD; take the number last (the series lock is held briefly); party snapshot; payments as entered; allocations (advance first, then new payments); ledger INVOICE and PAYMENT entries for a known customer; audit.
- **Document type** follows the tax profile: REGULAR → TAX_INVOICE; composition/unregistered → BILL_OF_SUPPLY with no tax (FR-TAX-1 AC4). Composition-specific wording is part of printing (5.6).
- **Discount limits** apply to the invoice's total discount (line + invoice discounts) against its value before discounts; both the percentage and the amount cap must hold. Over the limit, the cashier raises an approval request (`sales.discount`, required permission `pos.discount`); the approver's **own** limit must cover it. Approval binds to a SHA-256 of the cart content: any change clears it. The in-person "approver re-authenticates at the counter" variant (WORKFLOWS §5 step 2) is **not offered yet**; the approver uses the approvals screen on their own session.
- **Minimum price** compares the line value after all discounts (including its share of the invoice discount) with min price × quantity; below it needs `pos.price_override`.
- **Payments:** methods cash, UPI, card, bank transfer, other (fixed list; FR-POS-3 AC1 "configurable list" is deferred). A balance due or an overpayment needs a customer with a mobile (D-014); an overpayment becomes advance. Using advance cannot be combined with overpaying. References that look like card numbers are refused in the API and the DB.
- **Invoices** are visible to holders of `customers.view`; line costs only with `catalogue.cost.view`. Any member may withdraw their own approval request (`member` + not read-only).

### D-041 · 2026-10-27 · Accepted
**Decision (payments, refunds, reversals, increment 5.4):**
- **Every money movement of a customer locks the customer row first** (checkout, later payment, applying advance, refund, reversal), then invoice rows and payment advisory locks (D-020). The allocation bounds trigger now counts refunds too and stays the backstop.
- **Later payments** belong to a customer (walk-ins pay at the counter only); they are allocated to the chosen invoices in the given order, else oldest first; the rest is advance (D-014). Applying advance is an explicit action as well as part of checkout.
- **Refunds** pay out advance only, oldest payment first, as `payment_refunds` rows (method, reference, reason ≥ 10 characters) with REFUND ledger entries. They need `refunds.approve` (Manager, Owner). Refunds of invoiced amounts go through credit notes (5.5).
- **Reversal** of a wrongly recorded payment also needs `refunds.approve` and a reason: a reversal payment row, negative allocations and a REVERSAL ledger entry; a payment with refunds, an already reversed payment or a reversal cannot be reversed.
- **Statements** use business dates: a day runs from local midnight in the business's timezone.
- Payment status of invoices (UNPAID / PARTIALLY_PAID / PAID) is derived, never stored; credit notes will count from 5.5.

### D-042 · 2026-10-27 · Accepted
**Decision (cancellation, credit and debit notes, increment 5.5):**
- **Cancellation** (D-016) needs `invoices.cancel`, a reason, the business date ≤ invoice date + `cancel_window_days`, and no credit/debit notes on the invoice. The person states whether the goods never left (REVERSAL movements, units back IN_STOCK) or came back (SALE_RETURN into INSPECTION, units PENDING_INSPECTION). The INVOICE ledger entry is reversed; all payment allocations are released.
- **Settlement** of released money: customer advance, or a refund (`refunds.approve`, refund rows linked to the cancelled invoice or credit note). A walk-in sale has nobody to hold advance, so it must be refunded.
- **Credit notes** need `credit_notes.create`; lines and quantities of the original invoice; amounts are the original line snapshot × returned quantity / sold quantity (half up), and the return that completes a line takes exactly what is left, so notes never exceed the original. The note that completes the whole invoice also takes the rest of its round-off. Returned goods always go into INSPECTION (FR-INV-6). Paid money beyond what is still due is released (latest allocations first; an allocation is reversed whole and any remainder re-allocated, since an allocation can be reversed only once).
- **Debit notes** need `credit_notes.create` and a customer: extra taxable value per original line at that line's rate (exclusive), place of supply of the invoice; they are payable documents like invoices.
- Credit and debit notes use their own series with the shop's prefix and format, so a note can have the same visible number as an invoice; the printed title tells them apart. Per-document-type prefixes are a later option. Billing's `sales.return.create` (accepting a return for a manager to credit) is not used yet.

### D-043 · 2026-10-27 · Accepted
**Decision (portal look and layout, requested by the user):** a small design system in `apps/web/src/styles.css` (Tailwind theme tokens: ink neutrals, indigo brand, system font stack — no web-font download, so the CSP stays `self`-only), shared components in `ui.tsx` (page header with eyebrow/description/actions, cards for top-level sections, badges for statuses, refined inputs, buttons, alerts and tables) and an app shell (`shell.tsx`): sticky top bar with the product mark, and inside a business a side menu (a horizontal scrollable menu below 1024 px). The side menu is the only navigation to screens; the overview shows task cards with different wording, so every link name stays unique for screen readers and tests. Visible text labels such as "Status:" stay, because the status must not depend on colour alone.

### D-044 · 2026-10-27 · Accepted
**Decision (print and PDF, increment 5.6):**
- Shop address, phone, email and invoice terms are business settings (migration 0016, `business.settings.manage`) and are **copied into the party snapshot when a document is issued**; prints use only the issued document and its snapshot, so a reprint matches the original. Documents issued before 0016 print without these details.
- One template function per layout (wide: A4/A5; narrow: 80/58 mm roll), all values escaped, no scripts; served with its own CSP (`default-src 'none'; style-src 'unsafe-inline'`). The on-screen toolbar (paper choice, PDF link) is hidden when printing; printing uses the browser's print dialog.
- PDFs: headless Chromium (Playwright, now a runtime dependency of the API) renders the same HTML with JavaScript disabled, offline and all requests aborted; at most 2 renders at once, 20 queued (else 503 `PDF_BUSY`), 15 s timeout. Roll paper becomes one page as long as the receipt. Rendering runs in the API process for the pilot; moving it to the heavy-job worker (ADR-08) is a later step.
- Composition dealers' bills say "Composition taxable person, not eligible to collect tax on supplies"; nothing mentions e-invoicing, IRN/QR or digital signatures (FR-TAX-4). The wording of printed documents still needs the tax professional's review (Q5).

### D-045 · 2026-10-28 · Accepted
**Decision (reports and exports, increment 5.7):**
- Sales figures come from issued documents by their **business date**: gross sales = totals of invoices and debit notes; returns = credit notes issued in the period; net, taxable value and tax are net of credit notes. **Cancelled invoices count nowhere** (D-016: a cancellation undoes the sale). Cash received uses payment and refund times converted to business dates; reversals and refunds are shown separately from receipts.
- COGS = cost snapshots of sold lines minus the cost of credited lines (returned goods), lines without a recorded cost count 0 and are reported. Gross margin = taxable value − COGS. Receivables ageing is as of today (by document date); historical "as of" dates are not offered yet. Stock valuation splits sellable (available) from other (inspection, damaged, repair) stock.
- Permissions: sales, payments, returns and tax summaries need `reports.sales.view`; margin, receivables and stock valuation need `reports.financial.view`; exports need `reports.export` **and** the report's permission and are audited (report, format, period only). Exports are allowed in read-only mode (D-009).
- Formats: CSV for every report (UTF-8 with byte-order mark, rupees with 2 decimals, formula-like text prefixed with an apostrophe), XLSX written by a small built-in writer (no dependency; inline strings, no formulas), PDF from report HTML via the invoice PDF renderer.

### D-046 · 2026-10-28 · Accepted
**Decision (POS and sales screens, increment 5.8):**
- The POS cart is the server-side draft (D-040): every change is saved and priced by the server, saves run one at a time so a quick second change never creates a second draft. The screen never computes tax or totals itself.
- Search at the counter: an exact IMEI or serial number of an in-stock unit adds that unit directly; an exact SKU or barcode of a quantity item adds it; otherwise results are listed with in-stock units to pick (`GET /pos/search`, `pos.sell`).
- Payment defaults to one row for the full total; quick buttons set cash/UPI/card for the full amount; "Split payment" adds rows. A known customer is found as soon as a full mobile number is typed.
- New screens: Point of sale, Invoices (list, detail with print/PDF, credit note, cancellation, printed details), Customers (list, add, profile with balance, open invoices, record payment, refund advance, statement with exports). Side-menu entries depend on permissions. Debit notes and payment reversal have API support but no screen yet.

### D-047 · 2026-10-28 · Accepted
**Decision (customer profile, increment 6.1):**
- Optional profile fields (migration 0017): alternate mobile (E.164), tags (up to 10, at most 30 characters, no commas/semicolons, de-duplicated ignoring case), preferred contact channels (WhatsApp, SMS, email, call — a **preference, not consent**; consent is recorded separately in 6.2), date of birth (1900 up to the business's today; the "not in the future" check is in the application because a CHECK constraint must be immutable).
- The warranty is **recorded on the invoice line when the sale is saved/issued** (months and provider from the variant at that time). 0 = no warranty; null = sold before this migration (not recorded, shown as such). The warranty end date is the business sale date plus the recorded months, clamped to the month end. Changing a variant later does not change past promises.
- Owned items = serialised units and warranty-carrying lines on issued tax invoices/bills of supply, minus quantities returned on issued credit notes.
- Customer export (`customers.export`, owner by default): CSV of the fields chosen, in the order chosen, optional tag filter; erased customers are excluded; audited with field names, row count and whether a tag filter was used — no personal data in the audit. Allowed in read-only mode (D-009).
- An erased customer cannot be edited (404).

### D-048 · 2026-10-28 · Accepted
**Decision (consent, suppression and messages, increment 6.2):**
- **Consent** is append-only per customer, channel (WhatsApp, SMS, email) and purpose; the latest record is the state. Transactional messages are allowed unless withdrawn or suppressed; marketing needs a GRANTED marketing consent for that channel (FR-CON-1 AC4).
- **Suppression** is per channel and address (E.164 mobile or lower-case email), append-only SUPPRESS/RELEASE events; it blocks every purpose on that channel. Opt-out (staff action or inbound STOP via the adapter hook) suppresses at once and withdraws marketing consent. Only a holder of `marketing.approve` can record new consent on a suppressed contact, which releases it (reason RECONSENT). Erasure (6.6) will suppress with reason ERASED.
- **The gate runs at dispatch**, in the same transaction as the status change, under an advisory lock per address that opt-outs also take; messages created or approved earlier are blocked with the reason. Quiet hours (business settings, default 09:00–21:00 business time) defer marketing and reminder messages; transactional messages are not held.
- **Status machine** (WORKFLOWS §9) enforced by a trigger, with these additions: DRAFT/PENDING_APPROVAL → CANCELLED, PENDING_APPROVAL → DRAFT (sent back), QUEUED → FAILED (no provider configured: it never left), SENT → READ. SENT/DELIVERED/READ require the provider name and reference (LB020 + a check constraint); every status is written to `message_events`.
- **Permissions**: marketing — draft `marketing.draft`, approve `marketing.approve`, send `marketing.send`; transactional — `customers.manage` (may be created queued and sent at once); consent and opt-out `customers.manage`; viewing `customers.view`.
- **Provider adapter**: `MessageProvider` (name, configured, send). The default is NOT_CONFIGURED, so a dispatched message ends `FAILED` with `PROVIDER_NOT_CONFIGURED`; nothing is sent in this phase. Provider receipts (`recordProviderStatus`) will be called only from a verified webhook (NFR-18) once a provider exists; no webhook route is exposed yet. A crash between SUBMITTED and the provider answer leaves the message SUBMITTED (not retried automatically) — to handle with the job runner.

### D-049 · 2026-10-28 · Accepted
**Decision (reminders, increment 6.3):**
- Types and purposes: **birthday, warranty expiry and service due are marketing** (they promote the shop's services, so they need marketing consent at send time); **payment due is transactional**. Birthday additionally needs marketing consent on the setting's channel **when drafting** (FR-REM-1 AC1).
- Settings per type (off by default): channel, template, `days` (birthday and warranty: days ahead, default 0 and 15; service: days after the sale of a serialised unit, default 180; payment: days an open invoice has been unpaid, default 30). Viewing needs `customers.view`; changing needs `marketing.draft`; **turning auto-send on, or changing the text or channel of an auto-sending type, needs `marketing.approve`** and records that person as the standing approver.
- Templates: placeholders `{name} {shop} {model} {imei_last4} {warranty_end} {amount_due} {service_date}`, each type only those it can fill; others refused when saved. A placeholder without a recorded value skips that customer (`MISSING_FIELD`), as do a missing address (`NO_ADDRESS`) and missing birthday consent (`NO_CONSENT`); skips are returned to the caller and counted in the run summary.
- Runs are serialised per business (advisory lock) and idempotent by subject: birthday = customer + year, warranty and service = sale line, payment = invoice (one payment reminder per invoice). Service and payment catch up missed days (service: 7 days back). Each reminder is a message with origin REMINDER: drafts are reviewed and sent with the message routes; auto-send messages are moved DRAFT → PENDING_APPROVAL → APPROVED (standing approver) → QUEUED and dispatched through the send-time gate and quiet hours after the run commits.
- There is no scheduler yet: `POST /reminders/run` runs today's reminders on request; a daily job comes with the job runner.

### D-050 · 2026-10-28 · Accepted
**Decision (expenses, increment 6.4):**
- Optional module, **off by default**, switched by `business.settings.manage` (owner); audited. Recording and reversing need `expenses.manage` (owner by default) and the module on; reading needs `expenses.manage` and stays possible in read-only mode. Switching off later keeps earlier entries in reports.
- Fixed categories (rent, salaries, electricity, internet and phone, transport, repairs and maintenance, marketing, supplies, bank charges, taxes and fees, other); amount in paise; method as payments; reference never a card number; notes; optional receipt using the same file checks and private storage as scans (`storeUpload`), one expense per upload, never an OCR scan's file.
- Append-only. A correction is a **full reversal** (reason ≥ 10 characters) with the original's date, category and method and the negated amount (DB-enforced, LB021), so the corrected period nets to zero; a new entry records the right figures. One reversal per expense.
- Reports: expenses by category for a period (net of reversals) and **operating profit (estimate) = gross margin − expenses**, always labelled an estimate with its definitions and the note that unrecorded items are left out and it is not a tax computation. Both need `reports.financial.view` and export as CSV/XLSX/PDF.
