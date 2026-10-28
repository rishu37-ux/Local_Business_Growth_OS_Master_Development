-- Migration 0024 — offers and the AI Creative Studio (increment 7.4:
-- FR-AIC-1, -2, -4, -5, D-057). Generation runs through the hub (7.3); this
-- schema records offers, generation jobs and the drafts they produce.
-- New error code: LB023 approval does not match the current content.

create table lbg.offers (
  business_id     uuid not null references lbg.businesses(id),
  id              uuid not null default gen_random_uuid(),
  title           text not null check (length(title) between 1 and 80),
  discount_kind   text not null check (discount_kind in ('PERCENT', 'AMOUNT')),
  -- Basis points for PERCENT (1–9000), paise for AMOUNT.
  discount_value  bigint not null check (discount_value > 0),
  valid_from      date not null,
  valid_to        date not null,
  terms           text check (length(terms) <= 500),
  status          text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'WITHDRAWN')),
  approved_by     uuid,
  approved_at     timestamptz,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  check (valid_to >= valid_from),
  check (discount_kind <> 'PERCENT' or discount_value <= 9000),
  check (status <> 'APPROVED' or approved_by is not null)
);

-- An approved offer is fixed: its terms are what the content quotes.
create function lbg.offer_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'offers are withdrawn, not deleted' using errcode = 'LB001';
  end if;
  if old.status <> 'DRAFT' and (new.title, new.discount_kind, new.discount_value, new.valid_from, new.valid_to, new.terms)
     is distinct from (old.title, old.discount_kind, old.discount_value, old.valid_from, old.valid_to, old.terms) then
    raise exception 'an approved or withdrawn offer cannot be edited' using errcode = 'LB003';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'DRAFT' and new.status in ('APPROVED', 'WITHDRAWN'))
    or (old.status = 'APPROVED' and new.status = 'WITHDRAWN')) then
    raise exception 'offer status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  return new;
end
$$;
create trigger offers_guard before update or delete on lbg.offers
  for each row execute function lbg.offer_guard();

-- A generation job (FR-AIC-1 AC2): provider, model, cost estimate before and recorded cost after.
create table lbg.creative_jobs (
  business_id           uuid not null references lbg.businesses(id),
  id                    uuid not null default gen_random_uuid(),
  kind                  text not null check (kind in ('CAPTION', 'IMAGE')),
  status                text not null check (status in ('SUCCEEDED', 'FAILED')),
  integration_id        uuid not null,
  provider              text not null,
  model_id              text,
  -- The structured inputs (product facts, offer, branding) and a hash of the exact prompt sent.
  inputs                jsonb not null,
  prompt_sha256         text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  estimated_cost_paise  bigint check (estimated_cost_paise >= 0),
  cost_paise            bigint check (cost_paise >= 0),
  units                 integer not null default 0 check (units >= 0),
  error_code            text check (error_code ~ '^[A-Z0-9_]{1,40}$'),
  created_by            uuid not null,
  created_at            timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, integration_id) references lbg.integrations(business_id, id),
  check (status <> 'FAILED' or error_code is not null)
);
create trigger creative_jobs_append_only before update or delete on lbg.creative_jobs
  for each row execute function lbg.forbid_mutation();

-- Generated content, versioned. Approval is of the exact version (content hash);
-- editing returns the draft to DRAFT and clears the approval (FR-AIC-3 AC1).
create table lbg.creative_drafts (
  business_id      uuid not null references lbg.businesses(id),
  id               uuid not null default gen_random_uuid(),
  job_id           uuid not null,
  kind             text not null check (kind in ('CAPTION', 'IMAGE')),
  platform         text not null check (platform in ('WHATSAPP', 'SMS', 'INSTAGRAM', 'FACEBOOK', 'GOOGLE_BUSINESS', 'GENERIC')),
  aspect           text check (aspect in ('1:1', '4:5', '9:16', '16:9')),
  body             text check (length(body) <= 10000),
  upload_id        uuid,            -- generated image, private storage
  offer_id         uuid,
  product_ids      uuid[] not null default '{}',
  -- Facts the post-check compares against (prices, percentages, dates, specs).
  facts            jsonb not null,
  flags            jsonb not null default '[]',
  version          integer not null default 1 check (version >= 1),
  content_sha256   text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  status           text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED')),
  approved_by      uuid,
  approved_at      timestamptz,
  approved_sha256  text,
  created_by       uuid not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, job_id) references lbg.creative_jobs(business_id, id),
  foreign key (business_id, offer_id) references lbg.offers(business_id, id),
  foreign key (business_id, upload_id) references lbg.uploads(business_id, id),
  check ((kind = 'CAPTION') = (body is not null)),
  check ((kind = 'IMAGE') = (upload_id is not null)),
  check (status <> 'APPROVED' or (approved_by is not null and approved_sha256 = content_sha256))
);
create index creative_drafts_business_idx on lbg.creative_drafts (business_id, created_at desc);

create function lbg.creative_draft_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'drafts are archived, not deleted' using errcode = 'LB001';
  end if;
  if new.content_sha256 is distinct from old.content_sha256 then
    -- A content change is a new version and always back to DRAFT without approval.
    if new.version <> old.version + 1 or new.status <> 'DRAFT' or new.approved_sha256 is not null then
      raise exception 'an edit makes a new draft version' using errcode = 'LB023';
    end if;
    if old.status = 'ARCHIVED' then
      raise exception 'an archived draft cannot be edited' using errcode = 'LB003';
    end if;
  end if;
  if new.status = 'APPROVED' and new.approved_sha256 is distinct from new.content_sha256 then
    raise exception 'approval does not match the current content' using errcode = 'LB023';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'DRAFT' and new.status in ('PENDING_APPROVAL', 'ARCHIVED'))
    or (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED', 'REJECTED', 'DRAFT', 'ARCHIVED'))
    or (old.status in ('APPROVED', 'REJECTED') and new.status in ('DRAFT', 'ARCHIVED'))) then
    raise exception 'draft status % -> % not allowed', old.status, new.status using errcode = 'LB002';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger creative_drafts_guard before update or delete on lbg.creative_drafts
  for each row execute function lbg.creative_draft_guard();

do $$
declare
  t text;
begin
  foreach t in array array['offers', 'creative_jobs', 'creative_drafts'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert on lbg.offers, lbg.creative_jobs, lbg.creative_drafts to lbgos_app;
grant update (title, discount_kind, discount_value, valid_from, valid_to, terms, status, approved_by, approved_at)
  on lbg.offers to lbgos_app;
grant update (body, flags, facts, version, content_sha256, status, approved_by, approved_at, approved_sha256)
  on lbg.creative_drafts to lbgos_app;
revoke execute on function lbg.offer_guard(), lbg.creative_draft_guard() from public;
