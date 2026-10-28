# Next Steps (ordered)

Last updated: 2026-10-28 (Phase 5 complete; Phase 6 planned)

## Phase 6 — CRM, analytics, consent and reminders (in progress)

Plan and acceptance criteria: `PHASE6_PLAN.md`.

1. 6.1 customer profile (optional fields, owned units with warranty dates, history) and customer export (`customers.export`, selected fields, audited).
2. 6.2 consent records, suppression list, messages with the send-time gate and provider adapter (no provider connected: nothing is really sent).
3. 6.3 reminders (birthday, warranty, service due, payment due) as drafts; templates with recorded fields only.
4. 6.4 expenses and the operating-profit estimate.
5. 6.5 dashboard tiles with definitions.
6. 6.6 erase personal data; tenant data export (ZIP of CSVs).
7. 6.7 screens and the Phase 6 exit browser test.

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
