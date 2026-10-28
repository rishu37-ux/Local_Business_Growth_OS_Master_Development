-- Migration 0032 — sales channels, listings, channel orders with
-- reservations, the stock push queue, and the public store read functions
-- (increments 11.2–11.4, D-069, D-070).
--
-- Available-to-sell on a channel = AVAILABLE stock − open reservations (all
-- channels) − the channel's buffer, floored at 0. An order reserves while it
-- is open and not yet billed; billing goes through the normal sale, whose
-- SALE movement takes the stock.

-- Marketplace connectors are integrations of their own category.
alter table lbg.integrations drop constraint integrations_category_check;
alter table lbg.integrations add constraint integrations_category_check check (category in
  ('MESSAGING', 'SMS', 'EMAIL', 'LLM', 'IMAGE_VIDEO', 'OCR', 'STORAGE', 'PAYMENTS', 'SOCIAL', 'MARKETPLACE'));

create table lbg.sales_channels (
  business_id     uuid not null references lbg.businesses(id),
  id              uuid not null default gen_random_uuid(),
  kind            text not null check (kind in ('WEBSITE', 'MARKETPLACE')),
  name            text not null check (length(name) between 2 and 60),
  integration_id  uuid,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED')),
  stock_buffer    integer not null default 0 check (stock_buffer between 0 and 1000),
  order_cursor    text check (length(order_cursor) <= 500),
  last_sync_at    timestamptz,
  last_sync_error text check (last_sync_error ~ '^[A-Z0-9_]{1,40}$'),
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, integration_id) references lbg.integrations(business_id, id),
  check ((kind = 'WEBSITE') = (integration_id is null))
);
create unique index sales_channels_one_website on lbg.sales_channels (business_id) where kind = 'WEBSITE';
create unique index sales_channels_one_per_integration on lbg.sales_channels (business_id, integration_id)
  where integration_id is not null;

create table lbg.channel_listings (
  business_id          uuid not null,
  id                   uuid not null default gen_random_uuid(),
  channel_id           uuid not null,
  variant_id           uuid not null,
  external_sku         text not null check (external_sku ~ '^[A-Za-z0-9._/-]{1,60}$'),
  price_paise          bigint check (price_paise >= 0),
  published            boolean not null default true,
  last_pushed_quantity integer,
  last_pushed_at       timestamptz,
  created_at           timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (channel_id, variant_id),
  unique (channel_id, external_sku),
  foreign key (business_id, channel_id) references lbg.sales_channels(business_id, id),
  foreign key (business_id, variant_id) references lbg.product_variants(business_id, id)
);
create index channel_listings_variant_idx on lbg.channel_listings (business_id, variant_id);

create table lbg.channel_orders (
  business_id       uuid not null,
  id                uuid not null default gen_random_uuid(),
  channel_id        uuid not null,
  external_order_id text not null check (external_order_id ~ '^[A-Za-z0-9._:/-]{1,100}$'),
  status            text not null default 'NEW' check (status in ('NEW', 'ACCEPTED', 'CANCELLED')),
  customer_name     text check (length(customer_name) between 1 and 120),
  customer_mobile   text check (customer_mobile ~ '^\+91[6-9][0-9]{9}$'),
  note              text check (length(note) <= 500),
  oversold          boolean not null default false,
  needs_attention   boolean not null default false,
  sale_id           uuid,
  placed_at         timestamptz not null default now(),
  cancelled_reason  text check (length(cancelled_reason) between 3 and 200),
  created_at        timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (channel_id, external_order_id),
  foreign key (business_id, channel_id) references lbg.sales_channels(business_id, id),
  foreign key (business_id, sale_id) references lbg.invoices(business_id, id),
  check ((status = 'CANCELLED') = (cancelled_reason is not null))
);
create index channel_orders_open_idx on lbg.channel_orders (business_id, status) where status <> 'CANCELLED';

create table lbg.channel_order_lines (
  business_id      uuid not null,
  id               uuid not null default gen_random_uuid(),
  order_id         uuid not null,
  variant_id       uuid,
  external_sku     text not null check (length(external_sku) between 1 and 60),
  quantity         integer not null check (quantity between 1 and 1000),
  unit_price_paise bigint check (unit_price_paise >= 0),
  primary key (id),
  foreign key (business_id, order_id) references lbg.channel_orders(business_id, id),
  foreign key (business_id, variant_id) references lbg.product_variants(business_id, id)
);
create index channel_order_lines_order_idx on lbg.channel_order_lines (business_id, order_id);
create index channel_order_lines_variant_idx on lbg.channel_order_lines (business_id, variant_id);

-- Lines never change after import; an order's content is what the channel sent.
create trigger channel_order_lines_append_only before update or delete on lbg.channel_order_lines
  for each row execute function lbg.forbid_mutation();

-- One pending push per marketplace listing; a newer change supersedes the older one.
create table lbg.channel_sync_queue (
  business_id     uuid not null,
  listing_id      uuid not null primary key,
  queued_at       timestamptz not null default now(),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error      text check (last_error ~ '^[A-Z0-9_]{1,40}$'),
  foreign key (business_id, listing_id) references lbg.channel_listings(business_id, id)
);
create index channel_sync_queue_due_idx on lbg.channel_sync_queue (business_id, next_attempt_at);

-- Quantity reserved by open, unbilled channel orders for one variant (current business).
create function lbg.channel_reserved(p_variant uuid) returns integer
language sql stable set search_path = lbg, public, pg_temp as $$
  select coalesce(sum(l.quantity), 0)::integer
    from channel_order_lines l
    join channel_orders o on o.business_id = l.business_id and o.id = l.order_id
    left join invoices i on i.business_id = o.business_id and i.id = o.sale_id
   where l.business_id = current_business_id() and l.variant_id = p_variant
     and o.status in ('NEW', 'ACCEPTED')
     and (o.sale_id is null or i.status in ('DRAFT', 'DISCARDED'))
