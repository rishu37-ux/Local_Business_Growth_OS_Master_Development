# Cost Model (Phase 2)

Version 1.0 — 2026-10-27
Status: **Indicative only.** Vendor pricing pages (digitalocean.com, aws.amazon.com, supabase.com, neon.com) were **blocked by this environment's network policy** (proxy 403), so every price below comes from third-party web-search results, labelled per row. Re-verify against official pricing pages or calculators before committing spend. Nothing has been purchased or provisioned.

## 1. Assumptions

| # | Assumption |
|---|---|
| C1 | Exchange rate **₹96.5 = US$1** (Pluang undated live quote seen 2026-10-27; its 52-week range was 86.25–96.96). A 10% rate move changes INR totals by about 10%. |
| C2 | 730 hours per month for always-on services. |
| C3 | Pilot load: 1–10 shops, up to ~20 concurrent users per shop at peak (NFR-14), modest data (< 20 GB DB, < 50 GB files in year 1). |
| C4 | Excludes: people (development, support), payment-gateway fees, GST on platform subscriptions, domain, penetration test, legal/tax review, and **provider-metered usage** (AI, OCR, image/video, SMS, WhatsApp, email volume). Metered usage is passed through or quota-limited per tenant (FR-SUB-3) and will be measured in Phase 7 rather than guessed. |
| C5 | One region in India for all stateful services (latency and data-handling simplicity; see ADR-18). |

## 2. Unit prices found (third-party sources, 2026)

| Item | Price | Source (date) | Confidence |
|---|---|---|---|
| DigitalOcean Managed PostgreSQL, single node 1 / 2 / 4 GiB | $15 / $30 / $61 per month | kuberns.com DigitalOcean pricing guide (2026); InfraTally review (verified 2026-04-17) | Medium; BLR1-specific price not confirmed |
| DigitalOcean Managed PostgreSQL with standby (HA) | from ~$60/month | kuberns.com (2026) | Low–medium |
| DigitalOcean managed databases in BLR1 | Available (PostgreSQL listed) | DigitalOcean docs, regional availability page | Medium (seen in search snippet) |
| DigitalOcean App Platform service / worker | ~$5/month each for the smallest (1 shared vCPU, 512 MiB); larger sizes cost more | Third-party guides (2026), which disagree on tiers | Low |
| DigitalOcean Spaces | $5/month incl. 250 GB storage + 1 TB transfer | Third-party guide (2026) | Medium |
| AWS RDS PostgreSQL db.t4g.micro (2 vCPU, 1 GiB), Mumbai, on-demand | $15/month (1-yr reserved $11) | Bytebase dbcost (updated 2026-07-20) | Medium |
| AWS Fargate (Linux x86), us-east-1 | $0.04048 per vCPU-hour, $0.004446 per GB-hour; other regions reported 10–30% higher; no Mumbai rate found | Third-party Fargate pricing articles | Low for Mumbai |
| Supabase Pro | $25/month incl. $10 compute credit (covers Micro: 2-core ARM, 1 GB); PITR add-on ~$100/month per 7-day window; daily backups kept 7 days | Several 2026 third-party guides (they disagree on per-org vs per-project) | Medium |
| Neon Launch | $0.106 per CU-hour; storage $0.35/GB-month | neon.com/pricing as quoted in search results; storage from secondary sources | Medium |

## 3. Options compared (pilot, 1–10 shops)

| | **A. DigitalOcean BLR1 (recommended)** | B. AWS Mumbai | C. Managed serverless Postgres + container host |
|---|---|---|---|
| Database | Managed PostgreSQL 1–2 GiB single node: **$15–30** | RDS t4g.micro Single-AZ: **$15** + storage (not priced here) | Supabase Pro $25 (Micro) or Neon always-on 1 CU ≈ 0.106 × 730 = **$77** |
| App (API + worker + heavy PDF/OCR worker) | App Platform 3 components, small–medium: **~$25–50** (estimate from the tier info above) | Fargate: 0.5 vCPU/1 GB ≈ $18/month per task at us-east-1 rates (my calculation), so ~$20–23 each in Mumbai if the premium holds; 2 small + 1 larger (1 vCPU/2 GB ≈ $36–47): **~$75–95** | Container host in India still needed (e.g. option A's App Platform): **~$25–50** |
| Object storage | Spaces **$5** | S3 (not priced; small at pilot volume) | Spaces or S3 |
| Load balancer, NAT, logs | Included in App Platform (to verify) | ALB, NAT gateway, CloudWatch: **not priced (not found in available sources); material on AWS** — get from the AWS Pricing Calculator | Depends on host |
| Point-in-time recovery | Managed PostgreSQL includes backups; PITR window to verify | RDS automated backups + PITR (storage charges apply) | Supabase PITR add-on ~$100; Neon restore window by plan |
| KMS for envelope encryption | None managed (to verify) → KEK as platform secret | AWS KMS available | Depends |
| **Indicative monthly total** | **≈ $45–90 → ₹4,300–8,700** | **≈ $95–125+** before storage, ALB, NAT and logs → ₹9,200–12,100+ | **≈ $55–180 → ₹5,300–17,400** (cross-provider latency/egress) |
| Ops complexity | Low | High | Medium (two providers) |
| Data residency | India | India | DB in India only if a Mumbai region is chosen (availability to verify) |

Edge (Cloudflare free plan) and error tracking (free tier) are assumed at **$0** for the pilot; paid tiers are not priced here.

## 4. Scaling scenarios (option A, indicative)

| Shops | Configuration (assumed) | Infra/month (USD) | INR (C1) | Infra per shop (INR) | Revenue at Starter ₹999 | Revenue at Growth ₹1,999 |
|---|---|---|---|---|---|---|
| 1 (pilot) | DB 1 GiB single node; 3 small app components; Spaces | $45–60 | ₹4,300–5,800 | ₹4,300–5,800 | ₹999 | ₹1,999 |
| 10 | DB 2 GiB single node; API 1 GB; workers 1–2 GB | $60–90 | ₹5,800–8,700 | ₹580–870 | ₹9,990 | ₹19,990 |
| 100 | DB 4 GiB **with standby (HA)** ≈ $120–180 (assumed ≈ 2× single node); 2 API instances + workers ≈ $60–120; Spaces + extra storage ≈ $10–25; email ≈ $15–50 | $205–375 | ₹19,800–36,200 | ₹200–360 | ₹99,900 | ₹1,99,900 |

Reading: on infrastructure alone (excluding C4 items), the pilot breaks even at roughly 5–9 Starter shops. **This is not a profit projection** (FR-SUB / prompt §12): support effort, development, gateway fees, taxes and metered provider costs are excluded, and pilot pricing is unvalidated.

## 5. Cost controls designed in

- Per-tenant usage records and quotas for every metered provider; 80% alert, 100% hard stop unless the owner opted into capped overage (FR-SUB-3).
- AI/agent budgets per run and per tenant per day (FR-AGT-5).
- No Redis in the pilot (D-021); one PostgreSQL for data and the job queue.
- Container sizes reviewed monthly against actual CPU/memory; heavy jobs isolated so the API can stay small.

## 6. Decisions needed from the user

- **Q2:** confirm option A (DigitalOcean BLR1) or choose another, and a monthly infrastructure ceiling for the pilot (suggested: **US$100 ≈ ₹9,650** including headroom).
- Allow the hosts above in the environment's network settings if you want prices re-checked against the official pages from this environment.
