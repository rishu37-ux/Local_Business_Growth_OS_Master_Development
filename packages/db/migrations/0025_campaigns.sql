-- Migration 0025 — campaigns (increment 7.5: FR-AIC-3 AC1, FR-AIC-4 AC2,
-- WORKFLOWS §9, D-058). A campaign sends one approved text to a customer
-- segment (tags) on one channel; each recipient gets one ordinary message
-- that still passes the 6.2 send-time gate when it is dispatched.

create table lbg.campaigns (
  business_id      uuid not null references lbg.businesses(id),
  id               uuid not null default gen_random_uuid(),
  name             text not null check (length(name) between 1 and 80),
  channel          text not null check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  body             text not null check (length(body) between 1 and 1000),
  -- The Studio draft the text came from (optional); it must still be approved in that version.
  draft_id         uuid,
  -- Segment: customers carrying ANY or ALL of these tags; no tags = every customer.
  segment_tags     text[] not null default '{}' check (cardinality(segment_tags) <= 10 and array_position(segment_tags, null) is null),
  segment_match    text not null default 'ANY' check (segment_match in ('ANY', 'ALL')),
  -- Hash of what is approved (channel, text, segment); maintained by the trigger, never by the app.
  content_sha256   text not null default '',
  version          integer not null default 1 check (version >= 1),
  status           text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED',
                     'SCHEDULED', 'RUNNING', 'COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED')),
  status_reason    text check (length(status_reason) <= 200),
  scheduled_at     timestamptz,
  approved_by      uuid,
  approved_at      timestamptz,
  approved_sha256  text,
  -- At launch: segment members found, and those left out (no address, no marketing consent, suppressed, erased).
  audience_count   integer check (audience_count >= 0),
  excluded_count   integer check (excluded_count >= 0),
  started_at       timestamptz,
  finished_at      timestamptz,
  created_by       uuid not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, draft_id) references lbg.creative_drafts(business_id, id),
  check (status not in ('APPROVED', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'PARTIALLY_FAILED')
         or (approved_by is not null and approved_sha256 = content_sha256)),
  check (status <> 'SCHEDULED' or scheduled_at is not null),
  check (status not in ('RUNNING', 'COMPLETED', 'PARTIALLY_FAILED') or started_at is not null)
);
create index campaigns_business_idx on lbg.campaigns (business_id, created_at desc);
create index campaigns_due_idx on lbg.campaigns (status, scheduled_at) where status = 'SCHEDULED';

create function lbg.campaign_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'campaigns are cancelled, not deleted' using errcode = 'LB001';
  end if;
  new.content_sha256 := encode(sha256(convert_to(concat_ws(chr(31), new.channel, new.body,
                          array_to_string(new.segment_tags, chr(30)), new.segment_match), 'UTF8')), 'hex');
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' or new.approved_sha256 is not null then
      raise exception 'a campaign starts as a draft' using errcode = 'LB002';
    end if;
    return new;
  end if;
  if new.content_sha256 <> old.content_sha256 or new.draft_id is distinct from old.draft_id then
    -- Editing (also an approved or scheduled campaign) is a new version back in DRAFT without approval.
    if old.status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED') then
      raise exception 'a % campaign cannot be edited', old.status using errcode = 'LB003';
    end if;
    if new.status <> 'DRAFT' or new.approved_sha256 is not null or new.scheduled_at is not null
       or new.version <> old.version + 1 then
      raise exception 'an edit makes a new draft version' using errcode = 'LB023';
    end if;
    new.updated_at := now();
    return new;
  end if;
  if new.status in ('APPROVED', 'SCHEDULED', 'RUNNING') and new.approved_sha256 is distinct from new.content_sha256 then
    raise exception 'approval does not match the current content' using errcode = 'LB023';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'DRAFT' and new.status in ('PENDING_APPROVAL', 'CANCELLED'))
    or (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED', 'DRAFT', 'CANCELLED'))
    or (old.status = 'APPROVED' and new.status in ('SCHEDULED', 'RUNNING', 'CANCELLED'))
    or (old.status = 'SCHEDULED' and new.status in ('APPROVED', 'RUNNING', 'CANCELLED'))
    or (old.status = 'RUNNING' and new.status in ('COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED'))) then
    raise exception 'campaign status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  if old.status in ('COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED')
     and (new.audience_count, new.excluded_count, new.started_at, new.finished_at)
         is distinct from (old.audience_count, old.excluded_count, old.started_at, old.finished_at) then
    raise exception 'a finished campaign cannot change' using errcode = 'LB003';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger campaigns_guard before insert or update or delete on lbg.campaigns
  for each row execute function lbg.campaign_guard();

