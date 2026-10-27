# Phase 5 Plan — POS, invoices, payments, customer ledger, core reports

Version 1.0 — 2026-10-27. Backlog items P-01…P-09 (`BACKLOG.md`) are delivered in the increments below. Acceptance criteria (AC) are fixed **before** coding and refer to the SRS. An increment counts as done only when its ACs are shown by executed checks recorded in `TEST_REPORT.md`. Every new endpoint gets permission, cross-tenant (404) and read-only-mode tests.

Tax and invoice rules here implement D-012, D-013 and D-016 as written. They remain **subject to review by a qualified tax professional (Q5)**; nothing in this phase claims GST compliance.

## Increment 5.1 — Pure engines (P-01, P-05 core, P-02 format)
- AC1 FR-TAX-1 AC1–5: one pure tax module in `@lbgos/domain` computing invoice lines and totals: inclusive/exclusive pricing, line discounts, invoice discount apportioned proportionally to pre-discount line value (remainder paisa to the last line), CGST/SGST odd-paisa split, IGST for inter-state supply, zero-rated/exempt lines, cess, optional round-off to the rupee, multi-rate invoices, 100+ lines; Σ lines = totals always (property tests); Bill of Supply suppresses tax for unregistered/composition businesses. **≥95 % branch coverage** of the module, measured.
- AC2 FR-LED-2 AC1–2: pure allocation module: exact, partial, over-payment → advance, explicit invoice selection, FIFO by invoice date then number, applying an advance to a new invoice, refund of advance, reversal of a payment; Σ allocations per invoice ≤ total and payment status derived (property tests).
- AC3 FR-POS-4 AC3: numbering format with tokens `{PREFIX}`, `{FY}`, `{SEQ:n}`; a format whose rendering can exceed 16 characters or contain characters outside `[A-Za-z0-9/-]` is rejected at configuration time.
- AC4 FR-LED-3 / §7: metric definitions module (the SRS §7 table as data) used by reports and UI.

## Increment 5.2 — Customers, numbering service, re-authentication (P-02, FR-POS-5, FR-TAX-2 AC2)
- AC1 FR-POS-5 AC1–2 / FR-CRM-1 AC1 (core fields): customers by mobile (E.164-normalised, unique per business); lookup by mobile; inline create with name + mobile only; optional email, address, GSTIN (checksum), state; GSTIN state drives place of supply.
- AC2 FR-CRM-2 AC1: only name and mobile mandatory.
- AC3 FR-POS-4 AC1–5: series per document type and financial year; number allocated inside the issuing transaction (D-020 row lock); a new FY starts a new series automatically in the business timezone; format configurable per AC3 of 5.1; **concurrent issuing test: no gaps, no duplicates**, with rollbacks.
- AC4 FR-TAX-2 AC2 (carried from D-030): changing tax settings (tax profile, tax rates, invoice series format) requires a fresh sign-in (session younger than 10 minutes); otherwise 403 `REAUTH_REQUIRED`.

## Increment 5.3 — Selling and issuing (P-03 API, P-04)
- AC1 FR-POS-1 AC2: draft sale (cart) with lines; serialized lines need a specific IN_STOCK unit; held carts do not reserve stock (reservation not offered yet).
- AC2 FR-POS-2 AC1–3: line and invoice discounts validated server-side against the user's `pos.discount` limit (percent and amount); over-limit discounts need approval by a member whose limit covers it (approval request or the approver's in-session approval), the approver recorded on the invoice; selling below minimum price needs `pos.price_override`.
- AC3 FR-POS-3 AC1–4, AC6: one or more payments (cash, UPI, card, bank transfer, customer advance, other); partial payment needs a customer with mobile; cash tendered → change; references reject card-like numbers; payments are recorded as entered, never claimed as verified settlement.
- AC4 FR-INV-5 AC2–4, FR-LED-1: issuing in one transaction: number, invoice and line snapshots (tax engine), SALE movements, units SOLD, COGS snapshot (D-017), customer ledger INVOICE/PAYMENT entries, payment allocations; any failure writes nothing; **concurrent sale of the same IMEI: exactly one succeeds**; non-serialized stock cannot go negative unless allowed.
- AC5 FR-TAX-1 AC4: document type follows the tax profile (TAX_INVOICE for regular, BILL_OF_SUPPLY otherwise).

**Status (5.3):** done — TR-0019, D-040. Not offered yet: in-person approver re-authentication at the counter (approval requests are used), configurable payment-method list, reserve-on-hold.

