# Next Steps (ordered)

Last updated: 2026-10-27 (Phase 5, after increment 5.4)

## Phase 5 — POS, invoices, payments, customer ledger, core reports (next)

1. ~~CI green on the Phase 4 exit (#21)~~ · ~~`PHASE5_PLAN.md`~~ · ~~5.1 engines (P-01, allocation, formats)~~ (done, TR-0017).
2. ~~5.2 / P-02 numbering service, customers, re-authentication~~ (done, TR-0018).
3. ~~5.3 / P-03 API, P-04 drafts (carts), discount limits and approvals, atomic issue, IMEI race~~ (done, TR-0019, D-040).
4. ~~5.4 / P-05 later payments, advance, refunds, reversal, statement, payment status~~ (done, TR-0020, D-041).
5. 5.5 cancellation within the window, credit/debit notes, returns into inspection (FR-TAX-3, FR-POS-3 AC5, FR-INV-6 AC1).
6. 5.6 print/PDF (A4, A5, 80 mm, 58 mm; seller address/phone settings needed for the printed header).
7. 5.7 reports and exports; 5.8 POS screens (search ≤ 300 ms p95, ≤ 6 interactions) and the Phase 5 exit browser test.
8. ~~CI for 5.1 (#22) and 5.2 (#23)~~ green. CI #24 (5.3): Node 24 job passed all steps; the Node 22 job was still stuck in the Chromium download step (before any project code) when last checked — not a recorded pass. Check CI for the 5.4 push.

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
