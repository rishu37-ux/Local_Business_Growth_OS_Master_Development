# Decision Log

Format: ID · date · status (Proposed / Accepted / Superseded) · decision · rationale · alternatives considered.
"Proposed" decisions are working assumptions; they become "Accepted" in the Phase 2 architecture decision record.

---

### D-001 · 2026-10-27 · Accepted
**Decision:** Treat the project as greenfield and keep the master prompt file unchanged at the repository root.
**Rationale:** Phase 0 inspection found no code, manifests, migrations, tests or CI — only the prompt file.
**Alternatives:** None applicable.

### D-002 · 2026-10-27 · Accepted
**Decision:** Project memory lives in `/docs/*.md` committed to git, plus a root `CLAUDE.md` that instructs every new session to read it first.
**Rationale:** Required by prompt §13; the cloud session container is ephemeral, so only committed files survive.
**Alternatives:** AI-platform personal memory (rejected — not durable or reviewable).

### D-003 · 2026-10-27 · Proposed
**Decision:** Modular monolith in TypeScript: React + TypeScript + Tailwind frontend, TypeScript API backend, PostgreSQL database, background job queue.
**Rationale:** Recommended by the prompt; one deployable unit is simpler and cheaper for a pilot; module boundaries keep later extraction possible.
**Alternatives:** Microservices (rejected for now — premature); non-TS backend (rejected — one language across stack reduces cost).
**To decide in Phase 2:** specific frameworks (e.g., Fastify/NestJS/Hono; Vite SPA vs Next.js), ORM/query builder, queue technology (e.g., Postgres-backed queue vs Redis), monorepo tooling.

### D-004 · 2026-10-27 · Proposed
**Decision:** Enforce tenant isolation in two layers — service-layer scoping and PostgreSQL Row-Level Security keyed on `business_id` via a per-transaction setting.
**Rationale:** Prompt requires DB-level enforcement where supported; PostgreSQL 16 supports RLS and was verified runnable in this environment.
**Alternatives:** Schema-per-tenant / database-per-tenant (higher operational cost, harder migrations for many small shops; may revisit for large tenants).

### D-005 · 2026-10-27 · Proposed
**Decision:** Money stored as integer paise (or `NUMERIC`), never floating point; ledgers append-only with reversal entries.
**Rationale:** Financial accuracy and auditability requirements (prompt §2, §4, §5).
**Alternatives:** Float (rejected — rounding errors).

### D-006 · 2026-10-27 · Proposed
**Decision:** Defaults: INR, `Asia/Kolkata`, financial year April–March, all configurable per business.
**Rationale:** Pilot is an Indian mobile shop; prompt references GST and DLT.
**Alternatives:** None — values remain configurable.

### D-007 · 2026-10-27 · Accepted
**Decision:** Local development and tests use native PostgreSQL 16 binaries, not Docker, in this environment.
**Rationale:** Docker daemon is unavailable in the cloud session; PostgreSQL 16 server binaries are present and were verified to run.
**Alternatives:** Docker Compose (still the documented option for developer machines; CI may use service containers).

---
## Phase 1 decisions (2026-10-27)

### D-008 · 2026-10-27 · Accepted
**Decision:** IMEI uniqueness is enforced **per tenant**: within one business, an IMEI (whether stored as IMEI 1 or IMEI 2) can belong to only one serialized-unit record. The same IMEI may exist in different businesses. A unit that is sold and later bought back (trade-in/return) keeps its single record; its history is in the stock ledger.
**Rationale:** The same physical handset can legitimately pass through two shops (resale, trade-in). A platform-wide uniqueness check would reveal to one tenant that another tenant holds the device — a cross-tenant information leak (threat T1).
**Alternatives:** Global uniqueness (rejected — leaks data, blocks legitimate resale); a platform-only duplicate report for fraud review (deferred; would need privacy/legal review).

### D-009 · 2026-10-27 · Accepted
**Decision:** `SUSPENDED` business: Shop Owner can sign in with read-only access and data export; staff cannot sign in; no new transactions, messages, campaigns or agent actions. `REJECTED`: no business-data access (none exists). `CHANGES_REQUESTED`/`PENDING_APPROVAL`: applicant can view/edit only their application.
**Rationale:** Suspension must stop operations but must not hold the shop's own records (invoices needed for tax filing) hostage.
**Alternatives:** Full lock-out (rejected — tax/legal record access concern).

