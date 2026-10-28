# Requirements Traceability Matrix

Requirement IDs and acceptance criteria are defined in `SRS.md` (Phase 1). Origin: `REQUIREMENTS_BLUEPRINT.md`.
Status values: `Not started` · `Specified` · `In progress` · `Implemented (untested)` · `Implemented + tested` · `Verified` · `Blocked`.
Test evidence must reference an entry in `TEST_REPORT.md`. "In progress (DB layer)" means the database-level controls exist in real migrations and are tested (TR-0005), but the application features using them are not built yet.

Generated from `SRS.md` headings; `scripts/check-docs.sh` fails if an SRS requirement is missing here.

Last updated: 2026-10-27 (Phase 5, increment 5.2) · 100 requirements

| Req ID | Module | Summary | Phase | Status | Implementation | Test evidence |
|---|---|---|---|---|---|---|
| BR-T1 | Tenancy | Pending application | 3 | Implemented + tested | migration 0005, `packages/modules/src/tenancy/`, `apps/api/src/routes/tenancy.ts` | TR-0008 #5 |
| BR-T2 | Tenancy | Approval history | 3 | Implemented + tested | `tenancy/platform.ts`, migration 0001 trigger | TR-0008 #3, #6 |
| BR-T3 | Tenancy | Reasons required | 3 | Implemented + tested (AC1; AC2 visible in app — email/in-app notification pending 3.7) | `tenancy/platform.ts` | TR-0008 #6, #11, #13 |
| BR-T4 | Tenancy | Suspension and read-only modes | 3 | Implemented + tested (AC1, AC2, AC4; AC3 job pausing when jobs exist) | `@lbgos/domain` business-status, `apps/api/src/auth-plugin.ts` | TR-0008 #2, #11 |
| FR-AUTH-1 | Auth | Sessions | 3 | Implemented + tested (AC1–6; AC2 privilege-change rotation via session revocation) | `packages/modules/src/auth/`, `apps/api/src/auth-*.ts`, `routes/members.ts` | TR-0007 #1–6, TR-0008 #9–10 |
| FR-AUTH-2 | Auth | Password reset and verification | 3 | Implemented + tested (AC1–3, AC5; AC4 local list only — online breached check deferred) | `packages/modules/src/auth/` | TR-0007 #7–11 |
| FR-AUTH-3 | Auth | MFA | 3 | Implemented + tested (AC1–5; AC5 encrypted not hashed — D-025; passkeys not yet) | `packages/modules/src/auth/`, `apps/api/src/auth-plugin.ts`, migration 0006 | TR-0007 #12–14, TR-0009 #7 |
| FR-AUTH-4 | Auth | Rate limiting | 3 | Implemented + tested (fixed window, not progressive — D-026) | `packages/modules/src/auth/options.ts` | TR-0007 #15–16 |
| FR-AUTH-5 | Auth | MFA recovery | 3 | In progress (AC1 owner resets staff MFA done; AC2 platform process to document) | `routes/members.ts` | TR-0008 #10 |
| FR-ONB-1 | Onboarding | Registration and admin creation | 3 | Implemented + tested (AC1–3) | `routes/tenancy.ts`, `onboarding/platform.ts` | TR-0008 #5, TR-0009 #8 |
| FR-ONB-2 | Onboarding | Setup wizard | 3 | In progress (AC1–4 for details/tax/MFA/staff/preferences, API + web; products import and integrations steps later) | `onboarding/setup.ts`, `apps/web/src/pages/business.tsx` | TR-0009 #1, #5; TR-0010 #3 |
| FR-ONB-3 | Onboarding | Notifications and history | 3 | Implemented + tested (backend; real email provider pending Q6) | `notifications/`, `tenancy/platform.ts` | TR-0008 #6, TR-0009 #4 |
| FR-RBAC-1 | RBAC | Roles and permissions | 3 | Implemented + tested (AC1–4; R3 enforced by the approvals module) | `@lbgos/domain` permissions, `apps/api/src/auth-plugin.ts`, `tenancy/members.ts`, `modules/approvals/` | TR-0008 #1, #4, #9; TR-0013 #11 |
| FR-SUP-1 | Support | Support access | 3 | Specified | — | — |
| FR-INV-1 | Inventory | Hierarchy | 4 | Implemented + tested (AC1–3) | migration 0007, `packages/modules/src/catalogue/`, `apps/api/src/routes/catalogue.ts` | TR-0011 #2–4 |
| FR-INV-2 | Inventory | Phone attributes | 4 | Implemented + tested (AC1–4) | migration 0007, `packages/modules/src/catalogue/` | TR-0011 #2, #5 |
| FR-INV-3 | Inventory | Serialized units and IMEI | 4 | Implemented + tested for purchasing (AC1–5); AC6 transitions in `@lbgos/domain` units.ts, used by reversal (more with 4.3/4.4) | migrations 0001/0008, `@lbgos/domain` imei.ts/units.ts, `modules/purchasing/problems.ts` | TR-0012 #3–5 |
| FR-INV-4 | Inventory | Stock ledger | 4 | Implemented + tested (AC1–4: append-only ledger, REVERSAL corrections, trigger-maintained projection + reconciliation, adjustments/write-offs/corrections with reasons and approval requests) | migrations 0001/0008/0009, `modules/inventory/`, `modules/approvals/`, `routes/inventory.ts` | TR-0012 #6; TR-0013 #1–12 |
| FR-INV-5 | Inventory | Confirmed transactions only | 4–5 | Implemented + tested (AC1–2 purchases and sales; AC3 negative stock refused incl. concurrent last-unit sale; AC4 concurrent sale of one IMEI: exactly one succeeds; issuing is atomic) | migration 0008 trigger, `modules/purchasing/`, `modules/inventory/`, `modules/sales/` | TR-0012 #2, #6, #10–11; TR-0013 #5, #8; TR-0019 #1, #6–9 |
| FR-INV-6 | Inventory | Returns inspection | 4–5 | Implemented + tested (AC1 credit notes and cancellations with returned goods put units/quantities in INSPECTION via SALE_RETURN; AC2–3 outcomes, only RESTOCK makes them sellable) | migrations 0010, 0015; `modules/inventory/inspections.ts`, `modules/sales/returns.ts` | TR-0014 #1–6; TR-0021 #2, #4–5 |
| FR-INV-7 | Inventory | Alerts and reports | 4 | Implemented + tested (AC1 low-stock list; AC2 slow/dead with configurable N/M; AC3 reorder suggestion with formula, period, label; optional notification not built; on-order counted as 0 until purchase orders exist; low-stock dashboard tile in 6.5) | `@lbgos/domain` stock-reports.ts, `modules/inventory/reports.ts`, `modules/reports/dashboard.ts` | TR-0014 #7–10, TR-0030 #1 |
| FR-INV-8 | Inventory | Suppliers and purchases | 4 | Implemented + tested (AC1–4; attachments with 4.5 uploads) | migration 0008, `packages/modules/src/purchasing/`, `apps/api/src/routes/purchasing.ts` | TR-0012 #1–10 |
| FR-INV-9 | Inventory | Barcode/QR scanning | 4 | Implemented + tested in Chromium (AC1 keyboard-wedge input in the stock lookup and IMEI fields; AC2 camera button only when `BarcodeDetector` exists, manual field otherwise — headless Chromium has none; real scanners and phones not yet tested) | `modules/inventory/reports.ts`, `apps/web/src/pages/stock.tsx`, `purchases.tsx` | TR-0014 #11–12; TR-0016 #2, #6 |
| FR-OCR-1 | OCR | Capture and upload | 4 | Implemented + tested (AC1–3: upload JPEG/PNG/WebP/PDF from the scan screen, HEIC rejected with guidance, two scan types, status polling and retry; camera capture relies on the browser's file picker — not yet tried on a real phone) | migration 0011, `modules/ocr/`, `routes/scans.ts`, `apps/web/src/pages/scans.tsx` | TR-0015 #1–3, #9; TR-0016 #4 |
| FR-OCR-2 | OCR | Confidence and evidence | 4 | Implemented + tested (API: value, confidence level, source line per field; flagged fields must be confirmed before Create; image regions not available from the mock adapter) | `@lbgos/domain` ocr-parse.ts, `modules/ocr/jobs.ts` | TR-0015 #5, #7 |
| FR-OCR-3 | OCR | Deterministic validation | 4 | Implemented + tested (IMEI Luhn/format flags, duplicates in scan and in business, money/date parsing, recomputed line amounts with mismatch flags) | `@lbgos/domain` ocr-parse.ts, `modules/ocr/jobs.ts` | TR-0015 #5–8 |
| FR-OCR-4 | OCR | Review before posting | 4 | Implemented + tested (API and review screen: nothing created before Create, which stays disabled until every flagged field is confirmed; drafts only; match proposals with reasons) | `modules/ocr/jobs.ts`, `apps/web/src/pages/scans.tsx` | TR-0015 #6–8; TR-0016 #4 |
| FR-OCR-5 | OCR | Untrusted content | 4 | Implemented + tested (no LLM configured; AC2 strict-schema structurer hook with discard → manual entry; AC3 injection corpus unit + end to end) | `modules/ocr/structuring.ts`, `@lbgos/domain` ocr-parse.ts | TR-0015 #12–15 |
| FR-OCR-6 | OCR | File safety | 4 | In progress (AC1, AC2, AC3 worker thread with heap limit/timeout, AC5 tested; AC4 no scanner configured — stated; OS-level sandbox and S3 storage pending) | `@lbgos/domain` file-sniff.ts, `modules/ocr/` | TR-0015 #1–4, #9–11, #16 |
| FR-POS-1 | POS | Fast selling | 5 | Implemented + tested (AC1 search by name/model/SKU/barcode/IMEI; p95 42 ms over 10,000 variants **measured in the dev container, not the reference environment**; AC2 unit by IMEI; AC3 single-item sale to a known customer in 5 interactions in the browser; AC4 held carts resumable, no reservation) | `modules/sales/search.ts`, `apps/web/src/pages/pos.tsx` | TR-0019 #17–18; TR-0025 #1, #6–7 |
| FR-POS-2 | POS | Discounts within limits | 5 | In progress (AC1–3 implemented + tested via approval requests; in-person approver re-authentication not offered yet, D-040; POS screen applies line and invoice discounts and offers the approval request) | `domain/discount-limits.ts`, `modules/sales/`, `modules/approvals/`, `pages/pos.tsx` | TR-0019 #13–16, #20, #22b; TR-0025 #1 |
| FR-POS-3 | POS | Payments, partial payments, returns and refunds | 5 | In progress (AC1–4, AC6 at checkout tested; payment-method list fixed, not configurable; AC5 returns via credit notes, refunds with `refunds.approve` tested; later payments in TR-0020; POS split payment UPI + cash with balance due in the browser) | migrations 0001, 0013–0015; `modules/sales/`, `pages/pos.tsx`, `pages/customers.tsx` | TR-0002 T24; TR-0019 #10–12; TR-0021 #2, #5, #7; TR-0025 #1, #3 |
| FR-POS-4 | POS | Invoice numbering | 5 | Implemented + tested (AC1–5: series per type and FY created on first use, number taken under the series lock, FY boundary in business timezone, format validation, concurrent issuers without gaps/duplicates) | `@lbgos/domain` numbering.ts, `modules/sales/numbering.ts`, migration 0012 | TR-0017 #7; TR-0018 #6–8 |
| FR-POS-5 | POS | Customer capture | 5 | In progress (customer lookup by mobile, inline create with name + mobile, optional GSTIN/state with place of supply implemented + tested; checkout use in 5.3) | `modules/customers/`, `@lbgos/domain` customers.ts, `routes/sales.ts` | TR-0018 #1–4 |
| FR-TAX-1 | Tax | Deterministic tax calculation | 5 | In progress (pure engine implemented + tested: AC2–AC5 incl. ≥95 % branch coverage measured — 100 % for the engine; AC1 per-line snapshots stored on issue; AC4 document type by tax profile) | `packages/domain/src/tax-engine.ts`, `modules/sales/pricing.ts` | TR-0017 #1–4; TR-0019 #1–4 |
| FR-TAX-2 | Tax | Configurable, versioned rates | 4–5 | Implemented + tested (AC1, AC3; AC2 re-authentication: tax settings need a sign-in within 10 minutes) | migration 0007, `catalogue/tax-rates.ts`, `apps/api/src/auth-plugin.ts` (`freshAuth`) | TR-0011 #6–7; TR-0018 #9 |
| FR-TAX-3 | Tax | Credit/debit notes and cancellations | 5 | Implemented + tested (AC1 cancellation within the window with reversal movements and ledger, number kept; AC2 outside the window refused; AC3 full/partial credit notes from line snapshots, own series, returns into inspection; AC4 debit notes increase the amount due) — printed notes in 5.6 | migrations 0001, 0015; `modules/sales/returns.ts` | TR-0002 T16–T16g; TR-0005; TR-0021 #1–8 |
| FR-TAX-4 | Tax | E-invoice / signature only where applicable | 5 | In progress (AC2: printed documents tested to carry no e-invoice/IRN/QR/digital-signature statements; AC1: no e-invoice, e-way bill or signature feature exists, so nothing to enable — remains off until an integration is configured) | `modules/sales/print.ts` | TR-0023 #2 |
| FR-PRN-1 | Print | Print and PDF | 5 | In progress (AC1 four templates, default size per business, choosable per print; AC2 required fields from the issued snapshot; AC3 PDF by headless Chromium with the same text as the print page — automated; AC4 manual tests on real browsers/devices and a thermal printer **not done**; print/PDF links on the POS and invoice screens) | migration 0016, `modules/sales/print.ts`, `print-settings.ts`, `apps/api/src/pdf.ts` | TR-0023 #1–6; TR-0025 #2 |
| FR-CRM-1 | CRM | Customer profile | 5–6 | Done (AC1: core and optional fields incl. alternate mobile, DOB, tags, preferred channels; AC2 owned units with warranty as recorded, payments and balance; communications (6.2) and profile screen (6.7)) | migrations 0012, 0017, `modules/customers/` | TR-0018 #1–5, TR-0026 #1–3, #5, TR-0032 #1 |
| FR-CRM-2 | CRM | Data minimisation | 5–6 | Done (AC1 only name and mobile required, optional fields labelled optional; AC2 export of chosen fields with `customers.export`, audited; export screen) | `modules/customers/`, `routes/sales.ts`, `pages/customer-crm.tsx` | TR-0018 #1, TR-0026 #1, #4, TR-0032 #6 |
| FR-PRV-1 | Privacy | Data subject requests | 6 | Done (AC1 corrections audited since 5.2/6.1; AC2 erasure); legal retention to be confirmed (NFR-12) | migration 0021, `modules/privacy/`, `routes/privacy.ts` | TR-0026 #1, TR-0031 #1–4, #7, TR-0032 #7 |
| FR-PRV-2 | Privacy | Tenant data export | 6 | Done (ZIP of CSVs, owner, read-only allowed, audited; in-memory up to 200k rows per table) | `modules/privacy/` | TR-0031 #5–6, TR-0032 #8 |
| FR-LED-1 | Ledger | Customer ledger | 5 | In progress (INVOICE, PAYMENT, REFUND, REVERSAL entries written and tested; AC2 balance = Σ entries = receivable − advance; AC3 append-only and statement with opening/closing balance for any date range (business timezone) tested — printing/export of statements in 5.6/5.7; CREDIT_NOTE/DEBIT_NOTE in 5.5; ADJUSTMENT not offered yet) | migrations 0001, 0014; `modules/sales/sale.ts`, `modules/sales/payments.ts` | TR-0002 T18–T18d; TR-0005; TR-0019 #10–11; TR-0020 #1–9 |
| FR-LED-2 | Ledger | Deterministic allocation | 5 | Implemented + tested (pure module AC1–2; in the database: FIFO and selected invoices, advance, advance applied, refund, reversal; parallel payments never over-allocate; status derived) | `packages/domain/src/allocation.ts`, `modules/sales/payments.ts`, migration 0014 | TR-0017 #5–6; TR-0020 #1–7 |
| FR-LED-3 | Ledger | Metric separation | 5 | In progress (reports API and screen label net/gross sales, returns, taxable value, tax, cash received, receivables, advances, COGS and gross margin separately with §7 definitions; tests check no sales figure is called profit or cash; dashboard API tiles with definitions in 6.5, overview screen in 6.7) | `modules/reports/`, `apps/web/src/pages/reports.tsx` | TR-0024 #4, #10, TR-0030 #1–3 |
| FR-CON-1 | Consent | Consent and suppression | 6 | Done (AC1–4: consent records, suppression, send-time gate, communication history) | migration 0018, `modules/messaging/`, `routes/messaging.ts`, `domain/messaging.ts` | TR-0027 #1–7, #11–13, TR-0032 #1, #3–4 |
| FR-REM-1 | Reminders | Reminders | 6 | Done (AC1–3; run on request, no daily scheduler yet) | migration 0019, `modules/reminders/`, `routes/reminders.ts`, `domain/reminders.ts` | TR-0028 #1–9, #12, TR-0032 #2 |
| FR-RPT-1 | Reports | Report set | 5–6 | In progress (Phase 5 subset done with exact values on a seeded dataset: sales summary with previous period, sales by brand/model/variant, margin, receivables ageing, cash received by method, returns, tax summary, stock valuation; low/slow/dead stock in TR-0014; expenses and operating-profit estimate in 6.4; stock-movement report and campaign results later) | `modules/reports/` | TR-0024 #1–8, TR-0029 #7 |
| FR-RPT-2 | Reports | Definitions shown | 5 | Implemented + tested for the Phase 5 reports (every report returns its metric definitions; the Reports screen shows each next to its figure; exports include them) | `packages/domain/src/metrics.ts`, `modules/reports/`, `pages/reports.tsx` | TR-0017 #8; TR-0024 #4, #10 |
| FR-RPT-3 | Reports | Timezone and financial periods | 5–6 | Implemented + tested (sales at 23:30 and 00:15/00:30 IST, 31 March / 1 April FY split, payments by business date, week start configurable, default Monday) | `packages/domain/src/periods.ts`, `modules/reports/` | TR-0024 #1–3, #6 |
| FR-RPT-4 | Reports | Export | 5–6 | Implemented + tested (CSV for every report, XLSX for sales, stock and tax summaries and more, PDF for sales summary, tax summary and customer statements; `reports.export` plus the report's permission; every export audited) | `modules/reports/export.ts`, `routes/reports.ts` | TR-0024 #8–9 |
| FR-RPT-5 | Reports | AI analysis labelling | 5–6 | Specified | — | — |
| FR-EXP-1 | Expenses | Expenses (optional module) | 6 | Done (AC1–2) | migration 0020, `modules/expenses/`, `routes/expenses.ts` | TR-0029 #1–6, #8–11, TR-0032 #5 |
| FR-AIC-1 | Creative | Generation | 7 | Specified | — | — |
| FR-AIC-2 | Creative | Grounding | 7 | Specified | — | — |
| FR-AIC-3 | Creative | Approval | 7 | Specified | — | — |
| FR-AIC-4 | Creative | Variants and scheduling | 7 | Specified | — | — |
| FR-AIC-5 | Creative | Cost and asset tracking | 7 | Specified | — | — |
| FR-HUB-1 | API Hub | Adapters | 7 | Specified | — | — |
| FR-HUB-2 | API Hub | Configuration fields | 7 | Specified | — | — |
| FR-HUB-3 | API Hub | Secret handling | 7 | Done in API (AC1–4: write-only with 4-character hint, envelope encryption with KEK outside the DB, redaction tested, re-auth and audit); integration screens in 7.7 | migration 0022, `modules/secrets/`, `routes/secrets.ts` | TR-0034 #1–13 |
| FR-HUB-4 | API Hub | Lifecycle and health | 7 | Specified | — | — |
| FR-HUB-5 | API Hub | SSRF protection | 7 | Done (AC1–5: guarded client, lint rule, address checks, pinned connection, redirects) | `modules/outbound/`, `tooling/eslint/no-raw-http.js` | TR-0033 #1–7 |
| FR-HUB-6 | API Hub | Ownership and cost attribution | 7 | Specified | — | — |
| FR-MSG-1 | Messaging | WhatsApp | 7 | In progress (AC3 send blocked without opt-in, AC4 provider-confirmed statuses only — adapter interface, no provider connected) | `modules/messaging/` | TR-0027 #3, #8–9 |
| FR-MSG-2 | Messaging | Indian SMS DLT | 7 | Specified | — | — |
| FR-MSG-3 | Messaging | Google Business Profile and Meta | 7 | Specified | — | — |
| FR-MSG-4 | Messaging | Truthful status | 7 | Specified | — | — |
| FR-MSG-5 | Messaging | Drafts, approval, retries, opt-out | 7 | Specified | — | — |
| FR-AGT-1 | Agents | Initial agents | 8 | Specified | — | — |
| FR-AGT-2 | Agents | Deterministic core | 8 | Specified | — | — |
| FR-AGT-3 | Agents | Least privilege, tenant scope | 8 | Specified | — | — |
| FR-AGT-4 | Agents | Human approval | 8 | In progress (generic approval requests with payload hash, expiry, R3 and idempotent execution exist for stock adjustments; agent actions in Phase 8) | `modules/approvals/` | TR-0013 #6–11 |
| FR-AGT-5 | Agents | Reliability and budgets | 8 | Specified | — | — |
| FR-AGT-6 | Agents | Agent audit | 8 | Specified | — | — |
| FR-SUB-1 | Commercial | Plans and subscription status | 3/8/10 | In progress (plans, TRIALING on approval, status gate; billing invoices/notifications later) | migration 0006, `tenancy/platform.ts` | TR-0008 #2, TR-0009 #3 |
| FR-SUB-2 | Commercial | Admin-configurable pricing | 3/8/10 | Implemented + tested (AC1 audited price edits; AC2 seed plans flagged pilot) | `onboarding/platform.ts`, `routes/platform.ts` | TR-0009 #9 |
| FR-SUB-3 | Commercial | Metering and quotas | 3/8/10 | Specified | — | — |
| FR-AUD-1 | Audit | Audit log | 3 | In progress (append-only store + lifecycle/member/auth events; more actions as modules arrive) | `packages/modules/src/audit/` | TR-0005, TR-0007 #16, TR-0008 #12 |
| FR-MEM-1 | Continuity | Project memory | 0 | Implemented + tested (in CI) | `scripts/check-docs.sh` | TR-0001, TR-0002, TR-0006 #2 |
| NFR-1 | Non-functional | Responsive, accessible UI | 3–9 | In progress (axe 0 serious/critical on 16 screens × 360/768/1280 px, no overflow; keyboard-only/screen-reader checks pending) | `apps/web` | TR-0010 #4, #6; TR-0016 #7 |
| NFR-2 | Non-functional | Modular monolith | 3–9 | In progress | Monorepo + `tooling/eslint/module-boundaries.js` | TR-0004 #4–5 |
| NFR-3 | Non-functional | TypeScript + validation | 3–9 | In progress (TS strict; API validation pending) | `tsconfig.base.json` | TR-0004 #2 |
| NFR-4 | Non-functional | Tenant isolation in two layers | 3–9 | In progress (DB layer + service-layer membership/permission gate; per-endpoint cross-tenant tests for routes so far) | migrations, `apps/api/src/auth-plugin.ts` | TR-0005, TR-0008 #5, #9–10 |
| NFR-5 | Non-functional | Background jobs | 3–9 | In progress (OCR jobs: status, retries ≤3, SKIP LOCKED claiming, stale-job recovery, permission re-check; other job types later — D-036) | `modules/ocr/jobs.ts`, migration 0011 | TR-0015 #9–11 |
| NFR-6 | Non-functional | Private storage | 3–9 | In progress (private local/in-memory storage, authenticated proxy downloads; signed-URL S3 storage pending hosting Q2) | `modules/ocr/storage.ts`, `routes/scans.ts` | TR-0015 #1, #4 |
| NFR-7 | Non-functional | Swappable providers | 3–9 | In progress (OCR adapter interface; mock and test adapters swapped by configuration in tests) | `modules/ocr/isolate.ts`, `mock-adapter.ts` | TR-0015 #9–10 |
| NFR-8 | Non-functional | Money correctness | 3–9 | In progress (integer paise/basis-point arithmetic in `@lbgos/domain` money.ts; bigint/numeric columns; lint/schema check pending) | `packages/domain/src/money.ts` | TR-0011 #1 |
| NFR-9 | Non-functional | Time handling | 3–9 | Specified | — | — |
| NFR-10 | Non-functional | Observability | 3–9 | In progress (JSON logs, request IDs, redaction, health/readiness) | `apps/api/src/app.ts` | TR-0006 #7–8, #12–13 |
| NFR-11 | Non-functional | Backups | 3–9 | Specified | — | — |
| NFR-12 | Non-functional | Data protection | 3–9 | Specified | — | — |
| NFR-13 | Non-functional | Password storage | 3–9 | Implemented + tested | `packages/modules/src/auth/passwords.ts` | TR-0007 #11 |
| NFR-14 | Non-functional | Performance (pilot) | 3–9 | Specified | — | — |
| NFR-15 | Non-functional | Availability (pilot) | 3–9 | Specified | — | — |
| NFR-16 | Non-functional | Browser support | 3–9 | In progress (Chromium automated; Firefox, Safari/WebKit and real devices not yet tested) | `apps/api/test/browser.db.test.ts` | TR-0010 #3 |
| NFR-17 | Non-functional | Security headers | 3–9 | Implemented + tested (API) | `apps/api/src/app.ts` | TR-0006 #6 |
| NFR-18 | Non-functional | Webhook security | 3–9 | Specified | — | — |
| NFR-19 | Non-functional | Supply chain | 3–9 | Implemented + tested (CI audit + secret scan; lockfile) | `.github/workflows/ci.yml` | TR-0006 #1–4 |

## Security threats

Threat-by-threat mitigation status is tracked in `SECURITY_THREAT_MODEL.md` §6 (T1–T31).
