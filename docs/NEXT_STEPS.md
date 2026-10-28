# Next Steps (ordered)

Last updated: 2026-10-28 (Phase 6: all increments done; exit test passes locally)

## Phase 6 — CRM, analytics, consent and reminders (in progress)

Plan and acceptance criteria: `PHASE6_PLAN.md`.

1. ~~6.1 customer profile and customer export~~ — done (TR-0026, D-047); screen fields follow in 6.7.
2. ~~6.2 consent, suppression, messages with the send-time gate and provider adapter~~ — done (TR-0027, D-048); no provider connected.
3. ~~6.3 reminders~~ — done (TR-0028, D-049); a daily scheduler waits for the job runner.
4. ~~6.4 expenses and the operating-profit estimate~~ — done (TR-0029, D-050).
5. ~~6.5 dashboard tiles with definitions~~ — done in the API (TR-0030, D-051); shown on the overview in 6.7.
6. ~~6.6 erase personal data; tenant data export~~ — done in the API (TR-0031, D-052); legal review of retention still needed.
7. ~~6.7 screens and the Phase 6 exit browser test~~ — done (TR-0032, D-053).
8. **Next:** confirm CI green, record the Phase 6 exit, then plan Phase 7 (campaigns and AI creative) per the master prompt.

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
