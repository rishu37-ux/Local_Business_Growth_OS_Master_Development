# Next Steps (ordered)

Last updated: 2026-10-28 (Phases 0–9 complete, CI green — the pilot itself is blocked; Phase 10 complete, CI #62 green; everything left needs the user's inputs)

## What is left — all of it needs the user

Every phase of the prompt (0–10) has been built and tested with synthetic data and mock providers. What remains cannot be done or verified without the user:

1. **Q1 pilot shop** — run the pilot (`PILOT_CHECKLIST.md`), check the onboarding guide with the shop, interview for pricing (`PRICING_VALIDATION.md`).
2. **Q2 hosting/budget** — staging and production, provider backups with a timed restore, monitoring and alerts, edge WAF.
3. **Q3 auth** — confirm self-hosted auth (D-019/D-024) or name a managed provider.
4. **Q4 accounts** — email, WhatsApp Cloud API + templates, SMS with DLT, AI provider, OCR engine, malware scanner, payment gateway.
5. **Q5 tax review** — GST rules, invoice format, the platform's own invoices.
6. **Q6 domain** — TLS, email sending.
7. **Legal review** — terms, privacy notice, DPDP Act, retention/erasure, consent wording, CERT-In duties.
8. **Repository owner** — branch protection on `main` with the CI checks required.
9. **Product decisions** — plan contents and allowances, trial length, yearly prices; support contacts and hours.
10. **External penetration test** before broad launch.

Developer work that can follow those inputs:
- CSV bulk import of opening stock and customers;
- Firefox/WebKit and real-device tests;
- a manual screen-reader pass;
- the debit-note and payment-reversal screens;
- the reconciliation job for receipts older than the webhook window;
- a plans screen for the platform admin.

## Phase 10 — Commercial readiness, onboarding guides, support procedures, pricing validation (complete, CI #62 green)

Plan and acceptance criteria: `PHASE10_PLAN.md`.

1. ~~10.1 owner-granted support access~~ — done (TR-0045, D-067).
2. ~~10.2 platform billing invoices with manual payment~~ — done (TR-0045, D-068).
3. ~~10.3 guides, procedures, pricing validation, commercial readiness~~ — written; to be checked with a real shop.

## Phase 9 — Security review, isolation, accessibility, restore, pilot readiness (complete, CI #61 green; pilot blocked)

Plan and acceptance criteria: `PHASE9_PLAN.md`.

1. ~~9.1 tenant-isolation sweep over the route table~~ — done (TR-0044 #1–4); one 5xx fixed (SR-02).
2. ~~9.2 backup and restore drill~~ — done in a throwaway cluster and in CI (TR-0044 #5–7); production backups/PITR need Q2.
3. ~~9.3 accessibility and responsive sweep~~ — done in Chromium (TR-0044 #10–11); Firefox/WebKit and a screen reader not tested.
4. ~~9.4 security review~~ — `SECURITY_REVIEW.md` (SR-01 fixed, no high finding open; SR-03…SR-10 owned).
5. 9.5 pilot — `PILOT_CHECKLIST.md` written; **blocked on Q1–Q6**, tax review (Q5) and legal review.

## Phase 8 — Agents, approvals, monitoring, cost limits, analytics (complete)

Plan and acceptance criteria: `PHASE8_PLAN.md`. Mock AI adapter only until a provider account exists (Q4).

1. ~~8.1 agent runtime~~, ~~8.2 tools and the five assistants~~, ~~8.3 approval of proposals~~ — done in the API (TR-0040, D-061).
2. ~~8.4 job runner, plan quotas, monitoring~~ — done in the API (TR-0041, D-062). Plan limit values are a product decision (open).
3. ~~8.5 advanced analytics~~ — done in the API (TR-0042, D-063).
4. ~~8.6 screens and the Phase 8 exit test~~ — done (TR-0043, D-064).

**Phase 8 complete** (CI #60 green). Open from Phase 8: real AI provider (Q4) — agent behaviour with a real model is unverified; plan limit values (product decision); reconciliation for receipts older than the webhook window.


## Phase 7 — API Hub, AI Creative Studio, selected official integrations (complete)

Plan and acceptance criteria: `PHASE7_PLAN.md`. Mock adapters only until provider accounts exist (Q4).

1. ~~7.1 guarded outbound HTTP client and no-raw-HTTP lint rule~~ — done (TR-0033, D-054).
2. ~~7.2 secret store with envelope encryption~~ — done (TR-0034, D-055); new DB role `lbgos_secrets`.
3. ~~7.3 integration records, status machine, test connection, health, usage; adapters with mocks~~ — done (TR-0035, D-056).
4. ~~7.4 offers and the AI Creative Studio~~ — done (TR-0036, D-057).
5. ~~7.5 campaigns, exact-version approval, scheduling~~ — done (TR-0037, D-058).
6. ~~7.6 WhatsApp Cloud API and SMS DLT adapters, signed webhooks~~ — done against local mocks (TR-0038, D-059).
7. ~~7.7 screens and the Phase 7 exit browser test~~ — done (TR-0039, D-060).

**Phase 7 complete** (exit passed in the browser with mock adapters; CI #53/#54 green). Open from Phase 7: real providers (Q4: WhatsApp Cloud API account and templates, an SMS gateway with DLT registration, LLM/image providers); confirm the Graph API version; a reconciliation job for receipts older than the 5-minute window; configurable opt-out keywords; email channel; a job runner for scheduled campaigns and queued messages (Phase 8).



## Phase 6 (complete)

All increments 6.1–6.7 done; exit recorded in `PHASE6_PLAN.md` (CI #40 green). Open: legal review of retention and erasure (NFR-12); a daily scheduler for reminders and queued messages (job runner); no messaging provider connected.

## Phase 5 (complete)

All increments 5.1–5.8 done; exit recorded in `PHASE5_PLAN.md` (CI #32 green). Open before the pilot: manual print tests on real devices and an 80 mm thermal printer (FR-PRN-1 AC4); search timing on the reference environment; screens for debit notes and payment reversal.

## Phase 4 (complete)

All increments 4.1–4.6 done; see `PHASE4_PLAN.md` §Exit for evidence and deferrals.

## Carried from Phase 3

See `PHASE3_PLAN.md` §Exit and `PHASE4_PLAN.md` §Exit (deferred lists).

## Inputs requested from the user

- Q2 hosting/budget (D-022) — needed before a staging environment.
- Q3 confirm self-hosted auth (D-019/D-024 in use) or name a managed provider.
- Q6 domain — needed for a real email provider (production start is refused until then).
- Q1 pilot shop details, Q4 integration accounts (now including an **OCR engine/provider** choice and a malware scanner), Q5 tax-professional review.
- Repository owner: enable branch protection with the `CI` checks required on `main`.
