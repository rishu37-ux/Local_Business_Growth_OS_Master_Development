-- Migration 0018 — consent, suppression and messages (increment 6.2: FR-CON-1,
-- FR-MSG-1 AC3–4, WORKFLOWS §9, D-048). No messaging provider is connected:
-- nothing in this schema implies that a message reached anyone.
-- New error code: LB020 a message status needs a provider confirmation.

-- Consent records (table from 0001, append-only): the latest record per
-- customer, channel and purpose is the current state.
alter table lbg.customer_consents
  add constraint customer_consents_source check (length(source) between 3 and 200);
create index customer_consents_current_idx
  on lbg.customer_consents (business_id, customer_id, channel, purpose, recorded_at desc, id);

-- Suppression list per channel and address (E.164 mobile or lower-case email).
-- Append-only events; the latest event per address is the current state. A
-- suppressed address receives nothing on that channel, whatever the purpose.
create table lbg.contact_suppressions (
  business_id   uuid not null references lbg.businesses(id),
  id            uuid not null default gen_random_uuid(),
  channel       text not null check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  address       text not null check (address ~ '^\+[1-9][0-9]{7,14}$' or (address ~ '^[^@\s]+@[^@\s]+$' and address = lower(address))),
  action        text not null check (action in ('SUPPRESS', 'RELEASE')),
  reason        text not null check (reason in ('OWNER_OPT_OUT', 'STOP_REPLY', 'ERASED', 'RECONSENT')),
  customer_id   uuid,
  note          text check (length(note) <= 500),
  recorded_by   uuid,
  recorded_at   timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, customer_id) references lbg.customers(business_id, id)
);
create index contact_suppressions_current_idx
  on lbg.contact_suppressions (business_id, channel, address, recorded_at desc, id);
create trigger contact_suppressions_append_only before update or delete on lbg.contact_suppressions
  for each row execute function lbg.forbid_mutation();

-- Quiet hours for marketing and reminders (business time, minutes after midnight).
alter table lbg.business_settings
  add column quiet_start_minute smallint not null default 540 check (quiet_start_minute between 0 and 1439),
  add column quiet_end_minute smallint not null default 1260 check (quiet_end_minute between 1 and 1440),
  add constraint business_settings_quiet check (quiet_start_minute < quiet_end_minute);

-- Messages (WORKFLOWS §9). One row per message to one recipient.
create table lbg.messages (
  business_id          uuid not null references lbg.businesses(id),
  id                   uuid not null default gen_random_uuid(),
  customer_id          uuid,
  channel              text not null check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  purpose              text not null check (purpose in ('TRANSACTIONAL', 'MARKETING')),
  -- Where it came from: typed by staff, a reminder run (6.3) or a document (invoice share).
  origin               text not null default 'MANUAL' check (origin in ('MANUAL', 'REMINDER', 'DOCUMENT')),
  to_address           text not null check (length(to_address) <= 254),
  body                 text not null check (length(body) between 1 and 1000),
  status               text not null check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED',
                         'SUBMITTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BLOCKED', 'CANCELLED')),
  status_reason        text check (length(status_reason) <= 200),
  not_before           timestamptz,               -- quiet hours: not dispatched before this time
  provider             text check (length(provider) <= 40),
  provider_message_id  text check (length(provider_message_id) <= 200),
  created_by           uuid,
  approved_by          uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, customer_id) references lbg.customers(business_id, id),
  -- Provider statuses carry the provider's reference (FR-MSG-1 AC4).
  constraint messages_provider_status check (status not in ('SENT', 'DELIVERED', 'READ')
    or (provider is not null and provider_message_id is not null)),
  constraint messages_reason check (status not in ('FAILED', 'BLOCKED') or status_reason is not null)
);
create index messages_customer_idx on lbg.messages (business_id, customer_id, created_at desc);
create index messages_status_idx on lbg.messages (business_id, status, not_before);
create unique index messages_provider_ref_uq on lbg.messages (business_id, provider, provider_message_id)
  where provider_message_id is not null;

