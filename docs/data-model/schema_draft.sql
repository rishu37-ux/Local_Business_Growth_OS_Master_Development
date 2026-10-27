-- Local Business Growth OS — logical schema DRAFT (Phase 1 design artifact)
--
-- Purpose: make the Phase 1 data-model decisions concrete and mechanically
-- testable (tenant isolation via RLS, append-only ledgers, IMEI rules,
-- gapless invoice-number constraints). This is NOT a production migration;
-- Phase 3 will turn it into versioned migrations with the chosen tooling.
--
-- Expects roles created beforehand (see scripts/test-schema-draft.sh):
--   lbgos_owner    owns all objects; migration role; BYPASSRLS; never used by the running app
--   lbgos_app      tenant request role; NOBYPASSRLS; subject to RLS on app.business_id
--   lbgos_platform platform-admin role; grants on platform tables only (D-015)
-- Expects extensions pgcrypto and citext.

create schema lbg authorization lbgos_owner;
set role lbgos_owner;
set search_path = lbg, public;   -- public holds the pgcrypto and citext extensions

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Tenant context is set per transaction by the API from the authenticated
-- session: select set_config('app.business_id', '<uuid>', true).
-- Unset -> NULL -> RLS policies match no rows (fail closed).
create function current_business_id() returns uuid
language sql stable set search_path = lbg, public, pg_temp as $$
  select nullif(current_setting('app.business_id', true), '')::uuid
$$;

create function current_app_user_id() returns uuid
language sql stable set search_path = lbg, public, pg_temp as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- IMEI: exactly 15 digits with a valid Luhn check digit (FR-INV-3).
create function is_valid_imei(v text) returns boolean
language plpgsql immutable strict set search_path = lbg, public, pg_temp as $$
declare
  s int := 0;
  d int;
begin
  if v !~ '^[0-9]{15}$' then
    return false;
  end if;
  for i in 1..15 loop
    d := substr(v, 16 - i, 1)::int;      -- i = 1 is the rightmost (check) digit
    if i % 2 = 0 then
      d := d * 2;
      if d > 9 then d := d - 9; end if;
    end if;
    s := s + d;
  end loop;
  return s % 10 = 0;
end
$$;

-- Generic guard for append-only tables (FR-INV-4, FR-LED-1, FR-AUD-1).
create function forbid_mutation() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  raise exception '% is append-only; record a reversal instead', tg_table_name
    using errcode = 'LB001';
end
$$;

-- ---------------------------------------------------------------------------
-- Platform tables
-- ---------------------------------------------------------------------------

create table businesses (
  id              uuid primary key default gen_random_uuid(),
  legal_name      text not null check (length(legal_name) between 2 and 200),
  display_name    text,
  category        text not null,
  status          text not null default 'PENDING_APPROVAL' check (status in
                  ('PENDING_APPROVAL','CHANGES_REQUESTED','APPROVED_SETUP_PENDING',
                   'ACTIVE','SUSPENDED','REJECTED')),
  state_code      char(2) check (state_code ~ '^[0-9]{2}$'),
  gstin           text check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  timezone        text not null default 'Asia/Kolkata',
  fy_start_month  smallint not null default 4 check (fy_start_month between 1 and 12),
  currency        char(3) not null default 'INR',
  created_at      timestamptz not null default now()
);

-- Allowed business status transitions (WORKFLOWS.md §1), enforced in DB as a backstop.
create function businesses_status_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('PENDING_APPROVAL','APPROVED_SETUP_PENDING') then
      raise exception 'new business must start as PENDING_APPROVAL or APPROVED_SETUP_PENDING'
        using errcode = 'LB002';
    end if;
  elsif new.status is distinct from old.status then
    if (old.status, new.status) not in (
      ('PENDING_APPROVAL','APPROVED_SETUP_PENDING'),
      ('PENDING_APPROVAL','CHANGES_REQUESTED'),
      ('PENDING_APPROVAL','REJECTED'),
      ('CHANGES_REQUESTED','PENDING_APPROVAL'),
      ('CHANGES_REQUESTED','REJECTED'),
      ('APPROVED_SETUP_PENDING','ACTIVE'),
      ('APPROVED_SETUP_PENDING','SUSPENDED'),
      ('ACTIVE','SUSPENDED'),
      ('SUSPENDED','ACTIVE'),
      ('SUSPENDED','APPROVED_SETUP_PENDING')
    ) then
      raise exception 'invalid business status transition % -> %', old.status, new.status
        using errcode = 'LB002';
    end if;
  end if;
  return new;
