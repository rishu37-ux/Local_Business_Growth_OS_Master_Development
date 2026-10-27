# Next Steps (ordered)

Last updated: 2026-10-27 (end of Phase 1)

## Phase 2 — Architecture, cost model, deployment plan, backlog (next)

1. `docs/ARCHITECTURE_DECISION_RECORD.md`: compare and choose
   - API framework (e.g. Fastify / NestJS / Hono) and schema validation library;
   - frontend build (Vite React SPA vs Next.js) and UI component approach (Tailwind + accessible primitives);
   - database access (query builder vs ORM) — must support transaction-local `set_config` for RLS and raw SQL for constraints/policies;
   - migration tool (must handle policies, triggers and functions);
   - job queue (PostgreSQL-backed vs Redis-backed);
   - auth approach (managed provider vs maintained library) against FR-AUTH-1…5 and D-011 — depends on Q3;
   - monorepo layout and module-boundary enforcement (NFR-2).
2. Tenant-context middleware design: transaction-per-request, pooler mode, tests for context leakage (threat T26).
3. Cost model: 2–3 managed hosting options (DB with PITR, object storage, compute, queue, email); dated price assumptions; per-tenant cost at 1, 10, 100 shops. Depends on Q2 for budget.
4. Deployment, backup and rollback plan → fill `DEPLOYMENT_RUNBOOK.md` §3–5 (design; restore test stays in Phase 9).
5. Development backlog for Phases 3–5 with acceptance criteria references (SRS IDs).
6. Update `DECISION_LOG.md` (D-003…D-006 → Accepted or revised), traceability, memory.

## Phase 3 — Foundation (first application code)

7. Monorepo scaffold; lint, typecheck, unit tests; CI running `scripts/check-docs.sh`, `scripts/test-schema-draft.sh` (or its migration successor), dependency and secret scanning.
8. Convert schema draft into versioned migrations; keep the 67 checks as DB tests.
9. Auth, sessions, MFA, onboarding/approval flow, RBAC middleware with route-permission enumeration test, audit log.

## Inputs requested from the user

Q1–Q6 in `PHASE0_INSPECTION_REPORT.md` §5. Q2 (hosting/budget) and Q3 (auth approach) are needed for Phase 2; sensible documented defaults will be used if not provided.
