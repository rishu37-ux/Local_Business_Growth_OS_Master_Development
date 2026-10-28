# Phase 7 plan — API Hub, AI Creative Studio, selected official integrations

Version 1.0 — 2026-10-28. Master prompt §Development process, Phase 7; SRS FR-HUB-1…6, FR-AIC-1…5, FR-MSG-1…4, FR-SUB-3 (metering), NFR-18 (webhooks); ADR-13 (secrets), ADR-19 (providers); threat model T11 (SSRF), T12 (secret leakage), T13 (webhook spoofing), T16 (cost abuse), T10 (prompt injection). Acceptance criteria (AC) are fixed **before** coding. An increment counts as done only when its ACs are shown by executed checks recorded in `TEST_REPORT.md`. Every new endpoint gets permission, cross-tenant (404) and read-only-mode tests.

**No provider accounts or credentials exist** (Q4: WhatsApp Business Platform, SMS/DLT, email, LLM, image/video, payments, social are all `planned`). Phase 7 builds the hub, the security controls and the studio behind adapter interfaces, each with a mock adapter used in tests. A provider adapter written against a provider's documented API is **not** described as working until it has been tested against that provider with real credentials (status `tested`/`verified` in `INTEGRATIONS_STATUS.md`). Nothing in this phase spends money or contacts anyone.

## Increment 7.1 — Guarded outbound HTTP client (FR-HUB-5, T11)
**Status: done (TR-0033, D-054).**
- AC1: one client module for all outbound HTTP; a lint rule rejects `fetch`, `http(s).request`, `undici` and similar outside it (except the browser app and tests).
- AC2: `https` only (explicit allow-list for documented provider endpoints otherwise); port 443 or a provider-documented port; timeout default 15 s; response size limit.
- AC3: the host is resolved and **every** address checked; blocked: loopback, 0.0.0.0/8, private (10/8, 172.16/12, 192.168/16), link-local 169.254/16 (incl. metadata), CGNAT 100.64/10, multicast/reserved, IPv6 loopback, ULA fc00::/7, link-local fe80::/10, and IPv4-mapped/compatible forms; the connection uses the checked address (no re-resolution).
- AC4: at most 3 redirects, each re-checked.
- AC5: tests cover each blocked range, decimal/octal/hex/short IPv4 encodings, IPv6 forms and a DNS-rebinding scenario (first answer public, second private).

## Increment 7.2 — Secret store with envelope encryption (FR-HUB-3, ADR-13, T12)
- AC1: AES-256-GCM per secret with its own random data key, wrapped by a versioned KEK from the environment (never in the DB or repo); key rotation re-wraps data keys.
- AC2: secrets are write-only through the API; responses show only the last 4 characters and created/rotated dates.
- AC3: a dedicated DB role (or restricted columns) holds ciphertext; the app role cannot read plaintext columns because none exist.
- AC4: logs, errors, audit events and API responses never contain secret values (tests assert redaction for known field names and token patterns).
- AC5: changing a secret requires `integrations.manage` and a sign-in within 10 minutes; viewing the configuration and changing secrets are audited.

