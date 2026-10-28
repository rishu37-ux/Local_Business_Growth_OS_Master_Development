-- Migration 0031 — shop branding and the public online store settings
-- (increments 11.1 and 11.4: FR-ONB-2 AC1, D-069). The logo is an upload of
-- this business (PNG/JPEG, checked by the module); the brand colour is used
-- for accents only. The store address (slug) is public and unique across the
-- platform; the public website reads only through the definer functions in
-- migration 0032.

create table lbg.business_branding (
  business_id     uuid primary key references lbg.businesses(id),
  logo_upload_id  uuid,
  brand_color     text check (brand_color ~ '^#[0-9a-f]{6}$'),
  store_slug      text unique check (store_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$'
                                     and store_slug !~ '--'
                                     and store_slug not in ('admin', 'api', 'app', 'assets', 'help', 'login',
                                                            'platform', 'shop', 'sign-in', 'store', 'support', 'www')),
  store_enabled   boolean not null default false,
  store_tagline   text check (length(store_tagline) between 1 and 120),
  updated_at      timestamptz not null default now(),
  foreign key (business_id, logo_upload_id) references lbg.uploads(business_id, id),
  -- A store cannot be switched on without an address.
  constraint store_needs_slug check (not store_enabled or store_slug is not null)
);

alter table lbg.business_branding enable row level security;
alter table lbg.business_branding force row level security;
create policy tenant_isolation on lbg.business_branding to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.business_branding to lbgos_app;
grant update (logo_upload_id, brand_color, store_slug, store_enabled, store_tagline, updated_at)
  on lbg.business_branding to lbgos_app;
