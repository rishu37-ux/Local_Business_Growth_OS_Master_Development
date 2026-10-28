# Phase 11 plan — Shop branding (white-label), public shop website, and multi-channel stock (marketplaces)

Version 1.0 — 2026-10-28. Requested by the user after Phase 10 (D-069). It extends:
- FR-ONB-2 AC1 (branding/logo in setup);
- FR-PRN-1 (printed documents);
- FR-INV (stock);
- FR-HUB (integrations).

It also moves "custom domains/branded portals" (SRS §15) partly into scope. Acceptance criteria (AC) are fixed **before** coding. Only executed checks count (`TEST_REPORT.md`).

**What the user asked for:**
1. Stock in the system appears automatically on Amazon, Flipkart, other e-commerce platforms and the shop's own public website. Stock is also managed from there: an order on any channel takes stock.
2. Each shop is white-labelled: its logo, address and branding on its bills.
3. The public website is separate. Everyone signs in to one central dashboard that looks the same for all.

**What already exists:**
- The dashboard is already one central app with one sign-in for every shop (ADR-05). Each shop sees only its own data (TR-0044).
- Printed invoices already carry the shop's legal and display name, address, phone, e-mail and GSTIN from a snapshot taken at issue (TR-0023).

**What cannot be done without the user (Q4).** Amazon (Selling Partner API) and Flipkart (Seller API) need a seller account on each marketplace and approval as a developer/app on each. Their API contracts cannot be checked or tested from this environment. This phase therefore builds:
- the complete channel layer (listings, available-to-sell, stock push queue, order import, reservations, fulfilment through normal billing);
- a **documented JSON connector contract** (`marketplace_json`) that a marketplace connector or aggregator can implement;
- a mock marketplace for tests.

**Amazon and Flipkart adapters are not written and nothing is claimed to sync with them.** Each one is built and tested against that marketplace's real API after the accounts exist.

**Decisions taken here (documented defaults, D-069):**
- **No online payment** from shop customers (SRS §15: payment collection stays out of scope). The website takes **order requests**: stock is reserved, and the shop confirms, bills and collects payment as today.
- **Address of the website:** `/s/<shop-address>` on the platform's own domain. Custom domains per shop need Q6 and DNS/TLS automation, and come later.
- **Branding scope:** the logo and brand colour appear on printed and PDF invoices, on the shop's website, and next to the shop name in the dashboard. The dashboard itself stays the platform's single design for everyone, as the user asked.

