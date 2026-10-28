# Phase 8 plan — Agents, approval workflows, monitoring, cost limits and advanced analytics

Version 1.0 — 2026-10-28. Master prompt §10 (AI agent orchestration) and §Development process, Phase 8; SRS FR-AGT-1…6, FR-RPT-1 (low/slow/dead stock, campaign results), FR-RPT-5, FR-SUB-1 AC2, FR-SUB-3 AC2, NFR-5 (background jobs), NFR-10 (observability); WORKFLOWS §11 (approval requests), §12 (agent run); threat model T10 (prompt injection), T16 (cost abuse), T22 (PII in agent traces), T27 (approval abuse), T31 (forged scope from model output). Acceptance criteria (AC) are fixed **before** coding. An increment counts as done only when its ACs are shown by executed checks recorded in `TEST_REPORT.md`. Every new endpoint gets permission, cross-tenant (404) and read-only-mode tests.

**No AI provider account exists** (Q4). Agents run through the hub's LLM integration (7.3); tests use the mock adapter, whose model IDs script tool calls. Agent behaviour with a real model is unverified until a provider is connected. Agents never compute money, tax or stock: they call deterministic tools, and consequential tools only create approval requests.

## Increment 8.1 — Agent runtime (FR-AGT-3, -5, -6, WORKFLOWS §12)
**Status: done in the API (TR-0040, D-061); screens in 8.6.**
- AC1: agent runs are records with the §12 status machine enforced in the database (`QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED | LIMIT_REACHED | AWAITING_APPROVAL`; `AWAITING_APPROVAL → RUNNING | COMPLETED`); each run has an idempotency key unique per business and user — the same key returns the same run.
- AC2: limits per run: timeout (default 120 s), max tool calls (default 20), max model retries (3), cost budget per run; and per business per day. Exceeding any limit stops the run as `LIMIT_REACHED` with the limit named; no further tool calls happen.
- AC3: every tool declares the permission it requires; a call succeeds only if the invoking user holds it in the current business (agents act as the user, never with more). Tenant and user come from the session; a tool argument naming another business (or any `businessId`) is rejected.
- AC4: model output is untrusted: only JSON tool calls matching the tool's schema are executed; anything else ends the step. Data from records reaches the model as delimited data, never as instructions.
- AC5: the run record holds user, agent, input references (IDs), each step (tool, validated arguments, result summary, error), proposals, approvals, cost — never secret values or full personal data (redaction test with a synthetic secret and a customer mobile).
- AC6: a user can cancel a queued, running or waiting run; a cancelled run makes no further calls.