### D-010 · 2026-10-27 · Accepted
**Decision:** Subscription status is a separate dimension: `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELLED` (runs to period end), `EXPIRED`. `PAST_DUE` keeps full access for a configurable grace period (default 7 days); after that, and in `EXPIRED`, the tenant is **read-only + export** (same restrictions as suspension, but without changing business status). Effective access = most restrictive of business status and subscription status.
**Rationale:** Prompt requires separating account status from payment status.
**Alternatives:** Auto-suspending on non-payment (rejected — conflates the two states).

### D-011 · 2026-10-27 · Accepted
**Decision:** MFA (TOTP minimum; WebAuthn/passkeys preferred where available) is **mandatory** for Platform Admins and Shop Owners. Owners enrol during the setup wizard; a business cannot become `ACTIVE` until the owner has MFA. Staff MFA is optional; an owner can require it for all staff.
**Rationale:** Owners can manage users, integrations (credential access), refunds and tax settings — privileged per prompt §11.
**Alternatives:** Optional owner MFA (rejected — owner accounts are high-value targets).

### D-012 · 2026-10-27 · Accepted
**Decision:** Invoice numbers are **gapless and consecutive** per business, per series and per financial year, allocated inside the posting transaction under a row lock. Format is configurable (prefix + FY token + sequence), limited to 16 characters using letters, digits, `-` and `/`. Cancelled invoices keep their number and remain visible.
**Rationale:** Indian GST invoice rules (as commonly understood: unique, consecutive, ≤16 chars per financial year) — **must be confirmed by a tax professional** (Q5).
**Alternatives:** Database sequences (rejected — sequences leave gaps on rollback).

### D-013 · 2026-10-27 · Accepted
**Decision:** Tax computation rules (deterministic, integer paise):
- Each product/variant is flagged tax-inclusive (default for retail MRP pricing) or tax-exclusive.
- Line taxable value is computed after line discount. For inclusive prices: `taxable = round_half_up(gross × 100 / (100 + rate))`, `tax = gross − taxable`.
- Intra-state supply: tax split into CGST and SGST halves; if the half is an odd paisa, CGST takes `floor(tax/2)` and SGST the remainder. Inter-state: IGST = full tax. Place of supply defaults to the shop's state for over-the-counter sales and is editable when a customer GSTIN/state is entered.
- Optional invoice-level round-off to the nearest rupee, shown as a separate "Round off" line.
- Rates are data (versioned with effective dates), never constants in code.
**Rationale:** Deterministic, testable, and consistent with how retail GST invoices are typically presented — **subject to tax-professional review**.
**Alternatives:** Floating-point or per-invoice-only tax calculation (rejected).

### D-014 · 2026-10-27 · Accepted
**Decision:** Payment allocation: a payment is allocated to the invoices the user selects; if none are selected, it is allocated **oldest-outstanding-invoice first (FIFO by invoice date, then invoice number)**. Any unallocated remainder becomes a customer advance (credit balance). Walk-in fully-paid sales may have no customer; any sale leaving a balance due requires a customer record with a mobile number.
**Rationale:** Deterministic and explainable to shop owners; prompt §5 requires deterministic, tested allocation.
**Alternatives:** Proportional allocation (rejected — confusing for small shops).

### D-015 · 2026-10-27 · Accepted
**Decision:** Platform Admin database access uses a **separate database role** that has grants only on platform tables (businesses, applications, plans, subscriptions, platform audit). It has no grants on tenant business tables (products, invoices, customers…). Tenant requests use an application role subject to RLS keyed on `app.business_id`.
**Rationale:** Enforces threat T8 (admin over-access) at the database level, not just in code.
**Alternatives:** One role with an "is admin" session flag (rejected — a single bug or injected setting would expose all tenant data).

### D-016 · 2026-10-27 · Accepted
**Decision:** Cancelling an issued invoice is allowed only with permission `invoices.cancel`, a reason, and within a configurable window (default: same calendar day in the business timezone). Outside the window, corrections use a credit note. Both create reversal stock movements and ledger entries; nothing is deleted.
**Rationale:** Auditable corrections (prompt §4) while staying configurable for compliance review.
**Alternatives:** Free editing of issued invoices (rejected).

### D-017 · 2026-10-27 · Accepted
**Decision:** Cost of goods sold and stock valuation: serialized units use their **actual purchase cost**; non-serialized items use **moving weighted average cost**, recomputed on each purchase posting and snapshotted on each sale movement.
**Rationale:** Phones are individually costed and often bought at different prices; accessories are fungible. Snapshotting makes historical margins reproducible.
**Alternatives:** FIFO layers for non-serialized items (more complex; may revisit if accountant requires).
