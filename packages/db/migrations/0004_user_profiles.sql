-- Migration 0004 — identities live in schema auth; lbg.users is profile only.
-- Platform admins are recorded in a table the tenant role cannot reach.

-- Credentials and MFA state belong to the auth schema (D-019, threat T32).
alter table lbg.users drop column password_hash;
alter table lbg.users drop column mfa_enabled;

-- Users may edit only their own non-privileged profile fields.
revoke update on lbg.users from lbgos_app;
grant update (display_name, mobile_e164) on lbg.users to lbgos_app;

create table lbg.platform_admins (
  user_id     uuid primary key references lbg.users(id),
  granted_by  uuid references lbg.users(id),
  granted_at  timestamptz not null default now()
);
alter table lbg.platform_admins enable row level security;
alter table lbg.platform_admins force row level security;
create policy platform_admins_read on lbg.platform_admins for select to lbgos_platform using (true);
grant select on lbg.platform_admins to lbgos_platform;
-- Granting platform admin is an operator action run as the owner role (see DEPLOYMENT_RUNBOOK.md).

-- Called by the auth module after sign-up so every identity has a profile row
-- with the same ID. Lives in schema auth because lbgos_auth has no access to lbg.
create function auth.create_user_profile(p_id uuid, p_email citext, p_display_name text)
returns void
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
begin
  insert into lbg.users (id, email, display_name) values (p_id, p_email, p_display_name)
  on conflict (id) do nothing;
end
$$;
revoke execute on function auth.create_user_profile(uuid, citext, text) from public;
grant execute on function auth.create_user_profile(uuid, citext, text) to lbgos_auth;

-- Platform-scope audit events from the auth module (e.g. lockouts, FR-AUTH-4 AC3).
create function auth.record_auth_event(p_action text, p_user_id uuid, p_metadata jsonb)
returns void
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
begin
  if p_action !~ '^auth\.[a-z_.]+$' then
    raise exception 'invalid auth audit action %', p_action using errcode = '22023';
  end if;
  insert into lbg.audit_events (scope, actor_type, actor_user_id, action, metadata)
  values ('PLATFORM', 'SYSTEM', p_user_id, p_action, coalesce(p_metadata, '{}'::jsonb));
end
$$;
revoke execute on function auth.record_auth_event(text, uuid, jsonb) from public;
grant execute on function auth.record_auth_event(text, uuid, jsonb) to lbgos_auth;

-- MFA is mandatory for platform admins and business owners (D-011). Readable
-- by the request roles without exposing the underlying tables.
create function lbg.user_requires_mfa(p_user uuid)
returns boolean
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select exists (select 1 from platform_admins where user_id = p_user)
      or exists (
           select 1
             from memberships m
             join membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
             join roles r on r.business_id = mr.business_id and r.id = mr.role_id
            where m.user_id = p_user and m.status = 'ACTIVE' and r.is_system and r.name = 'Owner')
$$;
revoke execute on function lbg.user_requires_mfa(uuid) from public;
grant execute on function lbg.user_requires_mfa(uuid) to lbgos_app, lbgos_platform;
