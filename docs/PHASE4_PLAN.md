# Phase 4 Plan — Inventory, purchases, stock ledger, OCR-assisted review

Version 1.0 — 2026-10-27. Backlog items I-01…I-09 (`BACKLOG.md`) are delivered in the increments below. Acceptance criteria (AC) are fixed **before** coding; they refer to the SRS where one exists. An increment counts as done only when its ACs are shown by executed checks recorded in `TEST_REPORT.md`.

Every new endpoint is covered by tests for: permission denied without the key, 404 for non-members/other tenants, and read-only/suspended mode behaviour (`permittedInMode`). Every new tenant table gets RLS (meta-test NFR-4) and composite foreign keys.

## Increment 4.1 — Catalogue and tax rates (I-01, I-02)
- AC1 FR-INV-1 AC1–3: categories, brands, products (model), variants (default uom `pcs`); products are serialized or not (phones default to serialized); deleting anything with stock movements is refused and archiving is offered; archived items are hidden from default lists.
- AC2 FR-INV-2 AC1–2: all variant and product fields; SKU unique per business, barcode unique when present (409 with field name).
- AC3 FR-INV-2 AC3: warranty fields stored as entered; nothing is generated.
- AC4 FR-INV-2 AC4: purchase/average cost fields are absent from every catalogue response for users without `catalogue.cost.view` (Billing role test) and present for those with it.
- AC5 FR-TAX-2 AC1: tax rates are versioned records (`effective_from`/`effective_to`); overlapping periods for the same rate name are rejected; the rate effective on a given date is resolved by a tested function. Managing rates needs `tax.settings.manage` and is audited.
- AC6 FR-TAX-2 AC3: no tax rate or HSN code literal in application code; nothing is seeded (the owner enters rates; the UI says they must be verified by a tax professional).
- AC7 I-02: the variant/unit APIs use `@lbgos/domain` IMEI validation, and the DB check agrees with it on the shared vector file (existing parity test kept).

## Increment 4.2 — Suppliers and purchases (I-03)
- AC1 FR-INV-8 AC1: supplier fields; GSTIN format/checksum checked with the existing validator.
- AC2 FR-INV-8 AC2: draft purchase with lines (variant, qty, unit cost, tax rate, computed tax); serialized lines carry IMEIs whose count must equal the quantity before posting. Line and document totals are computed by code (`@lbgos/domain`), and the supplier's printed total, if entered, is compared and any difference shown.
- AC3 FR-INV-3 AC2–5 at entry: IMEIs are validated (Luhn, IMEI1≠IMEI2), and duplicates within the purchase, against existing units in the business, and against other draft purchases are reported per field; the same IMEI in another business is accepted and reveals nothing.
- AC4 FR-INV-8 AC3: duplicate supplier invoice number (same supplier, case-insensitive, already posted) blocks posting unless `purchases.post` holder supplies an override reason (≥10 chars, audited).
- AC5 FR-INV-5 AC1–2 / FR-INV-8 AC4: drafts change no stock. Posting (needs `purchases.post`) in one transaction: status → POSTED, units created `IN_STOCK` with IMEIs, PURCHASE movements, weighted-average cost update for non-serialized variants (D-017), supplier payable entry, audit event. A failure at any point writes nothing (test with an injected failure).
- AC6 WORKFLOWS §5 step 5: a posted purchase can be reversed (not edited) only if none of its units has left `IN_STOCK` and non-serialized stock suffices; reversal writes REVERSAL movements, retires the units and writes a payable reversal.
- AC7 Draft purchases can be edited and discarded; posted/reversed ones cannot be edited (409).

## Increment 4.3 — Stock ledger, levels, reconciliation, adjustments (I-04)
- AC1 FR-INV-4 AC1–2: every stock change is a `stock_movements` row; the application cannot update/delete movements (existing DB test); corrections are REVERSAL + new row.
- AC2 FR-INV-4 AC3: `stock_levels` projection maintained in the same transaction as each movement; a reconciliation check compares it with Σ movements per variant and reports differences (test plants a mismatch with the owner role and detects it).
- AC3 FR-INV-5 AC3: non-serialized stock cannot go negative unless the business enables "allow negative stock" (default off); serialized units move only from allowed statuses (WORKFLOWS §4), checked in code with row locks.
- AC4 FR-INV-4 AC4 + WORKFLOWS §11: adjustments, damage write-offs and corrections need a reason. A holder of `inventory.adjust.approve` may execute directly; a holder of only `inventory.adjust.request` creates an approval request (payload hash). Approval re-checks the payload hash and executes idempotently once; R3 (no self-approval when another approver exists); rejection needs a reason; requests expire after 72 h.
- AC5 Concurrency: two parallel decrements of the last non-serialized item — exactly one succeeds; two parallel write-offs of the same unit — exactly one succeeds.

## Increment 4.4 — Inspection, purchase returns, stock reports, lookup (I-05, I-06, I-07)
- AC1 FR-INV-6 AC2–3: `returns.inspect` records RESTOCK / DAMAGED / REPAIR / RETURN_TO_SUPPLIER for a unit or quantity in inspection, with notes; only RESTOCK makes it sellable. (Customer returns that *create* inspection items arrive with invoices in Phase 5; until then the inspection state is reached in tests through the ledger service.)
- AC2 FR-INV-7 AC1: reorder level per variant; low-stock list (on hand ≤ reorder level).
- AC3 FR-INV-7 AC2: slow-moving (no sale in N days, default 60) and dead stock (M days, default 120) for variants with stock, using SALE movements; N and M configurable per request.
- AC4 FR-INV-7 AC3: reorder suggestion per the SRS formula, returned with the formula, the data period and the label "suggestion"; exact-value tests.
- AC5 FR-INV-9 AC1: a lookup endpoint resolves a scanned code by exact barcode, SKU or IMEI (in that order) within the business; the web search field accepts keyboard-wedge input (type + Enter).
- AC6 FR-INV-9 AC2: camera scanning is offered only when the browser has `BarcodeDetector`; otherwise the manual field is shown without errors (browser test in Chromium headless, where it is unavailable).