-- Campaign messages: origin CAMPAIGN, linked to the campaign.
alter table lbg.messages
  add column campaign_id uuid,
  add constraint messages_campaign_fk foreign key (business_id, campaign_id) references lbg.campaigns(business_id, id),
  drop constraint messages_origin_check,
  add constraint messages_origin_check check (origin in ('MANUAL', 'REMINDER', 'DOCUMENT', 'CAMPAIGN')),
  add constraint messages_campaign_origin check ((origin = 'CAMPAIGN') = (campaign_id is not null));
create index messages_campaign_idx on lbg.messages (business_id, campaign_id) where campaign_id is not null;
create unique index messages_campaign_recipient_uq on lbg.messages (business_id, campaign_id, customer_id)
  where campaign_id is not null;

-- The message guard as last defined in 0021 (redaction), plus: a campaign
-- message starts QUEUED (its approval is the campaign's), only while the
-- campaign is RUNNING and only with the campaign's approved text and channel;
-- no message changes its origin or campaign.
create or replace function lbg.message_status_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.redacted_at is not null then
      raise exception 'a message cannot start redacted' using errcode = 'LB002';
    end if;
    if new.campaign_id is not null then
      if not (new.status = 'QUEUED' and new.purpose = 'MARKETING' and exists (
                select 1 from campaigns c
                 where c.business_id = new.business_id and c.id = new.campaign_id and c.status = 'RUNNING'
                   and c.body = new.body and c.channel = new.channel and c.approved_sha256 = c.content_sha256)) then
        raise exception 'a campaign message needs its running, approved campaign' using errcode = 'LB023';
      end if;
      return new;
    end if;
    if not (new.status in ('DRAFT', 'PENDING_APPROVAL')
            or (new.status = 'QUEUED' and new.purpose = 'TRANSACTIONAL')) then
      raise exception 'a message cannot start as %', new.status using errcode = 'LB002';
    end if;
    return new;
  end if;
  if new.campaign_id is distinct from old.campaign_id or new.origin is distinct from old.origin then
    raise exception 'a message keeps its origin' using errcode = 'LB003';
  end if;
  if old.redacted_at is not null and new.redacted_at is distinct from old.redacted_at then
    raise exception 'a redaction cannot be undone' using errcode = 'LB003';
  end if;
  if new.redacted_at is not null and old.redacted_at is null then
    if new.status <> old.status or new.body <> '[erased]' or new.to_address <> '[erased]'
       or (new.customer_id, new.channel, new.purpose, new.not_before, new.provider, new.provider_message_id)
          is distinct from (old.customer_id, old.channel, old.purpose, old.not_before, old.provider, old.provider_message_id) then
      raise exception 'a redaction changes only the text and address' using errcode = 'LB003';
    end if;
    new.updated_at := now();
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

alter table lbg.campaigns enable row level security;
alter table lbg.campaigns force row level security;
create policy tenant_isolation on lbg.campaigns to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.campaigns to lbgos_app;
grant update (name, channel, body, draft_id, segment_tags, segment_match, content_sha256, version, status,
              status_reason, scheduled_at, approved_by, approved_at, approved_sha256, audience_count,
              excluded_count, started_at, finished_at)
  on lbg.campaigns to lbgos_app;
revoke execute on function lbg.campaign_guard() from public;
