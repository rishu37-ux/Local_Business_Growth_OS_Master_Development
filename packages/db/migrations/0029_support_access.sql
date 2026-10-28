-- Migration 0029 — owner-granted, time-boxed platform support access
-- (increment 10.1: FR-SUP-1, threat T8, D-067). A grant lets platform support
-- read one business for a stated purpose, for at most 72 hours. It can be
-- revoked once and never edited or deleted; every use is a tenant audit event.

create table lbg.support_grants (
  business_id  uuid not null references lbg.businesses(id),
  id           uuid not null default gen_random_uuid(),
  granted_by   uuid not null,
  purpose      text not null check (length(purpose) between 10 and 500),
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  revoked_by   uuid,
  primary key (id),
  check (expires_at > granted_at and expires_at <= granted_at + interval '72 hours'),
  check ((revoked_at is null) = (revoked_by is null))
);
create index support_grants_active_idx on lbg.support_grants (business_id, expires_at desc) where revoked_at is null;

-- Only revocation may change a grant, only once, and the time is the database's.
create function lbg.support_grant_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'support grants cannot be deleted' using errcode = '42501';
  end if;
  if old.revoked_at is not null then
    raise exception 'support grant already revoked' using errcode = '22023';
  end if;
  if new.revoked_by is null
     or (new.business_id, new.id, new.granted_by, new.purpose, new.granted_at, new.expires_at)
        is distinct from (old.business_id, old.id, old.granted_by, old.purpose, old.granted_at, old.expires_at) then
    raise exception 'only revocation may change a support grant' using errcode = '22023';
  end if;
  new.revoked_at := now();
  return new;
end
$$;
create trigger support_grants_guard before update or delete on lbg.support_grants
  for each row execute function lbg.support_grant_guard();

-- The grant is created with the database's clock.
create function lbg.support_grant_times() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  new.granted_at := now();
  new.revoked_at := null;
  new.revoked_by := null;
  return new;
end
$$;
create trigger support_grants_times before insert on lbg.support_grants
  for each row execute function lbg.support_grant_times();

alter table lbg.support_grants enable row level security;
alter table lbg.support_grants force row level security;
create policy tenant_isolation on lbg.support_grants to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.support_grants to lbgos_app;
grant update (revoked_by) on lbg.support_grants to lbgos_app;
