# Requirements Traceability Matrix

Requirement IDs and acceptance criteria are defined in `SRS.md` (Phase 1). Origin: `REQUIREMENTS_BLUEPRINT.md`.
Status values: `Not started` · `Specified` · `In progress` · `Implemented (untested)` · `Implemented + tested` · `Verified` · `Blocked`.
Test evidence must reference an entry in `TEST_REPORT.md`. "In progress (DB layer)" means the database-level controls exist in real migrations and are tested (TR-0005), but the application features using them are not built yet.

Generated from `SRS.md` headings; `scripts/check-docs.sh` fails if an SRS requirement is missing here.

Last updated: 2026-10-27 (Phase 4, increment 4.1) · 100 requirements

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
| FR-RBAC-1 | RBAC | Roles and permissions | 3 | Implemented + tested (AC1–4; R3 pending approvals module) | `@lbgos/domain` permissions, `apps/api/src/auth-plugin.ts`, `tenancy/members.ts` | TR-0008 #1, #4, #9 |
| FR-SUP-1 | Support | Support access | 3 | Specified | — | — |
| FR-INV-1 | Inventory | Hierarchy | 4 | Implemented + tested (AC1–3) | migration 0007, `packages/modules/src/catalogue/`, `apps/api/src/routes/catalogue.ts` | TR-0011 #2–4 |
| FR-INV-2 | Inventory | Phone attributes | 4 | Implemented + tested (AC1–4) | migration 0007, `packages/modules/src/catalogue/` | TR-0011 #2, #5 |
| FR-INV-3 | Inventory | Serialized units and IMEI | 4 | In progress (DB layer + domain validation) | `packages/db/migrations/0001_foundation.sql`, `packages/domain/src/imei.ts` | TR-0002 T09–T11; TR-0005 (migrated DB) |
| FR-INV-4 | Inventory | Stock ledger | 4 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T12–T13b, T28, T28b; TR-0005 (migrated DB) |
| FR-INV-5 | Inventory | Confirmed transactions only | 4 | Specified | — | — |
| FR-INV-6 | Inventory | Returns inspection | 4 | Specified | — | — |
| FR-INV-7 | Inventory | Alerts and reports | 4 | Specified | — | — |
| FR-INV-8 | Inventory | Suppliers and purchases | 4 | Specified | — | — |
| FR-INV-9 | Inventory | Barcode/QR scanning | 4 | Specified | — | — |
| FR-OCR-1 | OCR | Capture and upload | 4 | Specified | — | — |
| FR-OCR-2 | OCR | Confidence and evidence | 4 | Specified | — | — |
| FR-OCR-3 | OCR | Deterministic validation | 4 | Specified | — | — |
| FR-OCR-4 | OCR | Review before posting | 4 | Specified | — | — |
| FR-OCR-5 | OCR | Untrusted content | 4 | Specified | — | — |
| FR-OCR-6 | OCR | File safety | 4 | Specified | — | — |
| FR-POS-1 | POS | Fast selling | 5 | Specified | — | — |
| FR-POS-2 | POS | Discounts within limits | 5 | Specified | — | — |
| FR-POS-3 | POS | Payments, partial payments, returns and refunds | 5 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T24; TR-0005 (migrated DB) |
| FR-POS-4 | POS | Invoice numbering | 5 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T14–T14e; spike TR-0003 (concurrent gapless numbering); TR-0005 (migrated DB) |
| FR-POS-5 | POS | Customer capture | 5 | Specified | — | — |
| FR-TAX-1 | Tax | Deterministic tax calculation | 5 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T15–T15c; TR-0005 (migrated DB) |
| FR-TAX-2 | Tax | Configurable, versioned rates | 4–5 | In progress (AC1 and AC3 implemented + tested; AC2 audited and permission-gated, re-authentication pending — D-030) | migration 0007, `catalogue/tax-rates.ts`, `@lbgos/domain` tax-rates | TR-0011 #6–7 |
| FR-TAX-3 | Tax | Credit/debit notes and cancellations | 5 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T16–T16g; TR-0005 (migrated DB) |
| FR-TAX-4 | Tax | E-invoice / signature only where applicable | 5 | Specified | — | — |
| FR-PRN-1 | Print | Print and PDF | 5 | Specified | — | — |
| FR-CRM-1 | CRM | Customer profile | 6 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T27, T27b; TR-0005 (migrated DB) |
| FR-CRM-2 | CRM | Data minimisation | 6 | Specified | — | — |
| FR-PRV-1 | Privacy | Data subject requests | 6 | Specified | — | — |
| FR-PRV-2 | Privacy | Tenant data export | 6 | Specified | — | — |
| FR-LED-1 | Ledger | Customer ledger | 5 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T18–T18d; TR-0005 (migrated DB) |
| FR-LED-2 | Ledger | Deterministic allocation | 5 | In progress (DB layer) | `packages/db/migrations/0001_foundation.sql` | TR-0002 T17–T17c; spike TR-0003 (allocation locking, D-020); TR-0005 (migrated DB) |
| FR-LED-3 | Ledger | Metric separation | 5 | Specified | — | — |
| FR-CON-1 | Consent | Consent and suppression | 6 | Specified | — | — |
| FR-REM-1 | Reminders | Reminders | 6 | Specified | — | — |
| FR-RPT-1 | Reports | Report set | 5–6 | Specified | — | — |
| FR-RPT-2 | Reports | Definitions shown | 5–6 | Specified | — | — |
| FR-RPT-3 | Reports | Timezone and financial periods | 5–6 | Specified | — | — |
| FR-RPT-4 | Reports | Export | 5–6 | Specified | — | — |
| FR-RPT-5 | Reports | AI analysis labelling | 5–6 | Specified | — | — |
| FR-EXP-1 | Expenses | Expenses (optional module) | 6 | Specified | — | — |
| FR-AIC-1 | Creative | Generation | 7 | Specified | — | — |
| FR-AIC-2 | Creative | Grounding | 7 | Specified | — | — |
| FR-AIC-3 | Creative | Approval | 7 | Specified | — | — |
| FR-AIC-4 | Creative | Variants and scheduling | 7 | Specified | — | — |
| FR-AIC-5 | Creative | Cost and asset tracking | 7 | Specified | — | — |
| FR-HUB-1 | API Hub | Adapters | 7 | Specified | — | — |
| FR-HUB-2 | API Hub | Configuration fields | 7 | Specified | — | — |
| FR-HUB-3 | API Hub | Secret handling | 7 | Specified | — | — |
| FR-HUB-4 | API Hub | Lifecycle and health | 7 | Specified | — | — |
| FR-HUB-5 | API Hub | SSRF protection | 7 | Specified | — | — |
| FR-HUB-6 | API Hub | Ownership and cost attribution | 7 | Specified | — | — |
| FR-MSG-1 | Messaging | WhatsApp | 7 | Specified | — | — |
| FR-MSG-2 | Messaging | Indian SMS DLT | 7 | Specified | — | — |
| FR-MSG-3 | Messaging | Google Business Profile and Meta | 7 | Specified | — | — |
| FR-MSG-4 | Messaging | Truthful status | 7 | Specified | — | — |
| FR-MSG-5 | Messaging | Drafts, approval, retries, opt-out | 7 | Specified | — | — |
| FR-AGT-1 | Agents | Initial agents | 8 | Specified | — | — |
| FR-AGT-2 | Agents | Deterministic core | 8 | Specified | — | — |
| FR-AGT-3 | Agents | Least privilege, tenant scope | 8 | Specified | — | — |
| FR-AGT-4 | Agents | Human approval | 8 | Specified | — | — |
| FR-AGT-5 | Agents | Reliability and budgets | 8 | Specified | — | — |
| FR-AGT-6 | Agents | Agent audit | 8 | Specified | — | — |
| FR-SUB-1 | Commercial | Plans and subscription status | 3/8/10 | In progress (plans, TRIALING on approval, status gate; billing invoices/notifications later) | migration 0006, `tenancy/platform.ts` | TR-0008 #2, TR-0009 #3 |
| FR-SUB-2 | Commercial | Admin-configurable pricing | 3/8/10 | Implemented + tested (AC1 audited price edits; AC2 seed plans flagged pilot) | `onboarding/platform.ts`, `routes/platform.ts` | TR-0009 #9 |
| FR-SUB-3 | Commercial | Metering and quotas | 3/8/10 | Specified | — | — |
| FR-AUD-1 | Audit | Audit log | 3 | In progress (append-only store + lifecycle/member/auth events; more actions as modules arrive) | `packages/modules/src/audit/` | TR-0005, TR-0007 #16, TR-0008 #12 |
| FR-MEM-1 | Continuity | Project memory | 0 | Implemented + tested (in CI) | `scripts/check-docs.sh` | TR-0001, TR-0002, TR-0006 #2 |
| NFR-1 | Non-functional | Responsive, accessible UI | 3–9 | In progress (axe 0 serious/critical on 8 screens × 360/768/1280 px, no overflow; keyboard-only/screen-reader checks pending) | `apps/web` | TR-0010 #4, #6 |
| NFR-2 | Non-functional | Modular monolith | 3–9 | In progress | Monorepo + `tooling/eslint/module-boundaries.js` | TR-0004 #4–5 |
| NFR-3 | Non-functional | TypeScript + validation | 3–9 | In progress (TS strict; API validation pending) | `tsconfig.base.json` | TR-0004 #2 |
| NFR-4 | Non-functional | Tenant isolation in two layers | 3–9 | In progress (DB layer + service-layer membership/permission gate; per-endpoint cross-tenant tests for routes so far) | migrations, `apps/api/src/auth-plugin.ts` | TR-0005, TR-0008 #5, #9–10 |
| NFR-5 | Non-functional | Background jobs | 3–9 | Specified | — | — |
| NFR-6 | Non-functional | Private storage | 3–9 | Specified | — | — |
| NFR-7 | Non-functional | Swappable providers | 3–9 | Specified | — | — |
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
