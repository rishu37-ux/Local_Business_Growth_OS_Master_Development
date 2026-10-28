# Test Report

Only tests and checks that were actually executed are recorded here. No application tests exist yet because no application code exists.

---

## TR-0001 · 2026-10-27 · Phase 0 documentation and environment checks

**Environment:** ephemeral cloud dev container, Linux x86_64, bash, Node v22.22.0, PostgreSQL 16.15 binaries.

| # | Check | Command / method | Result |
|---|---|---|---|
| 1 | Repository inspection | `git status`, `git log`, `git branch -a`, `find` | Only the prompt file present; branch identical to `main` |
| 2 | PostgreSQL usable for local tests | `initdb` + `pg_ctl start` as `postgres` user on a throwaway cluster, `select version()`, list `pgcrypto`/`citext`/`uuid-ossp`, then stop and delete | **Pass** — `PostgreSQL 16.15`, all three extensions available |
| 3 | Docker availability | `docker ps` | **Unavailable** — daemon socket missing (environment limitation, not a test failure) |
| 4 | Doc-check script syntax | `bash -n scripts/check-docs.sh` | **Pass** |
| 5 | Doc-check detects missing file | Ran script before `TEST_REPORT.md` existed | **Pass** — reported `MISSING docs/TEST_REPORT.md`, exit 1 |
| 6 | Doc-check detects planted secret | Temporary file with a fake `api_key = "..."` line, then removed | **Pass** — flagged the line, exit 1 |
| 7 | Prompt file preserved | `git diff --quiet -- Local_Business_Growth_OS_Master_Development_Prompt.txt` | **Pass** — unchanged |
| 8 | Final doc check (all files present, no secret patterns) | `./scripts/check-docs.sh` after all docs written | See result line below |

Result line for #8 is recorded after execution: **Pass — 9/9 documents present, no secret patterns, exit 0.**

**Not run:** unit, integration, security, accessibility or browser tests — no application code exists.
**Limitation:** the secret-pattern check is a simple regex screen, not a full secret scanner.

---

## TR-0002 · 2026-10-27 · Phase 1 data-model draft and documentation checks

**Environment:** ephemeral cloud dev container, Linux x86_64; PostgreSQL 16.15 throwaway cluster created by `scripts/test-schema-draft.sh` (run as the `postgres` OS user, Unix socket only, deleted on exit); Python 3.13.17. Synthetic data only.

**What this tests:** the *design-level* schema draft `docs/data-model/schema_draft.sql`. There is still **no application code**; these results show that the database-level controls in the design behave as specified. They do not show that any application feature works.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Schema draft applies cleanly | `scripts/test-schema-draft.sh` | **Pass** on the final run. The first two runs failed and exposed real defects, both fixed: (a) `citext` was not resolvable because `public` was missing from `search_path`; (b) trigger functions resolved table names through the caller's `search_path` and failed with `relation "invoices" does not exist` — fixed by pinning `search_path` on all 10 functions (also closes threat T25). |
| 2 | 67 schema checks (T01–T29, see test file) covering business status transitions, tenant isolation (RLS, forced RLS, fail-closed context, composite FKs, RLS bypass attempt), platform-role separation, IMEI Luhn/uniqueness/per-tenant scope, append-only stock movements/ledger/payments/audit (for app role and privileged roles), invoice numbering/length/charset/FY scope, total and reconciliation checks, issued-invoice immutability and cancellation, allocation bounds, card-number rejection, RLS coverage meta-check | `scripts/test-schema-draft.sh` | **Pass — 67/67 PASS lines, "ALL SCHEMA DRAFT CHECKS PASSED", exit 0** |
| 3 | Negative control: RLS disabled on `products` (injected defect) | temporary edit + `scripts/test-schema-draft.sh` | **Detected** — `FAIL T06 … statement succeeded`, exit 3; schema restored |
| 4 | Negative control: IMEI Luhn CHECK removed (injected defect) | temporary edit + `scripts/test-schema-draft.sh` | **Detected** — `FAIL T09b … statement succeeded`, exit 3; schema restored; re-run passes |
| 5 | Requirement coverage: blueprint IDs ⊆ SRS, every SRS requirement has acceptance criteria, matrix = SRS | `python3 -I scripts/check_traceability.py` | **Pass** — 100 SRS requirements, 88 blueprint IDs covered |
| 6 | Negative control: a matrix row removed / one requirement's AC removed (temporary) | same | **Detected** both (exit 1); files restored |
| 7 | Memory docs present, no secret patterns, coverage check | `scripts/check-docs.sh` | **Pass**, exit 0 (final run before commit) |

**Not run:** application unit/integration/API tests, concurrency tests (gapless numbering, allocation races), performance, accessibility, browser, print and security tests — no application exists yet.
**Known gaps in the draft** are listed in `DATA_MODEL.md` §5.

---

## TR-0003 · 2026-10-27 · Phase 2 tenant-context spike and harness refactor

**Environment:** ephemeral cloud dev container; Node v22.22.0; PostgreSQL 16.15 throwaway cluster via `scripts/with-throwaway-pg.sh` (schema draft applied; roles `lbgos_app`/`lbgos_platform` with LOGIN on a private Unix socket only); spike dependencies pinned: kysely 0.29.7, pg 8.23.1, tsx 4.23.15, typescript 6.0.3. `npm audit`: 0 vulnerabilities. Synthetic data only. **Spike code, not application code.**

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Schema draft suite after moving to the shared harness | `scripts/test-schema-draft.sh` | **Pass** — 67/67, exit 0 |
| 2 | Harness propagates failures | Temporary `t.ok(false)` appended to the test file | **Detected** — exit 3; file restored (no diff) |
| 3 | Spike typecheck | `cd spikes/tenant-context && npx tsc -p tsconfig.json` | **Pass** |
| 4 | Spike tests (12) | `cd spikes/tenant-context && npm test` | **Pass — 12/12** on the final run, and 3/3 consecutive re-runs of the full suite |
| 5 | Negative control: advisory lock removed from `allocatePayment()` | temporary edit + `npm test` | **Detected** — 11 pass / 1 fail (payment-split test); file restored; re-run passes |

What the 12 spike tests cover: tenant isolation with 200 concurrent requests on a 3-connection pool; no context left on pooled connections after commit and after rollback (20 probes); a negative control showing that a session-level `set_config` does leak (so the probe can detect leakage); rollback of all writes on failure; malformed context rejected before reaching the DB; cross-tenant write rejected (42501); platform pool denied tenant tables (42501); gapless invoice numbers under 30 concurrent issuers with 6 forced rollbacks (exactly `A/0001`–`A/0024`, counter = 25); allocation with locks rejects concurrent over-allocation (LB005); characterization test that **without** locks two transactions over-allocate (1,600 on a 1,000 invoice); helper bounds check; one payment split across two invoices concurrently, where exactly one allocation is rejected.

**Defects found during the spike:**
- The first run failed: parameterised queries cannot contain multiple statements (42601). The test seeding was split into single statements; this is also a useful safety property of the driver.
- A later run failed with `permission denied for table payments`: `SELECT … FOR UPDATE` requires UPDATE privilege, which append-only `payments` deliberately lacks. Replaced with `pg_advisory_xact_lock` (D-020).

**Not run:** any application tests (no application yet); pooler (PgBouncer) behaviour; load or performance tests.

---

## TR-0004 · 2026-10-27 · Phase 3 increment 3.1 — monorepo scaffold

**Environment:** cloud dev container; Node v22.22.0; pnpm 10.28.0; TypeScript 6.0.3; ESLint 10.13.0 + typescript-eslint 8.72.1 (strictTypeChecked); Vitest 5.0.5; fast-check 4.10.2.

| # | AC | Check | Result |
|---|---|---|---|
| 1 | AC1 | Removed all `node_modules`, then `pnpm install --frozen-lockfile` | **Pass** |
| 2 | AC2 | `pnpm check` (lint + format check + typecheck + tests) | **Pass**, exit 0 |
| 3 | AC3 | Node type stripping through a pnpm-style symlinked workspace package (scratch experiment) | **Pass** — `process.features.typescript = 'strip'`, import ran |
| 4 | AC4 | Module-boundary rule tests (ESLint RuleTester under Vitest) | **Pass** — 11/11 (6 valid, 5 invalid cases) |
| 5 | AC4 | Negative control through the real config: temporary `packages/modules` with `rbac` importing `tenancy/internal/repo.ts` and `tenancy/index.ts` | **Detected** — exactly the internal import flagged (exit 1); temporary files deleted |
| 6 | AC5 | `@lbgos/domain` IMEI tests: 4 valid + 6 invalid vectors (shared JSON file), property tests (exactly one valid check digit per 14-digit body; every single-digit substitution detected) | **Pass** — 12/12 |
| 7 | — | `pnpm audit` and `pnpm audit --prod` | **No known vulnerabilities** |

A lint finding on the first run (`no-misused-spread` on a string spread in a test) was fixed before commit. The DB/IMEI parity part of AC5 is covered in increment 3.2.

---

## TR-0005 · 2026-10-27 · Phase 3 increment 3.2 — migrations and tenant context

**Environment:** cloud dev container; Node v22.22.0; pnpm 10.28.0; PostgreSQL 16.15 throwaway cluster (`scripts/with-throwaway-pg.sh`, bootstrap from `packages/db/bootstrap/bootstrap.sql`); kysely 0.29.7, pg 8.23.1; Vitest 5.0.5. Synthetic data only.

| # | AC | Check | Result |
|---|---|---|---|
| 1 | AC1 | `node src/migrate-cli.ts` on an empty DB (as `lbgos_owner`) | **Pass** — `0001_foundation`, `0002_auth_schema` applied |
| 2 | AC1 | Re-running the migrator (Vitest) | **Pass** — no results, no error; both names recorded in `lbg_migrations.kysely_migration` |
| 3 | AC2 | `packages/db/test/schema-checks.sql` against the **migrated** DB | **Pass — 73/73** (the 67 Phase 1 checks + 6 new) |
| 4 | AC4 | New checks T30–T30f: `lbgos_app`/`lbgos_platform` have no USAGE on schema `auth`; `lbgos_auth` has USAGE on `auth` but none on `lbg`; tenant role denied a table in `auth` (42501); default privileges give `lbgos_auth` access to tables the owner creates | **Pass** |
| 5 | AC3 | Vitest DB suite: tenant isolation (200 concurrent / 3 connections), no leakage after commit/rollback + negative control, rollback, malformed context, cross-tenant write (42501), platform **and auth** pools denied tenant tables, gapless numbering (30 concurrent, 6 rollbacks), allocation locking (with/without locks), payment split | **Pass — 12/12** |
| 6 | 3.1 AC5 | IMEI parity: `@lbgos/domain` `isValidImei` vs `lbg.is_valid_imei()` on all 10 shared vectors | **Pass — 10/10** |
| 7 | — | Negative control: advisory lock removed from `packages/db/src/locking.ts` | **Detected** — 1 failed / 23 passed; file restored; re-run 24/24 |
| 8 | — | `pnpm check` (lint, format, typecheck, unit, DB) + `pnpm audit` | **Pass**, exit 0; no known vulnerabilities |
| 9 | — | Historical draft suite `scripts/test-schema-draft.sh` with the new bootstrap | **Pass** — still reproducible |

**Defects found and fixed during this increment:**
- Kysely 0.29 exports `Migrator` from `kysely/migration`, not the package root (boot failed with `does not provide an export named 'Migrator'`).
- The T30f check first failed with `permission denied for schema t`: the test-helper schema had not been granted to `lbgos_auth`. This was a harness gap, not a product defect.
- Lint flagged an unnecessary `Number()` conversion in `allocateInvoiceNumber` (int4 already arrives as a JS number).

The Phase 2 spike (`spikes/tenant-context`) was removed after its tests were ported; it remains in git history (commit `e4726a9`).

---

## TR-0006 · 2026-10-27 · Phase 3 increments 3.3 (CI) and 3.4 (API skeleton)

**Environment:** local — cloud dev container, Node v22.22.0, pnpm 10.28.0, PostgreSQL 16.15 throwaway clusters; fastify 5.12.7, @fastify/helmet 13.2.0, zod 4.6.7. CI — GitHub-hosted `ubuntu-24.04` runners (non-root), Node 22.18 and 24.

