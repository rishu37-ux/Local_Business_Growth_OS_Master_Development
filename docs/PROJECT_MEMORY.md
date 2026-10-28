# Project Memory

Last updated: 2026-10-28 · Current phase: **Phase 7 in progress — API Hub, AI Creative Studio, integrations; see PHASE7_PLAN.md** (Phase 6 complete, CI #40)
Branch: `claude/quirky-dirac-vm3o46`

## Current state

- **Phases 0–4 are complete** (Phase 4 exit: TR-0016, CI #21 green). Phase 5 plan: `PHASE5_PLAN.md`; increment 5.1 (pure tax engine with 100 % branch coverage, allocation, number formats, metric definitions) done (TR-0017). Increment 5.2 (customers module, numbering service with FY rollover and concurrency test, `freshAuth` re-authentication for tax settings, migration 0012) done (TR-0018). Increment 5.3 (draft sales/held carts, discount limits with approval requests, minimum price, atomic issue with stock, units, payments, allocations, ledger; concurrent IMEI sale test; migration 0013) done (TR-0019, D-040). Increment 5.4 (later payments, advance, refunds, reversals, statements, migration 0014) done (TR-0020, D-041). Increment 5.5 (cancellation within the window, credit and debit notes, returns into inspection, migration 0015) done (TR-0021, D-042). Portal redesign (design system, app shell, side menu; D-043, TR-0022) done at the user's request. Increment 5.6 (print templates A4/A5/80/58 mm, PDF via headless Chromium, print settings, migration 0016) done (TR-0023, D-044); manual printer tests not done. Increment 5.7 (reports with exact seeded values, CSV/XLSX/PDF exports, Reports screen) done (TR-0024, D-045). Increment 5.8 (POS, Invoices and Customers screens; Phase 5 exit browser test passes; search p95 42 ms over 10,000 variants in the dev container) done (TR-0025, D-046). **Phase 5 complete** (CI #32 green). Phase 6 plan: `PHASE6_PLAN.md`. Increment 6.1 (optional customer fields, warranty recorded on sale lines, owned units with warranty end dates, customer export with chosen fields; migration 0017) done (TR-0026, D-047). Increment 6.2 (consent records, suppression list, message status machine in the DB, send-time gate under a per-address lock, quiet hours, provider adapter defaulting to *not configured*; migration 0018) done (TR-0027, D-048) — no message has been sent to anyone. Increment 6.3 (reminder settings and templates, idempotent runs for birthday/warranty/service/payment, approved auto-send through the gate; migration 0019) done (TR-0028, D-049). Increment 6.4 (optional expenses module with receipts and reversal corrections, expenses report and operating-profit estimate; migration 0020) done (TR-0029, D-050). Increment 6.5 (dashboard tiles from the report functions, permission per tile) done in the API (TR-0030, D-051). Increment 6.6 (erase personal data — owner, reason, re-auth, anonymise/suppress/withdraw/cancel/redact, invoices keep snapshots; tenant ZIP export; migration 0021) done in the API (TR-0031, D-052). Increment 6.7 (screens: overview tiles and data download, customer profile with details/owned phones/consent/messages/erase, customer export, Reminders, Expenses, operating profit in Reports; Phase 6 exit browser test passes) done (TR-0032, D-053). **Phase 6 complete** (CI #40 green). Phase 7 plan: `PHASE7_PLAN.md`; increment 7.1 (guarded outbound HTTP client and no-raw-HTTP lint rule) done (TR-0033, D-054). Increment 7.2 (secret store: envelope encryption, `lbgos_secrets` role, write-only API, rotation and revocation, KEK rotation; migration 0022) done (TR-0034, D-055). Increment 7.3 (API Hub: integration records and status machine, test connection, health, per-tenant usage and quota, retries, mock adapters per category, custom REST; migration 0023) done (TR-0035, D-056). Increment 7.4 (offers, AI Creative Studio with structured prompts, deterministic grounding post-check, exact-version approval, images; migration 0024) done (TR-0036, D-057) — tested with the mock adapter only. Increment 7.5 (campaigns to tag segments with DB-hashed exact-version approval, R3, scheduling, cancel, sends through the 6.2 gate with truthful counts; migration 0025) done (TR-0037, D-058) — sending is refused until a messaging provider is configured; nothing has been sent to anyone. Increment 7.6 (WhatsApp Cloud API adapter, DLT-aware SMS adapter with a platform JSON contract, approved/registered templates only with purpose separation, signed webhooks with 5-minute window and idempotency, STOP opt-outs, system actor; migration 0026) done (TR-0038, D-059) — tested only against local mocks of the documented endpoints; no provider account exists. Increment 7.7 (API Hub, Offers, Creative Studio and Campaigns screens; side menu scrolls; test harness clears rate-limit counters) done and the **Phase 7 exit passed** in a real browser with mock adapters only (TR-0039, D-060). **Phase 7 complete** (CI #53/#54 green). Phase 8 plan: `PHASE8_PLAN.md`; increments 8.1–8.3 (agent runtime with DB status machine, limits and budgets, cancel; tools with per-tool permissions, tenant from session, recomputation; five assistants; proposals as approval requests with expected effects; masked records; migration 0027) done in the API (TR-0040, D-061) — tested with the mock model only. Increment 8.4 (job runner with lock and idempotent steps, trial and quota notices, per-plan AI/message/storage quotas with overage cap, owner and platform monitoring; migration 0028) done in the API (TR-0041, D-062). Increment 8.5 (weekly sales trend, repeat-customer rate, campaign results reports) done (TR-0042, D-063). Increment 8.6 (Assistants and Usage and monitoring screens, effects in Approvals, new report sections) done and the **Phase 8 exit passed** in a real browser with mock adapters only (TR-0043, D-064). **Phase 8 complete** (CI #60 green). Phase 9 plan: `PHASE9_PLAN.md`; the tenant-isolation sweep over every route of the app's route table, the backup/restore drill (also in CI), the accessibility sweep over 24 screens at three widths, the security headers check for every response type and the ASVS L2-aligned review (`SECURITY_REVIEW.md`; webhook rate limit SR-01 and an empty-change 500 SR-02 fixed; no high finding open) are done (TR-0044, D-065, D-066). The pilot is blocked on Q1–Q6 (`PILOT_CHECKLIST.md`). **Phase 9 complete** (CI #61 green). Phase 10 plan: `PHASE10_PLAN.md`; owner-granted, time-boxed, audited, view-only support access (migration 0029, D-067), platform billing invoices per financial year with manual payment only (migration 0030, D-068), the Billing and support screen, the billing section on the platform page, and the Phase 10 exit browser test are done (TR-0045); onboarding guide, support procedures, pricing validation plan and commercial readiness checklist are written. **All phases 0–10 are built and tested with synthetic data and mock providers; what remains needs the user's inputs (`NEXT_STEPS.md` §What is left).** **Phase 11 (requested by the user after Phase 10; D-069, D-070, `PHASE11_PLAN.md`):**
- **Shop branding:** logo and colour on invoices from the issue-time snapshot, and the logo in the dashboard.
- **The shop's public website:** at `/s/<address>`, server-rendered, with order requests and no online payment.
- **Online channels:** website plus marketplace connectors, with one stock. Available-to-sell = stock − reservations − buffer. Pushes are queued by a DB trigger and sent by the job runner; orders reserve stock until billed in POS.

All of this is done and tested with the mock connector (TR-0046). **Amazon and Flipkart are not connected:** they need the shop's seller accounts and API approval (Q4).

**Phase 12 (requested by the user after Phase 11; D-071, `PHASE12_PLAN.md`): camera + real OCR.**
- **Engine.** Tesseract 5 is the real OCR engine (`OCR_ENGINE=tesseract`; `scripts/dev-local.sh` turns it on when installed).
- **Camera.** A camera control (live preview, or a phone photo) is on four screens:
  - Point of sale: an IMEI photo adds that phone to the cart.
  - Catalogue: a box photo becomes a new product.
  - Scans: a supplier bill photo becomes a purchase draft; posting it adds the stock.
  - Stock: an IMEI or barcode photo finds the item and its status.
- **Tested** in Chromium with a fake camera and generated images (TR-0047). Accuracy on real photos is **not measured**.
- Phase 4 plan with acceptance criteria: `PHASE4_PLAN.md`. Increment 4.1 (catalogue, versioned tax rates, migration 0007, `@lbgos/modules/catalogue`) is implemented and tested (TR-0011). Increment 4.2 (suppliers, purchases draft → post → reverse, stock buckets and levels, migration 0008, `@lbgos/modules/purchasing` + `inventory`) is implemented and tested (TR-0012). Increment 4.3 (stock reads, reconciliation, adjustments, generic approvals module with R3, migration 0009) is implemented and tested (TR-0013). Increment 4.4 (inspection outcomes, low/slow/dead/reorder reports, code lookup, migration 0010) is implemented and tested (TR-0014). Increment 4.5 (uploads, isolated OCR jobs with a **mock** adapter, deterministic parsing, review → draft purchase, migration 0011, `@lbgos/modules/ocr`) is implemented and tested (TR-0015). Increment 4.6 (web screens for catalogue, tax rates, suppliers, purchases, stock, scans/review, approvals; `member` pseudo-permission; Phase 4 exit browser test) is implemented and tested (TR-0016).
- Phases 0–3 detail: PR #1 (through increment 3.6) was merged into `main` by the repository owner. Increments 3.7a/3.7b and the Phase 3 exit records are on the working branch, with `main` merged back in (merge commit `890d97c`; a rebase plus force-push was refused by the session's permission policy). These commits are not yet in `main`; no new PR has been opened.
- **What exists:** a pnpm monorepo, run with Node type stripping (no build step for server code).
  - `@lbgos/domain`: IMEI, GSTIN, financial years, permissions, access modes.
  - `@lbgos/db`: SQL migrations 0001–0006, `withTenant`, locking helpers.
  - `@lbgos/modules`: auth on Better Auth, tenancy, onboarding, audit, notifications.
  - `@lbgos/api`: Fastify app with sessions, RBAC, lifecycle, setup, invitations, platform admin.
  - `@lbgos/web`: React SPA served same-origin.
- **CI** on GitHub Actions runs lint, format, typecheck, build, unit, DB and browser tests, audit and secret scan.
- **Phase 3 exit test:** passes in Chromium (TR-0010): register → approve → owner MFA → setup → live → invite Billing staff.
- **Not done yet:** nothing is deployed and no external integration is connected. The production start is refused because no email provider is configured (Q6).

## Document index

| File | Purpose |
|---|---|
| `PROJECT_MEMORY.md` | This file — state, decisions summary, next action, blockers |
| `NEXT_STEPS.md` | Ordered actionable tasks |
| `DECISION_LOG.md` | Dated decisions D-001…D-070 |
| `SRS.md` | **Authoritative requirements**: 100 requirements, each with acceptance criteria; metric definitions; out-of-scope list |
| `WORKFLOWS.md` | State machines and core flows (§1 business … §12 agent run) |
| `ROLES_PERMISSIONS.md` | Permission keys, default roles, RBAC rules R1–R5 |
| `DATA_MODEL.md` | Entities, constraints, RLS design, known draft limitations |
| `data-model/schema_draft.sql`, `data-model/schema_draft_test.sql` | Design-level DDL and its tests (not production migrations) |
| `ARCHITECTURE_DECISION_RECORD.md` | ADR-01…19: runtime, tooling, layout, API, web, DB, tenant context, jobs, auth, authz, storage, PDF, secrets, edge, observability, testing, CI, hosting, providers |
| `COST_MODEL.md` | Indicative hosting costs (third-party prices; vendor sites blocked here), scenarios for 1/10/100 shops |
| `BACKLOG.md` | Ordered Phase 3–5 backlog with SRS references and definition of done |
| `PHASE3_PLAN.md` | Phase 3 increments, acceptance criteria and exit status/deferrals |
| `PHASE4_PLAN.md` | Phase 4 increments 4.1–4.6, acceptance criteria, exit status/deferrals |
| `PHASE5_PLAN.md` | Phase 5 increments 5.1–5.8, acceptance criteria and exit status |
| `PHASE6_PLAN.md` | Phase 6 increments 6.1–6.7, acceptance criteria and exit status |
| `PHASE7_PLAN.md` | Phase 7 increments 7.1–7.7 and acceptance criteria |
| `PHASE8_PLAN.md` | Phase 8 increments 8.1–8.6, acceptance criteria, the five agents |
| `PHASE9_PLAN.md` | Phase 9 increments 9.1–9.5, acceptance criteria and status |
| `SECURITY_REVIEW.md` | ASVS 4.0 L2-aligned checklist V1–V14 with evidence; findings SR-01…SR-10 |
| `PILOT_CHECKLIST.md` | Conditions before a real shop uses the system; go/no-go rule |
| `PHASE10_PLAN.md` | Phase 10 increments 10.1–10.3, acceptance criteria and status |
| `ONBOARDING_GUIDE.md` | Owner and staff guides following the real screens; go-live check |
| `SUPPORT_PROCEDURES.md` | Contacts (placeholders), severities, triage, support access, recovery, incidents, never-list |
| `PRICING_VALIDATION.md` | Pilot prices, cost per shop, hypotheses, interview guide, decision rule |
| `COMMERCIAL_READINESS.md` | What must be true before charging shops; owners and status |
| `PHASE11_PLAN.md` | Phase 11 (branding, shop website, online channels): increments, acceptance criteria, status |
| `PHASE12_PLAN.md` | Phase 12 (camera and Tesseract OCR for sale, product, purchase and stock): increments, acceptance criteria, status |
| `REQUIREMENTS_BLUEPRINT.md` | Phase 0 blueprint (superseded in detail by SRS) |
| `REQUIREMENTS_TRACEABILITY.md` | Requirement → implementation → test evidence (generated from SRS headings) |
| `SECURITY_THREAT_MODEL.md` | Assets, boundaries, threats T1–T31, per-workflow data flows, mitigation status |
| `TEST_REPORT.md` | TR-0001…TR-0046 — only executed checks |
| `INTEGRATIONS_STATUS.md` | Integration statuses (no secrets) |
| `DEPLOYMENT_RUNBOOK.md` | Environments, local checks, deployment design, backup and the drilled restore procedure, rollback, incident outline |
| `CHANGELOG.md` | Changes by version/date |
| `PHASE0_INSPECTION_REPORT.md` | What existed at start; environment facts; open questions Q1–Q6 |

Scripts: `scripts/check-docs.sh` (memory docs present, secret-pattern screen, requirement coverage via `scripts/check_traceability.py`), `scripts/with-throwaway-pg.sh <cmd>` (throwaway PostgreSQL + schema draft), `scripts/test-schema-draft.sh` (schema checks). Spike: `cd spikes/tenant-context && npm ci && npm test`.

## Key decisions

Accepted: D-001 greenfield · D-002 repo memory · D-007 native PostgreSQL locally · D-008 IMEI unique per tenant · D-009 suspension = owner read-only + export · D-010 separate subscription states, read-only after grace · D-011 MFA mandatory for platform admins and owners · D-012 gapless invoice numbers ≤16 chars per FY · D-013 deterministic tax rules (paise, CGST/SGST split, inclusive pricing) · D-014 FIFO payment allocation, remainder = advance · D-015 separate DB role for platform admin · D-016 invoice cancellation window, else credit note · D-017 actual cost (serialized) / weighted average (non-serialized).
Phase 2: D-003…D-006 confirmed · D-018 TypeScript 6 pin (typescript-eslint doesn't support TS 7) · D-019 Better Auth self-hosted, `auth` schema + role, Argon2id override (conditional on Q3) · D-020 locking rules (UPDATE…RETURNING for numbers; FOR UPDATE invoice + advisory lock payment) · D-021 no Redis in pilot · D-022 DigitalOcean BLR1 + Cloudflare (proposed, needs Q2).
Stack (ADR): Node 24 LTS target (≥22.22 supported) · pnpm workspaces · Fastify 5 + Zod 4 · React 19 + Vite 8 SPA, React Router, TanStack Query, Tailwind 4, React Aria Components · Kysely + pg, SQL migrations via Kysely Migrator · graphile-worker · Vitest, fast-check, Playwright + axe.

## Blockers / open questions

Nothing blocks the start of Phase 3 (scaffold, CI, migrations, tenancy, RBAC are provider-independent). Inputs needed:
- **Q2 hosting/budget** — confirm D-022 and a monthly ceiling (suggested US$100). Needed before staging is created.
- **Q3 auth approach** — default is self-hosted Better Auth (D-019); say so if you prefer a managed provider. Needed before backlog item F-06.
- Q1 pilot shop details, Q4 integration accounts, Q5 tax-professional review, Q6 domain (needed for email and Cloudflare).
- Legal review of DPDP Act / CERT-In / SMS-WhatsApp consent obligations before the pilot.
- **Environment network policy** blocks vendor sites (digitalocean.com, aws.amazon.com, supabase.com, neon.com); prices in `COST_MODEL.md` are unverified third-party figures.
- **Repository settings** (branch protection, required CI checks) must be enabled by the owner once CI exists.

## Unverified items

- All tax/invoice rules (D-012, D-013, FR-PRN-1 field list) are unverified with a tax professional.
- Hosting prices, PITR windows and KMS availability for the chosen provider are unverified (vendor sites blocked).
- Security controls are implemented and tested in code (see `SECURITY_REVIEW.md`), but nothing is deployed: no production TLS, backups, WAF or monitoring exist, and no external penetration test has been done.
- Performance/availability targets (NFR-14/15) are targets, not measurements.

## Exact next action

Phases 11 and 12 are done locally. Next, ask the user for a few real (consented) photos of boxes and bills from the pilot shop to measure OCR accuracy, and for the Amazon/Flipkart seller accounts and API approval (Q4) before building marketplace-specific adapters. Then, ask the user for the rest, in this order:
1. Q1 pilot shop.
2. Q2 hosting and budget.
3. Q6 domain.
4. Q4 accounts, starting with email.
5. Q5 tax professional.
6. Legal counsel.
7. Q3 confirmation.
8. Branch protection on `main`.
9. Plan contents and support contacts.

The full list is in `NEXT_STEPS.md` §What is left. While waiting, the developer backlog there (CSV import, other browsers, screen reader, remaining screens) can be done.
