# Phase 6 plan — CRM, analytics, consent and reminders

Version 1.0 — 2026-10-28. Master prompt §Development process, Phase 6; SRS FR-CRM-1/2, FR-CON-1, FR-REM-1, FR-PRV-1/2, FR-EXP-1, FR-RPT-1 (expenses, operating profit), FR-LED-3 AC1 (dashboard). Acceptance criteria (AC) are fixed **before** coding. An increment counts as done only when its ACs are shown by executed checks recorded in `TEST_REPORT.md`. Every new endpoint gets permission, cross-tenant (404) and read-only-mode tests.

**No messaging provider is connected** (WhatsApp Business Platform, SMS/DLT and email are `planned`, Q4). Phase 6 therefore builds the consent, suppression, message and reminder machinery behind a provider adapter. Without a configured provider nothing is sent: messages that would be sent end as `FAILED` with `PROVIDER_NOT_CONFIGURED`, and the screens say so. Automated tests use a test adapter that records what it was asked to send; no result in this phase is described as "sent to a customer".

## Increment 6.1 — Customer profile and data minimisation (FR-CRM-1, FR-CRM-2)
**Status: done in the API (TR-0026, D-047); communications appear with 6.2, screens in 6.7.**
- AC1 FR-CRM-1 AC1: optional alternate phone, DOB, tags (up to 10, short text), contact preference per channel, notes; only name and mobile mandatory and the others labelled optional (FR-CRM-2 AC1).
- AC2 FR-CRM-1 AC2: profile shows purchase history (documents), owned units (IMEI) with warranty end date **as recorded** (sale date + the variant's warranty months; none when the variant has no warranty), payments, ledger balance, communications.
- AC3 FR-CRM-2 AC2: customer export needs `customers.export`, includes only the fields chosen, CSV, audited (fields, count; no personal data in the audit).

## Increment 6.2 — Consent, suppression, communications (FR-CON-1)
- AC1: consent records per customer, channel (WhatsApp, SMS, email) and purpose (transactional, marketing) with source, time and actor; append-only; the current state is the latest record.
- AC2: default policy: transactional allowed (unless withdrawn or suppressed), marketing only with a GRANTED marketing consent for that channel.
- AC3: opt-out (owner action or an inbound "STOP" handled by the adapter hook) adds the contact to the suppression list at once; **the send-time gate** blocks suppressed contacts and missing consent (`BLOCKED`, with the reason) even for messages created earlier.
- AC4: message status machine as WORKFLOWS §9 (DB-enforced transitions); `SENT/DELIVERED/READ` only from a provider result; communication history records every attempt and status.
- AC5: provider adapter interface; the production default is "not configured"; quiet hours (default 09:00–21:00 business time) for marketing and reminders.

## Increment 6.3 — Reminders (FR-REM-1)
- AC1: types birthday (DOB present **and** marketing consent), warranty expiry (recorded warranty end date in the next N days), service due (configured interval after a sale), payment due (open balance older than N days).
- AC2: templates reference only recorded fields (`{name}`, `{shop}`, `{model}`, `{imei_last4}`, `{warranty_end}`, `{amount_due}`, `{service_date}`); a placeholder missing for a customer skips that customer (reported); unknown placeholders are refused when the template is saved.
- AC3: reminders are created as drafts; auto-send per type is off by default, needs `marketing.approve` to enable, and still passes the consent/suppression gate and quiet hours. Running the job twice does not duplicate reminders.

## Increment 6.4 — Expenses (FR-EXP-1, FR-RPT-1)
- AC1: module off by default; when enabled, `expenses.manage` records date, category, amount, payment method, notes and an optional attachment (existing upload checks and private storage).
- AC2: corrections are reversal entries (append-only, reason, audited).
- AC3: expenses report and operating-profit estimate (gross margin − expenses, labelled an estimate) with exact values on a seeded dataset.

## Increment 6.5 — Dashboard (FR-LED-3 AC1, FR-INV-7 AC1)
- AC1: overview tiles for today and this month: net sales, cash received, receivables, customer advances, gross margin (financial roles), low-stock count, reminders waiting; each with its §7 definition; nothing calls sales profit or cash.
- AC2: figures equal the report module's values (same queries).

## Increment 6.6 — Privacy requests and tenant export (FR-PRV-1, FR-PRV-2)
- AC1 FR-PRV-1 AC2: "erase personal data" (owner, reason, fresh sign-in): customer name/contact/DOB/notes anonymised, consents withdrawn, contact suppressed, pending messages cancelled; issued invoices keep their party snapshot (what was legally printed); audited. Legal retention rules remain to be confirmed (NFR-12).
- AC2 FR-PRV-2: owner exports all business data (catalogue, stock, invoices with lines, payments, customers, ledgers, expenses) as a ZIP of CSVs; audited; allowed in read-only mode.

## Increment 6.7 — Web screens and Phase 6 exit test
- Screens: customer profile (fields, consents, communications, owned units), reminders (settings, templates, drafts), expenses, dashboard tiles, export/erase actions; axe 0 serious/critical at 360/768/1280 px, no overflow, no CSP violations.

## Phase 6 exit
In a real browser, for a synthetic shop: the owner records WhatsApp marketing consent for one customer and none for another; a warranty reminder run drafts reminders only for customers with a recorded warranty end date in range; a birthday reminder is drafted only for the customer with a DOB and consent; one customer opts out and a send attempt to them is blocked at send time with the reason shown; communications history shows each attempt; with the test adapter a permitted message reaches `SENT` and without a provider it fails as not configured; an expense changes the operating-profit estimate by exactly its amount; a customer export contains only the selected fields and is audited; erasing a customer anonymises the profile while the old invoice still prints the original details; the tenant export ZIP contains the expected files; the dashboard shows the expected figures with definitions; cross-tenant tests pass; CI is green.

Not in Phase 6 (by design): real message delivery (needs provider accounts, Q4); campaigns and AI creative (Phase 7); agents (Phase 8).
