-- Migration 0008 — suppliers, purchases and the stock-level projection
-- (increment 4.2: FR-INV-3, FR-INV-4 AC3, FR-INV-5, FR-INV-8; WORKFLOWS §4–5).
-- New error codes: LB015 not enough stock in a bucket (negative stock not
-- allowed), LB016 purchase lines can change only while the purchase is a draft.

-- ---------------------------------------------------------------------------
-- Stock buckets. Physical stock is split into buckets so returned goods are
-- counted but not sellable (FR-INV-6): AVAILABLE is sellable; INSPECTION,
-- DAMAGED and REPAIR are not. RECLASSIFY moves stock between buckets of one
-- variant (a −q / +q pair), so on-hand totals are unchanged.
-- ---------------------------------------------------------------------------
alter table lbg.stock_movements
  add column bucket text not null default 'AVAILABLE'
    check (bucket in ('AVAILABLE', 'INSPECTION', 'DAMAGED', 'REPAIR'));
alter table lbg.stock_movements drop constraint stock_movements_movement_type_check;
alter table lbg.stock_movements add constraint stock_movements_movement_type_check check (movement_type in
  ('OPENING','PURCHASE','SALE','SALE_RETURN','PURCHASE_RETURN','TRANSFER_OUT','TRANSFER_IN','DAMAGE',
   'ADJUSTMENT','CORRECTION','REVERSAL','RECLASSIFY'));
create index stock_movements_variant_idx on lbg.stock_movements (business_id, variant_id, created_at);
create index stock_movements_reference_idx on lbg.stock_movements (business_id, reference_type, reference_id);

-- Units that never existed (their purchase was reversed) get status REVERSED.
alter table lbg.serialized_units drop constraint serialized_units_status_check;
alter table lbg.serialized_units add constraint serialized_units_status_check check (status in
  ('IN_STOCK','RESERVED','SOLD','PENDING_INSPECTION','IN_REPAIR','DAMAGED','RETURNED_TO_SUPPLIER','WRITTEN_OFF',
   'REVERSED'));
alter table lbg.serialized_units add column created_at timestamptz not null default now();

alter table lbg.business_settings
  add column allow_negative_stock boolean not null default false;   -- FR-INV-5 AC3

-- Projection of Σ stock_movements per variant and bucket (DATA_MODEL §3). It is
-- written only by the trigger below (the app role can read it, not write it),
-- in the same transaction as the movement, and is checked by reconciliation.
create table lbg.stock_levels (
  business_id  uuid not null,
  variant_id   uuid not null,
  bucket       text not null check (bucket in ('AVAILABLE', 'INSPECTION', 'DAMAGED', 'REPAIR')),
  quantity     numeric(12,3) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (business_id, variant_id, bucket),
  foreign key (business_id, variant_id) references lbg.product_variants(business_id, id)
);

-- The upsert takes a row lock, so concurrent decrements of one variant/bucket
-- queue up and each sees the previous result: the last item cannot be sold or
-- written off twice (FR-INV-5 AC3/AC4).
create function lbg.apply_stock_movement() returns trigger
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_qty numeric(12,3);
  v_allow boolean;
begin
  insert into stock_levels as l (business_id, variant_id, bucket, quantity)
  values (new.business_id, new.variant_id, new.bucket, new.quantity_delta)
  on conflict (business_id, variant_id, bucket)
    do update set quantity = l.quantity + excluded.quantity, updated_at = now()
  returning quantity into v_qty;
  if new.quantity_delta < 0 and v_qty < 0 then
    select coalesce((select allow_negative_stock from business_settings where business_id = new.business_id), false)
      into v_allow;
    -- Negative stock is never allowed for serialized units or outside AVAILABLE.
    if not v_allow or new.unit_id is not null or new.bucket <> 'AVAILABLE' then
      raise exception 'not enough stock' using errcode = 'LB015';
    end if;
  end if;
  return new;
end
$$;
create trigger stock_movements_apply after insert on lbg.stock_movements
  for each row execute function lbg.apply_stock_movement();

-- Backfill for movements written before this migration.
insert into lbg.stock_levels (business_id, variant_id, bucket, quantity)
select business_id, variant_id, bucket, sum(quantity_delta) from lbg.stock_movements
 group by business_id, variant_id, bucket;

