# Project Memory

Last updated: 2026-10-27 · Current phase: **Phase 3 in progress** — increments 3.1 (scaffold), 3.2 (migrations, tenant context), 3.3 (CI, green on GitHub), 3.4 (API skeleton) and 3.5 (auth, MFA, lockout) done; see `PHASE3_PLAN.md`
Branch: `claude/quirky-dirac-vm3o46`

## Current state

- Phases 0–2 are complete and committed: inspection; SRS, workflows, roles and data model; architecture decision record, cost model, deployment/backup plan and backlog.
- **No application code exists yet.** Executable artifacts so far: the design-level schema draft with 67 passing checks (TR-0002), the tenant-context spike with 12 passing tests (TR-0003, `spikes/tenant-context`), the throwaway-PostgreSQL harness, and documentation checks.
- No CI, deployment or integration exists. Every integration is `planned`. Nothing has been purchased or provisioned.

## Document index

| File | Purpose |
|---|---|
| `PROJECT_MEMORY.md` | This file — state, decisions summary, next action, blockers |
| `NEXT_STEPS.md` | Ordered actionable tasks |
| `DECISION_LOG.md` | Dated decisions D-001…D-017 |
| `SRS.md` | **Authoritative requirements**: 100 requirements, each with acceptance criteria; metric definitions; out-of-scope list |
| `WORKFLOWS.md` | State machines and core flows (§1 business … §12 agent run) |
| `ROLES_PERMISSIONS.md` | Permission keys, default roles, RBAC rules R1–R5 |
| `DATA_MODEL.md` | Entities, constraints, RLS design, known draft limitations |
| `data-model/schema_draft.sql`, `data-model/schema_draft_test.sql` | Design-level DDL and its tests (not production migrations) |
| `ARCHITECTURE_DECISION_RECORD.md` | ADR-01…19: runtime, tooling, layout, API, web, DB, tenant context, jobs, auth, authz, storage, PDF, secrets, edge, observability, testing, CI, hosting, providers |
| `COST_MODEL.md` | Indicative hosting costs (third-party prices; vendor sites blocked here), scenarios for 1/10/100 shops |
| `BACKLOG.md` | Ordered Phase 3–5 backlog with SRS references and definition of done |
| `REQUIREMENTS_BLUEPRINT.md` | Phase 0 blueprint (superseded in detail by SRS) |
| `REQUIREMENTS_TRACEABILITY.md` | Requirement → implementation → test evidence (generated from SRS headings) |
| `SECURITY_THREAT_MODEL.md` | Assets, boundaries, threats T1–T31, per-workflow data flows, mitigation status |
| `TEST_REPORT.md` | TR-0001 (Phase 0), TR-0002 (Phase 1) — only executed checks |
| `INTEGRATIONS_STATUS.md` | Integration statuses (no secrets) |
| `DEPLOYMENT_RUNBOOK.md` | Placeholder + how to run local checks |
| `CHANGELOG.md` | Changes by version/date |
| `PHASE0_INSPECTION_REPORT.md` | What existed at start; environment facts; open questions Q1–Q6 |

Scripts: `scripts/check-docs.sh` (memory docs present, secret-pattern screen, requirement coverage via `scripts/check_traceability.py`), `scripts/with-throwaway-pg.sh <cmd>` (throwaway PostgreSQL + schema draft), `scripts/test-schema-draft.sh` (schema checks). Spike: `cd spikes/tenant-context && npm ci && npm test`.

## Key decisions

Accepted: D-001 greenfield · D-002 repo memory · D-007 native PostgreSQL locally · D-008 IMEI unique per tenant · D-009 suspension = owner read-only + export · D-010 separate subscription states, read-only after grace · D-011 MFA mandatory for platform admins and owners · D-012 gapless invoice numbers ≤16 chars per FY · D-013 deterministic tax rules (paise, CGST/SGST split, inclusive pricing) · D-014 FIFO payment allocation, remainder = advance · D-015 separate DB role for platform admin · D-016 invoice cancellation window, else credit note · D-017 actual cost (serialized) / weighted average (non-serialized).
Phase 2: D-003…D-006 confirmed · D-018 TypeScript 6 pin (typescript-eslint doesn't support TS 7) · D-019 Better Auth self-hosted, `auth` schema + role, Argon2id override (conditional on Q3) · D-020 locking rules (UPDATE…RETURNING for numbers; FOR UPDATE invoice + advisory lock payment) · D-021 no Redis in pilot · D-022 DigitalOcean BLR1 + Cloudflare (proposed, needs Q2).
Stack (ADR): Node 24 LTS target (≥22.18 supported) · pnpm workspaces · Fastify 5 + Zod 4 · React 19 + Vite 8 SPA, React Router, TanStack Query, Tailwind 4, React Aria Components · Kysely + pg, SQL migrations via Kysely Migrator · graphile-worker · Vitest, fast-check, Playwright + axe.

## Blockers / open questions

Nothing blocks the start of Phase 3 (scaffold, CI, migrations, tenancy, RBAC are provider-independent). Inputs needed:
- **Q2 hosting/budget** — confirm D-022 and a monthly ceiling (suggested US$100). Needed before staging is created.
- **Q3 auth approach** — default is self-hosted Better Auth (D-019); say so if you prefer a managed provider. Needed before backlog item F-06.
- Q1 pilot shop details, Q4 integration accounts, Q5 tax-professional review, Q6 domain (needed for email and Cloudflare).
- Legal review of DPDP Act / CERT-In / SMS-WhatsApp consent obligations before the pilot.
- **Environment network policy** blocks vendor sites (digitalocean.com, aws.amazon.com, supabase.com, neon.com); prices in `COST_MODEL.md` are unverified third-party figures.
- **Repository settings** (branch protection, required CI checks) must be enabled by the owner once CI exists.

## Unverified items

- All tax/invoice rules (D-012, D-013, FR-PRN-1 field list) are unverified with a tax professional.
- Hosting prices, PITR windows and KMS availability for the chosen provider are unverified (vendor sites blocked).
- Security controls are design-only, except the DB-level prototype checks (TR-0002) and the spike (TR-0003), which are not a deployed system.
- Performance/availability targets (NFR-14/15) are targets, not measurements.

## Exact next action

Phase 3 increment **3.6** (F-09…F-11):
- Permission catalogue in `@lbgos/domain`.
- RBAC in the session hook: resolve the membership for the requested business, effective permissions, and the business/subscription status gate.
- Route enumeration test.
- Business lifecycle endpoints: application submit/review, approve/reject/request-changes with reasons, suspend/reinstate.
- Default role templates on approval.
- Audit service.
- Owner endpoints to revoke staff sessions and reset staff MFA (FR-AUTH-1 AC5, FR-AUTH-5 AC1).
- Session rotation on privilege change.

Deferred items from 3.5 are listed at the end of TR-0007.
