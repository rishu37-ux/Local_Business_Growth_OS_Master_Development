# Security Threat Model

Version: 0.4 (Phase 3 update) — 2026-10-27
Method: asset/trust-boundary analysis with STRIDE per boundary; verification against an OWASP ASVS-aligned checklist (to be created in Phase 3).

**Status: design only — no application exists.** Some database-level controls have been prototyped in the schema draft and tested (TR-0002); that is evidence for the design, not for a deployed system. Each mitigation's status is tracked in §6.

## 1. Assets

| ID | Asset | Sensitivity |
|---|---|---|
| AS1 | Tenant business data (products, stock, purchases, suppliers, prices, margins) | High — commercially sensitive |
| AS2 | Customer personal data (name, phone, email, address, DOB, consent, purchase history) | High — personal data (DPDP Act) |
| AS3 | Financial records: invoices, payments, customer ledger, stock ledger, credit/debit notes | Critical — integrity required for tax/legal |
| AS4 | User credentials, sessions, MFA secrets | Critical |
| AS5 | Integration credentials (WhatsApp, SMS, Meta, Google, AI providers, payment gateway) | Critical — misuse costs money and reputation |
| AS6 | Uploaded files (supplier invoices, product photos) and generated media | Medium–High |
| AS7 | Audit logs | High — integrity required |
| AS8 | Platform configuration: plans, prices, tax configuration | High |
| AS9 | Provider budgets / usage quotas (AI, SMS, WhatsApp, ad spend) | High — financial exposure |
| AS10 | Backups | Critical — contain all of the above |

## 2. Actors

Legitimate: Platform Admin, Shop Owner, Shop Staff, AI agents (system), background workers, external providers (webhooks).
Threat actors: unauthenticated internet attacker; malicious or compromised tenant user attempting cross-tenant access; malicious/over-reaching staff within a tenant; attacker supplying malicious files or OCR text; prompt-injection content in documents/messages; compromised third-party provider or webhook spoofing; insider with infrastructure access; supply-chain (malicious dependency).

## 3. Trust boundaries

```
[Browser (untrusted)] ──HTTPS──▶ [Edge: CDN/WAF/rate limit]
        ──▶ [API (modular monolith): authn, authz, validation, tenant context]
              ├──▶ [PostgreSQL with RLS]        (TB3)
              ├──▶ [Object storage, private]     (TB4)
              ├──▶ [Job queue] ──▶ [Workers: OCR / media / messaging / agents] (TB5)
              │                       ├──▶ [External AI/OCR providers]   (TB6)
              │                       └──▶ [Messaging/social providers]  (TB6)
              ├──▶ [Secret store / vault]        (TB7)
              └◀── [Provider webhooks (untrusted until verified)] (TB8)
```

- TB1 Browser ↔ edge/API
- TB2 Authenticated user ↔ tenant boundary (logical, enforced in API and DB)
- TB3 API ↔ database
- TB4 API/workers ↔ object storage
- TB5 API ↔ background workers (files and OCR text cross here)
- TB6 Platform ↔ external providers (outbound; SSRF risk)
- TB7 Application ↔ secret store
- TB8 External providers → webhooks (inbound)
- TB9 LLM/agent ↔ tools (model output is untrusted)

## 4. Threats and mitigations (STRIDE)

