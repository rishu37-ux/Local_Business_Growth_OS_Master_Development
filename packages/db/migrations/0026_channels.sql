-- Migration 0026 — official messaging channels (increment 7.6: FR-MSG-1, -2,
-- -4, -5 AC3, NFR-18, D-059): non-secret channel configuration, provider
-- templates (WhatsApp approved templates, DLT-registered SMS templates),
-- webhook idempotency records, the webhook target lookup, and a system actor
-- for work done on a provider's behalf.

-- Non-secret configuration (WhatsApp phone number / account IDs, DLT entity ID and headers).
alter table lbg.integrations
  add column config jsonb not null default '{}'
    check (jsonb_typeof(config) = 'object' and length(config::text) <= 4000);
grant update (config) on lbg.integrations to lbgos_app;

create table lbg.message_templates (
  business_id        uuid not null references lbg.businesses(id),
  id                 uuid not null default gen_random_uuid(),
  integration_id     uuid not null,
  channel            text not null check (channel in ('WHATSAPP', 'SMS')),
  name               text not null check (length(name) between 1 and 512),
  language           text not null default 'en' check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  -- Marketing (promotional) and transactional templates are kept apart (FR-MSG-2 AC2).
  purpose            text not null check (purpose in ('MARKETING', 'TRANSACTIONAL')),
  provider_category  text check (length(provider_category) <= 40),
  body               text not null check (length(body) between 1 and 1024),
  dlt_template_id    text check (dlt_template_id ~ '^\d{10,25}$'),
  status             text not null check (status in ('APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED')),
  -- SYNC: read from the provider; MANUAL: entered as registered on the DLT portal.
  source             text not null check (source in ('SYNC', 'MANUAL')),
  synced_at          timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  unique (business_id, integration_id, name, language),
  foreign key (business_id, integration_id) references lbg.integrations(business_id, id),
  check (channel <> 'SMS' or dlt_template_id is not null),
  check (channel <> 'WHATSAPP' or source = 'SYNC')
);

create function lbg.message_template_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'templates are disabled, not deleted' using errcode = 'LB001';
  end if;
  if (new.integration_id, new.channel, new.name, new.language) is distinct from
     (old.integration_id, old.channel, old.name, old.language) then
    raise exception 'a template keeps its identity' using errcode = 'LB003';
  end if;
  -- A manual (DLT) template's registered text cannot change; register a new one instead.
  if old.source = 'MANUAL' and (new.body, new.purpose, new.dlt_template_id) is distinct from
                               (old.body, old.purpose, old.dlt_template_id) then
    raise exception 'a registered DLT template cannot be edited' using errcode = 'LB003';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger message_templates_guard before update or delete on lbg.message_templates
  for each row execute function lbg.message_template_guard();

-- Each provider event is applied once (NFR-18): the provider's event key per integration.
create table lbg.webhook_events (
  business_id     uuid not null references lbg.businesses(id),
  id              uuid not null default gen_random_uuid(),
  integration_id  uuid not null,
  event_key       text not null check (length(event_key) between 1 and 300),
  kind            text not null check (kind in ('STATUS', 'INBOUND')),
  outcome         text not null check (outcome ~ '^[A-Z_]{1,40}$'),
  received_at     timestamptz not null default now(),
  primary key (id),
  unique (business_id, integration_id, event_key),
  foreign key (business_id, integration_id) references lbg.integrations(business_id, id)
);
create trigger webhook_events_append_only before update or delete on lbg.webhook_events
  for each row execute function lbg.forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['message_templates', 'webhook_events'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.message_templates, lbg.webhook_events to lbgos_app;
grant update (purpose, provider_category, body, status, synced_at) on lbg.message_templates to lbgos_app;
revoke execute on function lbg.message_template_guard() from public;

-- A provider calls the webhook URL of one integration before any tenant
-- context exists: this returns only what is needed to verify the call (the
-- business, provider and secret reference) for a tested channel integration.
create function lbg.webhook_target(p_integration uuid)
returns table (business_id uuid, provider text, category text, secret_id uuid, config jsonb)
language sql stable security definer set search_path = lbg, public, pg_temp as $$
  select i.business_id, i.provider, i.category, i.secret_id, i.config
    from integrations i
   where i.id = p_integration and i.status in ('TESTED', 'VERIFIED')
     and i.provider in ('whatsapp_cloud', 'sms_dlt_json')
$$;
revoke execute on function lbg.webhook_target(uuid) from public;
grant execute on function lbg.webhook_target(uuid) to lbgos_app;

-- The system actor (all-zero UUID) acts for a provider (webhooks); it is no
-- user, so histories record no actor for it.
create or replace function lbg.current_app_user_id() returns uuid
language sql stable set search_path = lbg, public, pg_temp as $$
  select nullif(nullif(current_setting('app.user_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid
$$;
