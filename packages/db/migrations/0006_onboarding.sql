-- Migration 0006 — onboarding: settings, tax profile, setup progress,
-- invitations, notifications, seed plans (FR-ONB-1…3, FR-AUTH-3 AC3, FR-SUB-1/2).
-- New error codes: LB010 invitation not usable (not found, expired, used or
-- revoked; one code so a token reveals nothing), LB011 invitation is for a
-- different email address.

create table lbg.business_settings (
  business_id        uuid primary key references lbg.businesses(id),
  require_staff_mfa  boolean not null default false,               -- FR-AUTH-3 AC3
  print_size         text not null default 'A4' check (print_size in ('A4', 'A5', '80MM', '58MM')),
  week_start         smallint not null default 1 check (week_start between 1 and 7),  -- 1 = Monday
  updated_at         timestamptz not null default now()
);

-- Tax registration as entered by the owner. Format/checksum is validated; no
-- claim is made that the GSTIN is registered (FR-ONB-2 AC4).
create table lbg.tax_profiles (
  business_id        uuid primary key references lbg.businesses(id),
  registration_type  text not null check (registration_type in ('REGULAR', 'COMPOSITION', 'UNREGISTERED')),
  gstin              text check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code         char(2) not null check (state_code ~ '^[0-9]{2}$'),
  updated_at         timestamptz not null default now(),
  check ((registration_type = 'UNREGISTERED') = (gstin is null)),
  check (gstin is null or substr(gstin, 1, 2) = state_code)
);

create table lbg.business_setup (
  business_id      uuid primary key references lbg.businesses(id),
  completed_steps  text[] not null default '{}',
  updated_at       timestamptz not null default now()
);

-- Invitations carry only a SHA-256 of the token; the token itself is emailed.
create table lbg.invitations (
  business_id  uuid not null references lbg.businesses(id),
  id           uuid not null default gen_random_uuid(),
  email        citext not null,
  role_ids     uuid[] not null,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by   uuid,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  check (expires_at > created_at)
);

-- Per-user notifications (FR-ONB-3). Written only by definer functions.
create table lbg.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references lbg.users(id),
  business_id  uuid references lbg.businesses(id),
  kind         text not null check (kind ~ '^[a-z_]+(\.[a-z_]+)+$'),
  title        text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index notifications_user_idx on lbg.notifications (user_id, created_at desc);

-- RLS: the three tenant tables use the standard tenant policy.
do $$
declare
  t text;
