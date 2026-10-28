# Commercial readiness checklist (Phase 10.3)

Version 1.0 — 2026-10-28. What must be true before the platform charges shops money beyond a pilot. It builds on `PILOT_CHECKLIST.md`, which must be complete first. **Paid launch has not happened and is blocked on the items marked Blocked.**

Status values:
- **Ready** — done and shown by an executed check.
- **Prepared** — the mechanism or document exists; the real step is not done.
- **Blocked** — needs an input.
- **Open** — work to do.

| # | Area | Condition | Owner | Status | Evidence / what is missing |
|---|---|---|---|---|---|
| 1 | Pilot | The pilot ran with at least one real shop, and its review is done | User | **Blocked (Q1)** | `PILOT_CHECKLIST.md` |
| 2 | Pricing | Prices and plan contents decided from pilot evidence | User | **Prepared** | `PRICING_VALIDATION.md`; pilot prices only |
| 3 | Billing | Invoices to shops, numbered per financial year, immutable once issued | Developer | **Ready** | TR-0045 (billing invoices) |
| 4 | Billing | GST on the platform's invoices, the platform's GST registration, and invoice wording reviewed | User (tax professional) | **Blocked (Q5)** | Invoices say "GST not computed" |
| 5 | Payments | A payment gateway (e.g. UPI autopay / cards) with verified webhooks; reconciliation against billing invoices | User (account), developer | **Blocked (Q4)** | Manual payment record only (TR-0045) |
| 6 | Legal | Terms of service, privacy notice, data processing terms for shops (the shop is the controller of its customers' data), refund and price-change rules, reviewed by counsel for India (DPDP Act, IT Act, consumer law) | User (counsel) | **Open** | Nothing is claimed as compliant |
| 7 | Support | Named contact channels, hours and people. A rota for S1. | User | **Open** | `SUPPORT_PROCEDURES.md` (placeholders) |
| 8 | Support | Response targets written into the terms (or explicitly "best effort" for the pilot) | User | **Open** | Proposed targets in `SUPPORT_PROCEDURES.md` §2 |
| 9 | Support | Owner-granted, time-boxed, audited support access | Developer | **Ready** | TR-0045 (support access) |
| 10 | Security | External penetration test passed, with findings fixed | User | **Open** | `SECURITY_REVIEW.md` SR-10 |
| 11 | Security | Open review findings (SR-03…SR-08) closed or accepted in writing | User, developer | **Open** | `SECURITY_REVIEW.md` |
| 12 | Operations | Production hosting, backups with a timed restore, monitoring with alerts, on-call | User, developer | **Blocked (Q2, Q6)** | `PILOT_CHECKLIST.md` #2–4, #19 |
| 13 | Onboarding | Owner and staff guides checked with the pilot shop | Developer with the shop | **Prepared** | `ONBOARDING_GUIDE.md` |
| 14 | Onboarding | Bulk import of opening stock and customers (CSV) — needed at more than a handful of shops | Developer | **Open** | Not built; screen-by-screen entry only |
| 15a | Marketplaces | Amazon/Flipkart: seller accounts, API approval, a dedicated adapter tested against each, or an approved connector service; marketplace fees in the plan margin | User (accounts), developer | **Blocked (Q4)** | Connector contract and mock only (TR-0046) |
| 15 | Integrations | Only the providers that are sold are connected with real accounts and tested; their costs are in the plan margin | User (accounts), developer | **Blocked (Q4)** | `INTEGRATIONS_STATUS.md` (all mock) |
| 16 | Accessibility/devices | Firefox, Safari/WebKit and real Android/iOS devices tested; manual screen-reader check | Developer | **Open** | Chromium only (TR-0044 #10–12) |
| 17 | Company | Legal entity, bank account and GST registration of the platform operator | User | **Open** | — |

**Rule:** no shop is charged until items 1, 4, 6, 7, 10, 12 and 17 are done. Until then, any fee is a pilot arrangement agreed in writing with that shop.