end
$$;

create trigger businesses_status_guard
  before insert or update of status on businesses
  for each row execute function businesses_status_guard();

create table business_status_events (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id),
  from_status   text,
  to_status     text not null,
  actor_user_id uuid,
  reason        text,
  created_at    timestamptz not null default now()
);

-- Global identities. Auth tables may be replaced by a managed auth provider (open question Q3).
create table users (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique,
  mobile_e164    text check (mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name   text not null,
  password_hash  text,                     -- Argon2id encoded string only (NFR-13)
  mfa_enabled    boolean not null default false,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED')),
  created_at     timestamptz not null default now()
);

create table plans (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  price_paise      bigint not null check (price_paise >= 0),
  billing_period   text not null check (billing_period in ('MONTH','YEAR')),
  limits           jsonb not null default '{}'::jsonb,
  active           boolean not null default true
);

create table subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id),
  plan_id               uuid not null references plans(id),
  status                text not null check (status in
                        ('TRIALING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  current_period_start  timestamptz not null,
  current_period_end    timestamptz not null,
  grace_days            smallint not null default 7,
  check (current_period_end > current_period_start)
);

-- Self-registration path: always creates PENDING_APPROVAL (BR-T1). The app role
-- has no INSERT grant on businesses; it can only use this function.
create function register_application(p_legal_name text, p_category text, p_state_code char(2))
returns uuid
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into businesses (legal_name, category, state_code, status)
  values (p_legal_name, p_category, p_state_code, 'PENDING_APPROVAL')
  returning id into v_id;
  insert into business_status_events (business_id, from_status, to_status, actor_user_id)
  values (v_id, null, 'PENDING_APPROVAL', current_app_user_id());
  return v_id;
end
$$;

-- Login lookup happens before any tenant context exists.
create function auth_find_user_by_email(p_email citext)
returns table (id uuid, password_hash text, mfa_enabled boolean, status text)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select u.id, u.password_hash, u.mfa_enabled, u.status from users u where u.email = p_email
$$;

-- ---------------------------------------------------------------------------
-- Tenant membership and RBAC
-- ---------------------------------------------------------------------------

create table memberships (
  business_id  uuid not null references businesses(id),
  id           uuid not null default gen_random_uuid(),
  user_id      uuid not null references users(id),
  status       text not null default 'ACTIVE' check (status in ('INVITED','ACTIVE','DEACTIVATED')),
  created_at   timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (business_id, user_id)
);

create table roles (
  business_id  uuid not null references businesses(id),
  id           uuid not null default gen_random_uuid(),
  name         text not null,
  is_system    boolean not null default false,   -- Owner role: not deletable (R1)
  primary key (id),
  unique (business_id, id),
  unique (business_id, name)
);

create table role_permissions (
  business_id     uuid not null,
  role_id         uuid not null,
  permission_key  text not null check (permission_key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  limits          jsonb,                      -- e.g. {"max_percent": 10, "max_paise": 500000}
  primary key (business_id, role_id, permission_key),
  foreign key (business_id, role_id) references roles(business_id, id)
);

create table membership_roles (
  business_id    uuid not null,
  membership_id  uuid not null,
  role_id        uuid not null,
  primary key (business_id, membership_id, role_id),
  foreign key (business_id, membership_id) references memberships(business_id, id),
  foreign key (business_id, role_id) references roles(business_id, id)
);

-- ---------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------

create table audit_events (
  id             uuid primary key default gen_random_uuid(),
  scope          text not null check (scope in ('TENANT','PLATFORM')),
  business_id    uuid references businesses(id),
  actor_type     text not null check (actor_type in ('USER','PLATFORM_ADMIN','SYSTEM','AGENT')),
  actor_user_id  uuid,
  action         text not null,
  target_type    text,
  target_id      uuid,
  request_id     text,
  metadata       jsonb not null default '{}'::jsonb,   -- never secrets / full PII
  created_at     timestamptz not null default now(),
  check (scope = 'PLATFORM' or business_id is not null)
);

-- ---------------------------------------------------------------------------
-- Catalogue and inventory
-- ---------------------------------------------------------------------------

create table tax_rates (
  business_id     uuid not null references businesses(id),
  id              uuid not null default gen_random_uuid(),
  name            text not null,
  rate_percent    numeric(5,2) not null check (rate_percent between 0 and 100),
  cess_percent    numeric(5,2) not null default 0 check (cess_percent between 0 and 100),
  effective_from  date not null,
  effective_to    date,
  primary key (id),
  unique (business_id, id),
  check (effective_to is null or effective_to >= effective_from)
);

create table categories (
  business_id  uuid not null references businesses(id),
  id           uuid not null default gen_random_uuid(),
  name         text not null,
  primary key (id),
  unique (business_id, id),
  unique (business_id, name)
);

create table brands (
  business_id  uuid not null references businesses(id),
  id           uuid not null default gen_random_uuid(),
  name         text not null,
  primary key (id),
  unique (business_id, id)
);
create unique index brands_name_uq on brands (business_id, lower(name));

create table products (
  business_id    uuid not null references businesses(id),
  id             uuid not null default gen_random_uuid(),
  category_id    uuid,
  brand_id       uuid,
  model_name     text not null,
  model_number   text,
  is_serialized  boolean not null default false,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, category_id) references categories(business_id, id),
  foreign key (business_id, brand_id) references brands(business_id, id)
);

create table product_variants (
  business_id              uuid not null,
  id                       uuid not null default gen_random_uuid(),
  product_id               uuid not null,
  sku                      text not null,
  barcode                  text,
  ram                      text,
  storage                  text,
  colour                   text,
  uom                      text not null default 'pcs',
  selling_price_paise      bigint not null check (selling_price_paise >= 0),
  min_selling_price_paise  bigint check (min_selling_price_paise >= 0),
  avg_cost_paise           bigint check (avg_cost_paise >= 0),        -- D-017, non-serialized
  price_includes_tax       boolean not null default true,
  tax_rate_id              uuid,
  hsn_code                 text check (hsn_code ~ '^[0-9]{4,8}$'),
  reorder_level            integer check (reorder_level >= 0),
  warranty_months          smallint check (warranty_months >= 0),
  warranty_provider        text,
  primary key (id),
  unique (business_id, id),
  unique (business_id, sku),
  foreign key (business_id, product_id) references products(business_id, id),
  foreign key (business_id, tax_rate_id) references tax_rates(business_id, id)
);
create unique index product_variants_barcode_uq on product_variants (business_id, barcode)
  where barcode is not null;

create table suppliers (
  business_id  uuid not null references businesses(id),
  id           uuid not null default gen_random_uuid(),
  name         text not null,
  gstin        text check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  mobile_e164  text check (mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  state_code   char(2) check (state_code ~ '^[0-9]{2}$'),
  primary key (id),
  unique (business_id, id)
);

create table purchases (
  business_id                uuid not null,
  id                         uuid not null default gen_random_uuid(),
  supplier_id                uuid not null,
  supplier_invoice_no        text not null,
  supplier_invoice_date      date not null,
  status                     text not null default 'DRAFT'
                             check (status in ('DRAFT','POSTED','REVERSED','DISCARDED')),
  duplicate_override_reason  text,
  taxable_paise              bigint not null default 0 check (taxable_paise >= 0),
  tax_paise                  bigint not null default 0 check (tax_paise >= 0),
  total_paise                bigint not null default 0 check (total_paise >= 0),
  posted_at                  timestamptz,
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, supplier_id) references suppliers(business_id, id),
  check (total_paise = taxable_paise + tax_paise),
  check ((status = 'DRAFT' or status = 'DISCARDED') or posted_at is not null)
);
-- FR-INV-8 AC3: one posted purchase per supplier invoice number unless overridden with a reason.
create unique index purchases_supplier_invoice_uq
  on purchases (business_id, supplier_id, lower(supplier_invoice_no))
  where status = 'POSTED' and duplicate_override_reason is null;

create table serialized_units (
  business_id      uuid not null,
  id               uuid not null default gen_random_uuid(),
  variant_id       uuid not null,
  serial_number    text,
  status           text not null check (status in
                   ('IN_STOCK','RESERVED','SOLD','PENDING_INSPECTION','IN_REPAIR',
                    'DAMAGED','RETURNED_TO_SUPPLIER','WRITTEN_OFF')),
  unit_cost_paise  bigint not null check (unit_cost_paise >= 0),
  purchase_id      uuid,
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, variant_id) references product_variants(business_id, id),
  foreign key (business_id, purchase_id) references purchases(business_id, id)
);
create unique index serialized_units_serial_uq on serialized_units (business_id, variant_id, serial_number)
  where serial_number is not null;

