# Next Steps (ordered)

Last updated: 2026-10-28 (Phase 7 complete locally; Phase 8 next)

## Phase 7 — API Hub, AI Creative Studio, selected official integrations (in progress)

Plan and acceptance criteria: `PHASE7_PLAN.md`. Mock adapters only until provider accounts exist (Q4).

1. ~~7.1 guarded outbound HTTP client and no-raw-HTTP lint rule~~ — done (TR-0033, D-054).
2. ~~7.2 secret store with envelope encryption~~ — done (TR-0034, D-055); new DB role `lbgos_secrets`.
3. ~~7.3 integration records, status machine, test connection, health, usage; adapters with mocks~~ — done (TR-0035, D-056).
4. ~~7.4 offers and the AI Creative Studio~~ — done (TR-0036, D-057).
5. ~~7.5 campaigns, exact-version approval, scheduling~~ — done (TR-0037, D-058).
6. ~~7.6 WhatsApp Cloud API and SMS DLT adapters, signed webhooks~~ — done against local mocks (TR-0038, D-059).
7. ~~7.7 screens and the Phase 7 exit browser test~~ — done (TR-0039, D-060).

**Phase 7 complete locally** (exit passed in the browser with mock adapters). Open from Phase 7: real providers (Q4: WhatsApp Cloud API account and templates, an SMS gateway with DLT registration, LLM/image providers); confirm the Graph API version; a reconciliation job for receipts older than the 5-minute window; configurable opt-out keywords; email channel; a job runner for scheduled campaigns and queued messages (Phase 8).

**Next: Phase 8** — agents, approval workflows for agent actions, monitoring, cost limits, analytics (plan to be written as `PHASE8_PLAN.md` from the prompt).

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
