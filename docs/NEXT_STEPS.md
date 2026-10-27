# Next Steps (ordered)

Last updated: 2026-10-27 (end of Phase 0)

## Phase 1 — Requirements / SRS (next)

1. Write `docs/SRS.md` from `REQUIREMENTS_BLUEPRINT.md`: user stories and testable acceptance criteria for every FR/NFR.
2. Document core workflows (`docs/WORKFLOWS.md`): shop registration → approval → setup; purchase → stock-in (with IMEI); POS sale → invoice → payment → ledger; return → inspection → restock; OCR scan → review → post; campaign draft → approval → send.
3. Finalise role/permission catalogue (permission keys per module, default role templates: Owner, Manager, Billing, Inventory).
4. Decide open Phase 1 questions: IMEI uniqueness scope; suspended-tenant access policy; subscription states; owner MFA mandatory or optional.
5. Produce logical data model (`docs/DATA_MODEL.md`) with tenant keys, constraints (IMEI uniqueness, invoice number uniqueness), append-only tables and RLS plan.
6. Refine `SECURITY_THREAT_MODEL.md` with data-flow details per workflow.
7. Update traceability matrix statuses to `Specified`.

## Phase 2 — Architecture (after Phase 1)

8. ADR: frameworks, ORM/query builder, queue, auth approach, monorepo layout.
9. Cost model comparing 2–3 managed hosting options (state assumptions and dates of pricing).
10. Deployment/backup plan; development backlog.

## Phase 3 — Foundation (first code)

11. Monorepo scaffold, lint/typecheck/test, CI with secret and dependency scanning.
12. Migrations: businesses, users, memberships, roles, audit; RLS policies; cross-tenant tests.
13. Auth, onboarding/approval flow.

## Inputs requested from the user (non-blocking for Phase 1)

See `PHASE0_INSPECTION_REPORT.md` §5 (Q1–Q6).
