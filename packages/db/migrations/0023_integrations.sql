-- Migration 0023 — integration records, lifecycle and usage (increment 7.3:
-- FR-HUB-1, -2, -4, -6, FR-SUB-3 AC1–2, WORKFLOWS §10, D-056). Credentials
-- live in integration_secrets (0022); this table holds configuration only.

create table lbg.integrations (
  business_id         uuid not null references lbg.businesses(id),
  id                  uuid not null default gen_random_uuid(),
  category            text not null check (category in ('MESSAGING', 'SMS', 'EMAIL', 'LLM', 'IMAGE_VIDEO', 'OCR',
                        'STORAGE', 'PAYMENTS', 'SOCIAL')),
  provider            text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  label               text not null check (length(label) between 1 and 80),
  -- Tenant-owned now; platform-owned integrations (shared keys) are recorded per tenant too (FR-HUB-6).
  owner               text not null default 'TENANT' check (owner in ('TENANT', 'PLATFORM')),
  auth_method         text not null check (auth_method in ('NONE', 'API_KEY', 'BEARER', 'OAUTH2_CLIENT_CREDENTIALS')),
  base_url            text check (base_url ~ '^https://' and length(base_url) <= 300),
  token_url           text check (token_url ~ '^https://' and length(token_url) <= 300),
  test_path           text check (test_path ~ '^/' and length(test_path) <= 200),
  allowed_port        integer check (allowed_port between 1 and 65535),
  scopes              text[] not null default '{}' check (cardinality(scopes) <= 20),
  model_id            text check (length(model_id) <= 100),
  -- Units per calendar month (business time); null = no limit set. 80 % warns, 100 % stops (FR-SUB-3 AC2).
  monthly_unit_limit  integer check (monthly_unit_limit > 0),
  timeout_ms          integer not null default 15000 check (timeout_ms between 1000 and 60000),
  max_retries         smallint not null default 3 check (max_retries between 0 and 3),
  secret_id           uuid,
  status              text not null default 'PLANNED' check (status in ('PLANNED', 'CONFIGURED', 'TESTED', 'VERIFIED',
                        'FAILED', 'DISABLED', 'REVOKED')),
  status_reason       text check (length(status_reason) <= 200),
  last_success_at     timestamptz,
  last_error_at       timestamptz,
  last_error_code     text check (last_error_code ~ '^[A-Z0-9_]{1,40}$'),
  created_by          uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, secret_id) references lbg.integration_secrets(business_id, id),
  constraint integrations_configured check (status in ('PLANNED', 'REVOKED') or auth_method = 'NONE'
    or secret_id is not null)
);
create index integrations_business_idx on lbg.integrations (business_id, category, status);

-- WORKFLOWS §10, plus: a configuration change sends TESTED/VERIFIED back to
-- CONFIGURED (it must be tested again). REVOKED is terminal.
create function lbg.integration_status_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('PLANNED', 'CONFIGURED') then
      raise exception 'an integration cannot start as %', new.status using errcode = 'LB002';
    end if;
    return new;
  end if;
  if old.status = 'REVOKED' then
    raise exception 'a revoked integration cannot change' using errcode = 'LB003';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'PLANNED' and new.status = 'CONFIGURED')
    or (old.status = 'CONFIGURED' and new.status = 'TESTED')
    or (old.status = 'TESTED' and new.status in ('VERIFIED', 'CONFIGURED'))
    or (old.status = 'VERIFIED' and new.status = 'CONFIGURED')
    or (old.status = 'FAILED' and new.status = 'CONFIGURED')
    or (old.status = 'DISABLED' and new.status = 'CONFIGURED')
    or (new.status in ('FAILED', 'DISABLED', 'REVOKED'))) then
    raise exception 'integration status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  if new.status = 'FAILED' and new.status is distinct from old.status and old.status in ('PLANNED', 'DISABLED') then
    raise exception 'integration status % -> FAILED not allowed', old.status using errcode = 'LB002';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger integrations_status_guard before insert or update on lbg.integrations
  for each row execute function lbg.integration_status_guard();
create trigger integrations_no_delete before delete on lbg.integrations
  for each row execute function lbg.forbid_mutation();

-- Every test and provider call: result, latency, units and cost (FR-HUB-4 AC3–4, FR-SUB-3 AC1, FR-AIC-5 AC1).
create table lbg.integration_calls (
  business_id     uuid not null,
  id              uuid not null default gen_random_uuid(),
  integration_id  uuid not null,
  kind            text not null check (kind in ('TEST', 'CALL')),
  purpose         text not null check (purpose ~ '^[a-z][a-z0-9_.]{1,59}$'),
  ok              boolean not null,
  latency_ms      integer check (latency_ms >= 0),
  error_code      text check (error_code ~ '^[A-Z0-9_]{1,40}$'),
  units           integer not null default 0 check (units >= 0),
  -- Estimated before (where a price is known) and recorded after (where the provider reports it).
  estimated_cost_paise bigint check (estimated_cost_paise >= 0),
  cost_paise      bigint check (cost_paise >= 0),
  user_id         uuid,
  at              timestamptz not null default clock_timestamp(),
  primary key (id),
  foreign key (business_id, integration_id) references lbg.integrations(business_id, id),
  check (ok or error_code is not null)
);
create index integration_calls_recent_idx on lbg.integration_calls (business_id, integration_id, at desc);
create trigger integration_calls_append_only before update or delete on lbg.integration_calls
  for each row execute function lbg.forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['integrations', 'integration_calls'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.integrations, lbg.integration_calls to lbgos_app;
grant update (label, base_url, token_url, test_path, allowed_port, scopes, model_id, monthly_unit_limit, timeout_ms,
              max_retries, secret_id, status, status_reason, last_success_at, last_error_at, last_error_code)
  on lbg.integrations to lbgos_app;
revoke execute on function lbg.integration_status_guard() from public;
