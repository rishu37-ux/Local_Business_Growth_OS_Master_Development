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
