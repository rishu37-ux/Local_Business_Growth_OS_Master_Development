# Roles and Permissions Catalogue

Version 1.0 (Phase 1) — 2026-10-27. Implements FR-RBAC-1. Status: **Specified, not implemented.**

## 1. Principles

- **Deny by default.** A user has no permission unless granted through a role in that business.
- Permissions are checked **server-side** on every protected endpoint and job. The UI may hide controls but is never the enforcement point.
- Permissions are scoped to one business (membership). A person who belongs to two shops has independent memberships.
- Permission changes are owner-only (`users.manage` + `roles.manage`), require recent re-authentication, and are audited (FR-AUD-1).
- Some permissions carry **limits** (e.g. maximum discount). Exceeding a limit creates an approval request rather than failing silently.
- Effective access is further restricted by business and subscription status (D-009, D-010): in read-only mode, only `*.view`, `reports.*.view` and `*.export` permissions apply.
- AI agents act **as the requesting user** with a subset of that user's permissions, never more (FR-AGT-3).

## 2. Platform-level roles

| Role | Description |
|---|---|
| `PLATFORM_ADMIN` | Manages applications/approvals, plans and pricing, platform integrations, platform health and usage. MFA mandatory (D-011). Has **no** access to tenant business records (D-015). |
| `PLATFORM_SUPPORT` *(optional, later)* | Read-only view of application/subscription status; tenant data access only via owner-granted, time-boxed support session (FR-SUP-1). Implemented in Phase 10 for platform admins: under an active grant they get the view-only set `SUPPORT_PERMISSIONS` and every non-GET request is refused (D-067). |

Platform permissions: `platform.applications.review`, `platform.businesses.manage` (create, suspend, reinstate), `platform.plans.manage`, `platform.integrations.manage`, `platform.usage.view`, `platform.audit.view`, `platform.admins.manage`.

## 3. Business-level permission keys

| Key | Meaning | Sensitive? |
|---|---|---|
| `business.settings.view` / `business.settings.manage` | Shop profile, branding, preferences | manage: yes |
| `tax.settings.manage` | Tax profile, rates, HSN defaults, invoice series | **Yes — consequential** |
| `users.view` / `users.manage` | Invite, deactivate staff; reset staff MFA | manage: yes |
| `roles.manage` | Create/edit roles, assign permissions | **Yes** |
| `audit.view` | View business audit log | yes |
| `subscription.manage` | Change plan, payment method, cancel | yes |
| `catalogue.view` / `catalogue.manage` | Categories, brands, products, variants, selling prices | |
| `catalogue.cost.view` | See purchase/cost prices and margins | **Yes — commercially sensitive** |
| `inventory.view` | Stock levels, units, movements | |
| `inventory.receive` | Receive stock against a purchase | |
| `inventory.adjust.request` | Propose a stock adjustment / damage write-off | |
| `inventory.adjust.approve` | Approve adjustments and corrections | **Yes — consequential** |
| `inventory.transfer` | Transfer between locations (when multi-location enabled) | |
| `returns.inspect` | Record inspection outcome and release returned stock | |
| `suppliers.view` / `suppliers.manage` | Supplier records | |
| `purchases.view` / `purchases.create` / `purchases.post` | Purchase drafts and posting to stock/ledger | post: yes |
| `ocr.scan` | Upload/capture scans and review extractions | |
| `pos.sell` | Create and issue sale invoices | |
| `pos.discount` *(limit: max % and max ₹ per invoice)* | Apply discounts up to the limit | |
| `pos.price_override` | Sell below configured minimum selling price | yes |
| `sales.return.create` | Accept a customer return (goods enter inspection) | |
| `refunds.approve` | Approve refunds (cash/UPI out) | **Yes — consequential** |
| `invoices.cancel` | Cancel an issued invoice within the cancellation window | **Yes** |
| `credit_notes.create` | Issue credit/debit notes | yes |
| `payments.record` | Record payments received, advances | |
| `customers.view` / `customers.manage` | CRM records | |
| `customers.export` | Export customer lists | **Yes — personal data** |
| `customer_ledger.view` | Customer balances and statements | |
| `expenses.manage` | Record business expenses (if enabled) | |
| `reports.sales.view` | Sales volume, payment-method, returns reports | |
| `reports.financial.view` | Margin, profit, stock valuation, receivables | yes |
| `reports.export` | Export reports (CSV/PDF/XLSX) | yes |
| `marketing.draft` | Create campaign drafts and AI creative drafts | |
| `marketing.approve` | Approve content for publishing / bulk send / ad spend | **Yes — consequential** |
| `marketing.send` | Execute approved sends/publishing/schedules | yes |
| `integrations.view` / `integrations.manage` | View status / configure, rotate, revoke credentials | manage: **yes** |
| `agents.use` | Invoke AI assistants (within the user's own permissions) | |
| `approvals.decide` | Decide approval requests (still requires the specific domain permission, e.g. `refunds.approve`) | yes |
| `support.grant` | Grant time-boxed platform support access | yes |

## 4. Default role templates

Created for every new business; owner may copy and edit (except Owner).

| Permission group | Owner | Manager | Billing | Inventory | Accountant (view) |
|---|:-:|:-:|:-:|:-:|:-:|
| business.settings.view | ✓ | ✓ | | | ✓ |
| business.settings.manage, tax.settings.manage, roles.manage, users.manage, subscription.manage, integrations.manage, support.grant | ✓ | | | | |
| users.view, audit.view | ✓ | ✓ | | | ✓ (audit) |
| catalogue.view | ✓ | ✓ | ✓ | ✓ | ✓ |
| catalogue.manage | ✓ | ✓ | | ✓ | |
| catalogue.cost.view | ✓ | ✓ | | | ✓ |
| inventory.view | ✓ | ✓ | ✓ | ✓ | ✓ |
| inventory.receive, inventory.adjust.request, returns.inspect | ✓ | ✓ | | ✓ | |
| inventory.adjust.approve | ✓ | ✓ | | | |
| suppliers.*, purchases.view/create, ocr.scan | ✓ | ✓ | | ✓ | (view) |
| purchases.post | ✓ | ✓ | | | |
| pos.sell, payments.record, sales.return.create | ✓ | ✓ | ✓ | | |
| pos.discount limit | unlimited | 10% / ₹5,000 | 2% / ₹500 | — | — |
| pos.price_override, invoices.cancel, credit_notes.create, refunds.approve | ✓ | ✓ | | | |
| customers.view | ✓ | ✓ | ✓ | | ✓ |
| customers.manage | ✓ | ✓ | ✓ (create/edit basic) | | |
| customers.export | ✓ | | | | |
| customer_ledger.view | ✓ | ✓ | ✓ | | ✓ |
| reports.sales.view | ✓ | ✓ | | | ✓ |
| reports.financial.view, reports.export | ✓ | ✓ | | | ✓ |
| marketing.draft | ✓ | ✓ | | | |
| marketing.approve, marketing.send | ✓ | | | | |
| integrations.view, agents.use | ✓ | ✓ | (agents) | (agents) | (agents) |
| approvals.decide | ✓ | ✓ | | | |

Default discount limits above are **initial suggestions**, editable per business.

## 5. Rules

- R1 The Owner role cannot be deleted or have permissions removed; every business must have at least one active Owner.
- R2 A user cannot grant a permission they do not hold, and cannot raise their own limits.
- R3 A user cannot approve their own approval request when the business has ≥2 users holding the required permission (self-approval allowed only for sole owners, and audited as such).
- R4 Deactivating a user revokes all of their sessions immediately.
- R5 Role/permission changes take effect on the next request (no long-lived permission caches beyond 60 s).