-- Every status a message takes, with who or what caused it (FR-CON-1 AC3).
create table lbg.message_events (
  business_id   uuid not null,
  id            uuid not null default gen_random_uuid(),
  message_id    uuid not null,
  status        text not null,
  reason        text check (length(reason) <= 200),
  actor_id      uuid,                              -- null: the system or the provider
  provider      text,
  at            timestamptz not null default now(),
  primary key (id),
  foreign key (business_id, message_id) references lbg.messages(business_id, id)
);
create index message_events_message_idx on lbg.message_events (business_id, message_id, at, id);
create trigger message_events_append_only before update or delete on lbg.message_events
  for each row execute function lbg.forbid_mutation();

-- Status machine (WORKFLOWS §9, D-048). Transactional messages may start QUEUED.
-- Additions to §9: DRAFT/PENDING_APPROVAL → CANCELLED, PENDING_APPROVAL → DRAFT
-- (sent back), QUEUED → FAILED (no provider configured: it never left), SENT → READ.
create function lbg.message_status_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if not (new.status in ('DRAFT', 'PENDING_APPROVAL')
            or (new.status = 'QUEUED' and new.purpose = 'TRANSACTIONAL')) then
      raise exception 'a message cannot start as %', new.status using errcode = 'LB002';
    end if;
    return new;
  end if;
  if new.status = old.status then
    if old.status not in ('DRAFT', 'QUEUED') then
      raise exception 'a % message cannot be edited', old.status using errcode = 'LB003';
    end if;
    -- Only the body of a draft and the quiet-hours time of a queued message change in place.
    if (old.status = 'DRAFT' and (new.customer_id, new.channel, new.purpose, new.to_address, new.not_before)
                                  is distinct from (old.customer_id, old.channel, old.purpose, old.to_address, old.not_before))
       or (old.status = 'QUEUED' and (new.body, new.to_address) is distinct from (old.body, old.to_address)) then
      raise exception 'only the text of a draft can change' using errcode = 'LB003';
    end if;
    new.updated_at := now();
    return new;
  end if;
  if not (
       (old.status = 'DRAFT' and new.status in ('PENDING_APPROVAL', 'CANCELLED'))
    or (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED', 'DRAFT', 'CANCELLED'))
    or (old.status = 'APPROVED' and new.status in ('QUEUED', 'CANCELLED'))
    or (old.status = 'QUEUED' and new.status in ('SUBMITTED', 'BLOCKED', 'CANCELLED', 'FAILED'))
    or (old.status = 'SUBMITTED' and new.status in ('SENT', 'FAILED'))
    or (old.status = 'SENT' and new.status in ('DELIVERED', 'READ', 'FAILED'))
    or (old.status = 'DELIVERED' and new.status = 'READ')) then
    raise exception 'message status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  if new.status in ('SENT', 'DELIVERED', 'READ') and new.provider_message_id is null then
    raise exception 'status % needs a provider confirmation', new.status using errcode = 'LB020';
  end if;
  if (new.body, new.to_address, new.channel, new.purpose, new.customer_id)
     is distinct from (old.body, old.to_address, old.channel, old.purpose, old.customer_id) then
    raise exception 'a message cannot be edited while changing status' using errcode = 'LB003';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger messages_status_guard before insert or update on lbg.messages
  for each row execute function lbg.message_status_guard();

-- The history row for every status taken (after the row exists).
create function lbg.message_status_log() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into message_events (business_id, message_id, status, reason, actor_id, provider)
    values (new.business_id, new.id, new.status, new.status_reason, current_app_user_id(), new.provider);
  end if;
  return null;
end
$$;
create trigger messages_status_log after insert or update on lbg.messages
  for each row execute function lbg.message_status_log();

do $$
declare
  t text;
begin
  foreach t in array array['contact_suppressions', 'messages', 'message_events'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.contact_suppressions, lbg.message_events to lbgos_app;
grant select, insert on lbg.messages to lbgos_app;
grant update (body, status, status_reason, not_before, provider, provider_message_id, approved_by)
  on lbg.messages to lbgos_app;
revoke execute on function lbg.message_status_guard(), lbg.message_status_log() from public;
