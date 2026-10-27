# Initial Requirements and Security Blueprint (Phase 0)

Status: **Draft — input to the Phase 1 SRS.** Source: `Local_Business_Growth_OS_Master_Development_Prompt.txt` (v1.0, 27 Oct 2026). Requirement IDs here are used in `REQUIREMENTS_TRACEABILITY.md`.

Nothing in this document is implemented yet.

## 1. Product summary

A multi-tenant SaaS "Growth OS" for local businesses. The first pilot vertical is a mobile-phone and electronics shop. Each shop (tenant) gets one portal for POS/billing, inventory with IMEI tracking, CRM and ledger, GST-configurable invoicing, analytics, OCR-assisted intake, AI marketing, messaging/social integrations and AI agents. Platform Admins approve shops and manage plans and integrations.

## 2. Actors and roles

| Role | Scope | Key permissions |
|---|---|---|
| Platform Admin | Whole platform | Review/approve/reject shop applications, manage plans, platform integrations, health, usage, support. Must use MFA. No implicit access to tenant business data — support access must be explicit, time-boxed and audited (proposed). |
| Shop Owner | One business (tenant) | Everything within their own tenant: users, products, sales, customers, integrations, settings. MFA strongly recommended / required for owner (decide Phase 2). |
| Shop Staff | One business, assigned permissions | Only explicitly granted permissions (e.g., `billing.create`, `inventory.view`). Default: no permissions. |
| Customer (non-user) | Data subject | Not a login user in v1. Has consent/opt-out state. |
| AI Agent (system actor) | One tenant, tool-scoped | Least-privilege tools; consequential actions require human approval. |

## 3. Tenant lifecycle

Business status (separate from subscription status):

```
PENDING_APPROVAL ──approve──▶ APPROVED_SETUP_PENDING ──setup complete──▶ ACTIVE
      │  ▲                                                                │  ▲
      │  └──resubmit── CHANGES_REQUESTED ◀──request changes──┘           │  │
      └──reject(reason)──▶ REJECTED                          suspend ────▼  │ reinstate
                                                               SUSPENDED ───┘
```

Subscription status (separate): e.g. `TRIAL`, `ACTIVE`, `PAST_DUE`, `CANCELLED`, `EXPIRED` (finalise in Phase 1).

Rules:
- BR-T1 Self-registration creates a `PENDING_APPROVAL` application; no business data access until approved.
- BR-T2 Every transition is recorded in approval history with actor, timestamp and reason.
- BR-T3 Rejection and change requests require a reason.
- BR-T4 `SUSPENDED` blocks business operations; read-only/export access policy to be decided in Phase 1.

## 4. Functional requirements (by module)

IDs are `FR-<module>-<n>`. Full acceptance criteria are written in Phase 1.

### M1 Authentication, users, onboarding
- FR-AUTH-1 Secure login/logout, session expiry, server-side session revocation.
- FR-AUTH-2 Password reset and verification flows that do not reveal whether an account exists.
- FR-AUTH-3 MFA for privileged users (Platform Admin required; Shop Owner configurable).
- FR-AUTH-4 Login rate limiting and lockout/backoff.
- FR-ONB-1 Self-registration → pending application; Admin can also create a shop directly.
- FR-ONB-2 Setup wizard: details, address, category, branding/logo, tax configuration, users, product import, integrations, preferences; with progress tracking.
- FR-ONB-3 Approval history and notifications.
- FR-RBAC-1 Configurable, least-privilege staff roles/permissions.

### M2 Catalogue and inventory
- FR-INV-1 Hierarchy category → brand → model (product) → variant → unit.
- FR-INV-2 Phone attributes: brand, model/model number, RAM, storage, colour, SKU/barcode, purchase/selling price, tax/HSN, supplier, warranty details.
- FR-INV-3 Serialized units: IMEI 1 (required for phones), optional IMEI 2, serial number, status. IMEI unique (proposed: unique per tenant, with platform-level duplicate warning — decide Phase 1). IMEI format validated (15 digits + Luhn check digit).
- FR-INV-4 Append-only stock ledger: purchase, sale, return, transfer, damage, adjustment, approved correction. Corrections via reversal records; no silent overwrites.
- FR-INV-5 Stock changes only on confirmed transactions.
- FR-INV-6 Returns enter an inspection state; not sellable until inspected and released.
- FR-INV-7 Low-stock alerts, slow-moving/dead stock reports, reorder suggestions.
- FR-INV-8 Suppliers and purchase records.
- FR-INV-9 Barcode/QR scanning where feasible.

### M3 OCR / smart scanner
- FR-OCR-1 Camera capture or image/PDF upload (product boxes, supplier invoices).
- FR-OCR-2 Extracted fields shown with confidence and source evidence.
- FR-OCR-3 Deterministic validation (IMEI Luhn, duplicates, malformed fields).
- FR-OCR-4 Mandatory review screen before any stock/purchase record is created; missing values left blank, never invented.
- FR-OCR-5 Uploaded files and OCR text treated as untrusted; instructions in scanned text never followed.
- FR-OCR-6 File type/size limits, isolated processing, malware scanning where practical.

