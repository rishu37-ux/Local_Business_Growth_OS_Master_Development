-- Migration 0007 — catalogue (increment 4.1): archiving, product/variant
-- fields from FR-INV-2, versioned tax rates (FR-TAX-2 AC1).
-- New error codes: LB012 tax-rate versions overlap, LB013 tax-rate version is
-- immutable (only effective_to may change), LB014 serialized flag cannot change
-- once stock exists.

alter table lbg.categories add column status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED'));
alter table lbg.brands add column status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED'));

alter table lbg.products
  add column description text check (length(description) <= 2000),
  add column created_at timestamptz not null default now(),
  add constraint products_model_name_len check (length(model_name) between 1 and 120),
  add constraint products_model_number_len check (length(model_number) <= 60);

alter table lbg.product_variants
  add column status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  -- Default/last purchase price (FR-INV-2 AC1); visible only with catalogue.cost.view (AC4).
  add column purchase_price_paise bigint check (purchase_price_paise >= 0),
  add column default_supplier_id uuid,
  add column created_at timestamptz not null default now(),
  add constraint product_variants_supplier_fk
    foreign key (business_id, default_supplier_id) references lbg.suppliers(business_id, id),
  add constraint product_variants_min_price check (min_selling_price_paise is null
                                                   or min_selling_price_paise <= selling_price_paise),
  add constraint product_variants_sku_format check (sku ~ '^[A-Za-z0-9._/-]{1,40}$'),
  add constraint product_variants_barcode_format check (barcode is null or barcode ~ '^[\x21-\x7e]{1,48}$');

-- Tax-rate versions. Versions of one rate share its name (case-insensitive);
-- their periods must not overlap. A version is immutable except for closing
-- it with effective_to; a new rate is a new version (FR-TAX-2 AC1–2).
create function lbg.tax_rate_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and (new.name is distinct from old.name or new.rate_percent is distinct from old.rate_percent
      or new.cess_percent is distinct from old.cess_percent or new.effective_from is distinct from old.effective_from
      or new.business_id is distinct from old.business_id) then
    raise exception 'a tax-rate version cannot be changed; add a new version' using errcode = 'LB013';
  end if;
  -- Serialise concurrent writers of the same rate name, then check overlap.
  perform pg_advisory_xact_lock(hashtextextended('tax_rate:' || new.business_id || ':' || lower(new.name), 0));
  if exists (
    select 1 from tax_rates t
     where t.business_id = new.business_id and lower(t.name) = lower(new.name) and t.id <> new.id
       and daterange(t.effective_from, t.effective_to, '[]') && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    raise exception 'tax-rate versions overlap' using errcode = 'LB012';
  end if;
  return new;
end
$$;
create trigger tax_rates_guard before insert or update on lbg.tax_rates
  for each row execute function lbg.tax_rate_guard();

-- The version of a rate in force on a date (same name as the referenced version).
create function lbg.effective_tax_rate(p_rate uuid, p_on date) returns uuid
language sql stable set search_path = lbg, public, pg_temp as $$
  select t.id from tax_rates r
    join tax_rates t on t.business_id = r.business_id and lower(t.name) = lower(r.name)
   where r.id = p_rate and t.effective_from <= p_on and (t.effective_to is null or t.effective_to >= p_on)
$$;

-- The serialized flag decides how stock is counted; it cannot change once any
-- variant of the product has stock movements.
create function lbg.product_serialized_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if new.is_serialized is distinct from old.is_serialized and exists (
    select 1 from stock_movements m join product_variants v on v.business_id = m.business_id and v.id = m.variant_id
     where v.business_id = new.business_id and v.product_id = new.id
  ) then
    raise exception 'serialized flag cannot change once stock exists' using errcode = 'LB014';
  end if;
  return new;
end
$$;
create trigger products_serialized_guard before update on lbg.products
  for each row execute function lbg.product_serialized_guard();

-- Deleting is allowed only for unused records: foreign keys from stock
-- movements, units, purchase and invoice lines refuse it (FR-INV-1 AC3).
grant delete on lbg.categories, lbg.brands, lbg.products, lbg.product_variants to lbgos_app;
revoke update on lbg.tax_rates from lbgos_app;
grant update (effective_to) on lbg.tax_rates to lbgos_app;
revoke execute on function lbg.tax_rate_guard(), lbg.effective_tax_rate(uuid, date), lbg.product_serialized_guard()
  from public;
grant execute on function lbg.effective_tax_rate(uuid, date) to lbgos_app;