-- IMEI 1 and IMEI 2 share one namespace per business (D-008): the primary key
-- makes an IMEI unique across both slots and all units of that business.
create table serialized_unit_imeis (
  business_id  uuid not null,
  imei         text not null check (is_valid_imei(imei)),
  unit_id      uuid not null,
  slot         smallint not null check (slot in (1, 2)),
  primary key (business_id, imei),
  unique (business_id, unit_id, slot),
  foreign key (business_id, unit_id) references serialized_units(business_id, id)
);

create table stock_movements (
  business_id           uuid not null,
  id                    uuid not null default gen_random_uuid(),
  variant_id            uuid not null,
  unit_id               uuid,
  movement_type         text not null check (movement_type in
                        ('OPENING','PURCHASE','SALE','SALE_RETURN','PURCHASE_RETURN',
                         'TRANSFER_OUT','TRANSFER_IN','DAMAGE','ADJUSTMENT','CORRECTION',
                         'REVERSAL')),
  quantity_delta        numeric(12,3) not null check (quantity_delta <> 0),
  unit_cost_paise       bigint check (unit_cost_paise >= 0),
  reference_type        text,
  reference_id          uuid,
  reverses_movement_id  uuid,
  reason                text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (reverses_movement_id),                       -- a movement can be reversed once
  foreign key (business_id, variant_id) references product_variants(business_id, id),
  foreign key (business_id, unit_id) references serialized_units(business_id, id),
  foreign key (business_id, reverses_movement_id) references stock_movements(business_id, id),
  check (unit_id is null or quantity_delta in (-1, 1)),
  check ((movement_type = 'REVERSAL') = (reverses_movement_id is not null)),
  check (movement_type not in ('ADJUSTMENT','CORRECTION','DAMAGE') or reason is not null)
);
create trigger stock_movements_append_only
  before update or delete on stock_movements
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Customers and consent
-- ---------------------------------------------------------------------------

