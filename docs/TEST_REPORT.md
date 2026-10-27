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
