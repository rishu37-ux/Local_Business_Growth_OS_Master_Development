-- Migration 0013 — selling (increment 5.3: FR-POS-1…3, FR-POS-5, FR-TAX-1,
-- FR-INV-5 AC2–4, FR-LED-1). Draft invoices are carts; issuing snapshots
-- everything needed to reprint the document as it was issued.

alter table lbg.invoice_lines
  add column tax_rate_id uuid,
  add column price_includes_tax boolean not null default true,
  add column cess_percent numeric(5,2) not null default 0 check (cess_percent between 0 and 100),
  add column gross_paise bigint not null default 0 check (gross_paise >= 0),
  -- Line discount as entered: PERCENT (value in basis points) or AMOUNT (paise).
  add column line_discount_kind text check (line_discount_kind in ('PERCENT', 'AMOUNT')),
  add column line_discount_value bigint check (line_discount_value >= 0),
  -- This line's share of the invoice-level discount (D-038); discount_paise is the line's own discount.
  add column invoice_discount_paise bigint not null default 0 check (invoice_discount_paise >= 0),
  add constraint invoice_lines_tax_rate_fk foreign key (business_id, tax_rate_id) references lbg.tax_rates(business_id, id),
  add constraint invoice_lines_discount_spec check ((line_discount_kind is null) = (line_discount_value is null));

-- Lines written before this migration: their value as entered, without discount detail.
update lbg.invoice_lines
   set gross_paise = discount_paise + case when price_includes_tax then line_total_paise else taxable_paise end;
alter table lbg.invoice_lines alter column gross_paise drop default;
-- The value relation of the tax engine (D-038): gross − discounts is the
-- line total for tax-inclusive prices and the taxable value otherwise (a Bill
-- of Supply line has no tax, so both are equal there).
alter table lbg.invoice_lines add constraint invoice_lines_value check (
  gross_paise - discount_paise - invoice_discount_paise
    = case when price_includes_tax then line_total_paise else taxable_paise end);

alter table lbg.invoices
  add column invoice_discount_kind text check (invoice_discount_kind in ('PERCENT', 'AMOUNT')),
  add column invoice_discount_value bigint check (invoice_discount_value >= 0),
  add column gross_paise bigint not null default 0 check (gross_paise >= 0),
  -- Seller and buyer details as printed (FR-PRN-1, FR-PRV-1 AC2): later profile changes do not alter it.
  add column party_snapshot jsonb,
  -- Over-limit discount approval (FR-POS-2 AC2): approved amount, approver and the draft content it covers.
  add column discount_approval_id uuid,
  add column discount_approved_by uuid,
  add column approved_discount_paise bigint check (approved_discount_paise >= 0),
  add column approved_content_sha256 text check (approved_content_sha256 ~ '^[0-9a-f]{64}$'),
  add column issued_by uuid,
  add column created_at timestamptz not null default now(),
  add column notes text check (length(notes) <= 1000),
  add constraint invoices_discount_spec check ((invoice_discount_kind is null) = (invoice_discount_value is null)),
  add constraint invoices_snapshot check (status in ('DRAFT', 'DISCARDED') or party_snapshot is not null);
create index invoices_customer_idx on lbg.invoices (business_id, customer_id, invoice_date);
create index invoices_status_idx on lbg.invoices (business_id, status, invoice_date);

alter table lbg.payments
  add column cash_tendered_paise bigint check (cash_tendered_paise >= 0),
  add column notes text check (length(notes) <= 500),
  add constraint payments_tendered check (cash_tendered_paise is null or (method = 'CASH' and cash_tendered_paise >= amount_paise));
create index payments_customer_idx on lbg.payments (business_id, customer_id, received_at);