## Increment 11.1 — Branding (white-label)
**Status: done (TR-0046 #1–4).**
- **AC1:** the owner (`business.settings.manage`) uploads a logo and sets a brand colour (`#RRGGBB`).
  - The logo must be PNG or JPEG only, checked by magic bytes, at most 1 MB and at most 2000 px per side. SVG is refused because it can carry scripts.
  - Each change is audited.
- **AC2:** an invoice issued after the logo is set prints it, on screen and in the PDF, together with a brand-colour accent. The logo and colour are part of the **issue-time snapshot**, so a reprint matches what was issued. An invoice issued earlier stays as it was. The colour is used only for the accent rule, never for text, so contrast is unaffected. The print CSP allows only `data:` images.
- **AC3:** the dashboard shows the shop's logo next to its name, for members of that shop only.

## Increment 11.2 — Sales channels, listings and available-to-sell
**Status: done with the mock connector (TR-0046 #5–8, D-070).**
- **AC1:** channels per business:
  - the shop's **website** (one per business);
  - **marketplace** channels, each linked to a tested integration of category `MARKETPLACE`.
  Each channel has a stock buffer of 0–1000 units.
- **AC2:** listings link a product variant to a channel, with an external SKU (unique per channel), an optional channel price (default: the selling price) and a published flag. Cost price, IMEIs and suppliers are never part of a listing.
- **AC3:** available-to-sell on a channel = available stock − reservations of open channel orders (all channels) − the channel's buffer, floored at 0. Exact values are checked on a seeded dataset.
- **AC4:** every stock change of a listed variant queues a push for its marketplace listings. The queue is written by a database trigger in the same transaction, so no change is missed. Listing changes and reservation changes queue a push too.
  - The job runner sends each pending push through the channel's adapter and records the result and the quantity sent.
  - A failure is retried with a limit and shown. A newer push supersedes an older one.

## Increment 11.3 — Channel orders, reservations and fulfilment
**Status: done with the mock connector (TR-0046 #9–11, D-070).** Known gap: a counter sale in POS is not blocked by reservations (D-070).
- **AC1:** orders are imported from a marketplace by the job runner (adapter `fetchOrders` with a cursor) and created from website order requests.
  - Each order is stored once per channel and external order ID (idempotent).
  - Lines are matched by external SKU. An unknown SKU makes the order "needs attention" and does not fail the import.
- **AC2:** an open order (NEW or ACCEPTED, not yet billed) reserves its quantities. An imported order larger than available-to-sell is still recorded (it happened on the marketplace), but it is flagged OVERSOLD.
- **AC3:** **Bill this order** (`pos.sell`) creates a sale draft with the order's lines, prices and customer; the cashier then issues it in Point of sale as usual.
  - Issuing writes the normal SALE movement, invoice number and GST.
  - Once the invoice is issued the order counts as fulfilled and its reservation ends.
  - Cancelling an order (shop, or the marketplace's feed) ends its reservation. A billed order cannot be cancelled from here; it follows the normal invoice cancellation or credit-note rules.
- **AC4:** cross-tenant: another business sees none of a business's channels, listings or orders, and gets 404 on their IDs.

## Increment 11.4 — The shop's public website (separate from the dashboard)
**Status: done (TR-0046 #12–15).**
- **AC1:** with the online store enabled and a shop address chosen (3–40 characters, `a-z`, `0-9`, `-`; unique; a few names reserved), `/s/<address>` shows:
  - the shop name, logo, colour, address and phone;
  - **published website listings only**: name, variant, price, and availability ("In stock", "Only N left" for N ≤ 3, "Out of stock").
  It is server-rendered HTML with no scripts and its own strict CSP. Nothing else of the business is reachable from it: public data is read only through definer functions that return public fields.
- **AC2:** a product page has an order request form (name, mobile, quantity) with a notice of who receives the details.
  - A valid request becomes a website order and reserves stock; a request above available-to-sell is refused with the number available.
  - It is rate-limited per address, has a spam trap field, and is idempotent per form token.
- **AC3:** a disabled store, an unknown address, or a business that is not ACTIVE → 404. An unpublished listing never appears. Security headers are present on every storefront response.

## Increment 11.5 — Screens and Phase 11 exit
**Status: done (TR-0046 #16–17).**
- **Settings → Branding and online store:** logo, colour, shop address, enable/disable the store, and the link to the website.
- **Online selling:**
  - channels with their buffer and last sync result;
  - listings per product (publish per channel, SKU, price);
  - orders (bill, cancel, status, oversold or needs-attention flags).
- **Exit (browser):**
  1. The owner uploads a logo and publishes two products.
  2. The website shows them with the logo; a customer sends an order request.
  3. The owner bills the order in Point of sale; the invoice shows the logo and stock goes down.
  4. A marketplace channel on the mock receives the new available quantity.
  5. An imported marketplace order reserves stock and lowers what the website shows.
  6. axe reports 0 serious/critical issues at 360, 768 and 1280 px on the new screens and the website.

## Phase 11 exit
**Status: passed locally (TR-0046); CI result recorded when known. Amazon and Flipkart are not connected (Q4).**
All of the above passes, including cross-tenant, read-only-mode and permission tests, and the isolation sweep covers the new routes. CI is green. Amazon and Flipkart remain **not connected** until the user's seller accounts and API approvals exist (Q4).
