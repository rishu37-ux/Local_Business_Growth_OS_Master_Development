# Development Backlog (Phases 3–5)

Version 1.0 (Phase 2) — 2026-10-27. Items are ordered; each references the SRS requirements whose acceptance criteria define "done". Status: all **Not started**.

**Definition of done (every item):** acceptance criteria covered by automated tests (or a recorded manual test where automation is impractical, e.g. thermal printers); lint, typecheck and all tests green in CI; cross-tenant and permission tests for any new endpoint; no secrets or real data in fixtures; `TEST_REPORT.md`, `REQUIREMENTS_TRACEABILITY.md` and `PROJECT_MEMORY.md` updated; and, if a decision changed, `DECISION_LOG.md`.

Size: S ≈ ≤1 day, M ≈ 2–3 days, L ≈ 4–5 days (rough, for ordering only).

## Phase 3 — Foundation

| # | Item | Refs | Size |
|---|---|---|---|
| F-01 | Monorepo scaffold per ADR-03; pnpm workspaces; TS 6 strict; ESLint flat config with module-boundary rule; Prettier; Vitest | NFR-2, NFR-3, D-018 | M |
| F-02 | CI workflow: lint, typecheck, unit, DB tests (throwaway PostgreSQL), docs check, dependency audit, secret scan, build; pinned actions | NFR-19, FR-MEM-1, ADR-17 | M |
| F-03 | `packages/db`: Kysely Migrator running SQL migrations; port the schema draft into migration 0001 (platform, RBAC, audit); DB roles incl. `lbgos_auth`; carry the TR-0002 checks over as DB tests | NFR-4, D-015, ADR-06 | L |
| F-04 | `withTenant()` and the three pools, from the spike; tests for context leakage and malformed context | ADR-07, T26 | S |
| F-05 | Fastify app skeleton: config validation, pino with redaction, request IDs, security headers/CSP, health endpoints, error mapping (LB00x → 409/422) | NFR-10, NFR-17 | M |
| F-06 | Auth module on Better Auth: sessions (cookie flags, rotation, idle/absolute timeouts, revocation), Argon2id override, breached-password check, uniform reset/verify responses, telemetry off, schema `auth` | FR-AUTH-1, FR-AUTH-2, NFR-13, D-019 | L |
| F-07 | MFA: TOTP + recovery codes; mandatory for platform admin and owner; owner "require staff MFA"; staff MFA reset by owner | FR-AUTH-3, FR-AUTH-5, D-011 | M |
| F-08 | Rate limiting with a PostgreSQL-backed store on auth endpoints; lockout audit events | FR-AUTH-4, ADR-14 | S |
| F-09 | RBAC: permission catalogue, default role templates, `onRequest` authorization hook, route enumeration test, rules R1–R5 tests | FR-RBAC-1 | L |
| F-10 | Business lifecycle: registration → PENDING_APPROVAL, admin review queue, approve/reject/request changes with reasons, suspension/read-only gates, status history | BR-T1…T4, FR-ONB-1, D-009 | L |
| F-11 | Audit log service (append-only, tenant/platform scopes) wired into F-06…F-10 | FR-AUD-1 | M |
| F-12 | Setup wizard (web): business details, tax profile and invoice series, MFA step, staff invites, preferences; progress persistence; ACTIVE gate | FR-ONB-2, FR-ONB-3 | L |
| F-13 | Web shell: routing, auth screens, business switcher, accessible layout at 360/768/1280 px; Playwright + axe smoke tests | NFR-1, NFR-16 | M |
| F-14 | Plans and subscriptions (admin-editable), status gate for read-only mode; seed pilot plans labelled "to validate" | FR-SUB-1, FR-SUB-2, D-010 | M |

**Phase 3 exit:** a self-registered synthetic shop can be approved, completes setup with owner MFA, invites a staff member with a limited role; every route is permission-checked; cross-tenant tests pass; CI is green.

## Phase 4 — Inventory, purchases, OCR review

| # | Item | Refs | Size |
|---|---|---|---|
| I-01 | Catalogue CRUD: categories, brands, products, variants, tax rates (versioned), HSN, cost visibility permission | FR-INV-1, FR-INV-2, FR-TAX-2 | L |
| I-02 | `packages/domain` IMEI validation (Luhn) + property tests; DB check parity test | FR-INV-3 | S |
| I-03 | Suppliers; purchases (draft → post → reverse) with IMEI capture, weighted-average cost, duplicate supplier-invoice check | FR-INV-8, FR-INV-5, D-017 | L |
| I-04 | Stock ledger service, `stock_levels` projection + reconciliation job; adjustments via approval requests | FR-INV-4, FR-INV-5 | L |
| I-05 | Returns inspection workflow | FR-INV-6 | M |
| I-06 | Low/slow/dead stock and reorder suggestions | FR-INV-7 | M |
| I-07 | Barcode wedge input + camera scanning where supported | FR-INV-9 | S |
| I-08 | Upload pipeline: magic-byte checks, limits, private storage adapter, isolated heavy worker | FR-OCR-1, FR-OCR-6, ADR-11 | L |
| I-09 | OCR adapter interface + mock; extraction schema; deterministic validators; review screen; draft purchase creation; prompt-injection test corpus | FR-OCR-2…5 | L |

## Phase 5 — POS, invoices, payments, ledger, core reports

| # | Item | Refs | Size |
|---|---|---|---|
| P-01 | Tax engine in `packages/domain` (D-013), ≥95% branch coverage, property tests (Σ lines = totals) | FR-TAX-1 | L |
| P-02 | Invoice numbering service (spike-proven lock) + format validation + FY rollover; concurrency test | FR-POS-4, D-012, D-020 | M |
| P-03 | POS UI: search/scan, IMEI selection, discounts with limits and approval, customer capture, multi-payment | FR-POS-1, FR-POS-2, FR-POS-5, FR-POS-3 | L |
| P-04 | Issue transaction: number + stock movements + ledger + allocations + COGS snapshot, atomic; IMEI double-sale race test | FR-INV-5 AC4, FR-LED-1 | L |
| P-05 | Allocation module (D-014) with locks (D-020), property tests | FR-LED-2 | M |
| P-06 | Cancellation window, credit/debit notes | FR-TAX-3, D-016 | M |
| P-07 | Print templates A4/A5/80/58 mm + PDF via Chromium worker; manual printer test record | FR-PRN-1, ADR-12 | L |
| P-08 | Customer ledger statements; metric definitions module; sales/receivables/payment-method reports with exact-value tests; timezone/FY boundary tests | FR-LED-3, FR-RPT-1…3 | L |
| P-09 | CSV/PDF/XLSX export with audit | FR-RPT-4 | M |

## Later phases (summary; detailed backlog written at the start of each phase)

- Phase 6: CRM profile, consent/suppression, reminders, privacy requests, expenses (FR-CRM-*, FR-CON-1, FR-REM-1, FR-PRV-*, FR-EXP-1).
- Phase 7: Integrations hub (SSRF-guarded client, envelope-encrypted secrets), creative studio, first official integrations (FR-HUB-*, FR-AIC-*, FR-MSG-*).
- Phase 8: Agents with approvals and budgets; usage metering (FR-AGT-*, FR-SUB-3).
- Phase 9: Security review and penetration-test preparation, restore drill, accessibility/responsive audit, pilot.
- Phase 10: Commercial readiness.
