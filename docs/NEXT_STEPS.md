# Next Steps (ordered)

Last updated: 2026-10-27 (end of Phase 2)

## Phase 3 — Foundation (next) — see `BACKLOG.md` F-01…F-14

1. F-01 Monorepo scaffold (ADR-03): pnpm workspaces, TS 6.0.x strict, ESLint 10 flat config + typescript-eslint 8 with the module-boundary rule, Prettier, Vitest 5.
2. F-02 CI on GitHub Actions: lint, typecheck, unit, DB tests via the throwaway-PostgreSQL harness, `scripts/check-docs.sh`, dependency audit, secret scan, build; pinned action SHAs. Ask the owner to enable branch protection.
3. F-03 Migrations: port `docs/data-model/schema_draft.sql` into SQL migrations (Kysely Migrator), add the `lbgos_auth` role/schema; carry over the 67 checks.
4. F-04 `withTenant()` and the pools from the spike, with its tests.
5. F-05…F-14 in order: app skeleton and security headers, auth (after Q3), MFA, rate limits, RBAC, business lifecycle, audit, setup wizard, web shell, plans/subscriptions.
6. At Phase 3 exit, update traceability statuses from `Specified` to implemented/tested only where tests exist.

## Inputs requested from the user

- Q2: confirm hosting (D-022) and a monthly ceiling — needed before staging.
- Q3: confirm self-hosted auth (D-019) or name a managed provider — needed before F-06.
- Q1, Q4, Q5, Q6 as in `PHASE0_INSPECTION_REPORT.md` §5.
- Optional: allow vendor pricing hosts in the environment's network settings to re-verify `COST_MODEL.md`.
