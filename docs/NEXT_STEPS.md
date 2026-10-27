# Next Steps (ordered)

Last updated: 2026-10-27 (end of Phase 3)

## Phase 4 — Inventory, suppliers/purchases, stock ledger, OCR review (next)

1. `docs/PHASE4_PLAN.md`: acceptance criteria per increment (BACKLOG I-01…I-09).
2. I-01 Catalogue CRUD with versioned tax rates and cost-price visibility (`catalogue.cost.view`).
3. I-02 IMEI already in `@lbgos/domain` — wire into catalogue/units with DB parity (done for validation).
4. I-03 Suppliers and purchases (draft → post → reverse), weighted average cost (D-017), duplicate supplier-invoice check.
5. I-04 Stock ledger service + `stock_levels` projection + reconciliation; adjustments via approval requests (needs a minimal approvals module).
6. I-05…I-07 Returns inspection, stock reports, barcode input.
7. I-08/I-09 Upload pipeline and OCR adapter (mock first), review screen, prompt-injection corpus.

## Carried from Phase 3

See `PHASE3_PLAN.md` §Exit (deferred list).

## Inputs requested from the user

- Q2 hosting/budget (D-022) — needed before a staging environment.
- Q3 confirm self-hosted auth (D-019/D-024 in use) or name a managed provider.
- Q6 domain — needed for a real email provider (production start is refused until then).
- Q1 pilot shop details, Q4 integration accounts, Q5 tax-professional review.
- Repository owner: enable branch protection with the `CI` checks required on `main`.
