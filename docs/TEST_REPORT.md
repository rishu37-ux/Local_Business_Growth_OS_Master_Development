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
