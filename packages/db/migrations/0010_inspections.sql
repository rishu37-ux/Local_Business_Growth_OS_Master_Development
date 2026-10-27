-- Migration 0010 — inspection records (increment 4.4: FR-INV-6 AC2–3).
-- Each inspection outcome is recorded once (append-only) together with the
-- stock movements it caused (reference_type 'INSPECTION').

create table lbg.inspections (
  business_id   uuid not null,
  id            uuid not null default gen_random_uuid(),
  variant_id    uuid not null,
  unit_id       uuid,
  quantity      numeric(12,3) not null check (quantity > 0),
  from_bucket   text not null check (from_bucket in ('INSPECTION', 'REPAIR')),
  outcome       text not null check (outcome in ('RESTOCK', 'DAMAGED', 'REPAIR', 'RETURN_TO_SUPPLIER', 'REPAIRED')),
  notes         text check (length(notes) <= 1000),
  inspected_by  uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, variant_id) references lbg.product_variants(business_id, id),
  foreign key (business_id, unit_id) references lbg.serialized_units(business_id, id),
  check (unit_id is null or quantity = 1),
  -- Only units in repair can come back from repair; REPAIRED returns them to inspection.
  check ((from_bucket = 'REPAIR') = (outcome = 'REPAIRED'))
);
create trigger inspections_append_only before update or delete on lbg.inspections
  for each row execute function lbg.forbid_mutation();

alter table lbg.inspections enable row level security;
alter table lbg.inspections force row level security;
create policy tenant_isolation on lbg.inspections to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.inspections to lbgos_app;
