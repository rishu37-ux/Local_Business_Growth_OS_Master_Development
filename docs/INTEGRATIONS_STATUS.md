# Integrations Status

Status values: `planned` · `configured` · `tested` (against sandbox/mock) · `verified` (against real provider with confirmed response) · `failed` · `blocked`.
**This file must never contain secrets, tokens, keys, passwords or account identifiers that grant access.**

Last updated: 2026-10-27 (Phase 4, increment 4.5). No accounts or credentials have been provided; nothing is connected. Phase 2 chose the *approach* for some rows (shown in Notes); choosing an approach is not configuring an integration.

| Integration | Purpose | Status | Permissions / approvals required (to confirm against current provider docs) | Limitations / notes |
|---|---|---|---|---|
| Authentication (Better Auth, self-hosted — D-019, conditional on Q3) | Login, sessions, MFA | planned | None external; runs in our DB | Not a third-party service unless the user picks managed auth |
| Object storage (S3-compatible; DigitalOcean Spaces proposed — D-022) | Invoices, photos, media | planned | Private bucket, presigned URLs ≤15 min | Provider pending Q2. **In use meanwhile:** `StorageAdapter` with a private local directory (`UPLOAD_DIR`) for development and an in-memory store in tests; files served only through an authenticated API route |
| OCR provider / engine | Product box & invoice text | planned (adapter interface + **mock** adapter tested) | API account or self-hosted engine (options to compare: a cloud OCR API, or self-hosted Tesseract) — Q4 | The mock adapter does **not** recognise text: it reads synthetic fixture text (PNG tEXt chunk / simple PDF strings). Accuracy of any real engine is unknown until tested with real, consented samples |
| LLM provider(s) | Parsing, drafts, agents | planned | API account, usage budget | Model choice pending; outputs untrusted. An optional OCR structuring hook exists (strict schema, verbatim-in-document rule) and is tested only with test structurers |
| Image / video generation provider | Creative studio | planned | API account, content policy compliance | Cost per asset to be measured |
| WhatsApp Business Platform (Cloud API or BSP) | Templates, notifications | planned | Meta Business verification, WABA, approved templates, opt-in | Template approval by Meta; per-conversation pricing |
| SMS gateway (India) | Transactional / promotional SMS | planned | TRAI DLT entity, header (sender ID) and template registration | DLT registration owned by the shop/platform entity |
| Email provider | Verification, reset, receipts | planned | Verified sending domain (SPF/DKIM/DMARC) | — |
| Google Business Profile API | Local SEO, posts, reviews | planned | API access approval from Google, verified profile, OAuth consent | Feature set limited to what the API supports |
| Meta Graph API (Facebook / Instagram) | Posts, insights | planned | App review, business account, page/IG professional account, scopes | Publishing limits per API rules |
| Payment gateway (subscriptions) | Platform billing | planned | Merchant account, KYC | Provider pending |
| GST e-invoice (IRP) / e-way bill | Only if legally applicable | planned (conditional) | GSP/IRP access; applicability depends on turnover thresholds | Requires tax-professional confirmation |
| Malware scanning | Upload safety | planned (not configured) | Engine/service choice | Uploads record `malware_scan = NOT_CONFIGURED`; the scan screen says no scanner is configured (FR-OCR-6 AC4) |
| Hosting (DigitalOcean BLR1 proposed — D-022) | Compute, managed PostgreSQL | planned | Account owned by the business operator | Pending Q2; pricing unverified (COST_MODEL.md) |
| Edge / WAF (Cloudflare proposed — ADR-14) | TLS, DDoS, WAF, edge rate limits | planned | DNS for the platform domain | Needs a domain (Q6) |
| Error tracking (Sentry or self-hosted GlitchTip — ADR-15) | Exceptions | planned | Project/DSN | PII scrubbing required |
