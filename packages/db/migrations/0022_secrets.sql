-- Migration 0022 — sealed integration secrets (increment 7.2: FR-HUB-3,
-- ADR-13, D-055). Values are envelope-encrypted by the application with keys
-- held outside the database; this table holds only ciphertext and metadata.
-- The tenant role can write a secret and read its metadata, never the sealed
-- material; only lbgos_secrets (used by the secrets module when an adapter
-- needs the value) can read it. Revoking destroys the sealed material.
-- New error code: LB022 sealed material may only be destroyed with the revocation.

create table lbg.integration_secrets (
  business_id         uuid not null references lbg.businesses(id),
  id                  uuid not null,
  purpose             text not null check (purpose ~ '^[a-z][a-z0-9_]{1,39}$'),
  label               text not null check (length(label) between 1 and 80),
  -- Last 4 characters of a long value (null for short ones); never more.
  hint                text check (length(hint) = 4),
  kek_version         text check (kek_version ~ '^[a-z0-9_-]{1,20}$'),
  wrapped_key         bytea check (length(wrapped_key) = 60),
  payload             bytea check (length(payload) between 29 and 8192),
  replaces_secret_id  uuid,
  created_by          uuid not null,
  created_at          timestamptz not null default now(),
  rewrapped_at        timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid,
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, replaces_secret_id) references lbg.integration_secrets(business_id, id),
  constraint integration_secrets_material check (
    (revoked_at is null and kek_version is not null and wrapped_key is not null and payload is not null)
    or (revoked_at is not null and wrapped_key is null and payload is null))
);
create index integration_secrets_business_idx on lbg.integration_secrets (business_id, created_at desc);

-- Allowed changes: revoke once (material destroyed in the same update) and,
-- for the secrets role, rewrap the data key under a newer KEK.
create function lbg.integration_secret_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'secrets are revoked, not deleted' using errcode = 'LB001';
  end if;
  if (new.business_id, new.id, new.purpose, new.label, new.hint, new.replaces_secret_id, new.created_by, new.created_at)
     is distinct from (old.business_id, old.id, old.purpose, old.label, old.hint, old.replaces_secret_id, old.created_by,
                       old.created_at) then
    raise exception 'a secret cannot be edited; store a new one' using errcode = 'LB001';
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked secret cannot change' using errcode = 'LB001';
  end if;
  if new.revoked_at is not null then
    if new.wrapped_key is not null or new.payload is not null then
      raise exception 'revoking must destroy the sealed material' using errcode = 'LB022';
    end if;
    return new;
  end if;
  -- Rewrap: only the KEK version and the wrapped data key change, only by the secrets role; the payload stays.
  if new.payload is distinct from old.payload then
    raise exception 'the sealed value cannot be replaced' using errcode = 'LB022';
  end if;
  if (new.kek_version, new.wrapped_key) is distinct from (old.kek_version, old.wrapped_key)
     and current_user <> 'lbgos_secrets' then
    raise exception 'only the secrets role rewraps data keys' using errcode = 'LB022';
  end if;
  return new;
end
$$;
create trigger integration_secrets_guard before update or delete on lbg.integration_secrets
  for each row execute function lbg.integration_secret_guard();

alter table lbg.integration_secrets enable row level security;
alter table lbg.integration_secrets force row level security;
create policy tenant_isolation on lbg.integration_secrets to lbgos_app, lbgos_secrets
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());

grant usage on schema lbg to lbgos_secrets;
grant execute on function lbg.current_business_id(), lbg.current_app_user_id() to lbgos_secrets;
-- Tenant role: insert a sealed secret; read metadata only; revoke.
grant insert on lbg.integration_secrets to lbgos_app;
grant select (business_id, id, purpose, label, hint, kek_version, replaces_secret_id, created_by, created_at,
              rewrapped_at, revoked_at, revoked_by)
  on lbg.integration_secrets to lbgos_app;
grant update (revoked_at, revoked_by, wrapped_key, payload) on lbg.integration_secrets to lbgos_app;
-- Secrets role: read everything; rewrap.
grant select on lbg.integration_secrets to lbgos_secrets;
grant update (kek_version, wrapped_key, rewrapped_at) on lbg.integration_secrets to lbgos_secrets;
revoke execute on function lbg.integration_secret_guard() from public;