| ID | Boundary | Threat | Mitigation (planned) | Residual risk |
|---|---|---|---|---|
| T1 | TB2/TB3 | **Cross-tenant data access** via IDOR, missing filter, or crafted `business_id` | Tenant ID taken from session, never request; service-layer scoping; PostgreSQL RLS on all tenant tables using `SET LOCAL app.tenant_id` per transaction; app role without BYPASSRLS and not table owner; automated cross-tenant tests for every endpoint | Bugs in RLS policy definitions; mitigated by tests and review |
| T2 | TB1 | Credential stuffing / brute force | Rate limit + progressive backoff; MFA for privileged users; breached-password check (optional); generic error messages | Phishing of MFA-less staff accounts |
| T3 | TB1 | Session hijacking / fixation | HttpOnly/Secure/SameSite cookies; session rotation on login and privilege change; server-side revocation; idle and absolute timeouts | Compromised end-user device |
| T4 | TB1 | CSRF | SameSite cookies + CSRF token on state-changing requests; origin checks | Low |
| T5 | TB1 | XSS (stored, e.g., product names, OCR text, customer names) | Framework auto-escaping, no raw HTML rendering of user data, strict CSP, sanitised print templates | Third-party script compromise — minimise third-party scripts |
| T6 | TB3 | SQL injection | Parameterised queries / query builder only; lint rule against string-built SQL | Low |
| T7 | TB2 | Privilege escalation within tenant (staff → owner; discount above limit) | Deny-by-default permission checks server-side; discount limits enforced in API; permission changes audited and owner-only | Misconfigured roles by owner |
| T8 | TB2 | Platform Admin over-access to tenant data | Admin actions scoped to platform tables; explicit, time-boxed, audited support access; MFA required | Insider misuse — audit and review |
| T9 | TB5 | **Malicious uploads** (polyglot files, zip bombs, malformed PDFs, huge images) | Allow-list MIME by magic bytes; size and page limits; decompression limits; processing in isolated worker with resource limits; malware scan where practical; files never served from app origin; random storage keys | Zero-day in image/PDF parsers |
| T10 | TB5/TB9 | **Prompt injection** via OCR text, supplier invoices, customer messages, websites | Untrusted content passed as delimited data; model has no direct write tools; all model output validated against schemas; consequential actions require human approval; deterministic code for money/stock/tax | Model may produce misleading drafts — human review required |
| T11 | TB6 | **SSRF** via custom integration endpoints or media URLs | Outbound HTTP through one guarded client: https-only, allow-listed hosts for prebuilt adapters, resolve-then-connect with block of private, loopback, link-local (169.254.0.0/16 incl. cloud metadata), CGNAT, IPv6 ULA/link-local; no redirects to blocked ranges; egress firewall in hosting | DNS edge cases — test explicitly |
| T12 | TB7 | Integration secret leakage (logs, UI, frontend bundle, errors) | Envelope encryption (AES-256-GCM, per-secret data key, versioned KEK — ADR-13); dedicated DB role; secrets write-only in UI (masked); log redaction; never returned by API; CI secret scanning | Compromised server process can read decrypted secrets in memory; without a managed KMS (likely on DigitalOcean) the KEK is a platform secret — host compromise exposes it |
| T13 | TB8 | Webhook spoofing / replay | Verify provider signatures; timestamp/replay window; idempotency keys | Provider-side compromise |
| T14 | AS3 | **Financial record tampering** or silent edits | Append-only ledgers; corrections as reversal entries; DB permissions prevent UPDATE/DELETE on ledger tables for app role; audit events; invoice number uniqueness constraint | DB superuser/insider — mitigated by backups and audit |
| T15 | AS3 | Arithmetic/tax errors (floating point, rounding, model-computed numbers) | Integer paise / NUMERIC; deterministic tax engine with unit tests; no LLM arithmetic | Incorrect tax configuration — professional review required |
| T16 | AS9 | **Cost abuse** — runaway AI/media generation, SMS/WhatsApp bulk sends, ad spend | Per-tenant quotas, budgets and alerts; rate limits on expensive endpoints; approval for bulk sends and ad spend; agent cost budgets and retry limits | Provider price changes |
| T17 | AS2 | Unlawful marketing / consent violations | Consent records, suppression list checked at send time, DLT template compliance, opt-out handling | Legal interpretation — legal review required |
| T18 | AS7 | Audit log tampering / repudiation | Append-only table, restricted role, actor/time/request ID recorded; optional hash chaining | Insider with DB superuser |
| T19 | Supply chain | Malicious or vulnerable dependency | Lockfiles; dependency audit in CI; minimal dependencies; pinned CI actions | Undisclosed vulnerabilities |
| T20 | AS10 | Backup exposure or unrecoverable data | Encrypted backups, restricted access, tested restore (Phase 9), point-in-time recovery where hosting supports | Untested until Phase 9 |
| T21 | TB1 | DoS / resource exhaustion | Edge WAF/DDoS from hosting provider; request size limits; pagination limits; queue back-pressure | Large volumetric attacks depend on provider |
| T22 | AS2 | PII in logs/agent traces | Structured logging with redaction; agent audit stores references, not raw PII | Developer error — review |
| T23 | TB2 | Account enumeration via registration/reset | Uniform responses and timing | Low |
| T24 | Lifecycle | Unapproved/suspended tenants accessing data | Business status checked in authorization middleware on every request; tenant cannot change its own status (column grants, T03) | Low |
| T32 | TB3 | **Auth credential exposure to tenant code paths** (session/MFA/password tables readable by request role) | Auth tables in schema `auth`, accessible only by role `lbgos_auth` used by the auth module (D-019) | Bugs in the auth module itself — auth test suite + pen test |
| T25 | TB3 | **search_path hijacking** in SECURITY DEFINER / trigger functions (an object in a caller-controlled schema shadows a table) | Every function pins `search_path`; `public` has no CREATE for app roles; definer functions minimal and reviewed | Found as a real defect in the schema draft (TR-0002) and fixed; add a lint/check in CI |
| T26 | TB3 | **Tenant context leakage across pooled connections** (setting from request A still set for request B) | Context set only with transaction-local `set_config(..., true)` inside each transaction via `withTenant()` (ADR-07); handlers never get raw connections; leakage test with negative control | Pooler misconfiguration (must be transaction mode) — retest when a pooler is added |
| T27 | TB2 | Approval abuse: self-approval of refunds/discounts/adjustments; approving a payload different from what was shown | Approval stores payload hash; edits invalidate approval; R3 no self-approval when another approver exists; audit | Sole-owner shops must self-approve (audited) |
| T28 | TB2 | Cross-tenant inference via uniqueness errors (e.g. "IMEI already exists" revealing another shop's stock) | IMEI uniqueness scoped per tenant (D-008); error messages never reference other tenants (T11) | Low |
| T29 | TB5 | Fraudulent or manipulated supplier invoices (via OCR) inflating stock/costs | OCR only creates drafts; posting requires `purchases.post` and review; code recomputes totals and shows mismatches; duplicate supplier invoice check | Collusion by an authorised insider — audit and reports |
| T30 | AS2 | Forged or missing consent evidence leading to unlawful messaging | Consent rows append-only with source/actor/time; suppression checked at send time | Owner may record consent falsely — legal responsibility stays with the shop; documented in terms |
| T31 | TB9 | Agent tool call with forged `business_id` / escalated scope from model output | Tools take tenant and user from session context only; per-tool permission check (FR-AGT-3) | Low |

## 5. Security requirements derived (ASVS-aligned areas)

V1 Architecture (this doc + ADRs) · V2 Authentication · V3 Session management · V4 Access control (incl. tenant isolation) · V5 Validation/encoding · V6 Cryptography · V7 Error handling & logging · V8 Data protection · V10 Malicious code / supply chain · V12 Files · V13 API & web services · V14 Configuration. Checklist with per-item status will be created in Phase 3 as `docs/ASVS_CHECKLIST.md`.

## 6. Mitigation status

| Mitigation area | Status | Evidence |
|---|---|---|
| T1 tenant isolation (DB layer: RLS, forced RLS, composite FKs, fail-closed context) | Designed; **prototyped and tested in schema draft** | TR-0002: T04–T08, T11, T20–T22, T25c, T26 |
| T1 tenant isolation (service layer, per-endpoint cross-tenant tests) | **Implemented + tested for existing routes** (membership + permission gate, 404 for non-members) | TR-0008 #5, #10 |
| T26 tenant context per transaction (`withTenant`) | **Prototyped and tested in spike** | TR-0003: 200 concurrent requests, no leakage after commit/rollback, negative control detects session-level leak |
| T15 allocation/numbering races | Prototyped and tested in spike (D-020) | TR-0003 |
| T8 platform admin cannot read tenant business data (DB role separation) | Designed; prototyped and tested | TR-0002: T19a–d, T29 |
| T14/T18 append-only ledgers, audit and immutable issued invoices | Designed; prototyped and tested | TR-0002: T12, T12c, T16–T16g, T18–T18d, T25b |
| T15 money/tax arithmetic invariants at DB level | Partially prototyped (total and reconciliation checks) | TR-0002: T15–T15c; tax engine unit tests pending (Phase 5) |
| T24 tenant cannot self-approve status | Prototyped and tested | TR-0002: T02, T03, T23 |
| T25 search_path pinning | Fixed in draft | TR-0002 (defect found and fixed) |
| T28 per-tenant IMEI uniqueness | Prototyped and tested | TR-0002: T09–T11 |
| T2 credential stuffing / brute force | **Implemented + tested** (per-account lockout, per-IP limits, MFA) | TR-0007 #12–16 |
| T3 session hijacking / fixation | **Implemented + tested** (HttpOnly/SameSite/Secure, rotation, server-side revocation, idle + absolute timeouts, token kept out of bodies) | TR-0007 #1–6 |
| T4 CSRF | **Implemented + tested** (SameSite=Lax + Origin check on state-changing API requests; Better Auth's own origin check) | TR-0007 #17 |
| T23 account enumeration | **Implemented + tested** (uniform sign-in failures, reset responses, lockout responses, duplicate sign-up) | TR-0007 #7, #9, #15 |
| T32 auth credential exposure to tenant code | **Implemented + tested** (schema `auth` + role separation; no credential columns in `lbg`) | TR-0005 T30*, TR-0007 #19 |
| T7 privilege escalation within tenant | **Implemented + tested** (deny-by-default permissions, R1/R2, no self role change, session revocation on role change) | TR-0008 #9 |
| T8 platform admin over-access | DB layer tested (TR-0002/5); API: platform routes only with platform permission + MFA; provisioning via definer function without tenant grants | TR-0008 #6–7 |
| T24 unapproved/suspended tenant access | **Implemented + tested** (access modes) | TR-0008 #2, #5, #11, #13 |
| All other threats (T5, T6, T9–T13, T16–T17, T19–T22, T27, T29–T31) | Specified in SRS / ADR; not implemented | — |

## 7. Known limitations and statements

- No system is 100% secure; this platform will not be described as "hack-proof".
- Authorized independent penetration testing is required before broad commercial launch.
- Legal requirements (GST, DPDP Act, TRAI DLT, WhatsApp/Meta/Google policies) need qualified review; nothing here constitutes verified compliance.

## 8. Data flows per workflow (Phase 1)

| Workflow (WORKFLOWS.md) | Boundaries crossed | Untrusted inputs | Key controls |
|---|---|---|---|
| §2 Registration → approval | TB1, TB2 | All form fields, uploaded logo | Email verification, rate limits, `register_application()` forces PENDING_APPROVAL, admin review, reasons recorded |
| §5 Purchase → stock-in | TB1, TB2, TB3 | Supplier invoice data, IMEIs | Permission `purchases.post`, IMEI validation (app + DB), totals recomputed, atomic posting, append-only movements |
| §6 POS sale → invoice → payment | TB1, TB2, TB3 | Cart contents, discounts, payment references | Server-side price/discount limits, tax engine, gapless numbering under lock, immutable issued invoice, allocation bounds |
| §7 OCR scan → review → post | TB1, TB4, TB5, TB6, TB9 | Image/PDF bytes, OCR text, model output | File checks, isolated worker, delimited untrusted text, schema-validated output, mandatory human review, drafts only |
| §8 Return → inspection → refund | TB1, TB2, TB3 | Return claims | Inspection state, `refunds.approve`, credit note + reversal entries |
| §9 Campaign → approval → send | TB2, TB6, TB8 | Generated content, provider webhooks | Grounding post-check, approval of exact version, consent/suppression at send time, quotas, signed webhooks, provider-confirmed status only |
| §10 Integration configuration | TB1, TB6, TB7 | Endpoint URLs, credentials | Re-authentication, SSRF-guarded client, write-only secrets, encryption, audit |
| §11–12 Agent runs and approvals | TB5, TB6, TB9 | Model output, tool arguments | Session-derived tenant/user, per-tool permission, approval for consequential actions, budgets, idempotency |