## Increment 8.2 — Tools and the five agents (FR-AGT-1, -2, FR-RPT-5)
**Status: done in the API (TR-0040, D-061); screens in 8.6.**
- AC1: five agents — Inventory/OCR, Finance/Analytics, CRM reminder, Marketing/Creative, Business Growth — each with a documented purpose, tool list and permission requirements (in this plan's appendix and returned by the API).
- AC2: read tools return deterministic figures from the existing report and stock functions (with their definitions and data period); write tools never write records directly.
- AC3: FR-AGT-2 AC2 — a tool handler recomputes any value the model supplies (e.g. an expected quantity after an adjustment, a discount amount) and rejects the call when it differs.
- AC4: FR-RPT-5 — an agent's answer separates "Facts (from your records)" (the tool figures, with period and sources) from "Suggestions"; every number shown as a fact comes from a tool result; a number in the model's text that is not in a tool result is flagged (the 7.4 grounding check).

## Increment 8.3 — Human approval of agent proposals (FR-AGT-4, WORKFLOWS §11)
**Status: done in the API (TR-0040, D-061); screens in 8.6.**
- AC1: consequential tools (stock adjustment, bulk marketing/campaign, reminder auto-send, purchase posting proposal, price change) only create approval requests with the exact payload hash; the run moves to `AWAITING_APPROVAL`; nothing executes before a human with the domain permission approves (R3 applies).
- AC2: the approval shows the exact proposed action, its inputs and the expected effect computed deterministically (e.g. "stock of X goes from 4 to 3"); approval executes once (idempotent); rejection or expiry ends the proposal and the run continues or completes with that outcome recorded.

## Increment 8.4 — Job runner, monitoring and cost limits (NFR-5, NFR-10, FR-SUB-3 AC2, FR-SUB-1 AC2)
**Status: done in the API (TR-0041, D-062); screens in 8.6.**
- AC1: one job runner (single active instance via a database lock) runs due work on a schedule: scheduled campaigns and queued messages (7.5), daily reminder runs (6.3), agent run timeouts, approval expiry, trial-end notices (7, 3, 1 days — FR-SUB-1 AC2) and integration health; each job is idempotent, recorded with status, duration and error, and safe to run twice.
- AC2: per-plan monthly quotas for AI units, messages and storage (FR-SUB-3 AC2): 80 % alert (notification), hard stop at 100 % unless the owner opted into overage with a cap; the stop is enforced where the usage happens.
- AC3: monitoring for the platform admin and the owner: job runs and failures, integration health and error rates, usage against quotas, agent runs by status; no tenant data in platform views beyond counts (D-015).

## Increment 8.5 — Advanced analytics (FR-RPT-1 remainder)
- AC1: low, slow and dead stock (definitions: below reorder level; no sale in 60 days; no sale in 180 days with stock on hand), sales trend by week, top products, repeat-customer rate, campaign results (messages, sent, delivered, read, blocked, failed per campaign) — each with its definition, exact values on a seeded dataset, CSV export.

## Increment 8.6 — Screens and Phase 8 exit test
- Screens: Assistants (start a run, see steps, facts vs suggestions, proposals, cancel), Approvals with expected effects, Usage and limits, Monitoring, the new analytics in Reports. axe 0 serious/critical at 360/768/1280 px, no overflow, no CSP violations.

## Phase 8 exit
In a real browser, for a synthetic shop with mock adapters only: the owner asks the Inventory assistant about low stock and sees facts with their period and source; the assistant proposes a stock adjustment, which waits for approval with its expected effect and executes once after approval; a model-supplied wrong quantity is rejected by the tool; a forged business ID in a tool argument is rejected; a run that exceeds its tool-call limit stops as `LIMIT_REACHED`; a user cancels a run; the daily budget stops a further run; the job runner sends a due scheduled campaign and records the job; usage against the plan quota is shown with the 80 % alert; the run record contains no secret or full mobile number; another business sees none of it; CI is green.

Not in Phase 8 (by design): real AI provider traffic (Q4); autonomous execution of consequential actions; paid-ad spend.

## Appendix — the five agents

| Agent | Purpose | Tools (permission) | Proposals (need approval) |
|---|---|---|---|
| Inventory/OCR assistant | Stock questions, low/slow stock, scan review help | `stock_levels` (inventory.view), `low_stock` (inventory.view), `pending_scans` (ocr.scan) | stock adjustment (inventory.adjust.request → approved by inventory.adjust.approve) |
| Finance/Analytics assistant | Sales, margin, receivables, cash explained with definitions | `sales_summary` (reports.sales.view), `margin` (reports.financial.view), `receivables` (customer_ledger.view), `cash_received` (reports.financial.view) | none |
| CRM reminder assistant | Who is due a reminder and why | `reminders_due` (customers.view), `customer_summary` (customers.view) | reminder run with auto-send (marketing.approve) |
| Marketing/Creative assistant | Caption drafts from catalogue and offers | `catalogue_facts` (catalogue.view), `offers` (marketing.draft), `draft_caption` (marketing.draft — creates a Studio draft only) | campaign send (marketing.approve, marketing.send) |
| Business Growth assistant | Weekly overview and suggestions | `sales_summary`, `low_stock`, `campaign_results` (each with its own permission) | none |
