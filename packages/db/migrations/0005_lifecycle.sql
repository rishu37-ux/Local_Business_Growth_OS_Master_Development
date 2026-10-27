-- Migration 0005 — business application lifecycle and role provisioning
-- (BR-T1…T4, FR-ONB-1, FR-RBAC-1). The tenant role cannot change business
-- status or create roles directly; these narrow SECURITY DEFINER functions do
-- exactly one checked thing each. New error codes:
--   LB006 duplicate open application   LB007 application not editable in its status
--   LB008 not a member of the business LB009 business already provisioned

-- Self-registration (BR-T1): the applicant becomes a member immediately, with
-- no roles; until approval that membership grants application access only.
create or replace function lbg.register_application(p_legal_name text, p_category text, p_state_code char(2))
returns uuid
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_user uuid := current_app_user_id();
  v_id uuid;
begin
  if v_user is null or not exists (select 1 from users where id = v_user) then
    raise exception 'no signed-in user with a profile' using errcode = 'LB008';
  end if;
  -- FR-ONB-1 AC3: one open application per person.
  if exists (select 1 from memberships m join businesses b on b.id = m.business_id
              where m.user_id = v_user and b.status in ('PENDING_APPROVAL', 'CHANGES_REQUESTED')) then
    raise exception 'an application is already open' using errcode = 'LB006';
  end if;
  insert into businesses (legal_name, category, state_code, status)
  values (p_legal_name, p_category, p_state_code, 'PENDING_APPROVAL')
  returning id into v_id;
  insert into memberships (business_id, user_id, status) values (v_id, v_user, 'ACTIVE');
  insert into business_status_events (business_id, from_status, to_status, actor_user_id)
  values (v_id, null, 'PENDING_APPROVAL', v_user);
  return v_id;
end
$$;

-- The caller's businesses (before a business is chosen there is no tenant context).
create function lbg.my_businesses()
returns table (business_id uuid, legal_name text, display_name text, status text, membership_status text)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select b.id, b.legal_name, b.display_name, b.status, m.status
    from memberships m join businesses b on b.id = m.business_id
   where m.user_id = current_app_user_id()
   order by b.created_at
$$;

-- Applicant edits while the application is open (columns the tenant role cannot update directly).
create function lbg.update_application(p_business uuid, p_legal_name text, p_category text, p_state_code char(2))
returns void
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_status text;
begin
  if not exists (select 1 from memberships where business_id = p_business and user_id = current_app_user_id()
                  and status = 'ACTIVE') then
    raise exception 'not a member of this business' using errcode = 'LB008';
  end if;
  select status into v_status from businesses where id = p_business for update;
  if v_status not in ('PENDING_APPROVAL', 'CHANGES_REQUESTED') then
    raise exception 'application cannot be edited in status %', v_status using errcode = 'LB007';
  end if;
  update businesses set legal_name = p_legal_name, category = p_category, state_code = p_state_code
   where id = p_business;
end
$$;

-- CHANGES_REQUESTED → PENDING_APPROVAL by the applicant (WORKFLOWS.md §1).
create function lbg.resubmit_application(p_business uuid)
returns void
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_status text;
begin
  if not exists (select 1 from memberships where business_id = p_business and user_id = current_app_user_id()
                  and status = 'ACTIVE') then
    raise exception 'not a member of this business' using errcode = 'LB008';
  end if;
  select status into v_status from businesses where id = p_business for update;
  if v_status <> 'CHANGES_REQUESTED' then
    raise exception 'only an application with requested changes can be resubmitted' using errcode = 'LB007';
  end if;
  update businesses set status = 'PENDING_APPROVAL' where id = p_business;
  insert into business_status_events (business_id, from_status, to_status, actor_user_id)
  values (p_business, 'CHANGES_REQUESTED', 'PENDING_APPROVAL', current_app_user_id());
  insert into audit_events (scope, business_id, actor_type, actor_user_id, action, target_type, target_id)
  values ('TENANT', p_business, 'USER', current_app_user_id(), 'application.resubmit', 'business', p_business);
end
$$;

-- Applicant details for the platform review queue (the platform role has no
-- grants on memberships).
create function lbg.application_applicants(p_business uuid)
returns table (user_id uuid, email citext, display_name text)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select u.id, u.email, u.display_name
    from memberships m join users u on u.id = m.user_id
   where m.business_id = p_business
$$;

-- On approval (platform role): create the default roles passed in as JSON
-- (templates live in @lbgos/domain) and make the current members Owners.
-- p_roles: [{"name": "...", "isSystem": bool, "permissions": [{"key": "...", "limits": {...}|null}]}]
create function lbg.provision_business(p_business uuid, p_roles jsonb)
returns integer
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
declare
  v_status text;
  v_role jsonb;
  v_perm jsonb;
  v_role_id uuid;
  v_owner_role uuid;
  v_count integer := 0;
begin
  select status into v_status from businesses where id = p_business for update;
  if v_status is distinct from 'APPROVED_SETUP_PENDING' then
    raise exception 'business must be APPROVED_SETUP_PENDING to provision (is %)', v_status using errcode = 'LB007';
  end if;
  if exists (select 1 from roles where business_id = p_business) then
    raise exception 'business already provisioned' using errcode = 'LB009';
  end if;
  for v_role in select * from jsonb_array_elements(p_roles) loop
    insert into roles (business_id, name, is_system)
    values (p_business, v_role->>'name', coalesce((v_role->>'isSystem')::boolean, false))
    returning id into v_role_id;
    v_count := v_count + 1;
    if (v_role->>'isSystem')::boolean and v_role->>'name' = 'Owner' then
      v_owner_role := v_role_id;
    end if;
    for v_perm in select * from jsonb_array_elements(v_role->'permissions') loop
      insert into role_permissions (business_id, role_id, permission_key, limits)
      values (p_business, v_role_id, v_perm->>'key', nullif(v_perm->'limits', 'null'::jsonb));
    end loop;
  end loop;
  if v_owner_role is null then
    raise exception 'templates must include the system Owner role' using errcode = '22023';
  end if;
  insert into membership_roles (business_id, membership_id, role_id)
  select p_business, m.id, v_owner_role from memberships m where m.business_id = p_business and m.status = 'ACTIVE';
  return v_count;
end
$$;

revoke execute on function lbg.my_businesses(), lbg.update_application(uuid, text, text, char),
  lbg.resubmit_application(uuid), lbg.application_applicants(uuid), lbg.provision_business(uuid, jsonb) from public;
grant execute on function lbg.my_businesses(), lbg.update_application(uuid, text, text, char),
  lbg.resubmit_application(uuid) to lbgos_app;
grant execute on function lbg.application_applicants(uuid), lbg.provision_business(uuid, jsonb) to lbgos_platform;

-- APPROVED_SETUP_PENDING → ACTIVE once setup is complete (FR-ONB-2 AC3). Only an
-- Owner may activate. The API additionally requires the owner's MFA, which the
-- database cannot see (it lives in schema auth).
create function lbg.activate_business(p_business uuid)
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
  update businesses set status = 'ACTIVE' where id = p_business;
  insert into business_status_events (business_id, from_status, to_status, actor_user_id)
  values (p_business, 'APPROVED_SETUP_PENDING', 'ACTIVE', current_app_user_id());
  insert into audit_events (scope, business_id, actor_type, actor_user_id, action, target_type, target_id)
  values ('TENANT', p_business, 'USER', current_app_user_id(), 'business.activate', 'business', p_business);
end
$$;
revoke execute on function lbg.activate_business(uuid) from public;
grant execute on function lbg.activate_business(uuid) to lbgos_app;
