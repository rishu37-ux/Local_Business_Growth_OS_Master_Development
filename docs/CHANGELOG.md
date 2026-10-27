# Changelog

## [0.1.0] — 2026-10-27 — Phase 1

### Added
- `docs/SRS.md` — 100 requirements with user stories and numbered acceptance criteria, metric definitions, NFR acceptance criteria, out-of-scope list.
- `docs/WORKFLOWS.md` — state machines (business, subscription, serialized unit, purchase, invoice, OCR job, messages/posts/campaigns, integrations, approvals, agent runs) and core flows.
- `docs/ROLES_PERMISSIONS.md` — permission keys, default role templates, RBAC rules.
- `docs/DATA_MODEL.md`, `docs/data-model/schema_draft.sql`, `docs/data-model/schema_draft_test.sql` — logical model and tested design-level schema draft (RLS, append-only ledgers, IMEI and invoice constraints).
- `scripts/test-schema-draft.sh` — throwaway PostgreSQL test harness.
- `scripts/check_traceability.py` — requirement coverage check (wired into `scripts/check-docs.sh`).
- Decisions D-008…D-017.

### Changed
- `SECURITY_THREAT_MODEL.md` v0.2: threats T25–T31, per-workflow data flows, evidence-based mitigation status.
- `REQUIREMENTS_TRACEABILITY.md` regenerated per individual requirement from the SRS.
- `REQUIREMENTS_BLUEPRINT.md` marked as superseded in detail by the SRS.
- `DEPLOYMENT_RUNBOOK.md`: how to run local checks.

### Fixed (in the schema draft, found by its tests)
- Missing `public` in `search_path` for extension types.
- Unpinned `search_path` in trigger/definer functions (threat T25).

## [0.0.1] — 2026-10-27 — Phase 0

### Added
- `docs/` project-memory set: `PROJECT_MEMORY.md`, `DECISION_LOG.md`, `REQUIREMENTS_TRACEABILITY.md`, `SECURITY_THREAT_MODEL.md`, `CHANGELOG.md`, `TEST_REPORT.md`, `INTEGRATIONS_STATUS.md`, `DEPLOYMENT_RUNBOOK.md`, `NEXT_STEPS.md`.
- `docs/PHASE0_INSPECTION_REPORT.md` — repository and environment inspection results.
- `docs/REQUIREMENTS_BLUEPRINT.md` — initial requirements and security blueprint.
- `CLAUDE.md` — session-start instructions pointing to project memory.
- `scripts/check-docs.sh` — documentation presence and secret-pattern check.

### Unchanged
- `Local_Business_Growth_OS_Master_Development_Prompt.txt` (preserved as-is).
