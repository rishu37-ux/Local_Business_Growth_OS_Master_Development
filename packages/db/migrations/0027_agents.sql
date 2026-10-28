-- Migration 0027 — AI agent runs (increment 8.1: FR-AGT-3, -5, -6,
-- WORKFLOWS §12, D-061). A run is one question to one assistant by one user;
-- its steps (model calls, tool calls, proposals) are append-only. Records
-- hold references and redacted summaries, never secret values.

create table lbg.agent_runs (
  business_id      uuid not null references lbg.businesses(id),
  id               uuid not null default gen_random_uuid(),
  agent            text not null check (agent in ('INVENTORY', 'FINANCE', 'CRM', 'MARKETING', 'GROWTH')),
  user_id          uuid not null,
  idempotency_key  text not null check (length(idempotency_key) between 8 and 100),
  -- The question with mobile numbers and email addresses masked.
  question         text not null check (length(question) between 1 and 1000),
  status           text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED',
                     'CANCELLED', 'LIMIT_REACHED', 'AWAITING_APPROVAL')),
  status_reason    text check (length(status_reason) <= 200),
  -- Limits (FR-AGT-5 AC1).
  timeout_seconds  integer not null default 120 check (timeout_seconds between 5 and 600),
  max_tool_calls   integer not null default 20 check (max_tool_calls between 1 and 50),
  max_retries      integer not null default 3 check (max_retries between 0 and 3),
  budget_units     integer not null default 4000 check (budget_units > 0),
  -- Usage so far.
  tool_calls       integer not null default 0 check (tool_calls >= 0),
  model_calls      integer not null default 0 check (model_calls >= 0),
  units            integer not null default 0 check (units >= 0),
  cost_paise       bigint not null default 0 check (cost_paise >= 0),
  -- The answer: facts from tool results, the model's suggestions, post-check flags.
  answer           jsonb,
  started_at       timestamptz,
  deadline_at      timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (business_id, user_id, idempotency_key),
  check (status not in ('FAILED', 'LIMIT_REACHED', 'CANCELLED') or status_reason is not null)
);
create index agent_runs_business_idx on lbg.agent_runs (business_id, created_at desc);
create index agent_runs_active_idx on lbg.agent_runs (status, deadline_at) where status in ('QUEUED', 'RUNNING');

create function lbg.agent_run_guard() returns trigger
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
       (old.status = 'QUEUED' and new.status in ('RUNNING', 'CANCELLED', 'FAILED'))
    or (old.status = 'RUNNING' and new.status in ('COMPLETED', 'FAILED', 'CANCELLED', 'LIMIT_REACHED', 'AWAITING_APPROVAL'))
    or (old.status = 'AWAITING_APPROVAL' and new.status in ('RUNNING', 'COMPLETED', 'CANCELLED'))) then
    raise exception 'agent run status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger agent_runs_guard before insert or update or delete on lbg.agent_runs
  for each row execute function lbg.agent_run_guard();

-- Steps: what the model asked for and what the tool did (FR-AGT-6 AC1).
create table lbg.agent_steps (
  business_id    uuid not null,
  id             uuid not null default gen_random_uuid(),
  run_id         uuid not null,
  seq            integer not null check (seq >= 1),
  kind           text not null check (kind in ('MODEL', 'TOOL', 'PROPOSAL', 'DECISION')),
  tool           text check (tool ~ '^[a-z_]{1,40}$'),
  -- Validated arguments and a summary of the result (references, counts, figures; redacted).
  arguments      jsonb,
  result         jsonb,
  error_code     text check (error_code ~ '^[A-Z0-9_]{1,40}$'),
  approval_id    uuid,
  units          integer not null default 0 check (units >= 0),
  created_at     timestamptz not null default now(),
  primary key (id),
  unique (business_id, run_id, seq),
  foreign key (business_id, run_id) references lbg.agent_runs(business_id, id),
  foreign key (business_id, approval_id) references lbg.approval_requests(business_id, id)
);
create trigger agent_steps_append_only before update or delete on lbg.agent_steps
  for each row execute function lbg.forbid_mutation();

-- The expected effect of an approval request, computed deterministically when
-- it is created (FR-AGT-4 AC2: e.g. "Available stock of X goes from 4 to 3").
alter table lbg.approval_requests add column effect text check (length(effect) <= 300);
create or replace function lbg.approval_request_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if new.business_id is distinct from old.business_id or new.requested_by is distinct from old.requested_by
     or new.action_type is distinct from old.action_type or new.payload is distinct from old.payload
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.required_permission is distinct from old.required_permission
     or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at
     or new.reason is distinct from old.reason or new.effect is distinct from old.effect then
    raise exception 'an approval request cannot be edited' using errcode = 'LB017';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'PENDING' and new.status in ('APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    or (old.status = 'APPROVED' and new.status in ('EXECUTED', 'EXECUTION_FAILED'))) then
    raise exception 'approval status % -> % not allowed', old.status, new.status using errcode = 'LB017';
  end if;
  if old.status not in ('PENDING', 'APPROVED') and new is distinct from old then
    raise exception 'a % approval request is final', old.status using errcode = 'LB017';
  end if;
  return new;
end
$$;

-- Daily agent budget per business (FR-AGT-5 AC1), in model units.
alter table lbg.business_settings
  add column agent_daily_unit_limit integer not null default 20000 check (agent_daily_unit_limit > 0);

do $$
declare
  t text;
begin
  foreach t in array array['agent_runs', 'agent_steps'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.agent_runs, lbg.agent_steps to lbgos_app;
grant update (status, status_reason, tool_calls, model_calls, units, cost_paise, answer, started_at, deadline_at,
              finished_at) on lbg.agent_runs to lbgos_app;
grant update (agent_daily_unit_limit) on lbg.business_settings to lbgos_app;
revoke execute on function lbg.agent_run_guard() from public;
