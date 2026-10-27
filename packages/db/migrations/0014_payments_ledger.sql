-- Migration 0014 — later payments, advance refunds, payment reversals and
-- statements (increment 5.4: FR-LED-1, FR-LED-2, D-014, D-020, D-041).
-- New error code: LB019 refund exceeds the payment's unallocated amount, or
-- the payment is reversed.

-- Money paid back to a customer out of the advance held on one payment.
create table lbg.payment_refunds (
  business_id   uuid not null,
  id            uuid not null default gen_random_uuid(),
  payment_id    uuid not null,
  customer_id   uuid not null,
  amount_paise  bigint not null check (amount_paise > 0),
  method        text not null check (method in ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER')),
  reference     text check (reference !~ '[0-9]{13,19}'),   -- never full card numbers
  reason        text not null check (length(reason) between 10 and 500),
  refunded_at   timestamptz not null default now(),
  recorded_by   uuid,
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, payment_id) references lbg.payments(business_id, id),
  foreign key (business_id, customer_id) references lbg.customers(business_id, id)
);
create index payment_refunds_payment_idx on lbg.payment_refunds (business_id, payment_id);
create trigger payment_refunds_append_only before update or delete on lbg.payment_refunds
  for each row execute function lbg.forbid_mutation();

-- A reversal says why it was made (it is audited as well).
alter table lbg.payments
  add constraint payments_reversal_reason check (reverses_payment_id is null or length(notes) >= 10);
create index payments_reverses_idx on lbg.payments (business_id, reverses_payment_id)
  where reverses_payment_id is not null;
create index customer_ledger_customer_idx on lbg.customer_ledger_entries (business_id, customer_id, created_at);

-- Backstop for FR-LED-2 AC2: a payment's allocations plus its refunds never
-- exceed its amount (replaces the 0001 version, which ignored refunds).
create or replace function lbg.payment_allocations_bounds() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
declare
  v_inv_alloc bigint;
  v_inv_total bigint;
  v_pay_alloc bigint;
  v_pay_amount bigint;
begin
  select coalesce(sum(amount_paise), 0) into v_inv_alloc from payment_allocations
   where business_id = new.business_id and invoice_id = new.invoice_id;
  select total_paise into v_inv_total from invoices
   where business_id = new.business_id and id = new.invoice_id;
  select coalesce((select sum(amount_paise) from payment_allocations
                    where business_id = new.business_id and payment_id = new.payment_id), 0)
       + coalesce((select sum(amount_paise) from payment_refunds
                    where business_id = new.business_id and payment_id = new.payment_id), 0)
    into v_pay_alloc;
  select amount_paise into v_pay_amount from payments
   where business_id = new.business_id and id = new.payment_id;
  if v_inv_alloc > v_inv_total or v_inv_alloc < 0 or v_pay_alloc > v_pay_amount or v_pay_alloc < 0 then
    raise exception 'allocation out of bounds (invoice %/%; payment %/%)',
      v_inv_alloc, v_inv_total, v_pay_alloc, v_pay_amount using errcode = 'LB005';
  end if;
  return null;
end
$$;

create function lbg.payment_refunds_bounds() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
declare
  v_used bigint;
  v_amount bigint;
begin
  if exists (select 1 from payments where business_id = new.business_id and reverses_payment_id = new.payment_id)
     or exists (select 1 from payments where business_id = new.business_id and id = new.payment_id
                                          and reverses_payment_id is not null) then
    raise exception 'a reversed payment cannot be refunded' using errcode = 'LB019';
  end if;
  select coalesce((select sum(amount_paise) from payment_allocations
                    where business_id = new.business_id and payment_id = new.payment_id), 0)
       + coalesce((select sum(amount_paise) from payment_refunds
                    where business_id = new.business_id and payment_id = new.payment_id), 0)
    into v_used;
  select amount_paise into v_amount from payments where business_id = new.business_id and id = new.payment_id;
  if v_used > v_amount then
    raise exception 'refund exceeds the advance held on the payment (%/%)', v_used, v_amount using errcode = 'LB019';
  end if;
  return null;
end
$$;
create constraint trigger payment_refunds_bounds after insert on lbg.payment_refunds
  for each row execute function lbg.payment_refunds_bounds();

alter table lbg.payment_refunds enable row level security;
alter table lbg.payment_refunds force row level security;
create policy tenant_isolation on lbg.payment_refunds to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.payment_refunds to lbgos_app;
revoke execute on function lbg.payment_refunds_bounds() from public;