## Increment 4.5 — Uploads and OCR-assisted review (I-08, I-09)
- AC1 FR-OCR-1 AC1–2: `ocr.scan` holders upload JPEG/PNG/WebP/PDF for `PRODUCT_LABEL` or `SUPPLIER_INVOICE`. HEIC is rejected with a clear message (no converter configured).
- AC2 FR-OCR-6 AC1: type by magic bytes (renamed files rejected), ≤10 MB, ≤10 PDF pages, ≤8000×8000 px read from the image header; limits configurable.
- AC3 FR-OCR-6 AC2: files stored by a `StorageAdapter` under random keys prefixed by business ID; never served with an executable type from the app origin; downloads are authenticated, `Content-Disposition: attachment`, `nosniff`. Local filesystem adapter for dev/test; S3-compatible adapter deferred until hosting (Q2).
- AC4 FR-OCR-1 AC3 / WORKFLOWS §7: job statuses UPLOADED → QUEUED → PROCESSING → NEEDS_REVIEW → COMPLETED / DISCARDED, PROCESSING → FAILED, FAILED → QUEUED (max 3 retries). Jobs carry `businessId` and `requestedBy`; the runner re-checks membership and `ocr.scan` at execution (ADR-08). Malformed files and timeouts end in FAILED.
- AC5 FR-OCR-6 AC4–5: no malware scanner is configured, and the job/status response says so; the pipeline never fetches URLs found in documents (no network client in the OCR module).
- AC6 FR-OCR-2: each extracted field has value, confidence and source snippet; low-confidence fields are flagged and must be confirmed.
- AC7 FR-OCR-3: IMEIs validated and duplicates flagged (business and same scan), never auto-corrected; numbers parsed deterministically; line totals recomputed and mismatches with printed totals shown.
- AC8 FR-OCR-4: nothing is created until "Create" on the review screen; missing required fields block creation; supplier-invoice scans create a **draft** purchase; catalogue matches proposed with a reason.
- AC9 FR-OCR-5: OCR text is data only. The OCR provider is an adapter (mock in tests and dev; no real provider is configured). An optional structuring step accepts only output matching a strict schema; anything else is discarded and the job marked for manual entry. A prompt-injection corpus test shows injected instructions produce only field values (no purchase posted, no price changed, no approval).

## Increment 4.6 — Web screens and Phase 4 exit test
- AC1 Screens: catalogue (products/variants), tax rates, suppliers, purchases (draft, IMEI entry, post, reverse), stock (levels, units, movements, low/slow/dead, reorder), adjustments and approvals, scan upload and review.
- AC2 NFR-1: axe (no serious/critical) and no horizontal overflow at 1280/768/360 px on every new screen; no CSP violations.

## Phase 4 exit
A synthetic shop owner creates a phone model with variants and a tax rate, records a supplier, receives a purchase with IMEIs (one entered manually, one from a scanned supplier invoice reviewed on the review screen), posts it and sees stock; a duplicate IMEI is rejected; a staff adjustment request is approved by the owner; stock on hand equals Σ movements (reconciliation clean); cross-tenant tests pass; CI is green.

Not in Phase 4 (by design): POS sales, customer returns/credit notes (Phase 5); real OCR provider and malware scanner (need provider choice, Q4); S3-compatible storage (needs hosting, Q2); multi-location transfers (out of scope for pilot, SRS §15).


## Exit status (2026-10-27)

**Exit criterion met**, and CI run #21 on the exit commit is green (TR-0016): the browser test (TR-0016) runs a synthetic shop through tax rate → phone model and variant → supplier → purchase with scanner-typed IMEIs → posting; a duplicate IMEI is refused; a scanned supplier invoice is reviewed with every flagged field confirmed and becomes a draft that is posted; a staff adjustment request changes nothing until the owner approves it; stock reconciles with the ledger. Cross-tenant tests cover every new route (TR-0011…TR-0015).

| Increment | Evidence |
|---|---|
| 4.1 catalogue, tax rates | TR-0011 |
| 4.2 suppliers, purchases, stock levels | TR-0012 |
| 4.3 stock ledger, adjustments, approvals | TR-0013 |
| 4.4 inspection, reports, lookup | TR-0014 |
| 4.5 uploads, OCR review (mock adapter) | TR-0015 |
| 4.6 web screens, exit test | TR-0016 |

**Deferred (explicit, not done):**
- A real OCR engine and malware scanner (provider choice, Q4); the mock adapter does not recognise text.
- S3-compatible storage with signed URLs (hosting, Q2); OS-level sandbox for file processing (Phase 9 review).
- Customer returns creating inspection stock, purchase returns as supplier documents and supplier credit (Phase 5 with invoices/credit notes).
- Purchase orders (so "on order" is 0 in reorder suggestions); opening-stock entry for serialized units other than as a purchase.
- Appending several product-label scans to one draft (each label creates its own draft today).
- Approval notifications to approvers (the Approvals screen lists them).
- Re-authentication before tax-setting changes (FR-TAX-2 AC2, D-030).
- Firefox/WebKit/real-device tests, real barcode scanners, keyboard-only and screen-reader passes (NFR-1, NFR-16).