create table customers (
  business_id   uuid not null references businesses(id),
  id            uuid not null default gen_random_uuid(),
  name          text not null,
  mobile_e164   text check (mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email         citext,
  dob           date,
  gstin         text check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code    char(2) check (state_code ~ '^[0-9]{2}$'),
  erased_at     timestamptz,                         -- FR-PRV-1 anonymisation
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (business_id, mobile_e164),
  check (erased_at is not null or mobile_e164 is not null)
);

create table customer_consents (
  business_id   uuid not null,
  id            uuid not null default gen_random_uuid(),
  customer_id   uuid not null,
  channel       text not null check (channel in ('WHATSAPP','SMS','EMAIL')),
  purpose       text not null check (purpose in ('TRANSACTIONAL','MARKETING')),
  status        text not null check (status in ('GRANTED','WITHDRAWN')),
  source        text not null,
  recorded_by   uuid,
  recorded_at   timestamptz not null default now(),
  primary key (id),
  foreign key (business_id, customer_id) references customers(business_id, id)
);
create trigger customer_consents_append_only
  before update or delete on customer_consents
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Invoices, payments and ledger
-- ---------------------------------------------------------------------------

create table invoice_series (
  business_id     uuid not null references businesses(id),
  id              uuid not null default gen_random_uuid(),
  document_type   text not null check (document_type in
                  ('TAX_INVOICE','BILL_OF_SUPPLY','CREDIT_NOTE','DEBIT_NOTE')),
  financial_year  text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix          text not null default '',
  next_number     integer not null default 1 check (next_number >= 1),
  primary key (id),
  unique (business_id, id),
  unique (business_id, document_type, financial_year, prefix)
);

create table invoices (
  business_id            uuid not null,
  id                     uuid not null default gen_random_uuid(),
  series_id              uuid,
  document_type          text not null check (document_type in
                         ('TAX_INVOICE','BILL_OF_SUPPLY','CREDIT_NOTE','DEBIT_NOTE')),
  financial_year         text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  invoice_number         text check (invoice_number ~ '^[A-Za-z0-9/-]{1,16}$'),   -- D-012
  invoice_date           date not null,
  customer_id            uuid,
  original_invoice_id    uuid,                                 -- for credit/debit notes
  place_of_supply_state  char(2) not null check (place_of_supply_state ~ '^[0-9]{2}$'),
  status                 text not null default 'DRAFT'
                         check (status in ('DRAFT','ISSUED','CANCELLED','DISCARDED')),
  discount_paise         bigint not null default 0 check (discount_paise >= 0),
  taxable_paise          bigint not null default 0 check (taxable_paise >= 0),
  cgst_paise             bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise             bigint not null default 0 check (sgst_paise >= 0),
  igst_paise             bigint not null default 0 check (igst_paise >= 0),
  cess_paise             bigint not null default 0 check (cess_paise >= 0),
  round_off_paise        bigint not null default 0 check (round_off_paise between -99 and 99),
  total_paise            bigint not null default 0 check (total_paise >= 0),
  issued_at              timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  created_by             uuid,
  primary key (id),
  unique (business_id, id),
  unique (business_id, document_type, financial_year, invoice_number),
  foreign key (business_id, series_id) references invoice_series(business_id, id),
  foreign key (business_id, customer_id) references customers(business_id, id),
  foreign key (business_id, original_invoice_id) references invoices(business_id, id),
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise),
  check (igst_paise = 0 or (cgst_paise = 0 and sgst_paise = 0)),
  check (status in ('DRAFT','DISCARDED') or (invoice_number is not null and issued_at is not null)),
  check (status <> 'CANCELLED' or (cancel_reason is not null and length(cancel_reason) >= 10
                                   and cancelled_at is not null)),
  check (document_type not in ('CREDIT_NOTE','DEBIT_NOTE') or original_invoice_id is not null)
);

