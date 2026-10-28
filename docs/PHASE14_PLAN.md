# Phase 14 plan — All states, the shop's full address, exports in every section

Version 1.0 — 2026-10-28. Requested by the user after Phase 13 (D-073).

**The request:**
1. When registering, the state list showed only a few states; it must have every state and union territory of India.
2. Shop details must take the shop's complete address, with fields such as district and city.
3. An export option in every section that needs one.

Acceptance criteria (AC) are fixed **before** coding. Only executed checks count (`TEST_REPORT.md`).

**What existed before this phase:**
- The state list on the registration form and on suppliers had 9 pilot states (a placeholder from Phase 3).
- The shop's address was a single free-text field in the print settings of the Invoices screen. The setup wizard asked only for the shop name.
- Exports existed for reports (CSV/XLSX/PDF), customers (chosen fields) and the owner's full data ZIP. The list screens had none.

**Decisions (D-073):**
- **States.** All 28 states and 8 union territories with their GST state codes, sorted by name:
  - The same list on registration, setup and suppliers.
  - The server accepts only these codes; the GST code "97 Other Territory" is not offered.
- **Address.** The shop's address is stored as fields:
  - Address line 1, line 2 (optional), landmark (optional), city or town, district, state, 6-digit PIN code.
  - It is asked in setup step 1 and can be edited later in **Shop details**.
  - The printed address (invoices, the shop's website) is composed from these fields, so documents keep working unchanged.
  - The state is the business's GST state. It can be changed during setup only; a saved GSTIN must belong to it.
  - After going live, the state is shown but not editable: changing it changes the place of supply, and needs support.
- **Exports.** A list export for each section, as CSV and Excel (XLSX), with the formula guard of D-045:
  - Catalogue (products and variants).
  - Stock levels, and phones by IMEI.
  - Suppliers.
  - Purchases.
  - Invoices.
  - Payments.
  - Expenses.
  - Online orders.

  Customers keep their own field-picking export, and reports keep theirs.
- **Export rules.**
  - Each export needs `reports.export` **and** the permission to see that section.
  - Cost columns need `catalogue.cost.view`, and buyer details in online orders need `customers.view` (else masked as on screen).
  - Every export is audited (section, format; no contents).
  - At most 50,000 rows; above that, the owner's full data ZIP is the way.

## Status

Both increments and the exit are done (TR-0049). CI #69 green.

## Increment 14.1 — States and the shop's address
- **AC1:** registration, setup and suppliers offer all 36 states and union territories. The API refuses any other code with 400.
- **AC2:**
  - Setup step 1 takes the full address: line 1, city, district, state and PIN code are required in the form.
  - A PIN code that is not 6 digits starting 1–9 → 422.
  - Saved, the address shows in Shop details and is printed on the next invoice as one composed address.
- **AC3:**
  - Shop details can edit the address after going live; the state is read-only then.
  - Changing the state during setup with a saved GSTIN of another state → 422.
  - Print settings no longer clear the address when saved without it.

## Increment 14.2 — Exports in every section
- **AC1:** `GET /api/businesses/:id/exports/:section?format=csv|xlsx` for the eight sections above:
  - Each row is tenant-scoped, and the file is downloaded with `nosniff` and a safe file name.
  - Unknown section or format → 400.
- **AC2:**
  - Without `reports.export` → 403; without the section's view permission → 403.
  - Cost columns appear only with `catalogue.cost.view`.
  - Online orders are masked without `customers.view`.
- **AC3:** CSV cells that start with =, +, -, @ are guarded. XLSX is a valid workbook (opened by an independent reader). Each export is audited.
- **AC4:** each of those screens shows **Export: CSV · Excel** to members who may export.

## Phase 14 exit (browser)
- A new shop applies with a state outside the old list (e.g. Bihar).
- In setup the owner enters the full address.
- After going live the address shows in Shop details, and the next invoice prints it.
- On Catalogue, Stock and Online selling, the export links download files whose rows match the screen.
- axe 0 serious/critical at 360/768/1280 px on the changed screens; CI green.

**Not done:** a district master list (district is typed, not chosen); PDF for list exports (reports keep PDF).
