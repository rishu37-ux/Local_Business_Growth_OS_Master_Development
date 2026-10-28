-- Migration 0020 — expenses (increment 6.4: FR-EXP-1, FR-RPT-1 operating
-- profit estimate, D-050). Optional module, off by default. Expenses are
-- append-only; a correction is a reversal entry plus, if needed, a new entry.
-- New error code: LB021 an expense reversal does not match the original.

alter table lbg.business_settings
  add column expenses_enabled boolean not null default false;

create table lbg.expenses (
  business_id          uuid not null references lbg.businesses(id),
  id                   uuid not null default gen_random_uuid(),
  expense_date         date not null check (expense_date >= date '2000-01-01'),
  category             text not null check (category in ('RENT', 'SALARIES', 'ELECTRICITY', 'INTERNET_PHONE',
                         'TRANSPORT', 'REPAIRS_MAINTENANCE', 'MARKETING', 'SUPPLIES', 'BANK_CHARGES', 'TAXES_FEES',
                         'OTHER')),
  -- Positive for an expense; a reversal carries the negated amount of the original.
  amount_paise         bigint not null check (amount_paise <> 0 and abs(amount_paise) <= 10000000000000),
  method               text not null check (method in ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER')),
  reference            text check (length(reference) <= 60 and reference !~ '[0-9]{13,19}'),  -- never card numbers
  notes                text check (length(notes) <= 500),
  upload_id            uuid,                         -- receipt or bill (private storage)
  reverses_expense_id  uuid,
  reason               text check (length(reason) between 10 and 500),
  recorded_by          uuid not null,
  created_at           timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, upload_id) references lbg.uploads(business_id, id),
  foreign key (business_id, reverses_expense_id) references lbg.expenses(business_id, id),
  constraint expenses_kind check (
    (reverses_expense_id is null and amount_paise > 0 and reason is null)
    or (reverses_expense_id is not null and amount_paise < 0 and reason is not null and upload_id is null))
);
create unique index expenses_one_reversal_uq on lbg.expenses (business_id, reverses_expense_id)
  where reverses_expense_id is not null;
create unique index expenses_upload_uq on lbg.expenses (business_id, upload_id) where upload_id is not null;
create index expenses_date_idx on lbg.expenses (business_id, expense_date);
create trigger expenses_append_only before update or delete on lbg.expenses
  for each row execute function lbg.forbid_mutation();

-- A reversal negates exactly one original expense and keeps its date,
-- category and method, so period figures net to zero for it.
create function lbg.expense_reversal_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
declare
  o expenses%rowtype;
begin
  if new.reverses_expense_id is null then
    return new;
  end if;
  select * into o from expenses where business_id = new.business_id and id = new.reverses_expense_id;
  if o.reverses_expense_id is not null or o.amount_paise <> -new.amount_paise or o.expense_date <> new.expense_date
     or o.category <> new.category or o.method <> new.method then
    raise exception 'expense reversal does not match the original' using errcode = 'LB021';
  end if;
  return new;
end
$$;
create trigger expenses_reversal_guard before insert on lbg.expenses
  for each row execute function lbg.expense_reversal_guard();

alter table lbg.expenses enable row level security;
alter table lbg.expenses force row level security;
create policy tenant_isolation on lbg.expenses to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.expenses to lbgos_app;
revoke execute on function lbg.expense_reversal_guard() from public;
