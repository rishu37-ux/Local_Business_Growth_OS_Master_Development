# Onboarding guide — shop owners and staff (Phase 10.3)

Version 1.0 — 2026-10-28. This guide follows the screens as they exist in the app today. Screen names are shown **in bold** as they appear in the side menu. It is written for a mobile-phone and accessories shop in India. Before the first real shop uses it, check it with that shop (`PILOT_CHECKLIST.md` #1, #15). **Use only test data until the pilot is approved.**

## Part A — Owner

### A1. Register and wait for approval
1. Open the app and choose **Create an account**. Enter your name, email and a password of at least 10 characters. Common passwords and passwords that contain your email name are refused.
2. Open the verification link sent to your email. Sign-in is refused until you do.
3. Fill in the business application: legal name, contact, address and GSTIN if registered. The application goes to the platform team for review. You can see its status on the business page, and any request for changes appears there with its reason.
4. You get a notification when the business is approved. Approval starts a trial (the trial notices arrive 7, 3 and 1 days before the trial ends).

### A2. Two-step verification (required for owners)
1. After the first sign-in as an owner you are asked to **Set up two-step verification**. Scan the code with an authenticator app (for example, Google Authenticator or Microsoft Authenticator) and enter the six-digit code.
2. **Save the 10 backup codes somewhere safe and offline.** Each code works once. Support cannot recover a lost authenticator for you without identity checks (see `SUPPORT_PROCEDURES.md` §5).

### A3. Setup wizard (business page)
Three steps are required before going live:
1. **Business details** — the shop name shown to customers, address, phone.
2. **Tax** — GST registration (registered / composition / unregistered), GSTIN, state, and the invoice number prefix (up to 6 characters). **Check these with your tax professional.** The app applies the rules as configured, and those rules are not verified by a tax professional yet (Q5).
3. **Two-step verification** — done in A2.

Then go live. You can change the details later. Tax settings ask you to sign in again before they change.

### A4. Catalogue and tax rates
1. **Catalogue → Tax rates:** check the GST rates you sell at (for example, 18 % for phones and accessories). Ask your tax professional which rates apply to which products.
2. **Catalogue:** add categories and brands, then products. For phones, choose *serialized*: each unit is tracked by its IMEI. Give each variant (colour, storage) a selling price, an optional minimum price, and a reorder level.

### A5. Opening stock
There is no bulk import yet. Choose one of two ways:
- **Purchases → New purchase** (recommended for stock you can match to supplier bills). Enter the supplier, the bill number and the lines with their IMEIs, then post it. Posting needs `purchases.post`, recomputes the totals, and shows mismatches before anything changes.
- **Stock → Adjust a stock count** for counted (non-serialized) items without a bill, such as cables and covers. Each adjustment is recorded with a reason.

**Check:** the count in **Stock** equals your physical count for every product before your first sale.

### A6. First sale
1. **Point of sale:** search by name, SKU or IMEI and add items. Add a customer, or sell to a walk-in customer.
2. Discounts above a staff member's limit need an approval. The approver's own limit must cover the discount.
3. Take the payment (cash, UPI, card reference — **never type a full card number**; it is refused), then complete. The invoice gets the next number for the financial year and cannot be edited afterwards.
4. Print or share the PDF from **Invoices**. Corrections are made by cancelling within the window or by issuing a credit note.

### A7. Daily and weekly routine
- **Invoices / Customers:** later payments, advances, refunds (refunds need `refunds.approve` and a reason), statements.
- **Approvals:** stock adjustments, discounts and assistant proposals waiting for you, each with its expected effect.
- **Reports:** sales, margin, receivables, stock age, weekly trend, repeat customers. Every figure shows its definition and period. Export to CSV or XLSX as needed.
- **Usage and monitoring:** how much of the plan's allowances is used, and what the background jobs did.

### A8. Staff
**Staff and invitations:** invite each person by email with one default role (Part B). Give a person only the roles they need, and remove access on the day someone leaves. Changing a person's roles signs them out everywhere.

### A9. Optional modules
These are off, or not connected, until you choose them:
- **Expenses** (for an operating-profit estimate);
- **Reminders** (birthday, warranty, service and payment-due drafts; automatic sending needs your approval);
- **Offers**, **Creative Studio** and **Campaigns** (marketing messages only to customers who gave consent, and only after approval);
- **API Hub** (connecting providers);
- **Assistants** (questions answered from your records; proposals always wait for approval).

No messaging or AI provider is connected yet, so messages are not sent (Q4).

### A10. Your data
- **Overview → full data download:** a ZIP of CSVs of your business data. You must have signed in recently.
- **Customer → erase personal data:** owner only, with a reason. Invoices keep the legally required snapshot.
- **Billing and support:** the platform's invoices to you and their status; **Support access** to let the platform team view your business for 1–72 hours, see every page they opened, and end it at any time (`SUPPORT_PROCEDURES.md` §4). Without your grant they cannot see your business data.

## Part B — Staff quick start (by default role)

| Role | Can do | Cannot do (ask the owner/manager) | First things to learn |
|---|---|---|---|
| **Billing** | Sell at the counter, take payments, start returns, add or edit customers, discounts up to 2 % / ₹500 | Cancel invoices, refunds, purchases, stock adjustments, reports | **Point of sale** search by IMEI; payments; walk-in vs named customer; when to ask for a discount approval |
| **Inventory** | Catalogue, purchases (draft), receiving, stock-count adjustment requests, return inspection, scans of supplier bills | Post purchases, approve adjustments, sell | **Purchases** draft from a bill or a **Scan**; checking IMEIs; **Stock → Adjust a stock count** |
| **Accountant** | View sales, financial reports, receivables, customer ledgers, purchases, audit log; export reports | Sell, change stock, change settings | **Reports** definitions and periods; exports; statements |
| **Manager** | Almost everything day to day, including approvals, refunds, cancellations, posting purchases, discounts up to 10 % / ₹5,000 | Settings, tax, roles, staff, subscription, integrations, sending campaigns | **Approvals**; refunds and credit notes; daily reports |

Everyone:
- Use your own account. Never share passwords.
- Sign out on shared devices. A session ends after 12 hours idle and after 7 days at most.
- Report anything unexpected to the owner. Never "fix" records outside the screens.

## Part C — Go-live check for the owner

- [ ] Business approved, two-step verification on, backup codes stored offline
- [ ] Business details and tax settings reviewed with a tax professional
- [ ] Tax rates and products checked; IMEIs entered for every phone in stock
- [ ] Stock count in the app = physical count
- [ ] One test sale, its payment, print and cancellation done on the real printer (then cancel it within the window)
- [ ] Staff invited with the right roles; the owner knows how to remove a person
- [ ] The owner knows the support contact and how to grant or revoke support access
