-- Migration 0021 — privacy requests (increment 6.6: FR-PRV-1 AC2, D-052).
-- Erasing a customer anonymises the profile, withdraws consent, suppresses
-- the contact, cancels pending messages and redacts the text and address of
-- past messages. Issued invoices keep their party snapshot (what was legally
-- printed); the suppression list keeps the address so the opt-out is honoured.
-- Legal retention rules are still to be confirmed (NFR-12).

create table lbg.privacy_requests (
  business_id   uuid not null references lbg.businesses(id),
  id            uuid not null default gen_random_uuid(),
  customer_id   uuid not null,
  kind          text not null check (kind in ('ERASE')),
  reason        text not null check (length(reason) between 10 and 500),
  requested_by  uuid not null,
  completed_at  timestamptz not null default now(),
  primary key (id),
  foreign key (business_id, customer_id) references lbg.customers(business_id, id)
);
create unique index privacy_requests_one_erase_uq on lbg.privacy_requests (business_id, customer_id)
  where kind = 'ERASE';
create trigger privacy_requests_append_only before update or delete on lbg.privacy_requests
  for each row execute function lbg.forbid_mutation();
alter table lbg.privacy_requests enable row level security;
alter table lbg.privacy_requests force row level security;
create policy tenant_isolation on lbg.privacy_requests to lbgos_app
  using (business_id = lbg.current_business_id())
  with check (business_id = lbg.current_business_id());
grant select, insert on lbg.privacy_requests to lbgos_app;

-- Messages: redaction is the one change allowed in any status, once, and only
-- to the fixed placeholder (the status history stays).
alter table lbg.messages add column redacted_at timestamptz;
create or replace function lbg.message_status_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.redacted_at is not null then
      raise exception 'a message cannot start redacted' using errcode = 'LB002';
    end if;
    if not (new.status in ('DRAFT', 'PENDING_APPROVAL')
            or (new.status = 'QUEUED' and new.purpose = 'TRANSACTIONAL')) then
      raise exception 'a message cannot start as %', new.status using errcode = 'LB002';
    end if;
    return new;
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
grant update (to_address, redacted_at) on lbg.messages to lbgos_app;