### 3.3 CI
| # | AC | Check | Result |
|---|---|---|---|
| 1 | AC1/AC2 | `.github/workflows/ci.yml`: actions pinned to commit SHAs (`actions/checkout` v7.0.1 `3d3c42e…`, `actions/setup-node` v7.1.0 `949feb2…`, both lightweight tags resolved with `git ls-remote`), `permissions: contents: read`, `persist-credentials: false` | Reviewed |
| 2 | AC3 | Run [#1](https://github.com/rishu37-ux/Local_Business_Growth_OS_Master_Development/actions/runs/40469782161) on commit `ffc1710` | **success** on both jobs (Node 22.18, Node 24); the job log shows lint, format, typecheck, 12 + 11 unit tests, migrations, **73/73 schema checks**, **24/24 DB tests**, docs checks, `pnpm audit` (no known vulnerabilities) and secretlint all running |
| 3 | — | Harness non-root path (never exercised in the root container): ran migrations + schema checks as a throwaway unprivileged user | **Pass**; the CI runner confirmed the same path |
| 4 | — | secretlint negative control: planted Slack token, AWS example key, truncated fake RSA key | Slack token **detected** (exit 1). AWS's published example key and the truncated fake key were **not** flagged — a known limit of the preset; `scripts/check-docs.sh` separately screens docs for private-key headers |

### 3.4 API skeleton
| # | AC | Check | Result |
|---|---|---|---|
| 5 | AC1 | Config tests: defaults; invalid PORT/LOG_LEVEL/DB URL rejected by name; production requires 3 DB URLs + session secret; error text never contains planted secret values | **Pass** (4 tests) |
| 6 | AC2 | Headers on 200 and 404: CSP (`default-src 'self'`, no `unsafe-inline`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS 1 year + subdomains, nosniff, referrer policy, X-Frame-Options, `cache-control: no-store` | **Pass** |
| 7 | AC3 | `/healthz` 200; `/readyz` 503 with no internal detail when the DB check fails; `/readyz` 200 against a real migrated DB as `lbgos_app` (DB test) | **Pass** |
| 8 | AC4 | Request ID: well-formed upstream ID echoed, malformed (log-injection) ID replaced; JSON log line carries `reqId`; 5 planted secrets (password, apiKey, nested token, authorization, cookie) absent from logs while a non-secret field is present | **Pass** |
| 9 | AC5 | SQLSTATE mapping for LB001–LB005, 23505, 23503, 23514, 42501 (403 + security log) with no internal text in bodies; generic 500 that keeps details in logs only; Zod validation 400 with field paths; unknown fields rejected | **Pass** (12 tests) |
| 10 | AC6 | Registering a route without `config.permission`/`config.public` throws; a declared route registers | **Pass** |
| 11 | — | Client IP: X-Forwarded-For ignored by default; exactly 1 or 2 trusted hops honoured | **Pass** |
| 12 | — | Negative controls: (a) redaction paths emptied → redaction test fails; (b) route-declaration check disabled → AC6 test fails; both files restored | **Detected** both (1 failed / 22 passed each) |
| 13 | — | Smoke test: `node apps/api/src/server.ts` (Node type stripping) against a migrated throwaway DB; `/healthz` and `/readyz` over real HTTP; SIGTERM | **Pass** — 200 `{"status":"ready"}` with `x-request-id`; clean shutdown |
| 14 | — | `pnpm check` (all packages, unit + DB), `pnpm audit`, `pnpm secrets` | **Pass**; no known vulnerabilities |

**Issues fixed during 3.4:** Fastify's types do not accept a hop count for `trustProxy`, so it became a hop-index function (now covered by test #11). Lint fixes: an unnecessary type assertion, and test functions marked `async` without `await`.

---

## TR-0007 · 2026-10-27 · Phase 3 increment 3.5 — authentication, MFA, rate limits

**Environment:** cloud dev container; Node v22.22.0; PostgreSQL 16.15 throwaway cluster with migrations 0001–0004; better-auth 1.7.14 (two-factor plugin), @node-rs/argon2 2.2.2, fastify 5.12.7. All accounts synthetic (`@example.test`). Better Auth's database rate limiter is enabled in tests.

| # | Requirement / AC | Check (apps/api/test/auth.db.test.ts unless noted) | Result |
|---|---|---|---|
| 1 | FR-AUTH-1 AC1 | Session cookie `lbgos.session_token` has HttpOnly, SameSite=Lax, Path=/; with secure cookies it is `__Secure-lbgos.session_token` with Secure; token absent from the JSON body | **Pass** |
| 2 | FR-AUTH-1 AC2 | New token on every sign-in, ignoring a token the client already sends (no fixation); completing MFA enrolment issues a new session and kills the old cookie | **Pass** |
| 3 | FR-AUTH-1 AC3 | `expiresAt − createdAt` = 604,800 s (absolute, no refresh); business user idle > 12 h → 401 and session row deleted; idle 11 h → still valid; platform admin idle > 30 min → 401 | **Pass** |
| 4 | FR-AUTH-1 AC4 | After sign-out, the old cookie gets 401 | **Pass** |
| 5 | FR-AUTH-1 AC5 | User lists 2 sessions and revokes the other; owner-side revocation exists as `AuthService.revokeAllSessions` (endpoint arrives with RBAC in 3.6) | **Pass** (user part) |
| 6 | FR-AUTH-1 AC6 | Password change signs out other sessions even when the client sends `revokeOtherSessions: false`; password reset signs out all sessions | **Pass** |
| 7 | FR-AUTH-2 AC1 | Reset request for a known vs unknown email: same status and byte-identical body | **Pass** |
| 8 | FR-AUTH-2 AC2 | Raw reset token appears nowhere in `auth.verification` (hashed identifiers); expiry = 1,800 s; token single-use | **Pass** |
| 9 | FR-AUTH-2 AC3 | Sign-in before email verification → 403 `EMAIL_NOT_VERIFIED`; duplicate sign-up returns the same status and response shape and sends no second email (no enumeration) | **Pass** |
| 10 | FR-AUTH-2 AC4 | Rejected: 9-character, common (`password123`), contains email name, single repeated character | **Pass** (local list). Online breached-password check **not implemented** (needs network; deferred) |
| 11 | FR-AUTH-2 AC5 / NFR-13 | Stored hash matches `$argon2id$v=19$m=19456,t=2,p=1$`; plaintext absent | **Pass** |
| 12 | FR-AUTH-3 AC2 (+AC1 mechanism) | Owner (system Owner role) without MFA: `/api/me` reachable with `mfaRequired: true`; other routes → 403 `MFA_ENROLMENT_REQUIRED`; after enrolment → 200. Platform admin also reports `mfaRequired: true` | **Pass** |
| 13 | FR-AUTH-3 AC4 | After enrolment, sign-in returns `twoFactorRedirect` with no usable session; wrong TOTP refused; correct TOTP (RFC 6238 generator in test) issues a session | **Pass** |
| 14 | FR-AUTH-3 AC5 | 10 backup codes; a code works once; TOTP secret and codes not stored in plain text | **Pass** (stored encrypted, not hashed — D-025) |
| 15 | FR-AUTH-4 AC1 | 5 failures → 429 even with the right password; after the 15-min window sign-in works; locked known vs unknown email → identical 429 body; per-IP limit 10/min (11th and 12th → 429) despite varying spoofed `X-Forwarded-For` / `x-lbgos-client-ip`; another IP unaffected | **Pass** |
| 16 | FR-AUTH-4 AC3 | Lockout writes PLATFORM-scope audit event `auth.sign_in.locked` keyed by account hash; email not in the event | **Pass** |
| 17 | T4 / session hook | Non-public route without session → 401; cross-origin POST with a valid cookie → 403 `ORIGIN_REJECTED`, same-origin → 200; business permissions fail closed (403) until RBAC | **Pass** |
| 18 | D-019 | Every new identity gets an `lbg.users` profile (definer function); first session use repairs a missing profile | **Pass** |
| 19 | Migrations | Schema checks after 0003/0004: 81/81 incl. T31–T31h (auth tables in `auth`; no credential columns in `lbg`; user cannot change own email; tenant role cannot read platform admins or call the profile function; auth role limited to `auth.*` audit actions) | **Pass** |
| 20 | D-028 | Drift check: Better Auth needs no schema change after migrations; negative control (temporary migration dropping `twoFactor.lockedUntil`) → reports the exact `alter table`, exit 1 | **Pass** / **Detected** |
| 21 | — | Negative controls on `auth.db.test.ts`: (a) forced `revokeOtherSessions` removed → AC6 fails; (b) lockout check disabled → 3 lockout tests fail; (c) token stripping removed → AC1 fails; (d) Better Auth pointed at `X-Forwarded-For` without stripping → rate-limit keying breaks (4+ failures). All restored; re-run 31/31 | **Detected** all |
| 22 | — | Smoke: real server start — production refused (no email provider), missing `SESSION_SECRET` refused; dev server: `/api/me` 401, sign-up 200 with `token: null`, dev email printed | **Pass** |
| 23 | — | `pnpm check` + drift check | **Pass** — domain 12, eslint rules 11, API unit 25, DB 81 SQL + 24, API DB 32 |

**Defects found and fixed:**
- Sign-up returned 500 because the profile hook cast to `citext` while the auth role's search path excludes `public`. It also left an identity without a profile (Better Auth's insert and after-hook are not one transaction); now repaired on first session use (#18).
- Sign-in bodies exposed the session token (D-027).
- The module-boundary rule caught the schema generator importing auth internals.
- The drift check initially failed on a clean schema: the compiler prints `;` when nothing is pending.

**Deferred, with reasons:** FR-AUTH-1 AC5 owner-revokes-staff endpoint and AC2 rotation on privilege change (need RBAC, 3.6); FR-AUTH-3 AC3 owner toggle "require MFA for staff" (needs business settings, 3.6/3.7); FR-AUTH-3 passkeys (should-have); FR-AUTH-2 AC4 online breached-password check (needs network access; the plugin exists); FR-AUTH-5 MFA recovery (AC1 needs RBAC, AC2 is an operational process to document before pilot). Production email provider not configured (Q6), so production start is refused by design.

---

## TR-0008 · 2026-10-27 · Phase 3 increment 3.6 — RBAC, business lifecycle, audit

**Environment:** as TR-0007, plus migration 0005. Synthetic data only.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-RBAC-1, ROLES_PERMISSIONS §3–4 | Domain tests: unique well-formed keys (match the DB check regex), business/platform sets disjoint; Owner is the only system role and holds all business permissions without limits; only Owner has roles/users/tax/integrations/subscription/support management; Billing lacks cost/refunds/cancel and has a 2%/₹500 discount limit; Accountant view/export only; merging (unlimited beats limited, max limit) is order-independent and never invents grants (property test) | **Pass** (domain 35/35 total) |
| 2 | WORKFLOWS §1, D-009, D-010 | Domain tests: REJECTED terminal; only CHANGES_REQUESTED → PENDING_APPROVAL; access mode for every status; suspended owner READ_ONLY / staff NONE; EXPIRED read-only, PAST_DUE read-only only after 7 grace days; SETUP blocks selling/payments/refunds/marketing.send; READ_ONLY allows views/exports/subscription only | **Pass** |
| 3 | Domain/DB parity | `packages/db/test/transitions.db.test.ts`: all 30 ordered status pairs, domain `canTransition` == DB trigger | **Pass — 30/30**; negative control (one transition removed from the domain table) **detected** exactly that pair |
| 4 | FR-RBAC-1 AC2 | Registration refuses unknown keys, business permissions without `:businessId`, platform permissions outside `/api/platform/` | **Pass** |
| 5 | BR-T1, FR-ONB-1 | `apps/api/test/lifecycle.db.test.ts`: application → PENDING_APPROVAL with applicant as member; second open application 409; invalid state code / extra `status` field 400; pending applicant can read the application but gets 403 `BUSINESS_NOT_AVAILABLE` for business data; non-member 404 | **Pass** |
| 6 | BR-T2, BR-T3 | Review queue only for platform admins (non-admin 403; admin without MFA 403 `MFA_ENROLMENT_REQUIRED`); request-changes with a 6-char reason 422, with a proper reason 204; applicant edits + resubmits; history shows PENDING → CHANGES_REQUESTED → PENDING with the reason; approving twice 409 | **Pass** |
| 7 | Approval provisioning | Approval creates exactly the 5 default roles; Owner role has all catalogue permissions; applicant becomes Owner | **Pass** |
| 8 | D-011, FR-ONB-2 AC3 | New owner without MFA → 403 `MFA_ENROLMENT_REQUIRED`; after enrolment mode SETUP; owner activates → ACTIVE/FULL; second activation 409 | **Pass** |
| 9 | FR-RBAC-1 rules | Billing staff refused `users.view`/`business.settings.view` routes; owner lists members with roles; role change applies and **revokes the member's sessions**; self role change 403; R2: delegated "People admin" cannot assign Owner/Manager (403 `GRANT_EXCEEDS_OWN`); R1: removing the last owner's roles 409 `LAST_OWNER` | **Pass** |
| 10 | FR-AUTH-5 AC1, FR-AUTH-1 AC5 | Staff cannot reset an owner's MFA (403); owner resets staff MFA (`twoFactorEnabled` false); R4 deactivation revokes sessions and the ex-member gets 404 | **Pass** |
| 11 | BR-T4, D-009 | Suspension needs a reason (422 without); owner READ_ONLY (view 200, state change 403 `TENANT_READ_ONLY`); reinstatement restores ACTIVE/FULL | **Pass** |
| 12 | FR-AUD-1 | Business audit log contains request_changes, resubmit, approve, activate, member.roles.set, member.mfa.reset, member.deactivate, suspend, reinstate | **Pass** |
| 13 | BR-T3 AC2 (CLOSED) | Rejected applicant can read status and reason; edit 403; can submit a new application | **Pass** |
| 14 | — | Negative controls (`lifecycle.db.test.ts`): (a) role-permission check off; (b) mode gate off; (c) R2 off; (d) R1 off; (e) inactive memberships allowed | **Detected** all (1–5 failures each); restored → 24/24 |
| 15 | — | `pnpm check`: domain 35, eslint rules 11, API unit 26, DB 81 SQL checks + 54, auth drift check, API DB 56 (auth 32 + lifecycle 24) | **Pass** |
| 16 | CI | Run [#3](https://github.com/rishu37-ux/Local_Business_Growth_OS_Master_Development/actions/runs/40472344510) (increment 3.5) | **success** |

**Issues found and fixed:** a rejected applicant originally had no access at all, so could not read the rejection reason; the new CLOSED mode fixes that. Lint: `Promise.reject` with a non-Error value; unnecessary type assertions.

**Not done in 3.6 (moved to 3.7):** staff invitations (staff membership is seeded directly in tests); in-app/email notifications for decisions (FR-ONB-3 AC1); admin-created businesses with owner invitation (FR-ONB-1 AC2); approval requests and R3 (no self-approval) — need the approvals module; FR-SUP-1 support access.

---

## TR-0009 · 2026-10-27 · Phase 3 increment 3.7a — onboarding backend

**Environment:** as TR-0008, plus migration 0006. Synthetic data only.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-ONB-2 AC4 | Domain: two widely published sample GSTINs accepted; malformed, lower-case, wrong check character, state mismatch rejected; property test: the computed check character is accepted and every other character rejected | **Pass** |
| 2 | FR-RPT-3 / D-012 | Domain: financial year at 31 Mar 23:30 IST vs 1 Apr 00:30 IST (and the same instant in UTC); January start; century wrap; label format property test | **Pass** (domain 42/42) |
| 3 | FR-SUB-1 AC2 | Approval creates a 14-day TRIALING Starter subscription | **Pass** |
| 4 | FR-ONB-3 AC1, BR-T3 AC2 | Applicant gets in-app notifications (changes requested, approved) and emails including the request-changes reason; users mark only their own notifications read (other user 404) | **Pass** |
| 5 | FR-ONB-2 AC1–AC3 | Setup reports required steps (details, tax, mfa), with MFA done for an enrolled owner; unknown timezone 422; `Asia/Kolkata` accepted; bad GSTIN checksum 422 `GSTIN_INVALID`; other-state GSTIN 422; valid profile creates TAX_INVOICE/CREDIT_NOTE/DEBIT_NOTE series for the current FY; no remaining required steps; activation 204. Lifecycle test: activation without a tax profile 409 | **Pass** |
| 6 | Invitations | Single-use token emailed; the stored row has only the hash; another user → 403 `INVITATION_EMAIL_MISMATCH`; invitee accepts and gets exactly Billing; reuse 410; inviting an existing member 409; expired 410; revoked 410; R2: delegated people admin cannot invite into Owner (403, no email sent) | **Pass** |
| 7 | FR-AUTH-3 AC3 | Owner enables "require MFA for staff" → staff `/api/me` shows `mfaRequired: true` and business routes return 403 `MFA_ENROLMENT_REQUIRED` | **Pass** |
| 8 | FR-ONB-1 AC2 | Platform admin creates a business; emailed owner invitation accepted; new owner must enrol MFA, then has Owner role in SETUP mode; non-admins 403 | **Pass** |
| 9 | FR-SUB-2 | Seed plans STARTER 99,900 / GROWTH 199,900 / PRO 349,900 paise, all `pilotPricing`; price change 204 and audited; non-admin 403 | **Pass** |
| 10 | — | Schema checks (incl. RLS meta-check over the four new tenant tables and notifications) and migration list | **Pass** — 81 SQL checks; DB package 54 |
| 11 | — | Negative controls on `onboarding.db.test.ts`: (a) email check removed from `accept_invitation` → 4 tests fail; (b) staff-MFA clause removed from `user_requires_mfa` → AC3 test fails; (c) invitation R2 check removed → R2 test fails; (d) expiry ignored → expiry test fails. All restored; 17/17 | **Detected** all |
| 12 | — | `pnpm check`: eslint rules 11, domain 42, API unit 26, DB 81 + 54, auth drift ok, API DB 73 (auth 32 + lifecycle 24 + onboarding 17) | **Pass** |

**Defect found and fixed:** the default timezone `Asia/Kolkata` was rejected by validation based on `Intl.supportedValuesOf` (D-030).

---

## TR-0010 · 2026-10-27 · Phase 3 increment 3.7b — web app and Phase 3 exit test

**Environment:** cloud dev container; Node v22.22.0; Vite 8.3.5 production build of `apps/web`; Playwright 1.63.0 with the preinstalled Chromium (`/opt/pw-browsers`); @axe-core/playwright 4.14.0; API listening on 127.0.0.1:4317 against a migrated throwaway PostgreSQL 16.15. Synthetic accounts only.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | ADR-05 / NFR-17 | Production build output has no inline scripts (only an external module script and stylesheet) | **Pass** |
| 2 | Static serving | `apps/api/test/static.test.ts`: traversal attempts clamped inside the root or refused; dotfile/encoded-separator paths 404 with no file content; assets served with the correct type, immutable caching and security headers; client routes get `index.html`; `/api/unknown` and missing assets 404 | **Pass** (API unit 37/37 total) |
| 3 | **Phase 3 exit criterion** | `apps/api/test/browser.db.test.ts` in Chromium. Applicant signs up in the UI and verifies via the emailed link, signs in and applies. Platform admin signs in with password + TOTP and approves in the review queue. The new owner is directed to MFA enrolment, enrols (TOTP from the displayed key), saves details and tax settings, and goes live. Owner invites `exit-staff@example.test` as Billing. Staff opens the invitation link, signs in (returned to the invitation) and accepts. The owner's member table shows the staff member with exactly **Billing** | **Pass** — 4 flow tests |
| 4 | NFR-1 (partial) | axe (WCAG 2.0/2.1/2.2 A/AA) on 8 screens (sign-up, sign-in, home, platform review, MFA enrolment, setup wizard, members, invitation) × 3 widths (1280/768/360 px) = 24 audits: **0 serious/critical violations**; no horizontal overflow at any width | **Pass** |
| 5 | NFR-17 | No CSP violation and no page error during the whole flow | **Pass**. The first run failed with 8 CSP violations: React Aria injects one `<style>`; fixed by allowing its exact hash (D-031), not `'unsafe-inline'` |
| 6 | — | Negative controls: (a) `<select>` label association removed → flow tests fail (selectors rely on labels); (b) form hint changed to low contrast → only the audit test fails, with 3 `color-contrast` violations (one per width). Both restored and rebuilt | **Detected** both |
| 7 | — | `pnpm check` (now including `pnpm build`): eslint rules 11, domain 42, web build, API unit 37, DB 81 + 54, auth drift ok, API DB 78 (auth 32 + lifecycle 24 + onboarding 17 + browser 5); `pnpm audit` no known vulnerabilities; secretlint clean | **Pass** |

**Not covered yet:** Firefox/WebKit and real mobile devices (NFR-16); keyboard-only operation of the full flow and screen-reader testing (manual, NFR-1); performance (NFR-14).

### TR-0010 addendum — CI run #9 failed; causes and fixes

[CI run #9](https://github.com/rishu37-ux/Local_Business_Growth_OS_Master_Development/actions/runs/40476371368) (commit `12efaee`, increment 3.7b) **failed on both jobs**:

1. **Node 22.18 job:** `pnpm install` stopped with `ERR_PNPM_UNSUPPORTED_ENGINE`, because `react-router@8.5.0` requires Node ≥ 22.22 and the repo uses `engine-strict`. **Fix:** engines floor raised to `>=22.22` (the dev container runs 22.22.0); the CI matrix now tests the newest Node 22 and Node 24. ADR-01 updated.
2. **Node 24 job:** the browser test failed with a Playwright strict-mode violation: two "Approve" buttons. In CI it shares the throwaway DB with the other API DB test files, which had left another pending application in the review queue; local runs happened to use a different file order. **Fix:** the test acts on its own application's card, and seeds a decoy pending application in `beforeAll` so the condition is reproduced on every run. With the decoy and the old selector, the exact CI error reproduced locally; with the fix, 5/5 pass. The lifecycle test had the same exact-queue assumption, which surfaced once the decoy existed; it now looks for its own application.
3. **Order-independence check:** the API DB suite was run with shuffled file order (`--sequence.shuffle.files`, seeds 1–4) → **78/78 passed each time**.

This counts as a CI failure on 3.7b until a green run on the fixed commit is recorded below.

**Result on the fixed commit:** [CI run #11](https://github.com/rishu37-ux/Local_Business_Growth_OS_Master_Development/actions/runs/40477809802) (commit `c589ab7`) **passed on both jobs** (Node 22 and Node 24).

### TR-0010 addendum 2 — defect found while capturing screenshots

While capturing screenshots of the portal for the user, a newly approved owner who had not yet enrolled MFA saw "You are not part of any business yet" on the home page. `GET /api/businesses` returned 403 (MFA required), and the home page treated the failure as an empty list. **Fix:** the endpoint (listing only the caller's own memberships) is reachable before MFA enrolment (`allowWithoutMfa`); the business's own pages still require MFA. The home page now shows the API error instead of an empty-list message.

| # | Check | Result |
|---|---|---|
| 1 | Lifecycle DB test: an approved owner without MFA gets 200 with their `APPROVED_SETUP_PENDING` business; browser test: the home page lists the business and shows the MFA alert before enrolment | **Pass** — API DB 78/78 |
| 2 | Negative control: fix reverted, tests re-run | **Detected** — the lifecycle tests fail; fix restored |
| 3 | `scripts/dev-local.sh` (new local demo script) | **Pass** — `GET /` 200 HTML, `/sign-in` 200, `/api/me` 401; instructions printed |

---

## TR-0011 · 2026-10-27 · Phase 4 increment 4.1 — catalogue and tax rates

**Environment:** cloud dev container; Node v22.22.0; PostgreSQL 16.15 throwaway cluster (`scripts/with-throwaway-pg.sh`, migrations 0001–0007); API through `app.inject` with real sessions. Synthetic shops created through the real onboarding API (`apps/api/test/shop-fixture.ts`).

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | NFR-8, D-013, D-017 | `packages/domain/test/money.test.ts`: half-up rounding, exact rate/quantity parsing (malformed text rejected), line value and exclusive tax, odd-paisa CGST/SGST split (property), precision-loss guard, weighted average cost incl. negative stock, average bounded by old/incoming cost (property), tax-rate version selection and overlap | **Pass** — domain 51/51 |
| 2 | FR-INV-1 AC1–2, FR-INV-2 AC1–3 | `apps/api/test/catalogue.db.test.ts`: category → brand → product → variants; serialized products counted in pieces; warranty text stored as entered; strict validation (unknown field, HSN format, min price > selling price) | **Pass** |
| 3 | FR-INV-2 AC1 | SKU and barcode unique per business with the field named in the 409; the same SKU/barcode accepted in another business | **Pass** |
| 4 | FR-INV-1 AC3 | Archived products hidden from the default list; unused products deleted; with a stock movement, product/variant/category deletion returns 409 `IN_USE` and the serialized flag is locked (`SERIALIZED_LOCKED`) | **Pass** |
| 5 | FR-INV-2 AC4 | Billing role sees no `purchasePricePaise`/`avgCostPaise`; owner does; Inventory role (catalogue.manage without cost.view) cannot write a purchase price (403 `COST_FORBIDDEN`) but can create the variant without it | **Pass** |
| 6 | FR-TAX-2 AC1 | No rates seeded; overlapping versions (case-insensitive name) rejected with 409; `lbg.effective_tax_rate` picks the version in force on boundary dates | **Pass** |
| 7 | FR-TAX-2 AC2 (part) | Versions immutable: the app role has no UPDATE on `rate_percent` (42501) and even the owner role is stopped by the trigger (LB013); closing a version works; rate management needs `tax.settings.manage` and writes `tax.rate.create` audit events; out-of-range/over-precise rates rejected | **Pass** |
| 8 | NFR-4 | Cross-tenant: another business's owner gets 404 on every product route under our business ID, and 404 when using their own business ID with our product ID; references to another tenant's category fail (422, composite FK) | **Pass** |
| 9 | — | Negative controls: (a) cost hiding disabled → the AC4 test fails; (b) overlap check disabled in the trigger → 3 tax-rate tests fail. Both restored; 15/15 pass | **Detected** both |
| 10 | — | `pnpm check`: lint, format, typecheck, build; domain 51, eslint rules 11, API unit 37, DB schema checks + 54, auth drift ok, API DB 93 (incl. catalogue 15) | **Pass**, exit 0 |

**Not covered yet:** re-authentication before tax-setting changes (FR-TAX-2 AC2, D-030); catalogue UI (increment 4.6).

---

## TR-0012 · 2026-10-27 · Phase 4 increment 4.2 — suppliers and purchases

**Environment:** as TR-0011, migrations 0001–0008. Synthetic shops: one UNREGISTERED, one REGULAR (sample GSTIN used only as a checksum vector), one unrelated tenant.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-INV-8 AC1 | Supplier GSTIN checksum rejected when wrong; lower-case GSTIN normalised; state taken from the GSTIN; GSTIN/state mismatch rejected | **Pass** |
| 2 | FR-INV-8 AC2, FR-INV-5 AC1 | Draft totals computed by code (intra-state CGST/SGST); difference from the printed supplier total shown (−₹4.10); a draft writes no movements and no stock level | **Pass** |
| 3 | FR-INV-3 AC2–4, FR-OCR-3 AC1 (shared checks) | Wrong check digit, duplicate IMEI within the purchase, IMEI1 = IMEI2 and unit-count mismatch reported per line/position/field; the wrong IMEI is stored exactly as entered; posting refused (422) | **Pass** |
| 4 | FR-INV-3 AC3, AC5 | After posting, the same IMEI on a new draft is a blocking `IMEI_EXISTS` with the existing unit ID; the same IMEI is accepted and posted in another business, with only a "no tax rate" warning | **Pass** |
| 5 | — | IMEIs on non-serialized lines flagged; non-digit IMEIs and another tenant's variant or supplier rejected (422) | **Pass** |
| 6 | FR-INV-5 AC2, FR-INV-8 AC4 | Posting: units IN_STOCK with IMEIs, 3 PURCHASE movements, stock levels 2 and 10, unit cost incl. tax for an unregistered shop (D-033), supplier payable = document total, `purchase.post` audit | **Pass** |
| 7 | FR-INV-8 AC4 | Posted purchase cannot be edited (409 `NOT_DRAFT`) or posted again; the DB refuses line changes even for the owner role (LB016) | **Pass** |
| 8 | FR-INV-8 AC3 | Same supplier invoice number (different case) blocks posting (409); override reason < 10 chars rejected; with a reason, posts and stores it | **Pass** |
| 9 | D-017, D-033 | Weighted average cost after a second purchase equals the formula; a REGULAR registrant's cost excludes tax; inter-state supplier → IGST only | **Pass** |
| 10 | FR-INV-5 AC2 (atomicity) | Two drafts sharing an IMEI posted concurrently: exactly one 200; the other 409/422 and left no units, no movements and stayed DRAFT | **Pass** |
| 11 | WORKFLOWS §5 | Reversal: units REVERSED, IMEIs released (re-entry no longer flagged), 2 REVERSAL movements, payable reduced by the document total; second reversal 409; reversal refused when a unit is SOLD (`REVERSAL_BLOCKED`) or non-serialized stock is short (`INSUFFICIENT_STOCK`, DB trigger LB015) | **Pass** |
| 12 | FR-RBAC-1, NFR-4 | Inventory staff create drafts but cannot post (403); Billing cannot see purchases/suppliers (403); another tenant gets 404 on purchase, post, supplier and ledger routes | **Pass** |
| 13 | — | Negative controls: (a) negative-stock check removed from the trigger → the insufficient-stock test fails; (b) existing-IMEI lookup disabled → the `IMEI_EXISTS` test fails (the concurrent test still passed: the IMEI primary key is the last line of defence). Both restored | **Detected** both |
| 14 | — | `pnpm check`: domain 56, API DB 109 (incl. purchasing 16, catalogue 15, browser exit test), DB 54 + schema checks | **Pass**, exit 0 |

---

## TR-0013 · 2026-10-27 · Phase 4 increment 4.3 — stock ledger, adjustments, approvals

**Environment:** as TR-0011, migrations 0001–0009. Shop with Owner, Manager, Inventory and Billing members; a second single-member shop.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-INV-4 AC3 | Stock overview per variant/bucket after a posted purchase; stock value shown only with `catalogue.cost.view` (Billing sees none) | **Pass** |
| 2 | — | Units filtered by IMEI; movement history per variant | **Pass** |
| 3 | FR-INV-4 AC3 | Reconciliation clean; the app role cannot write `stock_levels` (42501); a planted +1 in the projection (owner role) is reported exactly (projected 6, ledger 5) | **Pass** |
| 4 | FR-INV-4 AC4 | Reason < 10 chars rejected (400); direct ADJUSTMENT by an approver writes the movement and an `inventory.adjust` audit event | **Pass** |
| 5 | FR-INV-5 AC3 | Decrement below zero refused (409 `INSUFFICIENT_STOCK`); allowed when the business enables negative stock; serialized variants cannot get quantity adjustments (422) | **Pass** |
| 6 | WORKFLOWS §4 | Unit write-off IN_STOCK → WRITTEN_OFF once; a second write-off is 409 `INVALID_UNIT_TRANSITION` | **Pass** |
| 7 | FR-INV-4 AC2 | Correction writes a REVERSAL; a second correction of the same movement is 409 `ALREADY_REVERSED`; purchase movements cannot be "corrected" (422, reverse the document instead) | **Pass** |
| 8 | FR-INV-5 AC3 (concurrency) | Two parallel decrements of the last item → exactly one 201 and one 409; two parallel write-offs of one unit → exactly one 201 and one 409 | **Pass** |
| 9 | WORKFLOWS §11 | Inventory staff (request only) get 202 with a payload hash; nothing changes until approval; they cannot decide (403); a wrong hash is 409 `PAYLOAD_CHANGED`; a Manager's approval executes once (EXECUTED, decider recorded, one movement referencing the request); deciding again 409; the stored request is immutable even for the owner role (LB017) | **Pass** |
| 10 | WORKFLOWS §11 | Rejection needs a note (422 without); only the requester can cancel (403 for others); an approval whose execution no longer fits (stock changed) ends EXECUTION_FAILED with `INSUFFICIENT_STOCK` and writes no stock; expired requests are refused (409 `EXPIRED`) | **Pass** |
| 11 | Rule R3 | Self-approval refused while another member holds the permission; a sole owner may self-approve and the audit event records `selfApproved: true` | **Pass** |
| 12 | NFR-4 | Billing cannot adjust or list approvals (403); another tenant gets 404 on all stock/approval routes and cannot adjust our variant or unit through its own business ID (404) | **Pass** |
| 13 | — | Negative controls: hash comparison and the R3 check disabled → the hash and R3 tests fail (plus one dependent count). Restored | **Detected** |
| 14 | — | `pnpm check`: API DB 126 (incl. inventory 17), domain 56, DB 54 + schema checks | **Pass**, exit 0 |

**Not covered yet:** opening-stock entry for serialized units (enter as a purchase from an "opening stock" supplier for now); approval notifications to approvers (in-app list only).

---

## TR-0014 · 2026-10-27 · Phase 4 increment 4.4 — inspection, stock reports, lookup

**Environment:** as TR-0011, migrations 0001–0010. Customer returns (Phase 5) are simulated with SALE/SALE_RETURN ledger rows and unit statuses written by the owner role; report ages use back-dated synthetic movements.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-INV-6 AC1 (state only) | Returned goods counted in INSPECTION, not AVAILABLE; units and quantities listed in the inspection queue | **Pass** |
| 2 | FR-RBAC-1 | Billing (no `returns.inspect`) gets 403 on queue and outcomes | **Pass** |
| 3 | FR-INV-6 AC2–3 | RESTOCK returns a unit to IN_STOCK and AVAILABLE; repeating it is 409 | **Pass** |
| 4 | FR-INV-6 AC2–3, WORKFLOWS §4 | REPAIR → IN_REPAIR (REPAIR bucket); RESTOCK from repair refused; REPAIRED → PENDING_INSPECTION; DAMAGED → DAMAGED bucket; AVAILABLE unchanged throughout | **Pass** |
| 5 | FR-INV-6 AC2–3 | Quantities: RESTOCK 1 (AVAILABLE +1), DAMAGED 1, RETURN_TO_SUPPLIER 1 (leaves stock); a fourth outcome with nothing left is 409 `INSUFFICIENT_STOCK`; quantity inspection of a serialized variant 422 | **Pass** |
| 6 | FR-AUD-1, FR-INV-4 AC3 | 7 inspection records, each with its movements (2 per reclassification, 1 for return to supplier) and an `inventory.inspect` audit event; reconciliation clean | **Pass** |
| 7 | FR-INV-7 AC1 | Low-stock list returns exactly the variant with available (5) ≤ reorder level (5) | **Pass** |
| 8 | FR-INV-7 AC2 | Defaults N=60/M=120: never-sold stock received 130 days ago = DEAD (130 days, no last sale); last sale 70 days ago = SLOW; custom N=1/M=69 reclassifies as expected; M < N rejected (400) | **Pass** |
| 9 | FR-INV-7 AC3 | Reorder report labelled "suggestion", shows the formula, a 30-day period and the "on order not tracked" note; 15 sold → average 0.500/day, suggestion 3.500 → 4 units | **Pass** |
| 10 | FR-INV-7 AC3 | `@lbgos/domain` reorder tests: exact formula, never negative, missing level = 0, single rounding of lead-time demand, monotone in sales (property), input validation; age classification boundaries | **Pass** — domain 62/62 |
| 11 | FR-INV-9 AC1 | Lookup resolves barcode, SKU (case-insensitive), IMEI 2 (with surrounding spaces trimmed) to the unit; unknown code 404 | **Pass** |
| 12 | NFR-4 | Lookup never matches another business's barcode/IMEI; another tenant gets 404 on inspection and report routes | **Pass** |
| 13 | — | Negative controls: DAMAGED outcome pointed at AVAILABLE → 2 inspection tests fail; reorder level dropped from the formula → reorder test fails. Restored | **Detected** both |
| 14 | — | `pnpm check`: API DB 137 (incl. inspections/reports 11), domain 62 | **Pass**, exit 0 |

---

## TR-0015 · 2026-10-27 · Phase 4 increment 4.5 — uploads and OCR-assisted review

**Environment:** as TR-0011, migrations 0001–0011. OCR runs through the **mock adapter** (reads synthetic fixture text; it is not OCR) inside a Node worker thread, exactly as the server runs it; storage is in memory. Failure modes use test-only adapters (`apps/api/test/fixtures/`). All files are generated synthetically (`packages/domain/test/fixtures/files.ts`).

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-OCR-1 AC1–2, FR-OCR-6 AC2 | Label PNG upload (Inventory staff) → 202, job QUEUED, stored under `<businessId>/<random UUID>`, type from content, `malware_scan = NOT_CONFIGURED`, path-like file name reduced to a display name; no purchase, movement or approval created | **Pass** |
| 2 | FR-OCR-6 AC1 | Rejected by content: script renamed as upload (415), HEIC (415 with camera-setting guidance), > 10 MB (413), 9000 px wide (422), 11-page PDF (422), truncated PDF (422); nothing stored; JSON body 400; Billing 403 | **Pass** |
| 3 | FR-OCR-6 AC1 | Domain unit tests: JPEG/PNG/WebP/PDF sniffing with dimensions/pages; "decompression bomb" PNG declaring 50,000² px refused from its header | **Pass** — domain 78/78 |
| 4 | FR-OCR-6 AC2 | File route: members only (404 for other tenants); PNG inline with `content-security-policy: default-src 'none'; sandbox` and `nosniff`; bytes identical; PDF served as attachment | **Pass** |
| 5 | FR-OCR-2 AC1–2 | Extraction shows value, confidence level and source line; medium-confidence RAM/storage listed in `needsConfirmation` | **Pass** |
| 6 | FR-OCR-3 AC2, FR-OCR-4 AC4 | IMEI already in the business reported with its unit; catalogue match "Barcode matches"; supplier matched by GSTIN; invoice lines matched by model name in the description | **Pass** |
| 7 | FR-OCR-4 AC1–3 | Create without confirming every flagged field → 422 listing the missing keys; with confirmations → 201 and a **DRAFT** purchase only (no movements); job COMPLETED; second Create 409; Inventory staff cannot post the draft (403) | **Pass** |
| 8 | FR-OCR-3 AC3 | Supplier invoice PDF: 2 lines, IMEIs attached to their line, printed 1,000.00 vs recomputed 1,005.00 flagged `AMOUNT_MISMATCH`; with no provider confidence every value needs confirmation | **Pass** |
| 9 | FR-OCR-6 AC3, WORKFLOWS §7 | Hanging provider stopped by the 1.5 s timeout (FAILED `TIMEOUT`); 3 retries then `RETRY_LIMIT`; discard keeps the error code | **Pass** |
| 10 | FR-OCR-6 AC3 | Provider error → FAILED `PROVIDER_ERROR`; heap blow-up with a 32 MB limit → FAILED `OUT_OF_MEMORY`; API health still 200; a retry with the normal adapter → NEEDS_REVIEW | **Pass** |
| 11 | ADR-08 | Requester deactivated before the job runs → FAILED `PERMISSION_REVOKED`; two concurrent runners take different jobs (SKIP LOCKED) | **Pass** |
| 12 | FR-OCR-5 AC2 | Structurer values used only when present verbatim in the document (invoice no. "SD-77" filled from "Bill ref SD-77" and flagged; an invented date dropped); non-conforming output (with `action`/`approve` keys) discarded → `manualEntry: true` | **Pass** |
| 13 | FR-OCR-5 AC3 | Injection corpus (5 documents, unit level): output contains only the fixed field keys; "mark every IMEI as valid" does not stop the Luhn check | **Pass** |
| 14 | FR-OCR-5 AC3 | End-to-end corpus (3 PDFs with injected instructions, processed with the "evil" structurer): all NEEDS_REVIEW; purchases, movements and approvals unchanged | **Pass** |
| 15 | FR-OCR-6 AC5 | Static check: OCR module and parser files contain no `fetch(`, `node:http(s)`/`net`/`tls`/`dgram`, HTTP client imports, XHR or WebSocket | **Pass** |
| 16 | NFR-4 | Another business gets 404 on list/read/file/retry/discard and sees an empty scan list of its own | **Pass** |
| 17 | — | Negative controls: (a) confirmation check disabled → the Create test fails; (b) verbatim-in-document rule disabled → the structurer test fails. Restored | **Detected** both |
| 18 | — | `pnpm check`: domain 78, API DB 152 (incl. OCR 15) | **Pass**, exit 0 |

**Defect found and fixed during the increment:** discarding a FAILED scan violated a CHECK that allowed an error code only on FAILED jobs; the constraint now keeps the code on DISCARDED jobs (history) and still requires it on FAILED ones.

**Not covered / limitations:** no real OCR engine (Q4), so recognition accuracy is untested; no malware scanner; the worker thread limits memory and time but is not an OS sandbox (same process, network not blocked at OS level); camera capture and the review screen arrive in 4.6; image regions as evidence are not available from the mock.

---

## TR-0016 · 2026-10-27 · Phase 4 increment 4.6 — web screens and Phase 4 exit test

**Environment:** cloud dev container; Vite 8 production build of `apps/web`; Playwright 1.63.0 with the preinstalled Chromium; @axe-core/playwright 4.14.0; API on 127.0.0.1:4318 against migrations 0001–0011; OCR through the mock adapter, processed by the harness exactly as the server's job loop would. Synthetic shop, staff and files.

| # | Requirement / AC | Check (`apps/api/test/inventory-browser.db.test.ts`) | Result |
|---|---|---|---|
| 1 | FR-TAX-2, FR-INV-1/2, FR-INV-8 AC1 | Owner (signed in with password + TOTP) adds a tax rate, a serialized phone model with a variant (cost price visible to the owner) and a supplier with GSTIN through the UI | **Pass** |
| 2 | FR-INV-8, FR-INV-5 AC2 | New purchase in the UI: IMEIs typed character by character with Enter between scans (keyboard-wedge behaviour); draft shows "No problems found" and the computed total ₹35,400.00; posting adds the stock | **Pass** |
| 3 | FR-INV-3 AC3 | A second purchase with an IMEI already in stock shows the blocking check; posting is refused; the draft is discarded | **Pass** |
| 4 | FR-OCR-1…4 | Supplier-invoice PDF uploaded from the scan screen; after processing, the review screen shows each field with confidence and source; **Create stays disabled until all 10 flagged fields are confirmed**; supplier and product are pre-selected from the GSTIN and description matches; the IMEI is pre-filled; Create opens a DRAFT purchase, which the owner posts | **Pass** |
| 5 | FR-INV-4 AC4, WORKFLOWS §11 | Inventory staff request a −1 adjustment ("sent for approval"); stock unchanged (5); the owner approves on the Approvals screen; stock becomes 4 | **Pass** |
| 6 | FR-INV-9 AC1–2, FR-INV-4 AC3 | Stock screen: IMEI typed into the scanner field + Enter finds the unit ("matched by imei, unit in stock"); the camera button is shown only if `BarcodeDetector` exists (absent in headless Chromium, so none is shown and nothing errors); "Stock levels match the stock ledger"; phone stock 3 (2 purchased + 1 from the scan) | **Pass** |
| 7 | NFR-1, NFR-17 | axe (WCAG 2.0/2.1/2.2 A/AA) on 8 new screens (tax rates, catalogue, suppliers, purchase editor, scans, scan review, stock, approvals) × 3 widths = 24 audits: **0 serious/critical**; no horizontal overflow; no CSP violation or page error | **Pass** |
| 8 | — | `inventory.db.test.ts`: Inventory and Billing staff can open the business overview (it lists their usable permissions, without `inventory.adjust.approve` for Inventory); a non-member gets 404 | **Pass** |
| 9 | — | `pnpm check`: lint, format, typecheck, build; domain 78; API unit 37; DB schema checks + 54; auth drift ok; API DB 160 (incl. both browser tests). API DB suite with shuffled file order (seeds 1, 2): 160/160 each | **Pass**, exit 0 |

**Defects found by the browser test and fixed:**
1. **Staff could not open their business at all:** the overview route required `business.settings.view`, which the Inventory and Billing roles do not have, so the business page failed for them (the Phase 3 test only checked that staff reached the URL). The overview now uses a `member` pseudo-permission (any active member, 404 for others, still unavailable before setup; D-037). The Phase 3 lifecycle test that asserted the old 403 was changed to assert 200 for the overview and 403 for the audit log, which Billing does not hold.
2. **axe `scrollable-region-focusable` at 360 px:** wide tables scroll inside a container that keyboard users could not reach. The container is now a focusable, labelled region.

**CI:** [run #21](https://github.com/rishu37-ux/Local_Business_Growth_OS_Master_Development/actions/runs/40513254399) on commit `8a5f7d9` **passed** (Node 22 and 24). Runs #14, #17–#20 for increments 4.1–4.5 also passed.

**Not covered yet:** Firefox/WebKit and real phones (NFR-16), including camera capture through the file picker and `BarcodeDetector`; real USB/Bluetooth scanners (emulated by typed input); keyboard-only and screen-reader passes of the new screens (NFR-1 manual checks).

---

## TR-0017 · 2026-10-27 · Phase 5 increment 5.1 — tax, allocation and numbering engines

**Environment:** cloud dev container; Node v22.22.0; Vitest 5.0.5 with @vitest/coverage-v8 5.0.5; fast-check 4.10.2. Pure functions only (no database).

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-TAX-1 AC1–3, D-013 | `tax-engine.test.ts` worked examples: inclusive ₹118 → ₹100 + 9 + 9; exclusive; IGST; odd-paisa split (90/91); inclusive rounding (₹9.99 → 847 + 76 + 76); zero-rated; cess exclusive/inclusive incl. an odd split; line discounts (amount, percent); invoice discount apportioned 33/33/34 and 2:1; round-off +50/−49/0; multi-rate; fractional quantities; 120-line invoice | **Pass** |
| 2 | FR-TAX-1 AC4 | Bill of Supply: no tax amounts, net amount = total | **Pass** |
| 3 | FR-TAX-1 AC3 | Properties (400 runs): Σ lines = totals for every component; each line total = taxable + taxes; CGST ≤ SGST ≤ CGST + 1; IGST xor CGST/SGST; inclusive lines keep their net amount; nothing negative; round-off within −49…+50 and total a whole rupee; apportioned shares sum exactly and never exceed a line's value. Validation: no lines, zero/fractional quantity, rates > 100 %, negative price, discounts above the value | **Pass** |
| 4 | FR-TAX-1 AC5 | `pnpm -F @lbgos/domain test` runs with coverage thresholds of 95 % (branches, lines, functions, statements) over tax-engine, allocation, money, numbering and purchase. First measurement: branches 89.9 % → **the run failed**; unreachable fallbacks were removed by restructuring and edge tests added. Final: **tax-engine 100 % branches**, all five files 99.3 % branches / 100 % lines | **Pass** (threshold enforced) |
| 5 | FR-LED-2 AC1 | Allocation: FIFO (date, then numeric-aware number), exact, partial, spill-over with remainder as advance, explicit selection order, unknown invoice refused, advances from several payments applied oldest first, refund sources and over-refund refused, payment status (incl. credit notes), invalid amounts refused | **Pass** |
| 6 | FR-LED-2 AC2 | Property: never over-allocates an invoice or a payment; allocated = min(funds, amount due) | **Pass** |
| 7 | FR-POS-4 AC3 | Number formats: tokens render; default fits a 6-character prefix in 16 characters; formats that could exceed 16 characters, contain other characters, lack or repeat `{SEQ:n}`, or use unknown tokens are refused at configuration time; an outgrown sequence is "exhausted" rather than longer; property: any accepted format renders ≤ 16 allowed characters | **Pass** |
| 8 | FR-RPT-2, FR-LED-3 | Metric definitions present; operating profit labelled an estimate; no sales metric labelled profit or cash | **Pass** |
| 9 | — | Negative controls: (a) remainder paise not distributed in apportioning → 4 tax tests fail; (b) allocation ignoring the amount due → 4 allocation tests fail. Restored; 114/114 pass | **Detected** both |

---

## TR-0018 · 2026-10-27 · Phase 5 increment 5.2 — customers, numbering, re-authentication

**Environment:** as TR-0011, migrations 0001–0012.

| # | Requirement / AC | Check (`sales-setup.db.test.ts`, `customers.test.ts`) | Result |
|---|---|---|---|
| 1 | FR-POS-5 AC1, FR-CRM-2 AC1 | Billing staff create a customer with name + mobile only; "98765 43210" stored as +919876543210 | **Pass** |
| 2 | FR-CRM-1 AC1 | Lookup by "098765-43210" finds the same customer; creating "+91 98765 43210" again is 409 with the existing customer's ID; another business can have a customer with that mobile | **Pass** |
| 3 | — | Search by name and by mobile digits | **Pass** |
| 4 | FR-POS-5 AC2 | B2B GSTIN upper-cased, checksum-checked, state taken from it; invalid GSTIN and mobile refused; domain: place of supply = GSTIN state → customer state → shop state; mobile normalisation cases (10-digit, leading 0, 91, +91, foreign, invalid) | **Pass** |
| 5 | FR-PRV-1 AC1 (part) | A correction writes `customer.update` with field names only (no personal data); Inventory staff 403; other tenants 404 | **Pass** |
| 6 | FR-POS-4 AC3 | Numbering view shows the setup prefix and an example; a format that could exceed 16 characters is 422 `TOO_LONG`; a valid one is saved (Billing 403) | **Pass** |
| 7 | FR-POS-4 AC4–5 | 31 March 2027 23:30 IST → FY 2026-27, 1 April 2027 00:30 IST → a new 2027-28 series starting at 1 | **Pass** |
| 8 | FR-POS-4 AC1–2, D-020 | 30 concurrent transactions take numbers, 6 roll back: committed numbers are exactly 1–24, and the next is 25 | **Pass** |
| 9 | FR-TAX-2 AC2 | With the owner's session aged to 1 hour: tax-rate creation, numbering and tax-profile changes are 403 `REAUTH_REQUIRED`, other routes still work; after signing in again with password + TOTP the change succeeds | **Pass** |
| 10 | — | Negative controls: (a) fresh-session check disabled → the re-authentication test fails; (b) numbering read-then-write without the row lock → the concurrency test fails. Restored | **Detected** both |
| 11 | — | `pnpm check`: domain 126, API DB 171 | **Pass**, exit 0 |

**Test-infrastructure defect found and fixed:** the first full run failed with HTTP 429 on sign-up in `lifecycle.db.test.ts`. Each test file restarted the synthetic client-IP counter at the same value while all files share the database that stores auth rate-limit counters, so adding a test file made sign-ups from "the same IP" exceed the limit. Each file now starts at a random point of 10.0.0.0/8. (The rate limit itself behaved correctly.)

## TR-0019 · 2026-10-27 · Phase 5 increment 5.3 — selling and issuing

**Environment:** as TR-0011, migrations 0001–0013 (throwaway PostgreSQL 16 via `scripts/with-throwaway-pg.sh`).

| # | Requirement / AC | Check (`sales.db.test.ts`, `discount-limits.test.ts`, `schema-checks.sql`) | Result |
|---|---|---|---|
| 1 | FR-INV-5 AC2–3, FR-TAX-1 AC1/AC4, D-017 | Walk-in sale of a phone (by unit) and 2 cables, 18 % inclusive, GST-registered shop: TAX_INVOICE, taxable 13,559.32, CGST = SGST = 1,220.34, total 16,000.00; number `T26-27/0001`; unit SOLD; SALE movements −1 (unit cost) and −2 (average cost); line COGS 11,000.00 and 400.00; line description carries the IMEI; payment allocations = total; cash tendered 17,000 → change 1,000; `sale.issue` audited; seller GSTIN in the party snapshot; costs hidden from Billing, shown to the owner | **Pass** |
| 2 | FR-TAX-1 AC2 | B2B customer with a Karnataka GSTIN at a Maharashtra shop: place of supply 29, IGST 76.27, no CGST/SGST | **Pass** |
| 3 | FR-TAX-1 AC4 | Unregistered shop: BILL_OF_SUPPLY, no tax, ₹333.33 rounded to ₹333.00 (round-off −0.33) | **Pass** |
| 4 | FR-TAX-1 AC3 | Mixed sale with a 1 % line discount, a price override and a ₹10.01 invoice discount: every stored total equals `computeSale`; the DB reconciled header and lines on issue | **Pass** |
| 5 | — | A confirmed total that differs from the recomputed total is 409 `TOTAL_CHANGED` | **Pass** |
| 6 | FR-INV-5 AC4 (atomicity) | Issue failing after stock movements were written (series exhausted): 409 `SERIES_EXHAUSTED`; no stock movement, unit still IN_STOCK, draft still DRAFT, series counter unchanged; after fixing the series the sale takes the next consecutive number | **Pass** |
| 7 | FR-INV-5 AC4 | Two checkouts of the same IMEI at once: exactly one 201, the other 409 `UNIT_NOT_AVAILABLE`; one SALE movement | **Pass** |
| 8 | — | The same draft issued twice at once: one invoice, the other 409 `NOT_DRAFT`; one allocation | **Pass** |
| 9 | FR-INV-5 AC3 | The last unit of a non-serialized item sold by two checkouts at once: one 201, the other 409 `INSUFFICIENT_STOCK`; stock 0, never negative | **Pass** |
| 10 | FR-POS-3 AC2, D-014, FR-LED-1 | Part payment for a walk-in is 422 `BALANCE_NEEDS_CUSTOMER`; with a customer: UPI 500 + cash 300 on 2,000 → balance 1,200; ledger INVOICE +2,000, PAYMENT −300, −500 | **Pass** |
| 11 | FR-POS-3 AC1, D-014 | Overpayment refused for walk-ins; for a customer the 300 extra is advance (ledger −300); the next sale uses 300 advance + 200 cash (balance 0, allocations = total); using more advance than held is 422 `INSUFFICIENT_ADVANCE` | **Pass** |
| 12 | FR-POS-3 AC3–4 | Reference "4111 1111 1111 1111" is 422 `PAYMENT_INVALID`; a tendered amount on a UPI payment is refused | **Pass** |
| 13 | FR-POS-2 AC1–2 | Billing (2 % / ₹500): 1 % issues; 3 % reports `DISCOUNT_NEEDS_APPROVAL` and issuing is 422 `NOT_READY`; the cashier requests approval, cannot decide it (403); the Manager approves (EXECUTED); the sale issues and records the Manager and the request on the invoice | **Pass** |
| 14 | FR-POS-2 AC2 | 20 % discount: the Manager (10 %) is refused 403 `FORBIDDEN`; the owner approves; adding an item afterwards makes approval necessary again; requesting approval within one's own limit is 409 `APPROVAL_NOT_NEEDED` | **Pass** |
| 15 | FR-POS-2 AC2 | A request approved after the draft changed ends EXECUTION_FAILED `SALE_CHANGED` (nothing approved) | **Pass** |
| 16 | FR-POS-2 AC3 | Below the minimum price: Billing gets `BELOW_MIN_PRICE`; the Manager (`pos.price_override`) issues | **Pass** |
| 17 | FR-POS-1 AC2 | A serialized item without a unit reports `UNIT_REQUIRED`; a sold unit `UNIT_NOT_AVAILABLE`; the same unit twice or quantity 2 is 422 `INVALID_LINE` | **Pass** |
| 18 | FR-POS-1 AC4 | Held carts are listed; a discarded cart cannot be issued (`NOT_DRAFT`) | **Pass** |
| 19 | NFR tenancy | Inventory role 403 on sales and invoices; another business's owner gets 404 for this shop's sale (by its URL and by their own); other businesses' items (`INVALID_LINE`) and customers (`CUSTOMER_NOT_FOUND`) cannot be used; another business's invoice is 404; a suspended (read-only) business can list invoices, but creating a sale or cancelling an approval request is 403 `TENANT_READ_ONLY`; an empty cart is refused (400) | **Pass** |
| 20 | FR-POS-2 AC1 | Domain: both caps apply, exact at the boundary (2 % of ₹10,000; ₹500 cap), fractional percentages, unlimited grants, no grant ⇒ only zero | **Pass** |
| 21 | DB backstop | Schema checks T16i (line gross − discounts ≠ inclusive total refused) and T16j (issuing without a party snapshot refused) | **Pass** |
| 22 | — | Negative controls: (a) the sorted unit lock removed → test 7 fails (the second sale was then stopped only by the stock trigger, with `INSUFFICIENT_STOCK`); (b) every cashier treated as unlimited → test 13 fails. Restored | **Detected** both |
| 23 | — | `pnpm check`: lint, format, typecheck, build, domain 130 (coverage 100 % lines, 99.39 % branches over the money modules), API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 191 | **Pass**, exit 0 |

**Defects found while testing (fixed before commit):** `invoices` had no `created_at` (needed for held carts; added in 0013); test items created without a tax rate in a GST-registered shop were correctly reported as `NO_TAX_RATE` (test fixture fixed).

## TR-0020 · 2026-10-27 · Phase 5 increment 5.4 — payments, allocation, ledger

**Environment:** as TR-0011, migrations 0001–0014 (throwaway PostgreSQL 16).

| # | Requirement / AC | Check (`payments.db.test.ts`) | Result |
|---|---|---|---|
| 1 | FR-LED-2 AC1, D-014 | Invoices of ₹1,000 and ₹2,000 (older first); ₹1,500 UPI pays the first in full and ₹500 of the second; statuses PAID / PARTIALLY_PAID in the account and the invoice list; ₹2,000 cash (₹2,500 tendered) settles the rest, ₹500 advance, ₹500 change | **Pass** |
| 2 | FR-LED-2 AC1 | A payment for a chosen invoice pays only that one; another customer's invoice is 422 `UNKNOWN_INVOICE`; a card-like reference is 422 | **Pass** |
| 3 | FR-LED-2 AC1 | ₹700 paid before any invoice is advance; applied to a later ₹1,000 invoice → ₹300 due | **Pass** |
| 4 | FR-LED-2 AC1, D-041 | Advance refund: Billing 403; more than held 422 `INSUFFICIENT_ADVANCE`; Manager refunds ₹400 of ₹500 taken oldest payment first (REFUND entries ₹300 + ₹100); ₹100 advance left | **Pass** |
| 5 | FR-LED-2 AC1, D-041 | Reversal of a ₹1,200 payment: Billing 403; Manager reverses — allocations reversed (₹2,000 due again), REVERSAL ledger entry +₹1,200 linked to the PAYMENT entry; a second reversal is `ALREADY_REVERSED`; reversing the reversal is `NOT_REVERSIBLE` | **Pass** |
| 6 | DB backstop | A payment with refunds cannot be reversed (`REFUNDED`); a direct refund insert beyond the advance is refused (LB019); refunds and ledger entries cannot be updated (LB001) | **Pass** |
| 7 | FR-LED-2 AC2, D-020 | 5 parallel ₹600 payments (two users) to one ₹2,000 invoice: all succeed, allocations total exactly ₹2,000, ₹1,000 advance | **Pass** |
| 8 | FR-LED-1 AC3 | Statement 1–30 April 2026 (IST): opening ₹3,000 includes a payment at 31 March 23:30 IST, excludes one at 1 April 00:15 IST; entries with running balance; an entry at 1 May 00:01 IST excluded; closing ₹2,500; end before start is 400 | **Pass** |
| 9 | FR-LED-1 AC2 | In every account check, ledger balance = receivables − advance | **Pass** |
| 10 | NFR tenancy | Inventory 403; other businesses 404 (account, payments, reversal); suspended business: account readable, payment 403 `TENANT_READ_ONLY` | **Pass** |
| 11 | — | Negative controls: (a) customer lock removed from recording a payment → test 7 fails (2 of 5 payments refused with 422 by the allocation bounds trigger — no over-allocation, but wrong behaviour); (b) advance computed without refunds → test 4 fails. Restored | **Detected** both |
| 12 | — | `pnpm check`: domain 130, API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 200 | **Pass**, exit 0 |

## TR-0021 · 2026-10-27 · Phase 5 increment 5.5 — cancellation, credit and debit notes, returns

**Environment:** as TR-0011, migrations 0001–0015 (throwaway PostgreSQL 16).

| # | Requirement / AC | Check (`returns.db.test.ts`) | Result |
|---|---|---|---|
| 1 | FR-TAX-3 AC1, D-016 | Same-day cancellation of a part-paid phone sale, goods never left: Billing 403; Manager cancels — unit back IN_STOCK (OPENING → SALE → REVERSAL, all AVAILABLE), status CANCELLED, number kept, ₹5,000 paid becomes advance (balance −5,000); cancelling again is `NOT_ISSUED` | **Pass** |
| 2 | FR-TAX-3 AC1, FR-POS-3 AC5, FR-INV-6 AC1 | Walk-in cancellation: as advance is 422 `REFUND_REQUIRED`; with a cash refund the ₹1,000 is refunded (refund rows without a customer) and the 2 returned cables are in INSPECTION | **Pass** |
| 3 | FR-TAX-3 AC2, D-016 | Cancelling the next business day is refused `OUTSIDE_WINDOW` (points to a credit note); a refund without `refunds.approve` is `REFUND_FORBIDDEN` | **Pass** |
| 4 | FR-TAX-3 AC3, PHASE5 AC4 | 3 cables (₹1,500, unpaid): credit note for 1 = ₹500 (own series, `…/0001`), 1 more in INSPECTION, nothing released; credit note for the rest (`…/0002`); the two notes' taxable, CGST, SGST and totals equal the original line exactly; a further return is `RETURN_EXCEEDS_SOLD`; balance 0; the invoice can no longer be cancelled (`HAS_NOTES`); a credit note cannot itself be credited (`NOT_AN_INVOICE`) | **Pass** |
| 5 | FR-TAX-3 AC3, FR-POS-3 AC5, FR-INV-6 | Fully paid phone + cable: Billing 403; Manager credits the phone with a UPI refund — ₹15,000 released and refunded, unit PENDING_INSPECTION, invoice credited 15,000, outstanding 0, PAID; inspection RESTOCK makes the unit IN_STOCK; crediting the cable as advance leaves ₹500 advance (balance −500) | **Pass** |
| 6 | D-042 | A full credit note of a ₹333.33 sale rounded to ₹333.00 also takes the round-off: total ₹333.00 | **Pass** |
| 7 | PHASE5 AC4 | Two credit notes for the last unit at once: one 201, the other `RETURN_EXCEEDS_SOLD` | **Pass** |
| 8 | FR-TAX-3 AC4 | Debit note of ₹100 taxable on an 18 % line: ₹118 (CGST 9 + SGST 9); balance and receivable +₹118; a later payment is allocated to the debit note; a walk-in invoice is `NEEDS_CUSTOMER` | **Pass** |
| 9 | NFR tenancy | Other businesses 404 (cancel, credit note, by their URL and ours); suspended business 403 `TENANT_READ_ONLY` | **Pass** |
| 10 | — | Negative controls: (a) the "not more than sold" quantity check removed → test 4 fails (test 7 still passes: with no quantity given the remaining quantity is 0 and is refused separately); (b) paid money not released on a credit note → test 5 fails. Restored | **Detected** both |
| 11 | — | `pnpm check`: domain 130, API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 209; CI #25 (5.4 push, includes 5.3) green | **Pass**, exit 0 |

## TR-0022 · 2026-10-27 · Portal visual redesign (design system, app shell)

**Environment:** as TR-0011; Chromium (Playwright 1.63) against the built web app.

| # | Check | Result |
|---|---|---|
| 1 | Phase 3 exit browser test (sign-up → approval → MFA → setup → live → invite) on the redesigned screens, incl. axe (no serious/critical issues), no horizontal overflow at 1280/768/360 px, no CSP violations or page errors | **Pass** (5/5) |
| 2 | Phase 4 exit browser test (8 inventory screens × 3 widths axe, overflow, CSP) on the redesigned screens | **Pass** |
| 3 | First run after the redesign failed: the pending-application page no longer showed the text "Application status:" and the overview no longer showed "Status:" that the test (and screen-reader users) rely on; both labels restored | **Defect found and fixed** |
| 4 | Visual review: screenshots of sign-in, home, overview, catalogue, stock, purchases, suppliers, staff at 1440 px and overview/stock at 390 px taken from the running app with synthetic data and shared with the user (not stored in the repository) | Done |
| 5 | `pnpm check`: domain 130, API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 209 | **Pass**, exit 0 |

## TR-0023 · 2026-10-27 · Phase 5 increment 5.6 — print and PDF

**Environment:** as TR-0011, migrations 0001–0016; headless Chromium (Playwright 1.63) for PDFs; `pdftotext` (poppler-utils) to read PDF text.

| # | Requirement / AC | Check (`print.db.test.ts`, `amount-words.test.ts`) | Result |
|---|---|---|---|
| 1 | FR-PRN-1 AC1 | Owner saves default size 80 mm, address, phone (normalised to +919800011122), email and terms; Billing 403; invalid phone 422 | **Pass** |
| 2 | FR-PRN-1 AC2, FR-TAX-4 AC2 | Inter-state B2B sale (phone with IMEI + 2 cables, part-paid by UPI) printed in A4, A5, 80 mm and 58 mm: each shows title, shop name, address, phone, seller GSTIN, buyer name/GSTIN/state, place of supply, HSN codes, IMEI, total ₹16,000.00, "Rupees Sixteen Thousand Only", UPI payment and reference, balance due ₹6,000.00, terms; IGST and no CGST; no `<script>`; print CSP `default-src 'none'`; a customer name containing markup is shown escaped; no e-invoice/IRN/QR/digital-signature wording | **Pass** |
| 3 | FR-PRN-1 AC1–2, D-044 | Without `size` the business default is used; after changing the shop address the reprint still shows the address as issued; the default follows the settings | **Pass** |
| 4 | FR-TAX-1 AC4, FR-TAX-3 | Bill of Supply has no tax summary or GST column; a credit note prints "Credit Note" and "Against invoice"; a cancelled invoice prints "CANCELLED" | **Pass** |
| 5 | FR-PRN-1 AC3 | PDF for each size: `application/pdf`, starts `%PDF-`, attachment filename from the number; every word of the print page (without the screen-only toolbar) appears in the PDF text (case-insensitive: headings are uppercased by CSS) | **Pass** |
| 6 | NFR tenancy | Other businesses 404 (print, PDF); Inventory role 403; unknown size 400 | **Pass** |
| 7 | FR-PRN-1 AC2 | Amount in words, Indian system (thousand/lakh/crore, paise), boundaries and a property test over 0…10¹³ paise; state names for all GST codes | **Pass** |
| 8 | — | **Defect found by test 5 and fixed:** on A5 the line table was wider than the page and the Amount column was cut off in the PDF. The discount column now appears only when a line has a discount, A5 uses tighter cells, and amounts do not wrap; an A5 invoice with a discount was rendered and inspected as an image and fits | **Fixed** |
| 9 | — | Negative control: HTML escaping disabled → test 2 fails. Restored | **Detected** |
| 10 | FR-PRN-1 AC4 | Manual printing on Chrome (Android/desktop), Safari (iOS), Firefox and an 80 mm thermal printer | **Not done** (needs real devices) |
| 11 | — | `pnpm check`: domain 134, API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 215 | **Pass**, exit 0 |

## TR-0024 · 2026-10-28 · Phase 5 increment 5.7 — reports and exports

**Environment:** as TR-0011, migrations 0001–0016; Chromium for PDFs and the browser test; `pdftotext`, `unzip` and Python's `zipfile`/`xml.dom` to read exports.

Seeded dataset (`reports.db.test.ts`, GST-registered shop, 18 % inclusive): A — 31 Mar 2026 23:30 IST, 1 cable ₹500 cash; B — 1 Apr 2026 00:15 IST, 2 cables ₹1,000 cash; C — 5 Oct 2026 23:30 IST, phone ₹15,000 (cost ₹11,000) + cable to customer X, ₹10,000 UPI; D — 6 Oct 2026 00:30 IST, 4 cables ₹2,000 card; E — 7 Oct, cable sold and cancelled the same day with a cash refund; credit note for C's cable on Sunday 11 Oct. Second shop: invoices 10, 45 and 100 days old (₹1,000 each, unpaid), one 70 days old part-paid (₹700 due), ₹500 advance, 6 items @ ₹400 with 2 moved to damaged, 1 phone @ ₹9,000.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-RPT-3 AC1 | Day reports: 31 Mar = ₹500, 1 Apr = ₹1,000, 5 Oct = ₹15,500, 6 Oct = ₹2,000 (each one invoice) | **Pass** |
| 2 | FR-RPT-3 AC1, FR-RPT-1 AC2 | FY 2025-26 = ₹500; FY 2026-27: 3 invoices, gross ₹18,500, returns ₹500, net ₹18,000, taxable ₹15,254.24, tax ₹2,745.76 (exact); previous FY net ₹500; the cancelled sale E counts nowhere | **Pass** |
| 3 | FR-RPT-1, FR-RPT-3 AC2 | October: 2 invoices, gross ₹17,500, returns ₹500, net ₹17,000, previous month 0; Monday weeks (5–11 Oct) include the Sunday credit note, with week start set to Sunday (4–10 Oct) they do not | **Pass** |
| 4 | FR-RPT-2, FR-LED-3 | Definitions returned for every summary metric; no label calls sales profit or cash; inverted custom range 400 `INVALID_PERIOD` | **Pass** |
| 5 | FR-RPT-1 AC2 | Sales by model (October): phone qty 1, net ₹15,000, taxable ₹12,711.86, cost ₹11,000, margin ₹1,711.86; cable qty 4, net ₹2,000, taxable ₹1,694.92, cost ₹800, margin ₹894.92; margin summary: taxable ₹14,406.78, cost ₹11,800, margin ₹2,606.78 (18.09 %); Billing 403; Accountant sees cost | **Pass** |
| 6 | FR-RPT-1, FR-RPT-3 | Cash received in October: card ₹2,000, cash ₹500 received and ₹500 refunded (net 0), UPI ₹10,000; total net ₹12,000; by IST day the UPI payment is on 5 Oct, the card payment on 6 Oct | **Pass** |
| 7 | FR-RPT-1 AC2 | Returns October ₹500 (1 credit note); tax summary: credit notes −₹423.73 taxable, −₹38.13 CGST, −₹38.14 SGST; tax invoices (2) ₹14,830.51, CGST ₹1,334.74, SGST ₹1,334.75; totals ₹14,406.78 / ₹1,296.61 / ₹1,296.61; note says it is not a GST return | **Pass** |
| 8 | FR-RPT-1 AC2 | Ageing: Yash ₹1,000 in each of 0–30, 31–60 and 90+; Zara ₹700 in 61–90; totals ₹3,700; advances ₹500 shown separately. Stock valuation: item 4 sellable (₹1,600) + 2 other (₹800), phone ₹9,000; total ₹11,400 | **Pass** |
| 9 | FR-RPT-4 AC1–2 | CSV: byte-order mark, header `Date,Invoices,Gross sales (₹),…`, day rows and total row equal the report; a customer named `=cmd|…` is written as `'=cmd|…`; 2 `report.export` audit events. XLSX: valid package (all parts parse as XML), numeric cell 14406.78. PDF: tax summary and customer statement; statement CSV closing balance ₹5,000.00; returns as PDF refused `FORMAT_UNAVAILABLE`; Billing and Inventory 403; other businesses 404 | **Pass** |
| 10 | FR-RPT-2, NFR-1 | Browser (`reports-browser.db.test.ts`): the owner opens Reports from the side menu; net sales ₹1,500.00 with its definition, gross margin and tax note shown, no figure called profit, export links; axe (no serious/critical) at 1280/768/360 px, no overflow, no CSP violations; Billing has no Reports menu entry | **Pass** |
| 11 | — | Negative controls: (a) cancelled invoices counted → 3 tests fail; (b) payment day boundaries in UTC instead of IST → test 6 fails; (c) CSV formula guard removed → test 9 fails. Restored | **Detected** all |
| 12 | — | Defect found while writing the tests and fixed: credit-note, debit-note, cancellation and refund ledger entries were stamped with the clock time instead of the document time, so statements and cash reports could disagree with the documents' dates | **Fixed** |
| 13 | — | `pnpm check`: domain 140, API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 231 | **Pass**, exit 0 |

## TR-0025 · 2026-10-28 · Phase 5 increment 5.8 — POS and sales screens, Phase 5 exit test

**Environment:** as TR-0011; Chromium (Playwright 1.63) against the built web app (`phase5-exit.db.test.ts`). Synthetic GST-registered shop; Billing cashier (limit 2 % / ₹500); phone ₹15,000 (2 units by IMEI), cable ₹500; one earlier ₹500 sale today.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | Exit, FR-POS-1…3 | The cashier opens Point of sale from the side menu, scans the phone's IMEI (Enter adds it), adds the cable by SKU, enters a new mobile and adds the customer, gives ₹200 off the phone (within limit), total ₹15,300.00; pays ₹10,000 UPI (reference) + ₹3,000 cash, balance due ₹2,300.00 shown; completes: invoice `T26-27/0002` (next after the earlier `…/0001`) | **Pass** |
| 2 | Exit, FR-PRN-1 | From the receipt panel: A4 print page shows TAX INVOICE, number, IMEI, customer, ₹15,300.00, "Rupees Fifteen Thousand Three Hundred Only", ₹2,300.00 due and the shop address; 80 mm page shows the IMEI; PDF downloads as `application/pdf` | **Pass** |
| 3 | Exit, FR-LED-1 | Customers → search "Priya" → profile shows balance ₹2,300.00 "The customer owes the shop."; recording ₹2,300 by UPI → "Nothing owed." | **Pass** |
| 4 | Exit, FR-TAX-3, FR-INV-6 | The owner opens Invoices → the invoice → credit note for line 1 (phone) kept as advance → "Credit note issued."; the unit is PENDING_INSPECTION | **Pass** |
| 5 | Exit, FR-RPT-1 | Day reports: 2 invoices, gross ₹15,800, returns ₹14,800, net ₹1,000, taxable ₹847.46, tax ₹152.54; tax summary taxable ₹847.46, CGST ₹76.26, SGST ₹76.28, IGST 0; receivables ₹0 due, ₹14,800 advance; the Reports screen shows net ₹1,000.00 with its definition | **Pass** |
| 6 | FR-POS-1 AC3 | Single-item sale to a known customer: fill IMEI, Enter, fill mobile (customer found), tap Cash, Complete sale = **5 interactions** (≤ 6); invoice `…/0003` | **Pass** |
| 7 | FR-POS-1 AC1 | Counter search over 10,000 variants (60 requests, 6 query shapes, in-process API incl. session check): **p95 42.0 ms, median 29.4 ms** — dev container, not the reference environment | **Pass** (< 300 ms) |
| 8 | NFR-1, NFR-17 | axe (no serious/critical) at 1280/768/360 px on POS (with a cart), customer profile, customers, invoices and invoice detail (15 audits); no horizontal overflow; no CSP violations or page errors | **Pass** |
| 9 | — | **Defects found by the browser test and fixed:** (a) POS overflowed by 333 px at 360 px — screen-reader-only text inside a scrolling table escaped the scroll container (absolutely positioned); table scrollers are now `relative`, which fixes it for every table; (b) the POS grid had no column template below 1280 px; (c) a `<dl>` held a non-term element (axe); (d) two selects on the invoice page had the same label "Money already paid" — now distinct; (e) at 1280 px the cart table was cramped and the sticky payment card covered the Hold button — layout reworked | **Fixed** |
| 10 | — | Negative control: POS no longer sends line discounts → the exit test fails (total ≠ ₹15,300). Restored | **Detected** |
| 11 | — | `pnpm check`: domain 140, API unit 37, DB 54 + schema checks, auth schema drift ok, API DB 239 (includes Phase 3, Phase 4, reports and Phase 5 browser tests) | **Pass**, exit 0 |
| 12 | Exit | CI on GitHub for commit `2cb0c4d`: run #32 (Node 22 and Node 24 jobs: lint, format, typecheck, build, unit, DB and browser tests, memory checks, audit, secret scan) | **Pass** (success) |

## TR-0026 · 2026-10-28 · Phase 6 increment 6.1 — customer profile, owned units, customer export

**Environment:** as TR-0011 (`crm.db.test.ts`, `packages/domain` unit tests). Synthetic unregistered shop; Billing and Manager staff; phone (serialised, 12-month warranty, "Brand service"), charger (6 months), cable (no warranty).

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-CRM-1 AC1, FR-CRM-2 AC1 | A customer with only name and mobile is created (optional fields empty); a full profile stores alternate mobile `+919820000003`, DOB, tags trimmed/de-duplicated (`VIP`, `Repair customer`), channels de-duplicated; a later update audits field names only | **Pass** |
| 2 | FR-CRM-1 AC1 | Refused: DOB in the future or before 1900 (`DOB_INVALID`), 11 tags or a tag with a comma (`TAGS_INVALID`), unknown channel (400), bad alternate number (`MOBILE_INVALID`); nothing half-created. The database itself refuses 11 tags, an unknown channel and a DOB before 1900 | **Pass** |
| 3 | FR-CRM-1 AC2 | Owned items: unit sold 31 Jan 2024 with 12 months → warranty end 2025-01-31, provider recorded; charger 6 months → 2024-07-31; the cable (no warranty, no unit) is not listed; changing the variant's warranty later does not change what was recorded; a unit returned on a credit note disappears from the list; an item sold with no warranty shows 0 months and no end date | **Pass** |
| 4 | FR-CRM-2 AC2 | Export: Manager and Billing 403 (`customers.export` is owner-only by default); unknown or empty field list 400; `fields=mobile,name,tags&tag=bulk` returns exactly `Mobile,Name,Tags` and one row in that order (mobile prefixed with an apostrophe by the formula guard), no DOB; audit events hold field names, count and whether a tag filter was used, and no personal data | **Pass** |
| 5 | Access | Other businesses get 404 on owned items and export (their own export is empty); a suspended (read-only) business can still view owned items and export, but cannot edit a customer (`TENANT_READ_ONLY`) | **Pass** |
| 6 | Domain | `addMonths` (month-end clamping as PostgreSQL), `warrantyEnd`, `normalizeTags`: 3 new unit tests | **Pass** (domain 143) |
| 7 | — | Negative control: credit-note returns not subtracted from owned items → test 3 fails. Restored | **Detected** |
| 8 | — | `pnpm check`: domain 143, API unit 37, DB 54 + schema checks (83 PASS notices, 0 FAIL), Better Auth schema matches migrations, API DB 247 | **Pass**, exit 0 |

## TR-0027 · 2026-10-28 · Phase 6 increment 6.2 — consent, suppression, messages

**Environment:** as TR-0011 (`messaging.db.test.ts`, `packages/domain` unit tests). Synthetic unregistered shop; Billing and Manager staff. **No messaging provider is connected**: the API runs with none configured; a recording test adapter (in the test file, it contacts nobody) stands in where a provider result is needed. The API tests open the quiet-hours window all day (asserted to apply to the shop's settings row) so they do not depend on the clock; quiet hours are tested with a fixed clock.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-CON-1 AC4 | New customer: WhatsApp and SMS transactional allowed, marketing not; email not allowed (no address) | **Pass** |
| 2 | FR-CON-1 AC1 | Consent GRANTED then WITHDRAWN: latest decides, history newest first, source and actor stored; audit metadata channel/purpose/status only; consent rows cannot be updated (owner role); source shorter than 3 characters 400 | **Pass** |
| 3 | WORKFLOWS §9, FR-MSG-1 AC3 | Marketing: Billing cannot draft (403); Manager drafts (address = customer's mobile), cannot send unapproved (`INVALID_STATE`), cannot approve or send (403); owner approves and sends → no provider → `FAILED` / `PROVIDER_NOT_CONFIGURED`; history DRAFT → PENDING_APPROVAL → APPROVED → QUEUED → FAILED; list reports `provider.configured: false` | **Pass** |
| 4 | FR-CON-1 AC2 | Approved marketing to a customer without consent → `BLOCKED` / `NO_MARKETING_CONSENT` at send time | **Pass** |
| 5 | FR-CON-1 AC2 (exit) | A message approved and a transactional message queued **before** the opt-out are both `BLOCKED` / `SUPPRESSED` at dispatch; the address is on the suppression list at once; SMS (another channel) stays allowed; a Manager cannot re-grant consent on the suppressed contact (`RELEASE_NEEDS_APPROVER`), the owner can, which lifts the suppression | **Pass** |
| 6 | FR-CON-1 AC2 | Inbound STOP hook: suppresses and withdraws marketing consent; a repeat is a no-op; an unknown number is suppressed too (no customer) | **Pass** |
| 7 | FR-MSG-1 AC3 | Transactional with `send: true` is queued and dispatched at once → `FAILED` / `PROVIDER_NOT_CONFIGURED` (events QUEUED, FAILED); marketing with `send: true` refused; no email address → `NO_ADDRESS` | **Pass** |
| 8 | FR-MSG-1 AC4 (test adapter) | Accepted → `SENT` with the provider reference, the adapter received exactly the channel/address/text; re-dispatch skipped; receipts DELIVERED then READ, a late DELIVERED ignored, another provider's reference not matched; history QUEUED → SUBMITTED → SENT → DELIVERED → READ. Rejection and an exception → `FAILED` with the code / `PROVIDER_ERROR` | **Pass** |
| 9 | WORKFLOWS §9 (DB) | Direct SQL: DRAFT → SENT and DRAFT → QUEUED refused (LB002); editing the text after approval refused (LB003); SUBMITTED → SENT without a provider reference refused (LB020); marketing cannot be inserted QUEUED, nothing can be inserted SENT; message events and suppressions cannot be changed or deleted | **Pass** |
| 10 | FR-REM-1 AC3 | Quiet hours 09:00–21:00: marketing at 22:00 IST deferred to 09:00 IST next day; not due at 08:59, sent at 09:00 (test adapter); a transactional message at 22:00 goes at once | **Pass** |
| 11 | Access | Other businesses: 404 on consents, message and send, empty lists; read-only (suspended) business can view consents and messages but recording consent, drafting, approving and editing answer `TENANT_READ_ONLY` | **Pass** |
| 12 | Domain | `gateDecision` (precedence: erased, no address, suppressed, withdrawn, marketing consent) and `nextAllowedTime`/`localMinute`: 4 tests; `messaging.ts` added to the coverage gate (100 % lines, 96 % branches) | **Pass** (domain 147) |
| 13 | — | Negative control: the dispatch gate ignores suppression → 2 tests fail (opt-out test and a later one). Restored | **Detected** |
| 14 | — | `pnpm check`: domain 147, API unit 37, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 258 | **Pass**, exit 0 |

## TR-0028 · 2026-10-28 · Phase 6 increment 6.3 — reminders

**Environment:** as TR-0011 (`reminders.db.test.ts`, `packages/domain` unit tests). Runs use a fixed clock: 10 Nov 2026, 11:30 IST. Synthetic shop: Asha (birthday today, WhatsApp marketing consent, phone sold 20 Nov 2025 with 12 months' warranty), Bilal (birthday today, no consent, warranty ended June 2026), Chitra (no DOB; charger with 6 months' warranty sold 15 May 2026, no IMEI; phone sold 19 May 2026 with ₹600 still owed). No provider connected; a recording test adapter stands in for auto-send.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-REM-1 AC3 | All four types off by default with auto-send off; payment due is transactional, the others marketing; settings visible to anyone with `customers.view`, changes need `marketing.draft` (Billing 403) | **Pass** |
| 2 | FR-REM-1 AC2 | Saving a template with `{discount}` (unknown) and `{model}` (not available for birthdays) → 422 with both problems | **Pass** |
| 3 | FR-REM-1 AC3 | A Manager cannot turn on auto-send (`AUTO_SEND_NEEDS_APPROVER`) but can enable drafts; settings audited without personal data | **Pass** |
| 4 | FR-REM-1 AC1–2 (exit) | Run: drafts birthday (Asha only), warranty (Asha's phone, "ends on 20 Nov 2026", IMEI last 4) and service due (Chitra's phone, 175 days); skipped and reported: Bilal (no consent), Chitra's charger (no IMEI → `MISSING_FIELD imei_last4`), Chitra's payment reminder on email (`NO_ADDRESS`); Bilal's past warranty not drafted; all drafts `DRAFT`, nothing dispatched; run summary and audit hold counts only | **Pass** |
| 5 | FR-REM-1 AC3 | Second run: nothing new (3 already drafted); after switching payment due to WhatsApp, the skipped reminder is drafted ("₹600.00 is due"); two concurrent runs create nothing | **Pass** |
| 6 | FR-REM-1 AC3 | Auto-send turned on by the owner: Dev (consent) drafted, approved by the owner's standing approval and SENT through the test adapter (events DRAFT → PENDING_APPROVAL → APPROVED → QUEUED → SUBMITTED → SENT); Esha (opted out, consent withdrawn) not drafted | **Pass** |
| 7 | FR-REM-1 AC3, FR-CON-1 AC2 | Auto-send at 22:30 IST: a suppressed contact with consent still recorded is `BLOCKED SUPPRESSED`; another is deferred to 09:00 IST next day | **Pass** |
| 8 | Access | Other businesses see nothing and their own run creates nothing; read-only business can view reminders but cannot change settings or run (`TENANT_READ_ONLY`) | **Pass** |
| 9 | Domain | `templateProblems`, `renderTemplate`, `templatePlaceholders`, default templates valid: 3 tests; `reminders.ts` in the coverage gate (100 %) | **Pass** (domain 150) |
| 10 | — | **Defects found by these tests and fixed:** (a) the birthday reminder key did not include the customer, so one customer's birthday reminder blocked all others that year; (b) message events written in one transaction shared a timestamp and could come back out of order — migration 0019 adds an insertion sequence and wall-clock time | **Fixed** |
| 11 | — | **Flaky existing tests fixed:** `inspections-reports` and `inventory` fixtures picked units by `created_at`, which is equal for units created together; the code-lookup test failed once in the full run. They now order by IMEI | **Fixed** (file passed 3/3 alone before the fix as well) |
| 12 | — | Negative control: birthday drafted without consent → 3 tests fail. Restored | **Detected** |
| 13 | — | `pnpm check`: domain 150, API unit 37, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 266 | **Pass**, exit 0 |

## TR-0029 · 2026-10-28 · Phase 6 increment 6.4 — expenses and the operating-profit estimate

**Environment:** as TR-0011 (`expenses.db.test.ts`). Synthetic unregistered shop; Manager, Accountant and Billing staff; October sales: 3 cables at ₹1,000 (cost ₹100 each), issued through the sales module on 10 Oct 2026.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-EXP-1 AC1 | Module off by default: recording and receipt upload answer `MODULE_DISABLED`; a Manager cannot switch it on (403); the owner can; audited | **Pass** |
| 2 | FR-EXP-1 AC1 | Manager and Accountant cannot record (no `expenses.manage`); the owner records rent ₹10,000 by bank transfer with reference and notes; audit holds category, amount and whether a receipt is attached | **Pass** |
| 3 | FR-EXP-1 AC1 | Refused: future date (`DATE_INVALID`), a 16-digit card number as reference, amount 0, unknown category | **Pass** |
| 4 | FR-EXP-1 AC1 | Receipt: a non-image file refused; a PNG stored privately and attached; served with `default-src 'none'; sandbox`, bytes identical; the same upload cannot be attached twice; another business's upload cannot be attached; another business gets 404 for the file | **Pass** |
| 5 | FR-EXP-1 AC2 | Reversal: reason under 10 characters 400; full reversal with the same date, category and method and negated amount; second reversal `ALREADY_REVERSED`; reversing a reversal `NOT_REVERSIBLE`; list shows `reversedBy`; audited. Direct SQL: update refused; a partial reversal refused (LB021) | **Pass** |
| 6 | FR-EXP-1 AC2 | Two simultaneous reversals of one expense: exactly one succeeds (201 + 409) | **Pass** |
| 7 | FR-RPT-1 (exit) | October expenses: rent ₹10,000, supplies ₹450 (the reversed electricity bill nets to zero), total ₹10,450. Operating profit (estimate): taxable ₹3,000, COGS ₹300, gross margin ₹2,700, expenses ₹10,450, estimate −₹7,750; labelled an estimate with definitions and notes. A further ₹123.45 expense changes it by exactly −₹123.45; September has no expenses; Billing 403; CSV export row `Operating profit (estimate),-7873.45` | **Pass** |
| 8 | FR-EXP-1 | Switched off later: new entries refused; entries recorded earlier still count and the report says so | **Pass** |
| 9 | Access | Other businesses: 404 on reverse and list, their own list empty; read-only business can list but not record or reverse (`TENANT_READ_ONLY`) | **Pass** |
| 10 | — | Defect found while testing and fixed: reversing locked the expense row with `FOR UPDATE`, which the append-only table's grants (no UPDATE) refuse; reversals are now serialised with an advisory lock and the unique index | **Fixed** |
| 11 | — | Negative control: expenses report ignores reversals → 2 tests fail. Restored | **Detected** |
| 12 | — | `pnpm check`: domain 150, API unit 37, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 275 | **Pass**, exit 0 |

## TR-0030 · 2026-10-28 · Phase 6 increment 6.5 — dashboard tiles

**Environment:** as TR-0011 (`dashboard.db.test.ts`). Synthetic unregistered shop at the real clock (the dashboard is about today): a ₹2,000 sale of 2 cables (cost ₹100 each) to one customer with ₹500 paid in cash, ₹300 advance by UPI from another; cable reorder level 20 with 8 left, charger level 1 with 10; one payment-due reminder drafted. Billing, Accountant and Inventory staff.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-LED-3 AC1, FR-INV-7 AC1 | Owner: tiles net sales (today ₹2,000), cash received (₹800), receivables (₹1,500), customer advances (₹300), gross margin (₹1,800), low stock (1), reminders waiting (1), each with its §7 definition and source report; no sales tile labelled profit or cash | **Pass** |
| 2 | AC2 | Tiles equal the report endpoints for day and month (sales summary, payments, margin), receivables and advances (ageing report) and the low-stock list | **Pass** |
| 3 | Permissions | Billing sees low stock and reminders only; Inventory low stock only; Accountant all seven | **Pass** |
| 4 | Access | Another business gets 404 on this shop's dashboard and zeros on its own; read-only (suspended) business still sees the dashboard | **Pass** |
| 5 | — | Negative control: financial tiles shown without `reports.financial.view` → test 3 fails. Restored | **Detected** |
| 6 | — | `pnpm check`: domain 150, API unit 37, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 279 | **Pass**, exit 0 |

## TR-0031 · 2026-10-28 · Phase 6 increment 6.6 — erase personal data, tenant export

**Environment:** as TR-0011 (`privacy.db.test.ts`); ZIPs read with Python's `zipfile` (an independent reader, CRC checked). Synthetic shop; customer "Meera Synthetic" with mobile, email, DOB, address, notes, tags, WhatsApp marketing consent, one issued invoice, one failed SMS and one approved (pending) WhatsApp message.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-PRV-1 AC2 | Manager (`OWNER_ONLY`) and Billing refused; reason under 10 characters 400; a session older than 10 minutes `REAUTH_REQUIRED`; another business 404 | **Pass** |
| 2 | FR-PRV-1 AC2 (exit) | Erasure: name "Erased customer", mobile, alternate, email, address, DOB, notes, tags, channels cleared, `erased: true`; not found by name search; 6 consents withdrawn, nothing allowed on any channel; WhatsApp, SMS and email addresses suppressed (ERASED); the pending message cancelled (`CUSTOMER_ERASED`) and both messages redacted to `[erased]` with their status history kept; no new message can be created | **Pass** |
| 3 | FR-PRV-1 AC2 (exit) | The issued invoice still prints "Meera Synthetic" (party snapshot) | **Pass** |
| 4 | FR-PRV-1 AC2 | One audit event without name, number or reason; the reason is stored with the privacy request; second erasure `ALREADY_ERASED`; editing the erased customer 404; un-redacting a message refused (LB003); the number can be used for a new customer record and stays suppressed | **Pass** |
| 5 | FR-PRV-2 (exit) | Export: Manager `OWNER_ONLY`, other business 404; owner gets `application/zip` with README and 22 CSVs (catalogue, purchases, stock, units/IMEIs, customers, consents, invoices, lines, payments, allocations, refunds, ledger, expenses, messages); customers.csv shows the erased customer anonymised, invoices.csv keeps the printed snapshot, messages redacted; no other business's ID anywhere; audited with file and row counts | **Pass** |
| 6 | FR-PRV-2, BR-T4 | Another business's export holds only its own (no customers); a suspended (read-only) business can export but not erase (`TENANT_READ_ONLY`); a stale session `REAUTH_REQUIRED` | **Pass** |
| 7 | — | Negative control: erasure without suppressing the contact → 2 tests fail. Restored | **Detected** |
| 8 | — | `pnpm check`: domain 150, API unit 37, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 285 | **Pass**, exit 0 |

## TR-0032 · 2026-10-28 · Phase 6 increment 6.7 — screens and the Phase 6 exit test

**Environment:** as TR-0011; Chromium (Playwright 1.63) against the built web app (`phase6-exit.db.test.ts`), real clock (dates derived from today in IST). The API runs with a **recording test adapter** as the messaging provider (it contacts nobody); "not configured" is shown with the default adapter. Quiet hours opened all day for the run (quiet hours: TR-0027 #10). Synthetic shop: Asha (birthday today, phone whose 12-month warranty ends in 5 days), Bilal (birthday today, warranty ended last year, no consent), Chitra (phone bought today, email).

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | Exit, FR-CON-1 AC1 | The owner records WhatsApp marketing consent for Asha on her profile ("Allowed / Allowed" for WhatsApp); Bilal has none on any channel; Asha's owned phone shows its warranty end date | **Pass** |
| 2 | Exit, FR-REM-1 | On Reminders the owner turns on birthday and warranty reminders and runs them: "2 drafted, 1 skipped" — Asha's birthday and warranty only; Bilal skipped with "no marketing consent"; Chitra not drafted | **Pass** |
| 3 | Exit, FR-CON-1 AC2–3, FR-MSG-1 AC4 | Birthday reminder sent for approval, approved, sent → **Sent** (the test adapter received exactly Asha's number). The warranty reminder is approved, Asha is opted out of WhatsApp on her profile, then Send → **Blocked**; adapter not called again. Her Messages section shows "Reason: the contact opted out" and both histories (…→ Submitted → Sent; …→ Queued → Blocked) | **Pass** |
| 4 | Exit, AC5 of 6.2 | Without a provider (default adapter) a queued message → `FAILED / PROVIDER_NOT_CONFIGURED`; Chitra's profile shows "Reason: no messaging provider is connected" | **Pass** |
| 5 | Exit, FR-EXP-1, FR-RPT-1 | Expenses turned on and ₹1,234.56 electricity recorded on the Expenses screen → today's operating-profit estimate changes by exactly −₹1,234.56; the Reports screen shows the "Operating profit (estimate)" section with the expense | **Pass** |
| 6 | Exit, FR-CRM-2 AC2 | Customer export with Name and Tags chosen: file header exactly `Name,Tags`, row `Asha Rao (synthetic),VIP`, no mobile numbers; one `customer.export` audit event with those fields | **Pass** |
| 7 | Exit, FR-PRV-1 AC2 | Erasing Chitra on her profile: heading becomes "Erased customer", her email gone from the page; her invoice print still shows "Chitra Iyer (synthetic)" | **Pass** |
| 8 | Exit, FR-PRV-2 | The overview's "Download all shop data" link returns a valid ZIP with README, customers, invoices, invoice lines, payments, expenses and messages CSVs; customers.csv anonymised, expenses.csv has the expense | **Pass** |
| 9 | Exit, FR-LED-3 AC1 | Overview "At a glance": net sales today ₹12,000.00 with "Gross sales minus returns.", low stock and reminders tiles with definitions; equals `GET /dashboard` | **Pass** |
| 10 | NFR-1, NFR-17 | axe (no serious/critical) at 1280/768/360 px on customer profile, reminders, expenses, customers and overview (15 audits); no horizontal overflow; no CSP violations or page errors | **Pass** |
| 11 | — | **Defects found by the browser test and fixed:** (a) a reminder setting form re-mounted after saving (its key included saved values), losing the "saved" message; (b) the erase message disappeared with the erase section as the profile reloaded — the test now checks the erased profile itself, which says so. The Phase 5 reports browser test's "no profit anywhere" check was narrowed to allow the separately defined operating-profit estimate (FR-LED-3 AC2 forbids calling sales profit) | **Fixed** |
| 12 | — | Negative control: the send-time gate ignores the opt-out list → exit test 3 fails. Restored | **Detected** |
| 13 | — | `pnpm check`: domain 150, API unit 37, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 295 (includes Phase 3–6 browser tests) | **Pass**, exit 0 |
| 14 | Exit | CI on GitHub for commit `8a40b2f`: run #40 (Node 22 and Node 24 jobs: lint, format, typecheck, build, unit, DB and browser tests, memory checks, audit, secret scan) | **Pass** (success) |

## TR-0033 · 2026-10-28 · Phase 7 increment 7.1 — guarded outbound HTTP client

**Environment:** dev container; unit tests in `apps/api/test/outbound.test.ts` (no network: DNS and transport injected; the real https transport is exercised only with blocked targets, which never connect), ESLint rule tests in `tooling/eslint/no-raw-http.test.js`.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-HUB-5 AC3 | 36 addresses blocked: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 incl. 169.254.169.254, 172.16/12, 192.168/16, documentation and benchmarking ranges, multicast, reserved, broadcast, `::`, `::1`, fc00::/7, fe80::/10 (also with a zone id), ff00::/8, 2001:db8::/32, IPv4-mapped (dotted and hex), IPv4-compatible, NAT64 and 6to4 forms of private/metadata addresses, and non-IP strings; 7 public addresses (incl. 100.128.0.1, 172.32.0.1, a public IPv6 and a mapped public IPv4) allowed | **Pass** |
| 2 | FR-HUB-5 AC5 | URL encodings: decimal `2130706433`, hex `0x7f.0.0.1`, octal `0177.0.0.1`, short `127.1`, hex `0xa9fea9fe`, bracketed IPv6 loopback/mapped/ULA → all `BLOCKED_ADDRESS`; `http`, `ftp`, `file` refused; port 8443 refused unless allowed; credentials in the URL refused; invalid URL refused | **Pass** |
| 3 | FR-HUB-5 AC3 | A name resolving to a private, mixed (public + loopback) or IPv6 link-local answer is refused; an unresolvable name → `DNS_FAILED` | **Pass** |
| 4 | FR-HUB-5 AC3 (rebinding) | A resolver that answers public first and metadata afterwards is called **once**; the transport connects to the public address that was checked, with the host name for TLS and Host | **Pass** |
| 5 | FR-HUB-5 AC4 | A redirect to a private address or to `http` is refused; a redirect loop stops after 3 redirects (4 requests); 303 switches POST to GET; the final URL is reported | **Pass** |
| 6 | FR-HUB-5 AC1 | Lint rule `lbgos/no-raw-http` (server packages and API source, outbound module exempt): 5 valid and 10 invalid cases (http/https/undici/axios/net imports, re-export, dynamic import, require, `fetch`, `globalThis.fetch`); the existing server code passes it | **Pass** |
| 7 | — | Negative control: the 169.254.0.0/16 range removed → 8 tests fail. Restored | **Detected** |
| 8 | — | `pnpm check`: ESLint rules 26, domain 150, API unit 102, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 295 | **Pass**, exit 0 |
| 9 | — | CI run #41 on `82b708a`: all tests passed, but the **secret scan failed** — the fake `user:pass@` URL in the credentials-in-URL test matched secretlint's basic-auth rule (false positive; not a real credential). Fixed by building that URL at runtime; `pnpm secrets` now clean locally and added to the pre-commit checks | **Failed → fixed** |

## TR-0034 · 2026-10-28 · Phase 7 increment 7.2 — secret store with envelope encryption

**Environment:** as TR-0011 (`secrets.db.test.ts`) plus unit tests (`secrets-crypto.test.ts`). Synthetic test keys (`Buffer.alloc(32, 7)` etc.) and synthetic values only; no real secret was used.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | ADR-13 | Keyring parsing: first version current; empty, missing key, 16-byte key, duplicate version, bad version name refused with messages that never contain key material; a malformed `SECRETS_KEK` stops the server without echoing it | **Pass** |
| 2 | FR-HUB-3 AC2 | AES-256-GCM round trip; two seals of one value differ (fresh data key and nonce); ciphertext holds no plaintext; a flipped byte, another secret ID, another business, another purpose or a wrong KEK all fail to open | **Pass** |
| 3 | ADR-13 | KEK rotation re-seals only the data key (payload unchanged); afterwards a keyring with only the new KEK opens it; already-current secrets are untouched | **Pass** |
| 4 | FR-HUB-3 AC2, AC5 | Store: Manager 403 (no `integrations.manage`); owner 201 with metadata and hint `8e0d` only (exact field list), no value in the body; list (Manager allowed, Billing 403) shows metadata only; `secret.store` and `secret.list` audited | **Pass** |
| 5 | FR-HUB-3 AC5 | A session older than 10 minutes: storing and revoking `REAUTH_REQUIRED`, listing still works | **Pass** |
| 6 | FR-HUB-3 AC3 | The tenant role gets `permission denied` (42501) selecting the payload or `*`; the stored row holds no plaintext; KEK version recorded | **Pass** |
| 7 | ADR-13 | The secrets role opens the value for its own business only; another business's context → not found; without a tenant context it sees no rows (RLS) | **Pass** |
| 8 | FR-HUB-3 | Database refuses: replacing the payload (LB022), a rewrap by the tenant role (LB022), deleting (LB001), renaming (LB001); the secrets role cannot change the payload (42501) | **Pass** |
| 9 | FR-HUB-4 AC2 | Rotate: new secret with `replacesSecretId`, the old one revoked with its material destroyed (null), opening it → `REVOKED`; rotating a revoked secret refused; revoke once, second revoke `REVOKED` | **Pass** |
| 10 | ADR-13 | KEK rotation through the secrets role re-seals 1 live secret (revoked ones skipped), then 0; `rewrappedAt` set; only the new KEK needed afterwards | **Pass** |
| 11 | FR-HUB-3 AC3 | Requests carrying the value with an unknown field or a bad purpose → 400 without the value; captured logs, audit metadata and responses never contain it | **Pass** |
| 12 | Access | Other business 404; read-only business can list but not store (`TENANT_READ_ONLY`); a server without `SECRETS_KEK` answers `STORE_NOT_CONFIGURED` (503) and reports `storeConfigured: false` | **Pass** |
| 13 | — | Negative control: `select` on the whole table granted to the tenant role → test 6 fails. Restored | **Detected** |
| 14 | — | `pnpm check`: ESLint rules 26, domain 150, API unit 108, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 305 | **Pass**, exit 0 |
| 15 | — | CI run #43 on `c1fa6d8` (7.1 + 7.2 + the secret-scan fix): all jobs incl. secret scan | **Pass** (success) |

## TR-0035 · 2026-10-28 · Phase 7 increment 7.3 — API & Integrations Hub

**Environment:** as TR-0011 (`integrations.db.test.ts`). Mock adapters and an injected DNS resolver and transport only — **no real provider was contacted**. Synthetic keys only.

| # | Requirement / AC | Check | Result |
|---|---|---|---|
| 1 | FR-HUB-1 AC1–2 | Providers: a mock adapter for each of the 9 categories (messaging, SMS, email, LLM, image/video, OCR, storage, payments, social) and `custom_rest`; Manager can view, Billing 403 | **Pass** |
| 2 | FR-HUB-2, FR-HUB-3 | Create with a credential: Manager 403; owner 201 `CONFIGURED` with defaults (timeout 15 s, 3 retries) and only a secret ID; without a credential `PLANNED`; no value in the response | **Pass** |
| 3 | FR-HUB-1 AC3, FR-HUB-5 | Refused: unknown provider, unsupported category, missing base URL; endpoints `169.254.169.254`, a name resolving to 10.0.0.5, `0x7f.1` (`BLOCKED_ADDRESS`), port 8443 (`PORT_NOT_ALLOWED`) unless allowed, `http` (400) | **Pass** |
| 4 | FR-HUB-4 AC1, AC3 | Test connection → `TESTED` with latency; a configuration change → `CONFIGURED` ("test again"); a failing test → `FAILED` with code `MOCK_FAILURE`; after a fix → `TESTED`. Health: 3 calls, 1 error, error rate 1/3, last error code, recent calls. Audit: create, test, update, view (configuration viewing audited) | **Pass** |
| 5 | FR-HUB-4 AC2 | Disable (testing refused), enable (`CONFIGURED`), rotate the credential (new secret, old revoked, retest needed), revoke (`REVOKED`, credential destroyed, no further change or enable) | **Pass** |
| 6 | WORKFLOWS §10 | Database refuses PLANNED → TESTED/VERIFIED/FAILED, inserting as VERIFIED, deleting, and any change after REVOKED | **Pass** |
| 7 | FR-HUB-1 AC3 | `custom_rest` through the guarded client: API key header, bearer, OAuth2 client credentials (token POST with scope, then bearer GET); every request to the checked public address with the right host; HTTP 503 → `HTTP_503`; a redirect to 10.0.0.1 → `BLOCKED_ADDRESS` | **Pass** |
| 8 | FR-SUB-3 AC1–2, FR-HUB-6 | Calls record units and cost per tenant (5 calls, ₹10.00); 80 % warns, the 6th call is refused `QUOTA_EXCEEDED` | **Pass** |
| 9 | FR-HUB-2 | Retry policy: a provider failing twice then succeeding takes 3 attempts with 3 retries allowed; failing 3 times with 1 retry allowed stops after 2 attempts | **Pass** |
| 10 | — | No tested integration → `NOT_CONFIGURED`; no credential in responses, captured logs or audit metadata | **Pass** |
| 11 | Access | Stale session: create, endpoint change, credential change and revoke `REAUTH_REQUIRED` (testing not); other business 404 and empty list; read-only lists but cannot test or create (`TENANT_READ_ONLY`); with mocks off (production) only `custom_rest` is offered | **Pass** |
| 12 | — | Negative control: the quota stop removed → test 8 fails. Restored | **Detected** |
| 13 | — | `pnpm check`: ESLint rules 26, domain 150, API unit 108, DB 54 + schema checks (83 PASS, 0 FAIL), Better Auth schema matches migrations, API DB 318; `pnpm secrets` clean | **Pass**, exit 0 |