-- Reconciliation (FR-INV-4 AC3): projection rows that differ from Σ movements.
create function lbg.stock_level_mismatches()
returns table (variant_id uuid, bucket text, projected numeric, ledger numeric)
language sql stable set search_path = lbg, public, pg_temp as $$
  with ledger as (
    select m.variant_id, m.bucket, sum(m.quantity_delta) as qty from stock_movements m
     where m.business_id = current_business_id() group by m.variant_id, m.bucket
  )
  select coalesce(l.variant_id, s.variant_id), coalesce(l.bucket, s.bucket), coalesce(s.quantity, 0), coalesce(l.qty, 0)
    from ledger l
    full join (select * from stock_levels where business_id = current_business_id()) s
      on s.variant_id = l.variant_id and s.bucket = l.bucket
   where coalesce(s.quantity, 0) <> coalesce(l.qty, 0)
$$;

-- ---------------------------------------------------------------------------
-- Suppliers (FR-INV-8 AC1)
-- ---------------------------------------------------------------------------
alter table lbg.suppliers
  add column email citext check (email ~ '^[^@\s]+@[^@\s]+$'),
  add column address text check (length(address) <= 500),
  add column payment_terms text check (length(payment_terms) <= 200),
  add column notes text check (length(notes) <= 2000),
  add column status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  add column created_at timestamptz not null default now(),
  add constraint suppliers_name_len check (length(name) between 1 and 120),
  add constraint suppliers_gstin_state check (gstin is null or state_code is null or substr(gstin, 1, 2) = state_code);

-- Amounts owed to suppliers (append-only). Positive = payable increases.
create table lbg.supplier_ledger_entries (
  business_id   uuid not null,
  id            uuid not null default gen_random_uuid(),
  supplier_id   uuid not null,
  entry_type    text not null check (entry_type in ('PURCHASE', 'PURCHASE_REVERSAL')),
  amount_paise  bigint not null check (amount_paise <> 0),
  purchase_id   uuid,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, supplier_id) references lbg.suppliers(business_id, id),
  check ((entry_type = 'PURCHASE') = (amount_paise > 0))
);
create trigger supplier_ledger_append_only before update or delete on lbg.supplier_ledger_entries
  for each row execute function lbg.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Purchases (FR-INV-8 AC2–4)
-- ---------------------------------------------------------------------------
alter table lbg.purchases
  add column is_inter_state boolean not null default false,
  add column cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  add column sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  add column igst_paise bigint not null default 0 check (igst_paise >= 0),
  add column cess_paise bigint not null default 0 check (cess_paise >= 0),
  -- Total printed on the supplier's invoice, as entered, for comparison only.
  add column supplier_total_paise bigint check (supplier_total_paise >= 0),
  add column notes text check (length(notes) <= 2000),
  add column created_by uuid,
  add column created_at timestamptz not null default now(),
  add column reversed_at timestamptz,
  add column reversal_reason text,
  add constraint purchases_invoice_no_len check (length(supplier_invoice_no) between 1 and 40),
  add constraint purchases_tax_parts check (tax_paise = cgst_paise + sgst_paise + igst_paise + cess_paise),
  add constraint purchases_reversal check ((status = 'REVERSED') = (reversed_at is not null)
                                           and (reversed_at is null or length(reversal_reason) >= 10)),
  add constraint purchases_override_len check (duplicate_override_reason is null
                                               or length(duplicate_override_reason) >= 10);

create table lbg.purchase_lines (
  business_id      uuid not null,
  id               uuid not null default gen_random_uuid(),
  purchase_id      uuid not null,
  line_no          smallint not null check (line_no between 1 and 500),
  variant_id       uuid not null,
  quantity         numeric(12,3) not null check (quantity > 0),
  unit_cost_paise  bigint not null check (unit_cost_paise >= 0),    -- tax-exclusive, as on the supplier invoice
  tax_rate_id      uuid,                                            -- version in force on the invoice date
  rate_percent     numeric(5,2) not null default 0 check (rate_percent between 0 and 100),
  cess_percent     numeric(5,2) not null default 0 check (cess_percent between 0 and 100),
  taxable_paise    bigint not null check (taxable_paise >= 0),
  cgst_paise       bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise       bigint not null default 0 check (sgst_paise >= 0),
  igst_paise       bigint not null default 0 check (igst_paise >= 0),
  cess_paise       bigint not null default 0 check (cess_paise >= 0),
  primary key (id),
  unique (business_id, id),
  unique (business_id, purchase_id, line_no),
  foreign key (business_id, purchase_id) references lbg.purchases(business_id, id),
  foreign key (business_id, variant_id) references lbg.product_variants(business_id, id),
  foreign key (business_id, tax_rate_id) references lbg.tax_rates(business_id, id),
  check (igst_paise = 0 or (cgst_paise = 0 and sgst_paise = 0))
);