## Increment 5.4 — Payments, allocation, ledger (P-05, FR-LED-1/2/3)
- AC1 FR-LED-2: later payments allocated to selected invoices or FIFO; remainder → advance; advance applied to a new invoice; advance refund (`refunds.approve`); payment reversal reverses its allocations and ledger entries; invoice payment status derived (UNPAID/PARTIALLY_PAID/PAID).
- AC2 D-020: concurrent allocations to one invoice never over-allocate (locks; test with parallel requests).
- AC3 FR-LED-1 AC2–3: balance = Σ entries; statement for any date range with opening and closing balance; entries append-only (DB test).

**Status (5.4):** done — TR-0020, D-041. Statement printing/export comes with 5.6/5.7; ledger ADJUSTMENT entries are not offered.

## Increment 5.5 — Cancellation, credit and debit notes, returns (P-06, FR-TAX-3, FR-POS-3 AC5, FR-INV-6 AC1)
- AC1 FR-TAX-3 AC1–2 / D-016: cancellation with `invoices.cancel`, reason ≥ 10 chars, within the window (default same business day); reversal movements (units back IN_STOCK if they never left, otherwise into inspection — user states which), ledger reversal, payments become customer advance; number retained; outside the window refused with a pointer to credit notes.
- AC2 FR-TAX-3 AC3: credit note against an invoice, full or partial lines/quantities, own series, tax computed from the original line snapshots; returned goods go to INSPECTION (SALE_RETURN); ledger CREDIT_NOTE; optional refund needs `refunds.approve`.
- AC3 FR-TAX-3 AC4: debit note against an invoice increases the amount due (ledger DEBIT_NOTE).
- AC4 Returned quantity can never exceed what was sold on that invoice net of earlier credit notes.

## Increment 5.6 — Print and PDF (P-07, FR-PRN-1, FR-TAX-4)
- AC1 FR-PRN-1 AC1–2: HTML print templates for A4, A5, 80 mm, 58 mm from the stored invoice snapshot, with the fields listed in AC2 (business, GSTIN, number/date, customer and B2B details, HSN, quantities, rates, taxable value, tax breakdown, totals in figures and words, IMEIs, payments, terms); default size from business settings, choosable per print.
- AC2 FR-PRN-1 AC3: PDF rendered by headless Chromium from the same HTML (ADR-12); test compares text content of PDF and print HTML.
- AC3 FR-TAX-4: no e-invoice, IRN/QR or digital-signature claims; no text saying every GST invoice needs a digital signature (test on templates).
- AC4 FR-PRN-1 AC4 (manual printer and cross-browser tests) is **recorded as not done** unless actually performed; it needs real devices.

## Increment 5.7 — Reports and exports (P-08, P-09, FR-RPT-1…4)
- AC1 FR-RPT-1 (Phase 5 subset): sales summary (day/week/month/year with previous period), sales by brand/model/variant, margin (`reports.financial.view`), receivables ageing (0–30/31–60/61–90/90+), payment-method summary (cash received), returns, tax summary (labelled "not a filing"), stock valuation; **exact values on a seeded dataset**.
- AC2 FR-RPT-2 / FR-LED-3: every metric carries its §7 definition; nothing labels sales as profit or cash.
- AC3 FR-RPT-3: business timezone and FY start: sales at 23:30 and 00:30 IST and on 31 March / 1 April land in the right day and FY; week start configurable (default Monday).
- AC4 FR-RPT-4: CSV for tabular reports; PDF for sales summary, tax summary and ledger statements; XLSX for sales, stock and tax summaries; export needs `reports.export` and is audited.

## Increment 5.8 — POS and sales web screens, Phase 5 exit test
- AC1 FR-POS-1 AC1, AC3: POS screen: search/scan by name, model, SKU, barcode or IMEI; unit choice for serialized items; customer by mobile; discounts; split payment; issue and print. A single-item sale with a known customer in ≤ 6 interactions (counted in the browser test). The 300 ms p95 search target over 10,000 variants is measured on the dev container and reported as such (not the reference environment).
- AC2 Screens: invoices list/detail with print/PDF, customer profile with ledger and statement, payments, credit notes, reports; axe 0 serious/critical at 360/768/1280 px, no overflow, no CSP violations.

## Phase 5 exit
In a real browser, a synthetic shop sells a phone (chosen by IMEI) and an accessory to a new customer at POS with a discount within the cashier's limit, part-paid by UPI and cash; the invoice is issued with the next consecutive number and prints in A4 and 80 mm and as a PDF; the customer's balance shows the amount due; a later payment clears it; a credit note returns the phone into inspection; the sales, tax and receivables reports equal the expected values for the seeded data; cross-tenant tests pass; CI is green.

Not in Phase 5 (by design): payment-gateway collection (SRS §15), e-invoice/e-way bill (FR-TAX-4), messaging invoices by WhatsApp/SMS (Phase 6–7), full CRM consent and reminders (Phase 6), expenses (Phase 6), stock reservation for held carts.
