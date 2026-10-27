-- Migration 0012 — customers and invoice series settings (increment 5.2:
-- FR-POS-4, FR-POS-5, FR-CRM-1 core fields, FR-CRM-2).

alter table lbg.customers
  add column address text check (length(address) <= 500),
  add column notes text check (length(notes) <= 2000),
  add column updated_at timestamptz not null default now(),
  add constraint customers_name_len check (length(name) between 1 and 120),
  -- GSTIN of a B2B customer: its first two digits are the state (place of supply).
  add constraint customers_gstin_state check (gstin is null or state_code is null or substr(gstin, 1, 2) = state_code);
create index customers_name_idx on lbg.customers (business_id, lower(name));

-- Invoice numbering settings (D-012, D-038). The format applies to series
-- created after it is saved (unused series of the current year are updated
-- too); a series keeps its format once it has issued a number.
alter table lbg.business_settings
  add column invoice_prefix text not null default '' check (invoice_prefix ~ '^[A-Z0-9/-]{0,6}$'),
  add column number_format text not null default '{PREFIX}{FY}/{SEQ:4}' check (length(number_format) between 7 and 40),
  -- D-016: cancellation allowed until the end of this many days after the invoice date (0 = same day).
  add column cancel_window_days smallint not null default 0 check (cancel_window_days between 0 and 30),
  add column round_off boolean not null default true;

alter table lbg.invoice_series
  add column number_format text not null default '{PREFIX}{FY}/{SEQ:4}' check (length(number_format) between 7 and 40);

-- Existing businesses keep the prefix they chose during setup.
insert into lbg.business_settings (business_id, invoice_prefix)
select distinct on (business_id) business_id, prefix from lbg.invoice_series order by business_id, financial_year desc
on conflict (business_id) do update set invoice_prefix = excluded.invoice_prefix;

grant select, insert, update on lbg.invoice_series to lbgos_app;
