# Pricing validation plan (Phase 10.3)

Version 1.0 — 2026-10-28. **The prices in the system are pilot prices, not market prices. They have not been validated with any shop.** This document says what is in place, what is assumed, and how the prices will be tested once pilot shops exist (Q1). Nothing here is a revenue or profit forecast.

## 1. What exists today

| Plan (seeded, migration 0006) | Price | Billing | Allowances set | Status |
|---|---|---|---|---|
| Starter | ₹999 / month | monthly | none (no limits) | "Pilot pricing — to be validated with pilot customers; not a market price." |
| Growth | ₹1,999 / month | monthly | none | same |
| Pro | ₹3,499 / month | monthly | none | same |

Mechanisms that are implemented and tested:
- The platform admin can change price, allowances and notes without a deployment. Changes are audited (FR-SUB-2, TR-0009 #9) and apply to new invoices only. An issued invoice never changes (TR-0045).
- Monthly allowances for AI units, messages and storage per plan. The owner gets a notice at 80 % and a hard stop at 100 %, unless they set an overage cap (FR-SUB-3, TR-0041).
- Billing invoices at the plan price, paid by manual record (TR-0045).

**Not defined yet (product decision for the user):**
- **What makes the plans different.** The plans differ only in price today: every plan includes every feature, with no allowances set.
- **The trial length offered commercially.** The code default is 14 days (`TRIAL_DAYS`).
- **Yearly prices.**
- **The GST treatment** of the platform's own invoices (Q5).

## 2. Cost per shop (from `COST_MODEL.md`, indicative, unverified third-party prices)

- **Infrastructure:** ₹4,300–5,800/month for the pilot (1 shop), ≈ ₹580–870 per shop at 10 shops, and ≈ ₹200–360 per shop at 100 shops.
- **Not included in those figures:**
  - support time;
  - development;
  - payment gateway fees;
  - taxes;
  - metered provider costs: messages (WhatsApp per conversation, SMS per message) and AI per use, which are passed through by quotas.

A price is only viable if it covers infrastructure per shop, plus the metered use within the plan allowance, plus support. **These figures must be recomputed with real usage from the pilot.**

## 3. Hypotheses to test

| # | Hypothesis | Measure | Source |
|---|---|---|---|
| H1 | A small mobile shop gets enough value from billing + stock + IMEI tracking alone to pay ₹999/month | Owner says they would pay at the end of the trial; actual conversion after the trial | Interview; billing invoices paid |
| H2 | Daily use, not occasional: invoices issued on most trading days | Invoices per trading day; active days per month | Reports (sales), audit events |
| H3 | Reminders and campaigns justify a higher plan | Use of reminders/campaigns among pilot shops; messages sent | Usage screen (message counts), campaign results |
| H4 | The assistants are used enough to need an allowance | AI units per shop per month; % of shops that use them weekly | Usage (AI units), agent runs |
| H5 | Price sensitivity: the Starter price is not the main reason for not adopting | Reasons given by shops that decline | Interview |
| H6 | Metered costs stay within the plan margin | Messages and AI units per shop × provider unit cost | Usage records with unit cost (FR-SUB-3 AC1) |

## 4. Interview guide (owner, at the start and at the end of the pilot)

1. What do you use today for billing, stock and customer records? What does it cost per month?
2. What took the most time last week: billing, stock counting, chasing payments, or messaging customers?
3. (End of pilot) Which three screens did you use most? Which did you never open?
4. If this cost ₹999 a month, would you pay for it? At ₹1,999 with reminders and campaigns? What would make it clearly worth it?
5. What would make you stop using it?
6. Would you prefer monthly or yearly payment? UPI autopay, or a bill you pay by hand?

Record the answers without personal data beyond the shop's name. Store them outside this repository.

## 5. Decision rule (proposed)

- Keep a plan's price when at least half of the pilot shops that used it on most trading days say they would pay that price (H1/H2) **and** the metered cost per shop stays below 30 % of the price (H6).
- Lower the price or move features between plans when price is the main reason given for declining (H5).
- Set plan allowances from the 80th percentile of observed use (H4, H6), so that most shops never reach the stop.
- Any change is made through the platform plans API (`PATCH /api/platform/plans/:planId`, audited; there is no plans screen yet). It applies to new periods only. Existing shops are told 30 days ahead (the notice period is to be confirmed in the terms).

## 6. Pricing still blocked on

- Q1: pilot shops.
- A payment method for collecting fees (payment gateway account, Q4). Until then fees are paid manually and recorded by the admin.
- Q5: GST registration and the tax treatment of the platform's invoices.
- Legal terms with the price-change and refund rules (`COMMERCIAL_READINESS.md`).
