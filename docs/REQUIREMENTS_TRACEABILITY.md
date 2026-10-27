# Requirements Traceability Matrix

Requirement IDs are defined in `REQUIREMENTS_BLUEPRINT.md` (refined into the SRS in Phase 1).
Status values: `Not started` · `Specified` · `In progress` · `Implemented (untested)` · `Implemented + tested` · `Verified` · `Blocked`.
Test evidence must reference an entry in `TEST_REPORT.md`. No entry may claim testing without such evidence.

Last updated: 2026-10-27 (Phase 0)

| Req ID | Module | Summary | Phase | Status | Implementation | Test evidence |
|---|---|---|---|---|---|---|
| FR-MEM-1 | Continuity | Project memory docs in `/docs` | 0 | Implemented (docs) | `docs/*.md`, `CLAUDE.md` | TR-0001 (file presence & secret-pattern check) |
| FR-AUTH-1 | Auth | Login/logout, session expiry, revocation | 3 | Not started | — | — |
| FR-AUTH-2 | Auth | Reset/verification without enumeration | 3 | Not started | — | — |
| FR-AUTH-3 | Auth | MFA for privileged users | 3 | Not started | — | — |
| FR-AUTH-4 | Auth | Login rate limiting | 3 | Not started | — | — |
| FR-ONB-1 | Onboarding | Self-registration → PENDING_APPROVAL | 3 | Not started | — | — |
| FR-ONB-2 | Onboarding | Setup wizard + progress | 3 | Not started | — | — |
| FR-ONB-3 | Onboarding | Approval history, notifications | 3 | Not started | — | — |
| FR-RBAC-1 | Auth | Least-privilege configurable roles | 3 | Not started | — | — |
| BR-T1..T4 | Tenancy | Business status lifecycle | 3 | Not started | — | — |
| FR-AUD-1 | Audit | Append-only audit log | 3 | Not started | — | — |
| FR-INV-1..9 | Inventory | Catalogue, variants, IMEI units, stock ledger, returns inspection, alerts, suppliers, scanning | 4 | Not started | — | — |
| FR-OCR-1..6 | OCR | Capture, confidence, validation, review, untrusted input, file safety | 4 | Not started | — | — |
| FR-POS-1..5 | POS | Billing, discounts, payments, numbering, customer capture | 5 | Not started | — | — |
| FR-TAX-1..4 | Tax | Deterministic GST calc, versioned config, notes, e-invoice only where applicable | 5 | Not started | — | — |
| FR-PRN-1 | Print | A4/A5/80mm/58mm, PDF | 5 | Not started | — | — |
| FR-LED-1..3 | Ledger | Customer ledger, allocation, metric separation | 5 | Not started | — | — |
| FR-CRM-1..2 | CRM | Profiles, minimisation | 6 | Not started | — | — |
| FR-CON-1 | CRM | Consent, suppression, history | 6 | Not started | — | — |
| FR-REM-1 | CRM | Reminders | 6 | Not started | — | — |
| FR-RPT-1..5 | Analytics | Reports, definitions, timezone/FY, export, AI fact/estimate | 5–6 | Not started | — | — |
| FR-HUB-1..6 | API Hub | Adapters, config, vault, health, SSRF, cost attribution | 7 | Not started | — | — |
| FR-AIC-1..5 | Creative | Drafts/media, grounding, approval, variants, cost | 7 | Not started | — | — |
| FR-MSG-1..5 | Messaging | WhatsApp, DLT SMS, GBP/Meta, confirmed status, approval/opt-out | 7 | Not started | — | — |
| FR-AGT-1..6 | Agents | Five agents, deterministic core, least privilege, approval, idempotency, audit | 8 | Not started | — | — |
| FR-SUB-1..3 | Commercial | Plans, configurable pricing, metering/quotas | 3/8/10 | Not started | — | — |
| NFR-1..12 | Non-functional | See blueprint §5 | 3–9 | Not started | — | — |
| SEC T1–T24 | Security | See `SECURITY_THREAT_MODEL.md` | 3–9 | Not started | — | — |
