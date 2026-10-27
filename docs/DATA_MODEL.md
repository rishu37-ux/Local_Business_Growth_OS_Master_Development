# Logical Data Model

Version 1.1 (Phase 2 update) — 2026-10-27
Status: **Specified. Core tables exist as a design-level SQL draft that has been tested against PostgreSQL 16 (TR-0002).** This is not a production migration; Phase 3 turns it into versioned migrations.

- Draft DDL: `docs/data-model/schema_draft.sql`
- Draft tests (67 checks): `docs/data-model/schema_draft_test.sql`, run with `scripts/test-schema-draft.sh`

## 1. Tenancy approach (D-004, D-015)

| Aspect | Design |
|---|---|
| Tenant key | `business_id uuid` on every tenant-owned table |
| Tenant context | API sets `app.business_id` and `app.user_id` with `set_config(..., true)` (transaction-local) from the authenticated session — never from request input |
| Fail closed | Unset context → `current_business_id()` is NULL → policies match no rows; inserts rejected |
| RLS | Enabled **and forced** on every table except `plans` (no tenant/personal data); verified by meta-test T26 |
| Cross-tenant references | Parents have `unique (business_id, id)`; children use **composite foreign keys** `(business_id, x_id)` so a row can never reference another tenant's row (T08) |
| DB roles | `lbgos_owner` (owns objects, migrations, BYPASSRLS — never used by the running app); `lbgos_app` (tenant requests, NOBYPASSRLS, cannot disable RLS — T20); `lbgos_platform` (platform admin: grants on platform tables only — T19) |
| Pre-tenant operations | `register_application()` and `auth_find_user_by_email()` are minimal SECURITY DEFINER functions with pinned `search_path` |
| Connection pooling note | Transaction-local settings require the pooler to run in transaction mode with settings applied inside each transaction (verify with chosen stack in Phase 3) |

## 2. Entity overview

### Platform
| Table | Purpose | Key constraints |
|---|---|---|
| `businesses` | Tenants | Status CHECK + transition trigger (WORKFLOWS §1, T02); tenant can update only display_name/timezone/FY (column grants, T03) |
| `business_status_events` | Approval/status history | Append-only |
| `users` | Global identities | `email` unique (citext); `password_hash` Argon2id only; RLS: self + members of current business (T22) |
| `plans`, `subscriptions` | Commercial | Subscription status CHECK (D-010) |
| `audit_events` | Audit log | Append-only; `scope` TENANT/PLATFORM with separate visibility (T25) |

### Membership and RBAC
`memberships` (unique business+user), `roles` (unique name per business, `is_system` for Owner), `role_permissions` (permission key format check; `limits` jsonb for discount limits), `membership_roles`.

### Catalogue and inventory
| Table | Notes |
|---|---|
| `categories`, `brands` | Brand name unique case-insensitively per business |
| `tax_rates` | Versioned (`effective_from`/`effective_to`), rate 0–100 (FR-TAX-2) |
| `products` | Model; `is_serialized` |
| `product_variants` | RAM/storage/colour, SKU unique, barcode unique when present, prices in paise, HSN format, `avg_cost_paise` (D-017) |
| `suppliers` | GSTIN format check |
| `purchases` | DRAFT/POSTED/REVERSED/DISCARDED; total = taxable + tax; one posted purchase per supplier invoice number unless override reason |
| `serialized_units` | Current status projection (WORKFLOWS §4); unit cost |
| `serialized_unit_imeis` | PK `(business_id, imei)` → one namespace for IMEI 1 & 2 per business (D-008, T10); Luhn CHECK (T09) |
| `stock_movements` | **Append-only** ledger (T12); serialized ±1 (T13); REVERSAL ⇔ `reverses_movement_id`; each movement reversible once (T28); reason required for ADJUSTMENT/CORRECTION/DAMAGE |

### Customers
`customers` (mobile E.164, unique per business; `erased_at` for anonymisation), `customer_consents` (append-only; current consent = latest row per channel+purpose).

