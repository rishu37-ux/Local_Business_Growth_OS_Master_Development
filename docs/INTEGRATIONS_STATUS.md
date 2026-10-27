# Integrations Status

Status values: `planned` · `configured` · `tested` (against sandbox/mock) · `verified` (against real provider with confirmed response) · `failed` · `blocked`.
**This file must never contain secrets, tokens, keys, passwords or account identifiers that grant access.**

Last updated: 2026-10-27 (Phase 0). No accounts or credentials have been provided; nothing is connected.

| Integration | Purpose | Status | Permissions / approvals required (to confirm against current provider docs) | Limitations / notes |
|---|---|---|---|---|
| Authentication provider (managed or library) | Login, MFA | planned | — | Choice pending (Phase 2) |
| Object storage (private) | Invoices, photos, media | planned | Bucket with private ACL, signed URLs | Provider pending |
| OCR provider / engine | Product box & invoice text | planned | API account or self-hosted engine | Accuracy unknown until tested with real samples |
| LLM provider(s) | Parsing, drafts, agents | planned | API account, usage budget | Model choice pending; outputs untrusted |
| Image / video generation provider | Creative studio | planned | API account, content policy compliance | Cost per asset to be measured |
| WhatsApp Business Platform (Cloud API or BSP) | Templates, notifications | planned | Meta Business verification, WABA, approved templates, opt-in | Template approval by Meta; per-conversation pricing |
| SMS gateway (India) | Transactional / promotional SMS | planned | TRAI DLT entity, header (sender ID) and template registration | DLT registration owned by the shop/platform entity |
| Email provider | Verification, reset, receipts | planned | Verified sending domain (SPF/DKIM/DMARC) | — |
| Google Business Profile API | Local SEO, posts, reviews | planned | API access approval from Google, verified profile, OAuth consent | Feature set limited to what the API supports |
| Meta Graph API (Facebook / Instagram) | Posts, insights | planned | App review, business account, page/IG professional account, scopes | Publishing limits per API rules |
| Payment gateway (subscriptions) | Platform billing | planned | Merchant account, KYC | Provider pending |
| GST e-invoice (IRP) / e-way bill | Only if legally applicable | planned (conditional) | GSP/IRP access; applicability depends on turnover thresholds | Requires tax-professional confirmation |
| Malware scanning | Upload safety | planned | Engine/service choice | — |
