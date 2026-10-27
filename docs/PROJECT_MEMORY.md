# Project Memory

Last updated: 2026-10-27 · Current phase: **Phase 0 complete → Phase 1 next**
Branch: `claude/quirky-dirac-vm3o46`

## Current state

- Repository was greenfield: only the master prompt file existed (see `PHASE0_INSPECTION_REPORT.md`). It is preserved unchanged.
- No application code, database, CI, deployment or integration exists yet.
- Phase 0 deliverables created: inspection report, initial requirements/security blueprint, threat model, and all project-memory documents.

## Document index

| File | Purpose |
|---|---|
| `PROJECT_MEMORY.md` | This file — state, decisions summary, next action, blockers |
| `NEXT_STEPS.md` | Ordered actionable tasks |
| `DECISION_LOG.md` | Dated decisions with rationale/alternatives |
| `REQUIREMENTS_BLUEPRINT.md` | Phase 0 requirements + security blueprint (input to SRS) |
| `REQUIREMENTS_TRACEABILITY.md` | Requirement → implementation → test evidence |
| `SECURITY_THREAT_MODEL.md` | Assets, trust boundaries, threats, mitigations, residual risk |
| `TEST_REPORT.md` | Tests actually executed and results |
| `INTEGRATIONS_STATUS.md` | Integration statuses (no secrets) |
| `DEPLOYMENT_RUNBOOK.md` | Deployment/backup/recovery/rollback (placeholder until Phase 2–3) |
| `CHANGELOG.md` | Changes by version/date |
| `PHASE0_INSPECTION_REPORT.md` | What existed at start and environment facts |
| `../scripts/check-docs.sh` | Verifies memory docs exist and contain no obvious secret patterns |

## Key decisions so far

See `DECISION_LOG.md`. Accepted: D-001 greenfield, D-002 repo-based memory, D-007 native PostgreSQL for local tests. Proposed (confirm in Phase 2): D-003 TypeScript modular monolith, D-004 service-layer + RLS tenant isolation, D-005 integer-paise money and append-only ledgers, D-006 India defaults.

## Environment facts (cloud dev session)

Node 22, pnpm 10, PostgreSQL 16 server binaries (run as `postgres` user), Docker daemon unavailable, npm registry reachable.

## Blockers / open questions

None blocking Phase 1. Open inputs Q1–Q6 (pilot shop details, hosting budget, auth approach, desired integrations/accounts, tax-professional review, domain) — see `PHASE0_INSPECTION_REPORT.md` §5.

## Unverified items

Everything in the threat model and blueprint is design only. No legal/tax compliance has been verified. No integration is connected.

## Exact next action

Start Phase 1: write `docs/SRS.md` with user stories and acceptance criteria for module M1 (auth, onboarding, tenancy lifecycle, RBAC), then continue module by module per `NEXT_STEPS.md`.