create table invoice_lines (
  business_id       uuid not null,
  id                uuid not null default gen_random_uuid(),
  invoice_id        uuid not null,
  line_no           integer not null check (line_no >= 1),
  variant_id        uuid not null,
  unit_id           uuid,
  description       text not null,
  hsn_code          text check (hsn_code ~ '^[0-9]{4,8}$'),
  quantity          numeric(12,3) not null check (quantity > 0),
  unit_price_paise  bigint not null check (unit_price_paise >= 0),
  discount_paise    bigint not null default 0 check (discount_paise >= 0),
  tax_rate_percent  numeric(5,2) not null check (tax_rate_percent between 0 and 100),
  taxable_paise     bigint not null check (taxable_paise >= 0),
  cgst_paise        bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise        bigint not null default 0 check (sgst_paise >= 0),
  igst_paise        bigint not null default 0 check (igst_paise >= 0),
  cess_paise        bigint not null default 0 check (cess_paise >= 0),
  line_total_paise  bigint not null check (line_total_paise >= 0),
  cost_paise        bigint check (cost_paise >= 0),          -- COGS snapshot (D-017)
  primary key (id),
  unique (business_id, invoice_id, line_no),
  foreign key (business_id, invoice_id) references invoices(business_id, id),
  foreign key (business_id, variant_id) references product_variants(business_id, id),
  foreign key (business_id, unit_id) references serialized_units(business_id, id),
  check (line_total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise),
  check (unit_id is null or quantity = 1)
);

