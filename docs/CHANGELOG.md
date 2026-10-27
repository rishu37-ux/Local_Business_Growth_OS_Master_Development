# Changelog

## [Unreleased] — Phase 4 (in progress)

### Added
- Phase 4 plan (`docs/PHASE4_PLAN.md`).
- Migration 0007 and `@lbgos/modules/catalogue`: categories, brands, products, variants (archiving, cost visibility), versioned tax rates; catalogue API routes.
- `@lbgos/domain` integer money arithmetic and tax-rate version helpers.
- Migration 0008, `@lbgos/modules/purchasing` and `inventory`: suppliers, supplier ledger, purchases (draft → post → reverse) with IMEI checks, stock buckets and the `stock_levels` projection; purchasing API routes.

## [0.3.0] — 2026-10-27 — Phase 3 (foundation)

### Added
- pnpm monorepo: `@lbgos/domain`, `@lbgos/db`, `@lbgos/modules` (auth, tenancy, onboarding, audit, notifications), `@lbgos/api`, `@lbgos/web`, `@lbgos/eslint-rules` (module boundaries).
- SQL migrations 0001–0006 (foundation schema with RLS; `auth` schema; Better Auth tables; profiles/platform admins; lifecycle functions; onboarding, invitations, notifications, seed pilot plans).
- Self-hosted Better Auth with Argon2id, mandatory MFA for owners/platform admins, per-account lockout, idle + absolute session timeouts, CSRF origin check.
- RBAC with default roles and access modes; business lifecycle (apply → review → approve/reject/request changes → setup → activate → suspend/reinstate); audit log.
- Setup wizard backend + web UI, GSTIN validation, invoice series per financial year, staff invitations, notifications, admin-created businesses, plan management.
- React SPA served same-origin; Playwright + axe browser exit test.
- GitHub Actions CI (SHA-pinned actions, Node 22 + 24).
- Decisions D-023…D-031; test reports TR-0004…TR-0010.

### Fixed
- Home page of an approved owner before MFA enrolment listed no business (TR-0010 addendum 2).
- `scripts/dev-local.sh` for a local look at the portal.

### Removed
- `spikes/tenant-context` (ported to `@lbgos/db`; kept in git history).

## [0.2.0] — 2026-10-27 — Phase 2

### Added
- `docs/ARCHITECTURE_DECISION_RECORD.md` (ADR-01…19), `docs/COST_MODEL.md`, `docs/BACKLOG.md`.
- `spikes/tenant-context`: Kysely + node-postgres spike with 12 tests (tenant context under concurrency, leakage negative control, gapless numbering, allocation locking).
- `scripts/with-throwaway-pg.sh`: reusable throwaway PostgreSQL harness; `.gitignore`.
- Decisions D-018…D-022; D-003…D-006 confirmed.

### Changed
- `scripts/test-schema-draft.sh` now uses the shared harness.
- `DEPLOYMENT_RUNBOOK.md`: deployment, migration, backup/restore, rollback and incident-response plan (not rehearsed).
- `SECURITY_THREAT_MODEL.md` v0.3 (T12/T26 updated, T32 added, spike evidence); `DATA_MODEL.md` v1.1 (locking rules); `INTEGRATIONS_STATUS.md` (chosen approaches; still all planned).

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