### M4 POS, billing, tax
- FR-POS-1 Fast product/variant search, IMEI selection for serialized items.
- FR-POS-2 Discounts bounded by permission limits.
- FR-POS-3 Multiple and partial payments; returns/refunds.
- FR-POS-4 Unique, configurable invoice numbering per business and financial year.
- FR-POS-5 Customer capture at checkout with CRM reuse.
- FR-TAX-1 HSN/SAC, configurable tax rates, taxable value, CGST/SGST vs IGST by place of supply, discounts, totals — computed in deterministic, tested code.
- FR-TAX-2 No hard-coded tax rates or thresholds; versioned tax configuration with effective dates.
- FR-TAX-3 Credit/debit notes, cancellations, corrections — auditable.
- FR-TAX-4 E-invoice/IRN/QR/digital signature only where legally applicable and approved (not assumed).
- FR-PRN-1 A4, A5, 80 mm, 58 mm layouts; PDF download and browser print.

### M5 CRM and customer ledger
- FR-CRM-1 Profile: name, phone; optional email, address, DOB; contact preferences; consent status; history.
- FR-CRM-2 Data minimisation (DOB optional).
- FR-LED-1 Ledger for invoices, payments, advances, credits, refunds, outstanding balance.
- FR-LED-2 Deterministic, tested payment allocation.
- FR-LED-3 Clear separation of revenue, cash received, advances, receivables, gross margin, net profit.
- FR-CON-1 Consent, opt-out/suppression list and communication history; marketing only when permitted.
- FR-REM-1 Configurable birthday/warranty/service reminders that only reference recorded warranty terms.

### M6 Analytics and reports
- FR-RPT-1 Daily/weekly/monthly/yearly sales and comparisons; brand/model/variant performance; margin; expenses; stock valuation; receivables ageing; payment methods; returns; campaign results.
- FR-RPT-2 Every metric has a visible definition; sales never labelled as profit/cash.
- FR-RPT-3 Per-business timezone and financial-period rules.
- FR-RPT-4 CSV/PDF/XLSX export where required.
- FR-RPT-5 AI analysis distinguishes facts from estimates and states the data period.

### M7 AI Creative Studio
- FR-AIC-1 Drafts, captions, images, short videos via configured providers.
- FR-AIC-2 Content grounded in actual product data, approved offers and valid dates; no invented prices/discounts/stock/specs/guarantees.
- FR-AIC-3 Approval required before publish, ad spend or bulk send (unless explicit safe policy).
- FR-AIC-4 Platform/aspect-ratio variants, scheduled drafts.
- FR-AIC-5 Track generation cost, status, errors, assets.

### M8 API & Integrations Hub
- FR-HUB-1 Provider adapters behind interfaces; controlled custom-integration configuration.
- FR-HUB-2 Config fields: provider, auth method, endpoint, scopes, model/service ID, usage limits, timeout/retry, status.
- FR-HUB-3 Secrets server-side only, encrypted, masked in UI/logs.
- FR-HUB-4 Test connection, enable/disable, rotation/revocation, usage tracking, health.
- FR-HUB-5 SSRF protection: allow-listing, URL validation, block private/link-local/metadata ranges, DNS-rebinding defence, egress controls.
- FR-HUB-6 Tenant-owned or platform-owned credentials with cost attribution and limits.

### M9 WhatsApp, SMS, email, social
- FR-MSG-1 Official APIs only; WhatsApp templates, consent, delivery status.
- FR-MSG-2 Indian SMS DLT entity/sender/template compliance.
- FR-MSG-3 GBP/Meta features limited to approved API capabilities.
- FR-MSG-4 "Posted"/"delivered" states only from provider confirmation.
- FR-MSG-5 Drafts, approval, scheduling, retries, failure status, opt-out.

### M10 AI agents
- FR-AGT-1 Initial agents: Inventory/OCR, Finance/Analytics, CRM reminder, Marketing/Creative, Business Growth.
- FR-AGT-2 Arithmetic, ledger, tax, stock, authorization done by deterministic code — never by the model.
- FR-AGT-3 Least-privilege, tenant-scoped tools.
- FR-AGT-4 Human approval for consequential actions (refunds, stock adjustments, bulk marketing, publishing, ad spend, tax settings, purchases).
- FR-AGT-5 Idempotency, retry limits, timeouts, job status, cancellation, cost budgets.
- FR-AGT-6 Audit: input references, proposed action, approval, result, errors — no secrets/unnecessary PII.