-- Issued invoices are immutable except ISSUED -> CANCELLED (D-016); lines of
-- non-draft invoices cannot change; issuing requires lines to reconcile.
create function invoices_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
declare
  ignored text[] := array['status','cancel_reason','cancelled_at'];
  s record;
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices cannot be deleted' using errcode = 'LB003';
  end if;
  if old.status = 'DRAFT' then
    if new.status = 'ISSUED' then
      select coalesce(sum(taxable_paise), 0) as taxable, coalesce(sum(cgst_paise), 0) as cgst,
             coalesce(sum(sgst_paise), 0) as sgst, coalesce(sum(igst_paise), 0) as igst,
             coalesce(sum(cess_paise), 0) as cess, count(*) as n
        into s from invoice_lines l
       where l.business_id = new.business_id and l.invoice_id = new.id;
      if s.n = 0 or s.taxable <> new.taxable_paise or s.cgst <> new.cgst_paise
         or s.sgst <> new.sgst_paise or s.igst <> new.igst_paise or s.cess <> new.cess_paise then
        raise exception 'invoice totals do not reconcile with lines' using errcode = 'LB004';
      end if;
    end if;
    return new;
  end if;
  if old.status = 'ISSUED' and new.status = 'CANCELLED'
     and (to_jsonb(new) - ignored) = (to_jsonb(old) - ignored) then
    return new;
  end if;
  raise exception 'invoice % is % and immutable', old.id, old.status using errcode = 'LB003';
end
$$;
create trigger invoices_guard
  before update or delete on invoices
  for each row execute function invoices_guard();

create function invoice_lines_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
declare
  v_status text;
  v_business uuid := coalesce(new.business_id, old.business_id);
  v_invoice  uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  select status into v_status from invoices where business_id = v_business and id = v_invoice;
  if v_status is distinct from 'DRAFT' then
    raise exception 'lines of a % invoice cannot change', v_status using errcode = 'LB003';
  end if;
  return coalesce(new, old);
end
$$;
create trigger invoice_lines_guard
  before insert or update or delete on invoice_lines
  for each row execute function invoice_lines_guard();

create table payments (
  business_id         uuid not null,
  id                  uuid not null default gen_random_uuid(),
  customer_id         uuid,
  method              text not null check (method in
                      ('CASH','UPI','CARD','BANK_TRANSFER','ADVANCE','OTHER')),
  amount_paise        bigint not null check (amount_paise > 0),
  reference           text check (reference !~ '[0-9]{13,19}'),     -- never full card numbers
  received_at         timestamptz not null default now(),
  reverses_payment_id uuid,
  recorded_by         uuid,
  primary key (id),
  unique (business_id, id),
  unique (reverses_payment_id),
  foreign key (business_id, customer_id) references customers(business_id, id),
  foreign key (business_id, reverses_payment_id) references payments(business_id, id)
);
create trigger payments_append_only
  before update or delete on payments
  for each row execute function forbid_mutation();

