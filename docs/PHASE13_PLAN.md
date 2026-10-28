# Phase 13 plan — Online order details (platform and buyer)

Version 1.0 — 2026-10-28. Requested by the user after Phase 12 (D-072).

**The request:** e-commerce orders must show in the dashboard with complete platform details and the purchaser's complete details.

It extends FR-CHN-2 (channel orders) and touches FR-PRV-1/FR-PRV-2 (personal data). Acceptance criteria (AC) are fixed **before** coding. Only executed checks count (`TEST_REPORT.md`).

**What existed before this phase (Phase 11):**
- Orders from the website and from marketplace connectors, with the channel, the platform's order ID, the time, the lines and our state (reserved, billed, cancelled).
- Website orders carry the buyer's name and mobile.
- Marketplace orders carried **no buyer details** at all.
- Channel orders were not in the owner's data export and were not touched by erasure (a gap, closed here).

**Decisions (D-072):**
- **Contract.** The `marketplace_json` order feed (D-070) gains optional sections:
  - `buyer`: name, phone, email, GSTIN.
  - `shipTo` and `billTo`: name, phone, address lines, landmark, city, state, PIN code, country.
  - `payment`: method (prepaid or cash on delivery) and status.
  - `fulfilment`: who ships (seller or marketplace), the platform's own order status, ship-by and deliver-by dates, carrier and tracking ID.
  - `totals`: items, shipping, discount, tax, total and the marketplace's fees.
  - Each line gains the product title used on the platform.
- **Validation.** The required parts stay strict: a malformed order makes the whole feed invalid.
  - A malformed **optional** detail (a bad PIN code, an invalid GSTIN, an over-long name) is dropped field by field.
  - The order says which fields were dropped, so one bad address cannot stop all orders.
  - Text is limited in length and may not contain control characters.
- **Updates.** When the feed sends an order again, its progress fields are updated: platform status, payment status, dates, carrier and tracking. The lines, prices and buyer details are kept as first received.
- **What a platform really sends.** Amazon and Flipkart decide what they share:
  - Amazon gives buyer address and phone only with special data-protection approval for its restricted buyer data, and not for orders it ships itself (FBA).
  - Missing details are shown as "not given by the platform", never invented.
- **Who sees buyer details.** Buyer contact details and addresses are personal data.
  - Only members with `customers.view` see them in full.
  - Anyone else who may see orders (e.g. Inventory staff) sees the name's first letter, the phone's last 4 digits, and only the city, state and PIN code of the address.
- **Erasure and export.**
  - Erasing a customer also erases the buyer details of channel orders linked to them (by billed invoice or the same mobile).
  - The owner can also erase the buyer details of one order (reason and a recent sign-in, as for customers).
  - Lines, totals and the invoice stay.
  - The owner's data export now includes sales channels, listings, channel orders and lines.
- **Billing.** Billing an order creates or reuses the customer with the buyer's name, mobile, email, delivery address and GSTIN.

## Status

All three increments and the exit are done (TR-0048).

## Increment 13.1 — Contract, storage, API
- **AC1:** a feed order with every section is stored and returned by the order API with all fields.
  - A feed order with no optional sections still imports as before.
  - The mock marketplace uses the same parser.
- **AC2:** invalid optional fields are dropped one by one and listed on the order.
  - A malformed required field (ID, status, date, lines) still rejects the whole feed with `FEED_INVALID`.
- **AC3:** the order sent again with a new status and a tracking ID updates those fields. Lines and buyer details stay unchanged, and an erased buyer is never filled in again.
- **AC4:** without `customers.view` the buyer details are masked in the list and in the detail. Another business gets 404.
- **AC5:** the website form takes optional email and delivery address (line, city, PIN code). An invalid PIN code is refused with a message.

## Increment 13.2 — Privacy
- **AC1:** erasing a customer also erases buyer details of orders billed to them or with their mobile.
- **AC2:** `POST …/channel-orders/:id/erase-buyer`:
  - It is owner-only, with a reason and a recent sign-in.
  - It removes name, phone, email, GSTIN and both addresses; it is recorded in `privacy_requests` and audited without personal data.
  - Erasing a second time gives 409.
- **AC3:** the data export contains `sales_channels`, `channel_listings`, `channel_orders` and `channel_order_lines`.

## Increment 13.3 — Screens
- **AC1:** Online selling lists the orders:
  - Filters by channel and by state.
  - The platform order ID links to the order page.
  - Columns show the buyer, the delivery city, payment and fulfilment.
- **AC2:** the order page shows, in sections:
  - Platform: channel, order ID, received, platform status, shipped by, ship by, deliver by, carrier, tracking.
  - Buyer: name, phone, email, GSTIN.
  - Delivery address and billing address.
  - Payment.
  - Items: platform title, SKU, matched product, quantity, price, amount.
  - Totals: items, shipping, discount, tax, total, marketplace fees, and the amount after fees.
  - Our state, with the invoice number.
  - Bill and cancel actions.
  - Owner only: erase buyer details.
  - Missing details are shown as "Not given by the platform".

## Phase 13 exit (browser)
- A mock Amazon order with full buyer, address, payment, fulfilment and totals is synced.
- The owner opens it from the list and sees every detail, then bills it in Point of sale: the invoice is issued to a customer with the buyer's name.
- Inventory staff see the same order with masked buyer details.
- axe 0 serious/critical at 360/768/1280 px on the list and the order page; no CSP errors; CI green.

**Not done in this phase:**
- Real Amazon or Flipkart APIs (Q4).
- Printing shipping labels.
- Updating the order status back on the marketplace.
