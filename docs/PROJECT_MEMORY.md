# Project Memory

Last updated: 2026-10-27 · Current phase: **Phase 1 complete → Phase 2 (architecture) next**
Branch: `claude/quirky-dirac-vm3o46`

## Current state

- Phase 0 (inspection, blueprint, memory docs) and Phase 1 (SRS, workflows, roles, data model, threat model refinement) are complete and committed.
- **No application code exists yet.** The only executable artifacts are a design-level PostgreSQL schema draft with 67 passing checks (TR-0002) and documentation-check scripts.
- No CI, deployment or integration exists. Every integration is `planned`.

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
| `REQUIREMENTS_BLUEPRINT.md` | Phase 0 blueprint (superseded in detail by SRS) |
| `REQUIREMENTS_TRACEABILITY.md` | Requirement → implementation → test evidence (generated from SRS headings) |
| `SECURITY_THREAT_MODEL.md` | Assets, boundaries, threats T1–T31, per-workflow data flows, mitigation status |
| `TEST_REPORT.md` | TR-0001 (Phase 0), TR-0002 (Phase 1) — only executed checks |
| `INTEGRATIONS_STATUS.md` | Integration statuses (no secrets) |
| `DEPLOYMENT_RUNBOOK.md` | Placeholder + how to run local checks |
| `CHANGELOG.md` | Changes by version/date |
| `PHASE0_INSPECTION_REPORT.md` | What existed at start; environment facts; open questions Q1–Q6 |

Scripts: `scripts/check-docs.sh` (memory docs present, secret-pattern screen, requirement coverage via `scripts/check_traceability.py`), `scripts/test-schema-draft.sh` (throwaway PostgreSQL + schema checks).

## Key decisions

Accepted: D-001 greenfield · D-002 repo memory · D-007 native PostgreSQL locally · D-008 IMEI unique per tenant · D-009 suspension = owner read-only + export · D-010 separate subscription states, read-only after grace · D-011 MFA mandatory for platform admins and owners · D-012 gapless invoice numbers ≤16 chars per FY · D-013 deterministic tax rules (paise, CGST/SGST split, inclusive pricing) · D-014 FIFO payment allocation, remainder = advance · D-015 separate DB role for platform admin · D-016 invoice cancellation window, else credit note · D-017 actual cost (serialized) / weighted average (non-serialized).
Proposed, to confirm in Phase 2 ADR: D-003 TypeScript modular monolith stack details · D-004 two-layer tenant isolation (now prototyped) · D-005 integer paise · D-006 India defaults.

## Blockers / open questions

Nothing blocks Phase 2 design work. Inputs needed (see `PHASE0_INSPECTION_REPORT.md` §5):
- Q2 hosting preference/budget and Q3 managed auth vs library — **needed to finalise the Phase 2 ADR** (a documented default will be chosen if unanswered).
- Q1 pilot shop details, Q4 integration accounts, Q5 tax-professional review (D-012, D-013, invoice fields), Q6 domain.
- Legal review of DPDP Act obligations and SMS/WhatsApp consent rules (NFR-12, FR-MSG-2) — before pilot.

## Unverified items

- All tax/invoice rules (D-012, D-013, FR-PRN-1 field list) are unverified with a tax professional.
- Every security control is design-only except the DB-level prototype checks in TR-0002, which are not a deployed system.
- Performance/availability targets (NFR-14/15) are targets, not measurements.

## Exact next action

Start Phase 2: write `docs/ARCHITECTURE_DECISION_RECORD.md` choosing frameworks (API framework, frontend build, ORM/query builder, job queue, auth approach), monorepo layout and how tenant context is set per transaction; then the cost model and deployment/backup plan, then the Phase 3 backlog. See `NEXT_STEPS.md`.