create table payment_allocations (
  business_id             uuid not null,
  id                      uuid not null default gen_random_uuid(),
  payment_id              uuid not null,
  invoice_id              uuid not null,
  amount_paise            bigint not null check (amount_paise <> 0),   -- negative = reversal
  reverses_allocation_id  uuid,
  created_at              timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (reverses_allocation_id),
  foreign key (business_id, payment_id) references payments(business_id, id),
  foreign key (business_id, invoice_id) references invoices(business_id, id),
  foreign key (business_id, reverses_allocation_id) references payment_allocations(business_id, id),
  check ((amount_paise < 0) = (reverses_allocation_id is not null))
);
create trigger payment_allocations_append_only
  before update or delete on payment_allocations
  for each row execute function forbid_mutation();

-- Backstop for FR-LED-2 AC2: allocations never exceed the invoice total or the
-- payment amount, and never go negative. (The app also locks the invoice row.)
create function payment_allocations_bounds() returns trigger
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
  select coalesce(sum(amount_paise), 0) into v_pay_alloc from payment_allocations
   where business_id = new.business_id and payment_id = new.payment_id;
  select amount_paise into v_pay_amount from payments
   where business_id = new.business_id and id = new.payment_id;
  if v_inv_alloc > v_inv_total or v_inv_alloc < 0 or v_pay_alloc > v_pay_amount or v_pay_alloc < 0 then
    raise exception 'allocation out of bounds (invoice %/%; payment %/%)',
      v_inv_alloc, v_inv_total, v_pay_alloc, v_pay_amount using errcode = 'LB005';
  end if;
  return null;
end
$$;
create constraint trigger payment_allocations_bounds
  after insert on payment_allocations
  for each row execute function payment_allocations_bounds();

-- Signed amounts: positive = customer owes more (debit), negative = credit.
create table customer_ledger_entries (
  business_id        uuid not null,
  id                 uuid not null default gen_random_uuid(),
  customer_id        uuid not null,
  entry_type         text not null check (entry_type in
                     ('INVOICE','DEBIT_NOTE','REFUND','PAYMENT','ADVANCE','CREDIT_NOTE',
                      'ADJUSTMENT','REVERSAL')),
  amount_paise       bigint not null check (amount_paise <> 0),
  reference_type     text,
  reference_id       uuid,
  reverses_entry_id  uuid,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (reverses_entry_id),
  foreign key (business_id, customer_id) references customers(business_id, id),
  foreign key (business_id, reverses_entry_id) references customer_ledger_entries(business_id, id),
  check (entry_type not in ('INVOICE','DEBIT_NOTE','REFUND') or amount_paise > 0),
  check (entry_type not in ('PAYMENT','ADVANCE','CREDIT_NOTE') or amount_paise < 0),
  check ((entry_type = 'REVERSAL') = (reverses_entry_id is not null))
);
create trigger customer_ledger_entries_append_only
  before update or delete on customer_ledger_entries
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Approvals (FR-AGT-4, WORKFLOWS.md §11)
-- ---------------------------------------------------------------------------

create table approval_requests (
  business_id          uuid not null references businesses(id),
  id                   uuid not null default gen_random_uuid(),
  requested_by         uuid not null,
  agent_run_id         uuid,
  action_type          text not null,
  payload              jsonb not null,
  payload_sha256       text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  required_permission  text not null,
  status               text not null default 'PENDING' check (status in
                       ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED','EXECUTED',
                        'EXECUTION_FAILED')),
  decided_by           uuid,
  decided_at           timestamptz,
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  check (status in ('PENDING','CANCELLED','EXPIRED') or decided_by is not null)
);

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function forbid_mutation();
create trigger business_status_events_append_only
  before update or delete on business_status_events
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Generic tenant policy for every table with a business_id column, except
-- tables with bespoke policies below.
do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
     where c.table_schema = 'lbg' and c.column_name = 'business_id'
       and c.table_name not in ('memberships','audit_events','subscriptions','business_status_events')
  loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;

