# Next Steps (ordered)

Last updated: 2026-10-27 (end of Phase 4)

## Phase 5 — POS, invoices, payments, customer ledger, core reports (next)

1. Confirm CI green on the Phase 4 exit commit; record in TEST_REPORT.
2. `docs/PHASE5_PLAN.md`: acceptance criteria per increment (BACKLOG P-01…P-09).
3. P-01 tax engine in `@lbgos/domain` (D-013), ≥95 % branch coverage, property tests.
4. P-02 invoice numbering service (D-012, D-020) with the concurrency test from the spike.
5. P-03/P-04 POS UI and atomic invoice issue (stock SALE movements, units SOLD, ledger, COGS snapshot), IMEI double-sale race test.
6. P-05…P-09 allocation, cancellation/credit notes (returns into inspection), print/PDF, statements and reports, exports.

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
