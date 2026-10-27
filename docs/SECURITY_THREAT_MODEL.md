# Security Threat Model

Version: 0.1 (Phase 0 initial draft) — 2026-10-27
Method: asset/trust-boundary analysis with STRIDE per boundary; verification against an OWASP ASVS-aligned checklist (to be created in Phase 3).

**Status: design only. No control listed here is implemented or tested yet.** Each mitigation's status is tracked in the table in §6.

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
| T12 | TB7 | Integration secret leakage (logs, UI, frontend bundle, errors) | Envelope encryption or managed secret store; secrets write-only in UI (masked); log redaction; never returned by API; CI secret scanning | Compromised server process can read decrypted secrets in memory |
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
| T24 | Lifecycle | Unapproved/suspended tenants accessing data | Business status checked in authorization middleware on every request | Low |

## 5. Security requirements derived (ASVS-aligned areas)

V1 Architecture (this doc + ADRs) · V2 Authentication · V3 Session management · V4 Access control (incl. tenant isolation) · V5 Validation/encoding · V6 Cryptography · V7 Error handling & logging · V8 Data protection · V10 Malicious code / supply chain · V12 Files · V13 API & web services · V14 Configuration. Checklist with per-item status will be created in Phase 3 as `docs/ASVS_CHECKLIST.md`.

## 6. Mitigation status

| Mitigation area | Status | Evidence |
|---|---|---|
| All of T1–T24 | Planned (not implemented) | None — no code exists yet |

## 7. Known limitations and statements

- No system is 100% secure; this platform will not be described as "hack-proof".
- Authorized independent penetration testing is required before broad commercial launch.
- Legal requirements (GST, DPDP Act, TRAI DLT, WhatsApp/Meta/Google policies) need qualified review; nothing here constitutes verified compliance.