-- businesses: a tenant sees only its own row; the platform role sees all.
alter table businesses enable row level security;
alter table businesses force row level security;
create policy tenant_own_business on businesses to lbgos_app
  using (id = current_business_id());
create policy platform_all on businesses to lbgos_platform
  using (true) with check (true);

-- memberships: visible within the current business, or the user's own
-- memberships (needed for the "choose shop" step after login).
alter table memberships enable row level security;
alter table memberships force row level security;
create policy membership_read on memberships for select to lbgos_app
  using (business_id = current_business_id() or user_id = current_app_user_id());
create policy membership_write on memberships for insert to lbgos_app
  with check (business_id = current_business_id());
create policy membership_update on memberships for update to lbgos_app
  using (business_id = current_business_id())
  with check (business_id = current_business_id());

-- users: a tenant request sees itself and members of the current business only.
alter table users enable row level security;
alter table users force row level security;
create policy users_visible on users for select to lbgos_app
  using (id = current_app_user_id()
         or id in (select m.user_id from memberships m where m.business_id = current_business_id()));
create policy users_self_update on users for update to lbgos_app
  using (id = current_app_user_id()) with check (id = current_app_user_id());
create policy users_platform_read on users for select to lbgos_platform
  using (true);                       -- column grants below limit what is readable

-- audit: tenants see their own business's events; platform sees PLATFORM scope.
alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy audit_tenant_read on audit_events for select to lbgos_app
  using (business_id = current_business_id());
create policy audit_tenant_insert on audit_events for insert to lbgos_app
  with check (scope = 'TENANT' and business_id = current_business_id());
create policy audit_platform_read on audit_events for select to lbgos_platform
  using (scope = 'PLATFORM');
create policy audit_platform_insert on audit_events for insert to lbgos_platform
  with check (scope = 'PLATFORM');

-- subscriptions and status history: tenant reads own; platform manages.
alter table subscriptions enable row level security;
alter table subscriptions force row level security;
create policy subscription_tenant_read on subscriptions for select to lbgos_app
  using (business_id = current_business_id());
create policy subscription_platform_all on subscriptions to lbgos_platform
  using (true) with check (true);

alter table business_status_events enable row level security;
alter table business_status_events force row level security;
create policy status_events_tenant_read on business_status_events for select to lbgos_app
  using (business_id = current_business_id());
create policy status_events_platform_all on business_status_events to lbgos_platform
  using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Grants (least privilege). No DELETE except on draft-only line tables.
-- ---------------------------------------------------------------------------

revoke all on schema lbg from public;
grant usage on schema lbg to lbgos_app, lbgos_platform;
revoke execute on all functions in schema lbg from public;
grant execute on function current_business_id(), current_app_user_id(), is_valid_imei(text)
  to lbgos_app, lbgos_platform;
grant execute on function register_application(text, text, char), auth_find_user_by_email(citext)
  to lbgos_app;

-- Tenant role
grant select on businesses, subscriptions, business_status_events, plans to lbgos_app;
grant update (display_name, timezone, fy_start_month) on businesses to lbgos_app;   -- never status
grant select, update on users to lbgos_app;
grant select, insert, update on memberships, roles, tax_rates, categories, brands, products,
  product_variants, suppliers, purchases, serialized_units, customers, invoice_series,
  invoices, approval_requests to lbgos_app;
grant select, insert, delete on role_permissions, membership_roles to lbgos_app;
grant select, insert on serialized_unit_imeis to lbgos_app;
grant select, insert, update, delete on invoice_lines to lbgos_app;           -- guarded: drafts only
grant select, insert on stock_movements, customer_consents, payments, payment_allocations,
  customer_ledger_entries, audit_events to lbgos_app;                          -- append-only

-- Platform role: platform tables only (D-015) — no grants on tenant business data.
grant select, insert, update on businesses, plans, subscriptions to lbgos_platform;
grant select, insert on business_status_events, audit_events to lbgos_platform;
grant select (id, email, display_name, mfa_enabled, status, created_at) on users to lbgos_platform;

reset role;