## Increment 7.3 — Integration records, lifecycle and health (FR-HUB-1, -2, -4, -6, WORKFLOWS §10)
- AC1: integration record: category (messaging, SMS, email, LLM, image/video, OCR, storage, payments, social), provider, auth method, base URL (through the guarded client's checks), scopes, model/service ID, owner (tenant or platform), usage limits, timeout, retry policy (max 3, exponential backoff), status.
- AC2: status machine `PLANNED → CONFIGURED → TESTED → VERIFIED`, `→ FAILED → CONFIGURED`, `→ DISABLED`, `DISABLED → CONFIGURED`, `→ REVOKED` (DB-enforced); `TESTED` only after a successful test connection, `VERIFIED` only after a real operation confirmed by the provider.
- AC3: "Test connection" performs a harmless provider-specific call through the adapter and records result and latency; enable/disable, rotate (new secret, then old revoked) and revoke are audited.
- AC4: health: last success, last error, 24-hour error rate, quota usage; usage and cost recorded per tenant for both tenant- and platform-owned integrations (FR-SUB-3 AC1).
- AC5: every category has an interface and a mock adapter; business logic depends only on interfaces; the messaging gate of 6.2 uses the configured messaging integration when one is `TESTED` or better, otherwise it stays "not configured".

## Increment 7.4 — Offers and the AI Creative Studio (FR-AIC-1, -2, -5, T10)
- AC1: offer records (discount, valid from/to, terms) with approval; an offer past its end date cannot be used.
- AC2: a generation is a job (status, provider, model, estimated cost before, recorded cost after where reported); without a configured provider the studio shows "not configured" and creates nothing.
- AC3: prompts are built from structured data only (chosen products' name/specs/price from the catalogue, an approved offer, business branding); untrusted text is passed as delimited data.
- AC4: a deterministic post-check flags every price, percentage, date and spec value in the generated text that is not in the inputs; a flagged draft cannot be approved until edited or each flag acknowledged by the approver.
- AC5: usage records per generation (tenant, user, provider, units, cost, status, error); generated assets stored privately with metadata (prompt reference, inputs, approval status); per-tenant quota with an 80 % alert and a hard stop at 100 %.

## Increment 7.5 — Approval of exact versions, variants, campaigns and scheduling (FR-AIC-3, -4, WORKFLOWS §9)
- AC1: publishing, bulk marketing sends (more than one recipient) and ad spend need `marketing.approve` approval of the exact content version (content hash); editing after approval returns the item to draft.
- AC2: campaign status machine (WORKFLOWS §9) DB-enforced; a campaign sends to a customer segment (tags, consent) through the 6.2 send-time gate, one message per recipient, and reports sent/blocked/failed counts truthfully.
- AC3: output formats 1:1, 4:5, 9:16, 16:9 where the provider supports them; per-platform text length checks.
- AC4: approved items can be scheduled and cancelled until sent; no paid-ad spend exists in this phase (FR-SUB-3 AC3 stays unbuilt and is shown as unavailable).

## Increment 7.6 — Selected official integrations (FR-MSG-1, -2, -4, NFR-18)
- AC1: WhatsApp Business Platform (Cloud API) adapter against the documented API: template messages only for business-initiated sends, template list sync where the API allows; tested with a local mock of the documented endpoints, **not** against Meta until credentials exist.
- AC2: inbound webhook endpoint: signature verification, replays older than 5 minutes rejected, idempotent processing; delivery/read statuses and STOP replies feed `recordProviderStatus` and the opt-out hook of 6.2.
- AC3: SMS DLT fields (entity ID, header, template ID per template) required before an SMS integration can be configured; promotional and transactional kept separate.
- AC4: every screen that shows an integration shows its real status (FR-MSG-4); `INTEGRATIONS_STATUS.md` is updated only with evidence.

## Increment 7.7 — Screens and Phase 7 exit test
- Screens: API Hub (integrations list, add/configure, write-only secret entry, test connection, health, rotate/revoke), Offers, Creative Studio (generate with a mock provider in tests, review flags, approve exact version, assets), Campaigns (segment, preview counts, approve, schedule, results). axe 0 serious/critical at 360/768/1280 px, no overflow, no CSP violations.

## Phase 7 exit
In a real browser, for a synthetic shop and with mock adapters only: the owner adds an LLM integration with a secret (shown only as its last 4 characters afterwards, never in logs, audit or responses), tests the connection (status `tested`), and an attempt to point a custom integration at a private or metadata address is refused; an approved offer and two products produce a generated caption whose invented price is flagged and blocks approval until fixed; the approved version is used in a campaign to a tag segment where a customer without consent and an opted-out customer are blocked at send time and the counts are shown; editing the approved text returns it to draft; a scheduled campaign can be cancelled; usage and cost are recorded per tenant and the quota stop works; a signed mock webhook updates a delivery status while an unsigned or replayed one is rejected; cross-tenant tests pass; CI is green.

Not in Phase 7 (by design): real provider traffic without accounts (Q4); paid-ad spend; agents (Phase 8).

## Inputs needed from the user (not blocking the increments above)
- Q4: which providers to connect first and their accounts (WhatsApp BSP or Cloud API, SMS/DLT registration, email sending domain, LLM and image providers). Until then adapters are tested with mocks only.
