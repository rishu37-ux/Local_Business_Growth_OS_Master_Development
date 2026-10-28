# Phase 10 plan — Commercial readiness, onboarding guides, support procedures and pricing validation

Version 1.0 — 2026-10-28. Master prompt §Development process, Phase 10. SRS references:
- FR-SUP-1 (support access);
- FR-SUB-1 AC3 (platform billing invoices);
- FR-SUB-2 (pilot pricing, to be validated);
- FR-ONB-2 (setup wizard).

Acceptance criteria (AC) are fixed **before** coding. Only executed checks count (`TEST_REPORT.md`).

**What this phase cannot do without the user.** It cannot:
- validate prices with real shops (needs Q1 and pilot shops);
- take real payments (needs a payment gateway account, Q4);
- publish legal terms (needs counsel);
- run support with a real contact.

These items are prepared, not claimed.

## Increment 10.1 — Owner-granted support access (FR-SUP-1, threat T8)
**Status: done (TR-0045 #1–6, #11, D-067).**
- **AC1:** an owner (permission `support.grant`, recent sign-in) grants platform support access to the business for a stated purpose (10–500 characters) and a duration of 1–72 hours. The database refuses a grant longer than 72 hours.
- **AC2:** while a grant is active, a platform admin (MFA enforced) can **read** the business through the normal API, with view permissions only:
  - no exports;
  - no owner-only actions;
  - every non-GET request is refused.
  Without an active grant the admin gets 404, as any non-member does.
- **AC3:** every request made under a grant is recorded as a tenant audit event (`support.access`: method, route, grant), and so are the grant and its revocation. The owner sees the grants and the support actions.
- **AC4:** access ends automatically at expiry and immediately when the owner revokes. A revoked grant cannot be changed again, and grants cannot be deleted.
- Cross-tenant: a grant for business A gives no access to business B. Another business's owner cannot see or revoke A's grants.

## Increment 10.2 — Platform billing invoices with manual payment (FR-SUB-1 AC3)
**Status: done (TR-0045 #7–11, D-068); no gateway, GST not computed.**
- **AC1:** the platform admin issues a billing invoice for a business's subscription period, using the plan's price at that time. It gets a unique number per financial year (`LBG/<FY>/<n>`). Amounts are in integer paise; GST on the platform's own invoice is **not computed** until the tax review (Q5), and the invoice says so.
- **AC2:** a payment is recorded only as **manual** by an admin, with a reference and a reason (no gateway exists — Q4). Recording a payment marks the invoice paid. A paid or void invoice cannot be changed, and a void needs a reason. Every action is audited.
- **AC3:** the owner sees the business's billing invoices and their status. Other businesses see none of them.

## Increment 10.3 — Guides, procedures and pricing validation material
**Status: written** (`ONBOARDING_GUIDE.md`, `SUPPORT_PROCEDURES.md`, `PRICING_VALIDATION.md`, `COMMERCIAL_READINESS.md`); not yet checked with a real shop.
- **AC1:** `ONBOARDING_GUIDE.md` — owner and staff guides that follow the real screens: registration → approval → MFA → setup → catalogue → opening stock → first sale → payments → reports, plus a staff quick start per default role. Each step names the screen and says what the shop must check.
- **AC2:** `SUPPORT_PROCEDURES.md` — contact channels (placeholders until the user names them), severity levels and response targets, triage steps, the support-access procedure from 10.1, incident steps (linked to the runbook), data requests (export, erasure), and what support may never do.
- **AC3:** `PRICING_VALIDATION.md` — the seed plans with what each includes, cost per shop from `COST_MODEL.md`, the hypotheses to test, interview and usage questions, the measures that come from the product (usage and quota data), and the decision rule. Prices stay labelled "pilot pricing — to be validated".
- **AC4:** `COMMERCIAL_READINESS.md` — what must be true before paid launch (legal terms, privacy notice, GST registration of the platform, payment gateway, support, pen test, SLA wording). Each item has an owner and a status, and links to `PILOT_CHECKLIST.md`.

## Phase 10 exit
**Status: passed locally (TR-0045); CI result recorded when known. Paid launch stays blocked (`COMMERCIAL_READINESS.md`).**
10.1 and 10.2 pass their tests, including the cross-tenant and read-only tests. The guides and procedures are written against the real screens. Pricing and commercial readiness list what is open, with owners. CI is green. Paid launch stays blocked on the inputs listed in `COMMERCIAL_READINESS.md`.
