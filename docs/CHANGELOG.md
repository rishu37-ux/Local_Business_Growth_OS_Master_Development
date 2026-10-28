# Changelog

## [Unreleased] — Phase 7 (API Hub, AI Creative Studio, integrations)

### Added
- Phase 7 plan (`docs/PHASE7_PLAN.md`).
- `@lbgos/modules/outbound`: the guarded outbound HTTP client (SSRF protection) and ESLint rule `lbgos/no-raw-http`.
- Migration 0022, database role `lbgos_secrets` and `@lbgos/modules/secrets`: envelope-encrypted integration secrets (write-only API, rotation, revocation, KEK rotation); config `SECRETS_KEK`, `DATABASE_URL_SECRETS`.

## [0.6.0] — 2026-10-28 — Phase 6 (CRM, consent, reminders, expenses, analytics)

### Added
- Phase 6 plan (`docs/PHASE6_PLAN.md`).
- Migration 0017 and customer profile: alternate mobile, date of birth, tags, preferred contact channels; warranty months/provider recorded on sale lines; owned units and warranty items with end dates (`GET /customers/:id/owned-items`); customer CSV export of chosen fields (`GET /customers/export`, `customers.export`, audited); `addMonths`, `warrantyEnd`, `normalizeTags` in `@lbgos/domain`.
- Migration 0018 and `@lbgos/modules/messaging`: consent records and current state per channel, suppression list (opt-out, inbound STOP hook), messages with the WORKFLOWS §9 status machine enforced in the database, marketing approval, the send-time gate, quiet hours, provider adapter (default not configured) and communication history; messaging API routes; `gateDecision`, `nextAllowedTime` in `@lbgos/domain`.
- Migration 0019 and `@lbgos/modules/reminders`: reminder settings per type (off by default; auto-send needs `marketing.approve`), validated templates, idempotent runs drafting birthday, warranty-expiry, service-due and payment-due messages, auto-send through the send-time gate; reminder API routes; template helpers in `@lbgos/domain`.
- Migration 0020 and `@lbgos/modules/expenses`: optional expenses module (off by default), entries with receipts, full reversals as corrections; expenses report and operating-profit estimate (CSV/XLSX/PDF); `storeUpload`/`getUploadFile` in the OCR module for non-scan files.
- Dashboard API (`GET /dashboard`): net sales, cash received, receivables, customer advances, gross margin, low stock and reminders waiting, each with its definition and permission; metric definitions for low stock and reminders waiting.
- Migration 0021 and `@lbgos/modules/privacy`: erase a customer's personal data (owner, reason, recent sign-in) and the owner's full data export as a ZIP of CSVs.
- Screens: overview tiles and full data download; customer profile details, owned phones, consent and opt-out, messages, erasure; customer export; Reminders; Expenses; operating profit in Reports. Phase 6 exit browser test.

### Fixed
- Message event order within one transaction (insertion sequence, migration 0019).
- Flaky test fixtures that picked units by an equal `created_at`.

## [0.5.0] — 2026-10-28 — Phase 5 (POS, invoices, payments, ledger, reports)

### Added
- Phase 5 plan (`docs/PHASE5_PLAN.md`).
- `@lbgos/domain`: sale tax engine (D-013/D-038), payment allocation (D-014), invoice number formats, metric definitions; coverage gate ≥ 95 % on money modules.
- Migration 0012, `@lbgos/modules/customers` and `sales` numbering: customers (E.164 mobiles, GSTIN/state), invoice series with configurable format and FY rollover, numbering API; re-authentication (`freshAuth`) for tax settings.
- Migration 0013 and `@lbgos/modules/sales` selling: draft sales (held carts), pricing from current tax rates and place of supply, discount limits with approval requests (`sales.discount`, approver's own limit checked), minimum-price override, atomic issue (number, line snapshots with COGS, SALE movements, units SOLD, payments, allocations, advance use, customer ledger, audit), invoice list/detail; sales API routes; `discountWithinLimit` in `@lbgos/domain`.
- Migration 0014 and payments in `@lbgos/modules/sales`: later payments (selected invoices or oldest first), applying advance, advance refunds (`payment_refunds`), payment reversals, customer account (balance, receivable, advance, open invoices) and statement with opening/closing balance; payment status on invoices; payment API routes.
- Migration 0015 and returns in `@lbgos/modules/sales`: invoice cancellation within the window (goods back to stock or into inspection; payments to advance or refunded), credit notes (partial/full, from line snapshots, returns into inspection, release or refund of paid money), debit notes; invoice credited amount and status; API routes.
- Migration 0016 and printing: shop address/phone/email/terms settings copied into issued documents; print templates for A4, A5, 80 mm and 58 mm (amount in words, tax summary by HSN, payments, terms); PDF download rendered by headless Chromium; `amountInWords` and GST state names in `@lbgos/domain`.
- `@lbgos/modules/reports` and Reports screen: sales summary with previous period, sales by brand/model/variant, margin, receivables ageing, cash received by method, returns, tax summary, stock valuation, all with metric definitions; CSV/XLSX/PDF exports (audited); customer statement export; report periods in `@lbgos/domain`.
- POS screen (scan IMEI/barcode, cart priced by the server, customer by mobile, line and invoice discounts, split payments, held sales, receipt with print/PDF), Invoices and Customers screens; counter search API; Phase 5 exit browser test.

### Fixed
- Wide tables no longer make small screens scroll sideways when they contain screen-reader-only text.
- Ledger entries and refunds written by cancellations, credit and debit notes now carry the document time.

### Changed
- Portal redesign (D-043): design tokens, app shell with business side menu, dashboard-style overview, card sections, status badges, refined forms and tables, centred sign-in pages.
- Approvals: executors may add an approver check (`ApprovalAction.authorize`); the action map is shared (`apps/api/src/approval-actions.ts`); any member may withdraw their own request and list it (`/approvals/mine`).

### Fixed
- Test harness: synthetic client IPs no longer collide across test files (sign-up rate limits).

## [0.4.0] — 2026-10-27 — Phase 4 (inventory, purchases, stock ledger, OCR review)

### Added
- Phase 4 plan (`docs/PHASE4_PLAN.md`).
- Migration 0007 and `@lbgos/modules/catalogue`: categories, brands, products, variants (archiving, cost visibility), versioned tax rates; catalogue API routes.
- `@lbgos/domain` integer money arithmetic and tax-rate version helpers.
- Migration 0008, `@lbgos/modules/purchasing` and `inventory`: suppliers, supplier ledger, purchases (draft → post → reverse) with IMEI checks, stock buckets and the `stock_levels` projection; purchasing API routes.
- Migration 0009, `@lbgos/modules/approvals` and inventory adjustments: stock overview/units/movements/reconciliation APIs, adjustments, write-offs, corrections, approval requests (payload hash, expiry, R3).
- Migration 0010: inspection records; inspection queue/outcomes, low/slow/dead stock and reorder-suggestion reports, code lookup API.
- Migration 0011 and `@lbgos/modules/ocr`: scan uploads (magic bytes, limits), private storage adapter, OCR jobs in isolated worker threads with retries, mock OCR adapter (fixture text), deterministic field parsing, review with confirmations → draft purchase, structuring hook with strict schema.
- Web screens: catalogue, tax rates, suppliers, purchases (IMEI entry, post, reverse), stock (scanner field, camera where supported, levels, reports, inspections, adjustments), scans and review, approvals; Phase 4 exit browser test.

### Fixed
- Staff without `business.settings.view` could not open their business overview (`member` pseudo-permission, D-037).
- Wide tables were not keyboard-scrollable on small screens.

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
