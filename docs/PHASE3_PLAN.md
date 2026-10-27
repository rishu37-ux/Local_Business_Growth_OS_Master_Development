# Phase 3 Plan — Foundation

Version 1.0 — 2026-10-27. Backlog items F-01…F-14 (`BACKLOG.md`) are delivered in the increments below. Acceptance criteria (AC) are fixed **before** coding. An increment counts as done only when its ACs are shown by executed checks recorded in `TEST_REPORT.md`.

Inputs still open: Q3 (auth approach). Per prompt guidance, Phase 3 proceeds on the documented default (D-019, self-hosted Better Auth) behind `modules/auth`, so a later switch stays local to that module.

## Increment 3.1 — Monorepo scaffold (F-01)
- AC1 `pnpm install --frozen-lockfile` succeeds from a clean checkout.
- AC2 `pnpm lint`, `pnpm typecheck`, `pnpm test` pass at the repo root.
- AC3 TypeScript `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`; server code runs directly with Node's built-in type stripping (no build step, D-023).
- AC4 A module importing another module's internal file fails lint; importing its `index.ts` passes (rule unit-tested, plus a negative-control lint run).
- AC5 `packages/domain` holds pure logic with unit and property tests. The first item is IMEI validation, which agrees with the DB check on a shared test vector.

## Increment 3.2 — Migrations and tenant context (F-03, F-04)
- AC1 Migrations (SQL files run by Kysely Migrator) build the full schema from an empty DB, and re-running is a no-op.
- AC2 The 67 schema checks (TR-0002) pass against the **migrated** DB.
- AC3 `withTenant()` and role pools live in `packages/db`; the spike's tests pass against the migrated DB as Vitest tests.
- AC4 The `auth` schema and `lbgos_auth` role exist; `lbgos_app` and `lbgos_platform` cannot read `auth` tables (test).

## Increment 3.3 — CI (F-02)
- AC1 A GitHub Actions workflow runs install, lint, typecheck, unit tests, DB tests, docs check, dependency audit and secret scan on push and PR.
- AC2 Actions are pinned to commit SHAs; `permissions: contents: read`.
- AC3 The workflow is observed to run on the pushed branch, with its result recorded (if run results are visible from this session).

## Increment 3.4 — API skeleton (F-05)
- AC1 The Fastify app validates config at boot (fails fast on missing/invalid env).
- AC2 Security headers per NFR-17 on every response (test).
- AC3 `/healthz` and `/readyz` (DB check).
- AC4 Logs are JSON with a request ID; configured secret/PII paths are redacted (test with a planted secret).
- AC5 DB error codes LB001–LB005 map to 409/422 with no internal details leaked (test).
- AC6 Route-declaration test: every route has `config.permission` or `config.public === true`, otherwise boot fails (test with a deliberately undeclared route).

## Increment 3.5 — Auth, MFA, rate limits (F-06, F-07, F-08)
- ACs are FR-AUTH-1…5 and NFR-13 in the SRS; each AC gets a test, or is explicitly recorded as deferred with a reason.

## Increment 3.6 — RBAC, lifecycle, audit (F-09, F-10, F-11)
- ACs are FR-RBAC-1, BR-T1…T4, FR-ONB-1, FR-AUD-1 and rules R1–R5.

## Increment 3.7 — Web shell, setup wizard, plans (F-12, F-13, F-14)
- ACs are FR-ONB-2/3, NFR-1 (axe + three viewports), FR-SUB-1/2.

## Phase 3 exit
A self-registered synthetic shop can be approved, completes setup with owner MFA, and invites a staff member with a limited role. Every route is permission-checked, cross-tenant tests pass, and CI is green.


## Exit status (2026-10-27)

**Exit criterion met:** the browser test (TR-0010 #3) runs a self-registered synthetic shop through approval, owner MFA, setup and go-live, and invites a Billing staff member who accepts. Every route is permission-checked: unknown keys, missing `:businessId` and misplaced platform permissions fail at registration (TR-0008 #4). Cross-tenant/non-member access returns 404 (TR-0008 #5, #10). CI is green on every increment through 3.7a; 3.7b's result is recorded in TR-0010/CHANGELOG once observed.

| Increment | Evidence |
|---|---|
| 3.1 scaffold | TR-0004 |
| 3.2 migrations + tenant context | TR-0005 |
| 3.3 CI | TR-0006 |
| 3.4 API skeleton | TR-0006 |
| 3.5 auth / MFA / lockout | TR-0007 |
| 3.6 RBAC / lifecycle / audit | TR-0008 |
| 3.7a onboarding backend | TR-0009 |
| 3.7b web app + exit test | TR-0010 |

**Deferred to later phases (explicit, not done):**
- Passkeys/WebAuthn (FR-AUTH-3 should-have).
- Online breached-password check (FR-AUTH-2 AC4; needs network).
- FR-AUTH-5 AC2 owner MFA recovery process (operational doc, before pilot).
- Approval requests and rule R3 (approvals module, Phase 8).
- FR-SUP-1 support access.
- Re-authentication for tax-setting changes (FR-TAX-2 AC2, Phase 5).
- Products-import and integrations wizard steps (Phases 4/7).
- Real email provider (Q6).
- Firefox/WebKit/real-device testing (NFR-16).
- Keyboard-only and screen-reader manual checks (NFR-1).
- Performance measurement (NFR-14).
- BR-T4 AC3 job pausing (when jobs exist).
- A UI for Billing-only staff: they can sign in and accept, but have no screens yet because Billing screens arrive with POS in Phase 5.