$$;

-- Queue a push for every marketplace listing of a variant (same transaction as the change).
create function lbg.queue_channel_sync(p_business uuid, p_variant uuid) returns void
language sql security definer set search_path = lbg, public, pg_temp as $$
  insert into channel_sync_queue (business_id, listing_id)
  select l.business_id, l.id
    from channel_listings l join sales_channels c on c.business_id = l.business_id and c.id = l.channel_id
   where l.business_id = p_business and l.variant_id = p_variant and c.kind = 'MARKETPLACE'
  on conflict (listing_id) do update set queued_at = now(), attempts = 0, next_attempt_at = now(), last_error = null
$$;
revoke execute on function lbg.queue_channel_sync(uuid, uuid) from public;
grant execute on function lbg.queue_channel_sync(uuid, uuid) to lbgos_app;

-- Every change of available stock queues the variant's marketplace listings.
create function lbg.stock_level_queues_sync() returns trigger
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
begin
  if new.bucket = 'AVAILABLE' and (tg_op = 'INSERT' or new.quantity is distinct from old.quantity) then
    perform queue_channel_sync(new.business_id, new.variant_id);
  end if;
  return new;
end
$$;
create trigger stock_levels_queue_sync after insert or update on lbg.stock_levels
  for each row execute function lbg.stock_level_queues_sync();

do $$
declare
  t text;
begin
  foreach t in array array['sales_channels', 'channel_listings', 'channel_orders', 'channel_order_lines',
                           'channel_sync_queue'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.sales_channels, lbg.channel_listings, lbg.channel_orders, lbg.channel_order_lines
  to lbgos_app;
grant update (name, status, stock_buffer, order_cursor, last_sync_at, last_sync_error) on lbg.sales_channels to lbgos_app;
grant update (external_sku, price_paise, published, last_pushed_quantity, last_pushed_at) on lbg.channel_listings
  to lbgos_app;
grant update (status, oversold, needs_attention, sale_id, cancelled_reason) on lbg.channel_orders to lbgos_app;
grant select, insert, update, delete on lbg.channel_sync_queue to lbgos_app;
grant execute on function lbg.channel_reserved(uuid) to lbgos_app;

-- ---------------------------------------------------------------------------
-- Public store (11.4). The website has no session and no tenant context: it
-- resolves the store address here and reads only public fields of published
-- website listings. Nothing else of the business is reachable through these.
-- ---------------------------------------------------------------------------

create function lbg.store_business(p_slug text) returns uuid
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select b.id from business_branding br join businesses b on b.id = br.business_id
   where br.store_slug = lower(p_slug) and br.store_enabled and b.status = 'ACTIVE'
$$;
revoke execute on function lbg.store_business(text) from public;
grant execute on function lbg.store_business(text) to lbgos_app;

-- The public face of a store: name, contact, colour, tagline, whether a logo exists.
create function lbg.store_profile(p_slug text)
returns table (business_id uuid, name text, address text, phone text, brand_color text, tagline text,
               logo_upload_id uuid, website_channel_id uuid)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select b.id, coalesce(b.display_name, b.legal_name), s.business_address, s.business_phone, br.brand_color,
         br.store_tagline, br.logo_upload_id, c.id
    from businesses b
    join business_branding br on br.business_id = b.id
    left join business_settings s on s.business_id = b.id
    left join sales_channels c on c.business_id = b.id and c.kind = 'WEBSITE' and c.status = 'ACTIVE'
   where b.id = store_business(p_slug)
$$;
revoke execute on function lbg.store_profile(text) from public;
grant execute on function lbg.store_profile(text) to lbgos_app;

-- Published website listings with their available-to-sell (never cost, IMEIs or suppliers).
create function lbg.store_listings(p_slug text)
returns table (listing_id uuid, product_name text, brand text, variant_label text, price_paise bigint,
               available integer)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  with biz as (select store_business(p_slug) as id),
       site as (select c.* from sales_channels c, biz
                 where c.business_id = biz.id and c.kind = 'WEBSITE' and c.status = 'ACTIVE')
  select l.id, p.model_name, br.name,
         nullif(concat_ws(' · ', v.ram, v.storage, v.colour), ''),
         coalesce(l.price_paise, v.selling_price_paise),
         greatest(0, floor(coalesce(sl.quantity, 0))::integer
                     - coalesce((select sum(ol.quantity) from channel_order_lines ol
                                  join channel_orders o on o.business_id = ol.business_id and o.id = ol.order_id
                                  left join invoices i on i.business_id = o.business_id and i.id = o.sale_id
                                 where ol.business_id = l.business_id and ol.variant_id = l.variant_id
                                   and o.status in ('NEW', 'ACCEPTED')
                                   and (o.sale_id is null or i.status in ('DRAFT', 'DISCARDED'))), 0)::integer
                     - site.stock_buffer)
    from site
    join channel_listings l on l.business_id = site.business_id and l.channel_id = site.id and l.published
    join product_variants v on v.business_id = l.business_id and v.id = l.variant_id and v.status = 'ACTIVE'
    join products p on p.business_id = v.business_id and p.id = v.product_id and p.status = 'ACTIVE'
    left join brands br on br.business_id = p.business_id and br.id = p.brand_id
    left join stock_levels sl on sl.business_id = v.business_id and sl.variant_id = v.id and sl.bucket = 'AVAILABLE'
   order by p.model_name, 4 nulls first, l.id
$$;
revoke execute on function lbg.store_listings(text) from public;
grant execute on function lbg.store_listings(text) to lbgos_app;