-- IMEIs/serials entered for serialized lines (draft data; unit_id set on posting).
create table lbg.purchase_line_units (
  business_id    uuid not null,
  id             uuid not null default gen_random_uuid(),
  line_id        uuid not null,
  position       smallint not null check (position between 1 and 1000),
  imei1          text check (imei1 ~ '^[0-9]{1,20}$'),
  imei2          text check (imei2 ~ '^[0-9]{1,20}$'),
  serial_number  text check (length(serial_number) between 1 and 60),
  unit_id        uuid,
  primary key (id),
  unique (business_id, id),
  unique (business_id, line_id, position),
  foreign key (business_id, line_id) references lbg.purchase_lines(business_id, id),
  foreign key (business_id, unit_id) references lbg.serialized_units(business_id, id),
  check (imei1 is not null or serial_number is not null)
);

-- Lines and their units change only while the purchase is a draft.
create function lbg.purchase_draft_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
declare
  v_purchase uuid;
  v_status text;
begin
  if tg_table_name = 'purchase_lines' then
    v_purchase := coalesce(new.purchase_id, old.purchase_id);
  else
    select l.purchase_id into v_purchase from purchase_lines l
     where l.business_id = coalesce(new.business_id, old.business_id) and l.id = coalesce(new.line_id, old.line_id);
  end if;
  select status into v_status from purchases where id = v_purchase;
  -- Posting records unit IDs before it flips the status, so no exception is needed.
  if v_status <> 'DRAFT' then
    raise exception 'purchase % is %, its lines cannot change', v_purchase, v_status using errcode = 'LB016';
  end if;
  return coalesce(new, old);
end
$$;
create trigger purchase_lines_draft_only before insert or update or delete on lbg.purchase_lines
  for each row execute function lbg.purchase_draft_guard();
create trigger purchase_line_units_draft_only before insert or update or delete on lbg.purchase_line_units
  for each row execute function lbg.purchase_draft_guard();

-- Purchase status machine (WORKFLOWS §5): DRAFT → POSTED → REVERSED, DRAFT → DISCARDED.
create function lbg.purchase_status_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'DRAFT' and new.status in ('POSTED', 'DISCARDED'))
    or (old.status = 'POSTED' and new.status = 'REVERSED')) then
    raise exception 'purchase status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  if old.status <> 'DRAFT' and new.status = old.status then
    raise exception 'a % purchase cannot be edited', old.status using errcode = 'LB003';
  end if;
  return new;
end
$$;
create trigger purchases_status_guard before update on lbg.purchases
  for each row execute function lbg.purchase_status_guard();

-- IMEIs of reversed units are released so the goods can be entered again
-- correctly (D-033); IMEIs of any other unit stay reserved forever (D-008).
create policy imei_release on lbg.serialized_unit_imeis as restrictive for delete to lbgos_app
  using (exists (select 1 from lbg.serialized_units u
                  where u.business_id = serialized_unit_imeis.business_id and u.id = serialized_unit_imeis.unit_id
                    and u.status = 'REVERSED'));

-- RLS for the new tenant tables.
do $$
declare
  t text;
begin
  foreach t in array array['stock_levels', 'supplier_ledger_entries', 'purchase_lines', 'purchase_line_units'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;

grant select on lbg.stock_levels to lbgos_app;
grant select, insert on lbg.supplier_ledger_entries to lbgos_app;
grant select, insert, update, delete on lbg.purchase_lines, lbg.purchase_line_units to lbgos_app;
grant delete on lbg.serialized_unit_imeis to lbgos_app;
revoke execute on function lbg.apply_stock_movement(), lbg.stock_level_mismatches(), lbg.purchase_draft_guard(),
  lbg.purchase_status_guard() from public;
grant execute on function lbg.stock_level_mismatches() to lbgos_app;
