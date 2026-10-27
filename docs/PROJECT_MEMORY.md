# Project Memory

Last updated: 2026-10-27 · Current phase: **Phase 5 in progress — increment 5.1 (tax, allocation, numbering engines) done; see PHASE5_PLAN.md**
Branch: `claude/quirky-dirac-vm3o46`

## Current state

- **Phases 0–4 are complete** (Phase 4 exit: TR-0016, CI #21 green). Phase 5 plan: `PHASE5_PLAN.md`; increment 5.1 (pure tax engine with 100 % branch coverage, allocation, number formats, metric definitions) done (TR-0017).
- Phase 4 plan with acceptance criteria: `PHASE4_PLAN.md`. Increment 4.1 (catalogue, versioned tax rates, migration 0007, `@lbgos/modules/catalogue`) is implemented and tested (TR-0011). Increment 4.2 (suppliers, purchases draft → post → reverse, stock buckets and levels, migration 0008, `@lbgos/modules/purchasing` + `inventory`) is implemented and tested (TR-0012). Increment 4.3 (stock reads, reconciliation, adjustments, generic approvals module with R3, migration 0009) is implemented and tested (TR-0013). Increment 4.4 (inspection outcomes, low/slow/dead/reorder reports, code lookup, migration 0010) is implemented and tested (TR-0014). Increment 4.5 (uploads, isolated OCR jobs with a **mock** adapter, deterministic parsing, review → draft purchase, migration 0011, `@lbgos/modules/ocr`) is implemented and tested (TR-0015). Increment 4.6 (web screens for catalogue, tax rates, suppliers, purchases, stock, scans/review, approvals; `member` pseudo-permission; Phase 4 exit browser test) is implemented and tested (TR-0016).
- Phases 0–3 detail: PR #1 (through increment 3.6) was merged into `main` by the repository owner. Increments 3.7a/3.7b and the Phase 3 exit records are on the working branch, with `main` merged back in (merge commit `890d97c`; a rebase plus force-push was refused by the session's permission policy). These commits are not yet in `main`; no new PR has been opened.
- **What exists:** a pnpm monorepo, run with Node type stripping (no build step for server code).
  - `@lbgos/domain`: IMEI, GSTIN, financial years, permissions, access modes.
  - `@lbgos/db`: SQL migrations 0001–0006, `withTenant`, locking helpers.
  - `@lbgos/modules`: auth on Better Auth, tenancy, onboarding, audit, notifications.
  - `@lbgos/api`: Fastify app with sessions, RBAC, lifecycle, setup, invitations, platform admin.
  - `@lbgos/web`: React SPA served same-origin.
- **CI** on GitHub Actions runs lint, format, typecheck, build, unit, DB and browser tests, audit and secret scan.
- **Phase 3 exit test:** passes in Chromium (TR-0010): register → approve → owner MFA → setup → live → invite Billing staff.
- **Not done yet:** nothing is deployed and no external integration is connected. The production start is refused because no email provider is configured (Q6).

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
| `PHASE3_PLAN.md` | Phase 3 increments, acceptance criteria and exit status/deferrals |
| `PHASE4_PLAN.md` | Phase 4 increments 4.1–4.6, acceptance criteria, exit status/deferrals |
| `PHASE5_PLAN.md` | Phase 5 increments 5.1–5.8 and acceptance criteria |
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
Stack (ADR): Node 24 LTS target (≥22.22 supported) · pnpm workspaces · Fastify 5 + Zod 4 · React 19 + Vite 8 SPA, React Router, TanStack Query, Tailwind 4, React Aria Components · Kysely + pg, SQL migrations via Kysely Migrator · graphile-worker · Vitest, fast-check, Playwright + axe.

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

Phase 5, increment **5.2** (PHASE5_PLAN.md §5.2): customers (mobile lookup, inline create, GSTIN/state), invoice series with configurable format and FY rollover, number allocation under lock with a concurrency test, re-authentication (fresh session) for tax-setting changes. Then 5.3 selling and issuing.

Carry the Phase 3 and Phase 4 deferrals listed in `PHASE3_PLAN.md` §Exit and `PHASE4_PLAN.md` §Exit.