### M11 Subscriptions and commercial
- FR-SUB-1 Plans, trials, status, invoices, payment status, limits, cancellation/suspension.
- FR-SUB-2 Admin-configurable plans/prices without code changes. Indicative pilot pricing (to validate, not guaranteed): Starter ₹999, Growth ₹1,999, Pro ₹3,499 per month.
- FR-SUB-3 Separate metering for AI/media/SMS/WhatsApp/provider costs and ad budget; per-tenant usage, quotas and alerts.

### M12 Audit and continuity
- FR-AUD-1 Audit log of sensitive actions, permission changes, credential access, financial corrections — append-only.
- FR-MEM-1 Project memory documents maintained in `/docs` (see `PROJECT_MEMORY.md`).

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Responsive and accessible UI (target WCAG 2.2 AA) on mobile, tablet, desktop browsers. PWA/native not required. |
| NFR-2 | Modular monolith; module boundaries enforced in code. |
| NFR-3 | TypeScript end-to-end; strict runtime schema validation at API boundaries. |
| NFR-4 | PostgreSQL; tenant isolation enforced in service layer **and** by Row-Level Security. |
| NFR-5 | Background job queue for OCR, media, campaigns, reports. |
| NFR-6 | Private object storage with short-lived signed URLs. |
| NFR-7 | Provider adapters swappable without business-logic changes. |
| NFR-8 | Money stored as integer minor units (paise) or `NUMERIC`; never floating point. |
| NFR-9 | All timestamps stored in UTC; reporting uses tenant timezone (default `Asia/Kolkata`) and financial year (default April–March). |
| NFR-10 | Observability: structured logs (PII/secret-redacted), metrics, error tracking, health checks. |
| NFR-11 | Backups encrypted, with restoration actually tested before pilot. |
| NFR-12 | Data protection aligned with India's DPDP Act 2023 and its rules (legal review required — not verified here). |

## 6. Security blueprint (summary)

Full details in `SECURITY_THREAT_MODEL.md`. Verification will follow an OWASP ASVS-aligned checklist (target level L2 for the platform, with L3-style controls for credential vault and financial ledger — confirm in Phase 2).

Baseline controls to build in Phase 3, before any business module:
1. Tenant context resolved server-side from the authenticated session, never from client input; set per transaction (`SET LOCAL app.tenant_id`) for RLS.
2. Application DB role without `BYPASSRLS`, not the table owner; migrations run under a separate role.
3. Deny-by-default authorization middleware; permission checks on every protected route; automated cross-tenant access tests.
4. Password hashing with Argon2id (or managed auth equivalent); MFA (TOTP / WebAuthn) for privileged users.
5. HttpOnly, Secure, SameSite cookies; CSRF tokens for state-changing cookie-authenticated requests; strict CSP; output encoding.
6. Parameterised queries only; schema validation on every input.
7. Rate limits on login, reset, OCR, AI generation and messaging endpoints; per-tenant quotas.
8. Secrets in a managed secret store or envelope-encrypted vault; never in frontend bundles, repo or logs; secret scanning in CI.
9. Append-only audit log; append-only stock and customer ledgers with reversal entries.
10. File upload pipeline: type sniffing, size limits, isolated processing, no server-side URL fetches of user-supplied URLs without SSRF guard.
11. Prompt-injection defence: untrusted content passed to models as data, tool access gated by deterministic policy and human approval.
12. Dependency and secret scanning, protected branches and CI.

Not promised: "100% hack-proof" security. Independent authorized penetration testing is required before broad commercial launch.

## 7. Proposed initial data-model entities (to be refined in Phase 1)

Platform: `platform_users`, `businesses` (tenants), `business_applications`, `approval_events`, `plans`, `subscriptions`, `usage_records`, `audit_events`.
Tenant-scoped (all carry `business_id`): `memberships`, `roles`, `role_permissions`, `business_settings`, `tax_profiles`, `tax_rates` (versioned), `categories`, `brands`, `products`, `product_variants`, `serialized_units`, `suppliers`, `purchases`, `purchase_lines`, `stock_movements` (append-only), `customers`, `consents`, `invoices`, `invoice_lines`, `invoice_number_sequences`, `payments`, `payment_allocations`, `customer_ledger_entries` (append-only), `credit_debit_notes`, `returns`, `expenses`, `uploads`, `ocr_jobs`, `ocr_extractions`, `integrations`, `integration_secrets` (encrypted, restricted), `campaigns`, `generated_assets`, `messages`, `agent_runs`, `approval_requests`, `jobs`.

## 8. Explicit assumptions

- A1 Primary market is India; currency INR; default timezone `Asia/Kolkata`; financial year April–March.
- A2 English UI first; i18n-ready string handling (Hindi etc. later, not committed).
- A3 Single pilot shop initially; multi-tenant schema from day one.
- A4 Tax behaviour is configurable and will be reviewed by a qualified tax professional before production use.
- A5 No real customer data is used in development or tests.
