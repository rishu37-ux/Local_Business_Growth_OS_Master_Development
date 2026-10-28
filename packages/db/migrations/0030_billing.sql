-- Migration 0030 — platform billing invoices with manual payment
-- (increment 10.2: FR-SUB-1 AC3, D-068). The platform bills a business for a
-- subscription period at the plan price of that time. No payment gateway
-- exists (Q4): a payment is only ever recorded by an admin, marked MANUAL.
-- GST on the platform's own invoice is not computed until the tax review (Q5).

create table lbg.billing_number_series (
  financial_year text primary key check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  next_number    integer not null default 1 check (next_number >= 1)
);

create table lbg.billing_invoices (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references lbg.businesses(id),
  subscription_id    uuid not null references lbg.subscriptions(id),
  financial_year     text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number    integer not null check (sequence_number >= 1),
  number             text not null unique check (number ~ '^LBG/[0-9]{4}-[0-9]{2}/[0-9]+$'),
  plan_code          text not null,
  plan_name          text not null,
  period_start       date not null,
  period_end         date not null,
  amount_paise       bigint not null check (amount_paise >= 0),
  tax_status         text not null default 'NOT_COMPUTED' check (tax_status = 'NOT_COMPUTED'),
  status             text not null default 'ISSUED' check (status in ('ISSUED', 'PAID', 'VOID')),
  issued_at          timestamptz not null default now(),
  issued_by          uuid not null,
  paid_on            date,
  payment_method     text check (payment_method = 'MANUAL'),
  payment_reference  text check (length(payment_reference) between 3 and 100),
  payment_recorded_by uuid,
  voided_at          timestamptz,
  void_reason        text check (length(void_reason) between 10 and 500),
  voided_by          uuid,
  unique (financial_year, sequence_number),
  check (period_end > period_start),
  check ((status = 'PAID') = (paid_on is not null and payment_method is not null
                               and payment_reference is not null and payment_recorded_by is not null)),
  check ((status = 'VOID') = (voided_at is not null and void_reason is not null and voided_by is not null))
);
create index billing_invoices_business_idx on lbg.billing_invoices (business_id, issued_at desc);

-- Issued content never changes; the only changes are ISSUED → PAID and ISSUED → VOID, once.
create function lbg.billing_invoice_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'billing invoices cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.status := 'ISSUED';
    new.issued_at := now();
    new.paid_on := null; new.payment_method := null; new.payment_reference := null; new.payment_recorded_by := null;
    new.voided_at := null; new.void_reason := null; new.voided_by := null;
    return new;
  end if;
  if old.status <> 'ISSUED' then
    raise exception 'billing invoice % is %', old.number, old.status using errcode = '22023';
  end if;
  if (new.id, new.business_id, new.subscription_id, new.financial_year, new.sequence_number, new.number,
      new.plan_code, new.plan_name, new.period_start, new.period_end, new.amount_paise, new.tax_status,
      new.issued_at, new.issued_by)
     is distinct from
     (old.id, old.business_id, old.subscription_id, old.financial_year, old.sequence_number, old.number,
      old.plan_code, old.plan_name, old.period_start, old.period_end, old.amount_paise, old.tax_status,
      old.issued_at, old.issued_by) then
    raise exception 'issued billing invoice content cannot change' using errcode = '22023';
  end if;
  if new.status = 'VOID' then
    new.voided_at := now();
  elsif new.status <> 'PAID' then
    raise exception 'invalid billing invoice status change' using errcode = '22023';
  end if;
  return new;
end
$$;
create trigger billing_invoices_guard before insert or update or delete on lbg.billing_invoices
  for each row execute function lbg.billing_invoice_guard();

alter table lbg.billing_invoices enable row level security;
alter table lbg.billing_invoices force row level security;
create policy billing_tenant_read on lbg.billing_invoices for select to lbgos_app
  using (business_id = lbg.current_business_id());
create policy billing_platform_all on lbg.billing_invoices to lbgos_platform
  using (true) with check (true);
grant select on lbg.billing_invoices to lbgos_app;
grant select, insert on lbg.billing_invoices to lbgos_platform;
grant update (status, paid_on, payment_method, payment_reference, payment_recorded_by, void_reason, voided_by)
  on lbg.billing_invoices to lbgos_platform;
grant select, insert, update on lbg.billing_number_series to lbgos_platform;
alter table lbg.billing_number_series enable row level security;
alter table lbg.billing_number_series force row level security;
create policy billing_series_platform on lbg.billing_number_series to lbgos_platform using (true) with check (true);