begin
  foreach t in array array['business_settings', 'tax_profiles', 'business_setup', 'invitations'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
alter table lbg.notifications enable row level security;
alter table lbg.notifications force row level security;
create policy notifications_own on lbg.notifications for select to lbgos_app
  using (user_id = lbg.current_app_user_id());
create policy notifications_mark_read on lbg.notifications for update to lbgos_app
  using (user_id = lbg.current_app_user_id()) with check (user_id = lbg.current_app_user_id());

grant select, insert, update on lbg.business_settings, lbg.tax_profiles, lbg.business_setup to lbgos_app;
grant select, insert on lbg.invitations to lbgos_app;
grant update (revoked_at) on lbg.invitations to lbgos_app;
grant select on lbg.notifications to lbgos_app;
grant update (read_at) on lbg.notifications to lbgos_app;

-- Notify every active member of a business (platform decisions, FR-ONB-3 AC1).
create function lbg.notify_business_members(p_business uuid, p_kind text, p_title text, p_body text)
returns integer
language sql security definer set search_path = lbg, public, pg_temp as $$
  with ins as (
    insert into notifications (user_id, business_id, kind, title, body)
    select m.user_id, p_business, p_kind, p_title, p_body
      from memberships m where m.business_id = p_business and m.status = 'ACTIVE'
    returning 1
  )
  select count(*)::integer from ins
$$;

-- Accept an invitation as the signed-in user (FR-ONB-2 "users" step).
create function lbg.accept_invitation(p_token_hash text)
returns uuid
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_user uuid := current_app_user_id();
  v_inv invitations%rowtype;
  v_email citext;
  v_membership uuid;
begin
  select * into v_inv from invitations where token_hash = p_token_hash for update;
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'invitation is not valid' using errcode = 'LB010';
  end if;
  select email into v_email from users where id = v_user;
  if v_email is null or v_email <> v_inv.email then
    raise exception 'invitation is for a different email address' using errcode = 'LB011';
  end if;
  insert into memberships (business_id, user_id, status) values (v_inv.business_id, v_user, 'ACTIVE')
  on conflict (business_id, user_id) do update set status = 'ACTIVE'
  returning id into v_membership;
  delete from membership_roles where business_id = v_inv.business_id and membership_id = v_membership;
  insert into membership_roles (business_id, membership_id, role_id)
  select v_inv.business_id, v_membership, r from unnest(v_inv.role_ids) as r;
  update invitations set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
  insert into audit_events (scope, business_id, actor_type, actor_user_id, action, target_type, target_id)
  values ('TENANT', v_inv.business_id, 'USER', v_user, 'invitation.accept', 'invitation', v_inv.id);
  return v_inv.business_id;
end
$$;

-- Platform-created business: invite its owner (FR-ONB-1 AC2).
create function lbg.create_owner_invitation(p_business uuid, p_email citext, p_token_hash text, p_expires timestamptz,
                                            p_invited_by uuid)
returns uuid
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_owner_role uuid;
  v_id uuid;
begin
  select id into v_owner_role from roles where business_id = p_business and is_system and name = 'Owner';
  if v_owner_role is null then
    raise exception 'business has no Owner role yet' using errcode = 'LB007';
  end if;
  insert into invitations (business_id, email, role_ids, token_hash, invited_by, expires_at)
  values (p_business, p_email, array[v_owner_role], p_token_hash, p_invited_by, p_expires)
  returning id into v_id;
  return v_id;
end
$$;

-- Owners can require MFA for all staff (FR-AUTH-3 AC3).
create or replace function lbg.user_requires_mfa(p_user uuid)
returns boolean
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select exists (select 1 from platform_admins where user_id = p_user)
      or exists (
           select 1
             from memberships m
             join membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
             join roles r on r.business_id = mr.business_id and r.id = mr.role_id
            where m.user_id = p_user and m.status = 'ACTIVE' and r.is_system and r.name = 'Owner')
      or exists (
           select 1 from memberships m join business_settings s on s.business_id = m.business_id
            where m.user_id = p_user and m.status = 'ACTIVE' and s.require_staff_mfa)
$$;

-- Activation also needs a tax profile (FR-ONB-2 AC3 required steps).
create or replace function lbg.activate_business(p_business uuid)
returns void
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_business businesses%rowtype;
begin
  if not exists (
    select 1 from memberships m
      join membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
      join roles r on r.business_id = mr.business_id and r.id = mr.role_id
     where m.business_id = p_business and m.user_id = current_app_user_id() and m.status = 'ACTIVE'
       and r.is_system and r.name = 'Owner') then
    raise exception 'only an owner can activate the business' using errcode = 'LB008';
  end if;
  select * into v_business from businesses where id = p_business for update;
  if v_business.status <> 'APPROVED_SETUP_PENDING' then
    raise exception 'business is % and cannot be activated', v_business.status using errcode = 'LB007';
  end if;
  if v_business.state_code is null then
    raise exception 'business state is required before activation' using errcode = 'LB007';
  end if;
  if not exists (select 1 from tax_profiles where business_id = p_business) then
    raise exception 'tax configuration is required before activation' using errcode = 'LB007';
  end if;
  update businesses set status = 'ACTIVE' where id = p_business;
  insert into business_status_events (business_id, from_status, to_status, actor_user_id)
  values (p_business, 'APPROVED_SETUP_PENDING', 'ACTIVE', current_app_user_id());
  insert into audit_events (scope, business_id, actor_type, actor_user_id, action, target_type, target_id)
  values ('TENANT', p_business, 'USER', current_app_user_id(), 'business.activate', 'business', p_business);
end
$$;

revoke execute on function lbg.notify_business_members(uuid, text, text, text), lbg.accept_invitation(text),
  lbg.create_owner_invitation(uuid, citext, text, timestamptz, uuid) from public;
grant execute on function lbg.accept_invitation(text) to lbgos_app;
grant execute on function lbg.notify_business_members(uuid, text, text, text),
  lbg.create_owner_invitation(uuid, citext, text, timestamptz, uuid) to lbgos_platform;

-- Seed plans: the prompt's suggested pilot prices (§12), explicitly unvalidated.
-- Limits are intentionally empty: they are product decisions not yet made.
alter table lbg.plans add column pilot_pricing boolean not null default false;
alter table lbg.plans add column notes text;
insert into lbg.plans (code, name, price_paise, billing_period, limits, pilot_pricing, notes) values
  ('STARTER', 'Starter', 99900, 'MONTH', '{}', true, 'Pilot pricing — to be validated with pilot customers; not a market price.'),
  ('GROWTH', 'Growth', 199900, 'MONTH', '{}', true, 'Pilot pricing — to be validated with pilot customers; not a market price.'),
  ('PRO', 'Pro', 349900, 'MONTH', '{}', true, 'Pilot pricing — to be validated with pilot customers; not a market price.');
