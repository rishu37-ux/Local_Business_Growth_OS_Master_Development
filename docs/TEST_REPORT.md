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
