# Requirements Traceability Matrix

Requirement IDs and acceptance criteria are defined in `SRS.md` (Phase 1). Origin: `REQUIREMENTS_BLUEPRINT.md`.
Status values: `Not started` · `Specified` · `In progress` · `Implemented (untested)` · `Implemented + tested` · `Verified` · `Blocked`.
Test evidence must reference an entry in `TEST_REPORT.md`. "Design prototype only" means a database-level control was exercised in the schema draft (TR-0002); the requirement itself is **not implemented** in any application.

Generated from `SRS.md` headings; `scripts/check-docs.sh` fails if an SRS requirement is missing here.

Last updated: 2026-10-27 (Phase 2) · 100 requirements

| Req ID | Module | Summary | Phase | Status | Implementation | Test evidence |
|---|---|---|---|---|---|---|
| BR-T1 | Tenancy | Pending application | 3 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T23, T23a |
| BR-T2 | Tenancy | Approval history | 3 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T02, T02b |
| BR-T3 | Tenancy | Reasons required | 3 | Specified | — | — |
| BR-T4 | Tenancy | Suspension and read-only modes | 3 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T03 |
| FR-AUTH-1 | Auth | Sessions | 3 | Specified | — | — |
| FR-AUTH-2 | Auth | Password reset and verification | 3 | Specified | — | — |
| FR-AUTH-3 | Auth | MFA | 3 | Specified | — | — |
| FR-AUTH-4 | Auth | Rate limiting | 3 | Specified | — | — |
| FR-AUTH-5 | Auth | MFA recovery | 3 | Specified | — | — |
| FR-ONB-1 | Onboarding | Registration and admin creation | 3 | Specified | — | — |
| FR-ONB-2 | Onboarding | Setup wizard | 3 | Specified | — | — |
| FR-ONB-3 | Onboarding | Notifications and history | 3 | Specified | — | — |
| FR-RBAC-1 | RBAC | Roles and permissions | 3 | Specified | — | — |
| FR-SUP-1 | Support | Support access | 3 | Specified | — | — |
| FR-INV-1 | Inventory | Hierarchy | 4 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T07, T08 |
| FR-INV-2 | Inventory | Phone attributes | 4 | Specified | — | — |
| FR-INV-3 | Inventory | Serialized units and IMEI | 4 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T09–T11 |
| FR-INV-4 | Inventory | Stock ledger | 4 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T12–T13b, T28, T28b |
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
| FR-POS-3 | POS | Payments, partial payments, returns and refunds | 5 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T24 |
| FR-POS-4 | POS | Invoice numbering | 5 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T14–T14e; spike TR-0003 (concurrent gapless numbering) |
| FR-POS-5 | POS | Customer capture | 5 | Specified | — | — |
| FR-TAX-1 | Tax | Deterministic tax calculation | 5 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T15–T15c |
| FR-TAX-2 | Tax | Configurable, versioned rates | 5 | Specified | — | — |
| FR-TAX-3 | Tax | Credit/debit notes and cancellations | 5 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T16–T16g |
| FR-TAX-4 | Tax | E-invoice / signature only where applicable | 5 | Specified | — | — |
| FR-PRN-1 | Print | Print and PDF | 5 | Specified | — | — |
| FR-CRM-1 | CRM | Customer profile | 6 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T27, T27b |
| FR-CRM-2 | CRM | Data minimisation | 6 | Specified | — | — |
| FR-PRV-1 | Privacy | Data subject requests | 6 | Specified | — | — |
| FR-PRV-2 | Privacy | Tenant data export | 6 | Specified | — | — |
| FR-LED-1 | Ledger | Customer ledger | 5 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T18–T18d |
| FR-LED-2 | Ledger | Deterministic allocation | 5 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T17–T17c; spike TR-0003 (allocation locking, D-020) |
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
| FR-SUB-1 | Commercial | Plans and subscription status | 3/8/10 | Specified | — | — |
| FR-SUB-2 | Commercial | Admin-configurable pricing | 3/8/10 | Specified | — | — |
| FR-SUB-3 | Commercial | Metering and quotas | 3/8/10 | Specified | — | — |
| FR-AUD-1 | Audit | Audit log | 3 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T25–T25d |
| FR-MEM-1 | Continuity | Project memory | 0 | Implemented + tested | `scripts/check-docs.sh` | TR-0001, TR-0002 (#doc checks) |
| NFR-1 | Non-functional | Responsive, accessible UI | 3–9 | Specified | — | — |
| NFR-2 | Non-functional | Modular monolith | 3–9 | Specified | — | — |
| NFR-3 | Non-functional | TypeScript + validation | 3–9 | Specified | — | — |
| NFR-4 | Non-functional | Tenant isolation in two layers | 3–9 | Specified | `docs/data-model/schema_draft.sql` (design draft) | Design prototype only: TR-0002 T04–T08, T19–T22, T26, T26b; spike TR-0003 (withTenant under concurrency) |
| NFR-5 | Non-functional | Background jobs | 3–9 | Specified | — | — |
| NFR-6 | Non-functional | Private storage | 3–9 | Specified | — | — |
| NFR-7 | Non-functional | Swappable providers | 3–9 | Specified | — | — |
| NFR-8 | Non-functional | Money correctness | 3–9 | Specified | — | — |
| NFR-9 | Non-functional | Time handling | 3–9 | Specified | — | — |
| NFR-10 | Non-functional | Observability | 3–9 | Specified | — | — |
| NFR-11 | Non-functional | Backups | 3–9 | Specified | — | — |
| NFR-12 | Non-functional | Data protection | 3–9 | Specified | — | — |
| NFR-13 | Non-functional | Password storage | 3–9 | Specified | — | — |
| NFR-14 | Non-functional | Performance (pilot) | 3–9 | Specified | — | — |
| NFR-15 | Non-functional | Availability (pilot) | 3–9 | Specified | — | — |
| NFR-16 | Non-functional | Browser support | 3–9 | Specified | — | — |
| NFR-17 | Non-functional | Security headers | 3–9 | Specified | — | — |
| NFR-18 | Non-functional | Webhook security | 3–9 | Specified | — | — |
| NFR-19 | Non-functional | Supply chain | 3–9 | Specified | — | — |

## Security threats

Threat-by-threat mitigation status is tracked in `SECURITY_THREAT_MODEL.md` §6 (T1–T31).
