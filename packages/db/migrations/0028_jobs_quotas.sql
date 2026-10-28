-- Migration 0028 — job runner, plan quotas and monitoring (increment 8.4:
-- NFR-5, NFR-10, FR-SUB-1 AC2, FR-SUB-3 AC2, D-062).

-- One row per job step per business per tick: what ran, how long, what happened.
create table lbg.job_runs (
  business_id  uuid not null references lbg.businesses(id),
  id           uuid not null default gen_random_uuid(),
  job          text not null check (job ~ '^[a-z_]{1,40}$'),
  status       text not null check (status in ('SUCCEEDED', 'FAILED')),
  processed    integer not null default 0 check (processed >= 0),
  error_code   text check (error_code ~ '^[A-Z0-9_]{1,40}$'),
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  primary key (id),
  check (status <> 'FAILED' or error_code is not null),
  check (finished_at >= started_at)
);
create index job_runs_business_idx on lbg.job_runs (business_id, started_at desc);
create index job_runs_recent_idx on lbg.job_runs (started_at desc);
create trigger job_runs_append_only before update or delete on lbg.job_runs
  for each row execute function lbg.forbid_mutation();

-- Notices sent once (trial ending in 7/3/1 days, quota 80 %/100 % per month).
create table lbg.job_notices (
  business_id  uuid not null references lbg.businesses(id),
  id           uuid not null default gen_random_uuid(),
  notice       text not null check (length(notice) between 1 and 100),
  sent_at      timestamptz not null default now(),
  primary key (id),
  unique (business_id, notice)
);
create trigger job_notices_append_only before update or delete on lbg.job_notices
  for each row execute function lbg.forbid_mutation();

-- FR-SUB-3 AC2: the owner may allow AI use beyond the plan allowance, up to this many extra units a month.
alter table lbg.business_settings
  add column ai_overage_cap_units integer not null default 0 check (ai_overage_cap_units between 0 and 10000000);
grant update (ai_overage_cap_units) on lbg.business_settings to lbgos_app;

do $$
declare
  t text;
begin
  foreach t in array array['job_runs', 'job_notices'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.job_runs, lbg.job_notices to lbgos_app;

-- The job runner works business by business; it needs the list before any
-- tenant context exists. Only live businesses are processed.
create function lbg.job_businesses() returns setof uuid
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select id from businesses where status = 'ACTIVE' order by id
$$;
revoke execute on function lbg.job_businesses() from public;
grant execute on function lbg.job_businesses() to lbgos_app;

-- Notify the active members of the current business who hold a permission
-- (e.g. trial and quota notices to those who manage the business). Only for
-- the business in the caller's tenant context.
create function lbg.notify_permission_holders(p_permission text, p_kind text, p_title text, p_body text)
returns integer
language sql security definer set search_path = lbg, public, pg_temp as $$
  with ins as (
    insert into notifications (user_id, business_id, kind, title, body)
    select distinct m.user_id, m.business_id, p_kind, p_title, p_body
      from memberships m
      join membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
      join role_permissions rp on rp.business_id = mr.business_id and rp.role_id = mr.role_id
     where m.business_id = current_business_id() and m.status = 'ACTIVE' and rp.permission_key = p_permission
    returning 1
  )
  select count(*)::integer from ins
$$;
revoke execute on function lbg.notify_permission_holders(text, text, text, text) from public;
grant execute on function lbg.notify_permission_holders(text, text, text, text) to lbgos_app;

-- Platform monitoring: counts only, never tenant records (D-015).
create function lbg.platform_monitoring(p_hours integer default 24)
returns table (metric text, label text, n bigint)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select 'job', job || ':' || status, count(*) from job_runs
   where started_at > now() - make_interval(hours => p_hours) group by job, status
  union all
  select 'agent_run', status, count(*) from agent_runs
   where created_at > now() - make_interval(hours => p_hours) group by status
  union all
  select 'integration', status, count(*) from integrations where status <> 'REVOKED' group by status
  union all
  select 'business', status, count(*) from businesses group by status
$$;
revoke execute on function lbg.platform_monitoring(integer) from public;
grant execute on function lbg.platform_monitoring(integer) to lbgos_platform;

-- The run guard of 0027, plus: a run that never started and passed its
-- deadline (e.g. after a restart) stops as LIMIT_REACHED (job runner).
create or replace function lbg.agent_run_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'agent runs are kept' using errcode = 'LB001';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'QUEUED' then
      raise exception 'a run starts queued' using errcode = 'LB002';
    end if;
    return new;
  end if;
  if (new.agent, new.user_id, new.idempotency_key, new.question, new.timeout_seconds, new.max_tool_calls,
      new.max_retries, new.budget_units)
     is distinct from (old.agent, old.user_id, old.idempotency_key, old.question, old.timeout_seconds,
                       old.max_tool_calls, old.max_retries, old.budget_units) then
    raise exception 'a run keeps its request and limits' using errcode = 'LB003';
  end if;
  if new.tool_calls < old.tool_calls or new.model_calls < old.model_calls or new.units < old.units
     or new.cost_paise < old.cost_paise then
    raise exception 'usage only grows' using errcode = 'LB003';
  end if;
  if old.status in ('COMPLETED', 'FAILED', 'CANCELLED', 'LIMIT_REACHED') then
    raise exception 'a finished run cannot change' using errcode = 'LB003';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'QUEUED' and new.status in ('RUNNING', 'CANCELLED', 'FAILED', 'LIMIT_REACHED'))
    or (old.status = 'RUNNING' and new.status in ('COMPLETED', 'FAILED', 'CANCELLED', 'LIMIT_REACHED', 'AWAITING_APPROVAL'))
    or (old.status = 'AWAITING_APPROVAL' and new.status in ('RUNNING', 'COMPLETED', 'CANCELLED'))) then
    raise exception 'agent run status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  new.updated_at := now();
  return new;
end
$$;