### Sales and ledger
| Table | Notes |
|---|---|
| `invoice_series` | Per business, document type, FY, prefix; `next_number` incremented under row lock (D-012) |
| `invoices` | One table for TAX_INVOICE, BILL_OF_SUPPLY, CREDIT_NOTE, DEBIT_NOTE. Number ≤16 chars `[A-Za-z0-9/-]`, unique per business+type+FY (T14). Total = taxable + taxes + round-off (T15). IGST xor CGST/SGST. Issue requires lines to reconcile (T15c). Issued = immutable except → CANCELLED with reason ≥10 chars (T16). Never deleted. Notes must reference original invoice |
| `invoice_lines` | Snapshot of HSN, rate, taxable, taxes, COGS; changes only while invoice is DRAFT (T16b); serialized line qty = 1 |
| `payments` | Append-only; amount > 0; reference cannot contain 13–19 consecutive digits (T24); reversals by `reverses_payment_id` |
| `payment_allocations` | Append-only; negative amount only as reversal; trigger keeps Σ per invoice ≤ total and Σ per payment ≤ amount (T17) |
| `customer_ledger_entries` | Append-only; signed amounts (debit +, credit −) with sign enforced by type (T18) |
| `approval_requests` | Payload + SHA-256; decision fields required once decided |

### Specified but not yet in the SQL draft (Phase 3–8)
`sessions`, `mfa_factors`, `recovery_codes`, `password_reset_tokens`, `invitations`, `business_settings`, `setup_progress`, `locations`, `purchase_lines`, `supplier_ledger_entries`, `stock_levels` (projection — see §3), `returns`/`inspections`, `expenses`, `uploads`, `ocr_jobs`, `ocr_extractions`, `integrations`, `integration_secrets` (encrypted; restricted role), `usage_records`, `offers`, `campaigns`, `generated_assets`, `messages`, `message_events`, `suppression_list`, `reminders`, `agent_runs`, `agent_tool_calls`, `notifications`, `support_grants`, `platform_invoices`, `jobs`.

## 3. Derived data

- **Stock on hand** = Σ `stock_movements.quantity_delta` per variant (and status per unit). A `stock_levels` projection table will be maintained in the same transaction for fast reads and rebuilt/reconciled by a scheduled job (FR-INV-4 AC3). The projection is not a ledger and may be rebuilt; the ledger is the source of truth.
- **Invoice payment status** derived from allocations (UNPAID/PARTIALLY_PAID/PAID).
- **Customer balance** = Σ ledger entries.

## 4. Conventions

- Money: `bigint` paise; never float (NFR-8). Rates: `numeric(5,2)`. Quantities: `numeric(12,3)`.
- Time: `timestamptz` (UTC); business-date fields (`invoice_date`) are `date` in business timezone.
- IDs: UUID (`gen_random_uuid()`); human-facing numbers (invoice numbers, SKUs) are separate columns.
- Status columns: `text` + CHECK (easier to evolve than enums).
- Custom error codes from triggers: `LB001` append-only, `LB002` invalid status transition, `LB003` immutable document, `LB004` totals don't reconcile, `LB005` allocation out of bounds. API maps them to 409/422.
- Every SECURITY DEFINER and trigger function pins `search_path` (a missing pin was a real defect found and fixed during TR-0002).

## 5. Known limitations of the draft (to resolve in Phase 3–5)

1. Negative-stock prevention and unit-status ↔ movement consistency are enforced in application code (with row locks), not yet by DB triggers.
2. The allocation-bounds trigger is only a backstop: TR-0003 showed two concurrent transactions can over-allocate without locks. Rule D-020: lock the invoice `FOR UPDATE` and the payment with `pg_advisory_xact_lock` (`FOR UPDATE` on `payments` is impossible by design — it needs UPDATE privilege). Verified in the spike; must be re-tested in the Phase 5 implementation.
3. Gapless numbering depends on the application incrementing `invoice_series.next_number` in the issuing transaction. The spike (TR-0003) verified it with 30 concurrent issuers and 6 rollbacks; the Phase 5 implementation must keep that test.
4. `customers.mobile_e164` uniqueness assumes one customer per mobile per business; shared family numbers may need a relaxation later.
5. Indexes for reporting queries, and partitioning for `audit_events`/`stock_movements`, are not designed yet.
6. Superuser/DB-owner access bypasses RLS by design; protection there relies on operational controls (T14/T18 residual risk).
