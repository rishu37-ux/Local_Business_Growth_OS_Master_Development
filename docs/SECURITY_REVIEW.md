# Security review — OWASP ASVS 4.0 level 2-aligned (Phase 9.4)

Version 1.0 — 2026-10-28. Scope: the code in this repository (API, web app, database migrations, CI) as of Phase 9. Method: each ASVS chapter relevant to this system walked against the code and the executed tests in `TEST_REPORT.md`; the threat model (`SECURITY_THREAT_MODEL.md` §6) updated with the result. This is an **internal, self-performed review**. It is not an independent penetration test, and it does not make the system "secure" or "hack-proof". An authorised external penetration test is still required before broad commercial launch (§7 of the threat model).

Status values: **Met** (implemented and shown by an executed test), **Partly** (implemented in part, or implemented but shown only in part), **Not met**, **N/A** (does not apply to this system). Evidence points to `TEST_REPORT.md` entries (TR-xxxx #n) or code.

## Findings of this review

| ID | Severity | Finding | Status |
|---|---|---|---|
| SR-01 | Medium | The public webhook routes (`/api/webhooks/*`) had no request rate limit. Each request costs a database lookup and an HMAC check, and 9.4 AC3 asks for rate limits on webhooks. | **Fixed:** 300 requests per source address per minute, 429 with `Retry-After`, warning logged (`routes/webhooks.ts`); test `channels.db.test.ts` "webhook rate limit" (TR-0044 #9). The counter is in-process, which is enough for the single-instance deployment (ADR-03); several instances would need a shared store. |
| SR-02 | Low | `PATCH …/categories/:id` and `…/brands/:id` with an empty body returned 500 (an empty `SET`), found by the isolation sweep. It revealed nothing, but a 5xx on bad input is an error-handling defect (V7). | **Fixed:** the schema requires a name or a status, so the request now gets a 400 (TR-0044 #2). |
| SR-03 | Medium | No online breached-password check (FR-AUTH-2 AC4). Only a local list of common passwords and context rules is applied. | **Open.** Owner: the user decides whether outbound calls to a k-anonymity breach service are acceptable. Hosting is needed first (Q2). |
| SR-04 | Medium | No malware scanning of uploads. The status is shown as NOT_CONFIGURED. | **Open.** Owner: the user. A scanner choice is part of Q4. |
| SR-05 | Medium | The OCR/file worker runs in a worker thread with heap and time limits but shares the process, including its network access. There is no OS-level sandbox. | **Open.** Owner: hosting decision (Q2) — a separate container with no network. |
| SR-06 | Medium | The key-encryption key (KEK) for integration secrets is a platform secret held in the environment, not in a managed KMS. | **Open.** Owner: hosting decision (Q2). Accepted residual risk in ADR-13. |
| SR-07 | Medium | Backups and point-in-time recovery are not configured anywhere real. Restore was tested only against a throwaway cluster (TR-0044 #5–7). | **Open.** Owner: hosting decision (Q2). The procedure is in `DEPLOYMENT_RUNBOOK.md`. |
| SR-08 | Medium | `main` has no branch protection, so CI is not enforced before a merge. | **Open.** Owner: the repository owner (a GitHub setting). |
| SR-09 | Low | The audit log is append-only (DB grants), but it has no hash chaining. | **Accepted** for now (the threat model lists chaining as optional). |
| SR-10 | Info | No independent penetration test has been done. | **Open** before broad launch. Owner: the user. |

**No finding rated high remains open.** No high-severity finding was found in code during this review. The two code findings (SR-01, SR-02) are fixed, with tests.

## V1 Architecture, design and threat modelling
| Item | Status | Evidence |
|---|---|---|
| 1.1 Threat model kept per workflow, updated with the build | Met | `SECURITY_THREAT_MODEL.md` §4, §6, §8 (updated in this review) |
| 1.2 Every route declares its access rule; the app refuses to start otherwise | Met | `app.ts` onRoute check; TR-0008, `app.test.ts` "refuses unknown permission keys" |
| 1.4 Access control enforced server-side, in two layers (API and DB) | Met | TR-0002, TR-0005, TR-0044 #1–4 |
| 1.5 Untrusted input (OCR, model output, provider data) treated as data | Met | TR-0015 #12–15, TR-0040 |
| 1.14 Separation of privileges by DB role (app, platform, auth, secrets, owner) | Met | TR-0002 T19*, TR-0007 #19, TR-0034 |

## V2 Authentication
| Item | Status | Evidence |
|---|---|---|
| 2.1 Password length 10–128, common/context passwords refused | Met | TR-0007 #10 |
| 2.1.7 Breached-password check | **Not met** | SR-03 |
| 2.4 Password storage (argon2id, m=19 MiB, t=2) | Met | TR-0007 #11 |
| 2.2 Brute-force protection: account lockout, per-IP limits | Met | TR-0007 #15–16 |
| 2.5 Reset: uniform responses, hashed single-use token, 30-min expiry, revokes sessions | Met | TR-0007 #6–8 |
| 2.8 TOTP MFA required for owners and platform admins; backup codes single-use | Met | TR-0007 #12–14 |
| Re-authentication for sensitive actions (secrets, erasure, export) | Met | TR-0018, TR-0031, TR-0034 |

## V3 Session management
| Item | Status | Evidence |
|---|---|---|
| 3.2 New token on sign-in and MFA; no fixation | Met | TR-0007 #2 |
| 3.3 Idle (12 h; platform 30 min) and absolute (7 days) timeouts; sign-out revokes | Met | TR-0007 #3–4 |
| 3.4 Cookie HttpOnly, SameSite=Lax, Secure with `__Secure-` prefix in production | Met | TR-0007 #1 |
| 3.5 Token never in a response body | Met | TR-0007 #1 |
| 3.7 Sessions revoked on password change and role change | Met | TR-0007 #6, TR-0008 #9 |

## V4 Access control
| Item | Status | Evidence |
|---|---|---|
| 4.1 Deny by default; permission catalogue; read-only and suspended modes | Met | TR-0008 |
| 4.2 Tenant isolation on **every** business route (route table sweep: other owner, foreign IDs, signed out, platform) | Met | TR-0044 #1–3 |
| 4.2 Every tenant table: RLS enabled and forced, with a policy (60 tables) | Met | TR-0044 #4 |
| 4.3 Platform admin cannot read tenant data | Met | TR-0002 T19*, TR-0008 #6–7 |
| CSRF: SameSite plus an Origin check on state-changing requests | Met | TR-0007 #17 |
| Approvals: payload hash, no self-approval when another approver exists | Met | TR-0013 #9–11, TR-0019, TR-0040 |
| Platform support reads tenant data only under an owner's time-boxed grant; read-only; every request audited (added in Phase 10) | Met | TR-0045 #1–6 |

## V5 Validation, sanitisation and encoding
| Item | Status | Evidence |
|---|---|---|
| 5.1 Strict schemas (unknown fields refused) on every route | Met | `app.test.ts` "rejects unknown fields"; Zod strict objects |
| 5.2 No raw HTML from user data; escaped print templates; CSV formula guard | Met | TR-0023 #2, TR-0024 #9 |
| 5.3 Parameterised SQL only (Kysely; string-built SQL not used) | Met | code review; lint rules |
| 5.5 SSRF: one guarded outbound client; raw HTTP blocked by lint | Met | TR-0033 |

## V6 Stored cryptography
| Item | Status | Evidence |
|---|---|---|
| 6.2 AES-256-GCM envelope encryption, a key per secret, bound to its row | Met | TR-0034 |
| 6.4 Key management in a KMS | **Partly** | SR-06 |
| 6.3 Randomness from the platform CSPRNG (`crypto.randomUUID`, `randomBytes`) | Met | code review |

## V7 Error handling and logging
| Item | Status | Evidence |
|---|---|---|
| 7.1 Generic errors with a request ID; no stack traces or internals | Met | `app.test.ts` "returns a generic 500" |
| 7.1 No 5xx on bad input across the whole route table | Met (after SR-02) | TR-0044 #2 |
| 7.2 Security events logged (RLS denial, lockout, webhook limit) | Met | `app.ts`, TR-0007 #16 |
| 7.3 Redaction of secrets and personal data in logs, audit and agent traces | Met | `app.test.ts` "redacts planted secrets", TR-0034, TR-0040 |
| 7.3 Audit log append-only for the app role | Met | TR-0002 T18* (hash chaining: SR-09) |

## V8 Data protection
| Item | Status | Evidence |
|---|---|---|
| 8.1 `Cache-Control: no-store` on API responses and downloads | Met | TR-0044 #8 |
| 8.3 Personal-data export and erasure, owner-only with re-authentication | Met | TR-0031 |
| 8.3 Card numbers refused in payment references | Met | TR-0019 #12 |
| Backups encrypted and restorable | **Partly** | restore drill TR-0044 #5–7; production backups SR-07 |

## V9 Communications
| Item | Status | Evidence |
|---|---|---|
| 9.1 TLS for clients; HSTS (1 year, subdomains) | **Partly** | HSTS header on every response (TR-0044 #8); TLS depends on the domain and hosting (Q2, Q6) |
| 9.2 Outbound TLS only, port 443, certificate checks | Met | TR-0033 |

## V10 Malicious code and supply chain
| Item | Status | Evidence |
|---|---|---|
| 10.3 Lockfile, frozen install, dependency audit (high/critical fails CI), secret scan | Met | `.github/workflows/ci.yml`; CI runs |
| CI actions pinned | Met | `ci.yml` |

## V11 Business logic
| Item | Status | Evidence |
|---|---|---|
| 11.1 Money, tax and stock computed deterministically; model output never trusted for figures | Met | TR-0017, TR-0040 (VALUE_MISMATCH) |
| 11.1 Limits on costly actions: plan quotas, agent budgets, rate limits | Met | TR-0040, TR-0041 |
| Race conditions on sale, payment and numbering | Met | TR-0003, TR-0019, TR-0020 |

## V12 Files and resources
| Item | Status | Evidence |
|---|---|---|
| 12.1 Size, page and pixel limits; request body limit 1 MiB (413), webhooks 256 KiB | Met | TR-0015, TR-0044 #8 |
| 12.2 File type by magic bytes; random keys; private storage | Met | TR-0015 |
| 12.5 Downloads as attachments with `nosniff`; PDFs sandboxed | Met | TR-0015, TR-0044 #8 |
| Malware scanning | **Not met** | SR-04 |
| Processing isolation | **Partly** | SR-05 |

## V13 API and web services
| Item | Status | Evidence |
|---|---|---|
| 13.1 Same-origin API; Origin check; JSON only | Met | TR-0007 #17 |
| 13.2 Webhooks: signature over the raw body, 5-minute window, applied once, rate-limited | Met | TR-0038 #9–12, TR-0044 #9 |

## V14 Configuration
| Item | Status | Evidence |
|---|---|---|
| 14.4 Security headers on **every** response type (JSON, HTML, asset, download, 400/401/404/413/429) | Met | TR-0044 #8–9 |
| 14.4 CSP without `unsafe-inline` (one hashed style) | Met | TR-0006, browser tests |
| 14.1 Production start refused without required config (email provider, secrets) | Met | TR-0007 #22 |
| 14.2 Proxy trust limited to N hops | Met | `app.test.ts` |
| Branch protection on `main` | **Not met** | SR-08 |
