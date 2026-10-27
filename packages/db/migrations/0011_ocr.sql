-- Migration 0011 — uploads and OCR jobs (increment 4.5: FR-OCR-1…6,
-- WORKFLOWS §7). Files live in private storage; only metadata is here.
-- New error code: LB018 OCR job status change not allowed.

create table lbg.uploads (
  business_id    uuid not null references lbg.businesses(id),
  id             uuid not null default gen_random_uuid(),
  -- Random key, prefixed by business ID (ADR-11); never derived from the file name.
  storage_key    text not null unique check (storage_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  content_type   text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_size      integer not null check (byte_size > 0),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  original_name  text check (length(original_name) <= 200),
  width          integer check (width > 0),
  height         integer check (height > 0),
  page_count     smallint check (page_count > 0),
  -- FR-OCR-6 AC4: no scanner is configured; the status says so instead of implying a clean scan.
  malware_scan   text not null default 'NOT_CONFIGURED' check (malware_scan in ('NOT_CONFIGURED', 'CLEAN', 'INFECTED')),
  uploaded_by    uuid not null,
  created_at     timestamptz not null default now(),
  primary key (id),
  unique (business_id, id),
  check (storage_key like business_id::text || '/%')
);

create table lbg.ocr_jobs (
  business_id         uuid not null references lbg.businesses(id),
  id                  uuid not null default gen_random_uuid(),
  upload_id           uuid not null,
  scan_type           text not null check (scan_type in ('PRODUCT_LABEL', 'SUPPLIER_INVOICE')),
  status              text not null default 'QUEUED' check (status in
                      ('UPLOADED', 'QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'COMPLETED', 'DISCARDED', 'FAILED')),
  attempts            smallint not null default 0 check (attempts between 0 and 4),
  error_code          text check (error_code ~ '^[A-Z_]{1,40}$'),
  provider            text check (provider ~ '^[a-z0-9_-]{1,40}$'),
  -- Schema-validated extraction (field values, confidence, evidence); OCR text itself is not kept.
  extraction          jsonb,
  -- True when the optional structuring step was discarded and fields must be entered by hand (FR-OCR-5 AC2).
  manual_entry        boolean not null default false,
  requested_by        uuid not null,
  created_purchase_id uuid,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  primary key (id),
  unique (business_id, id),
  foreign key (business_id, upload_id) references lbg.uploads(business_id, id),
  foreign key (business_id, created_purchase_id) references lbg.purchases(business_id, id),
  -- A failed job always says why; the code is kept if the job is later discarded.
  check (status <> 'FAILED' or error_code is not null),
  check (error_code is null or status in ('FAILED', 'DISCARDED')),
  check (status <> 'COMPLETED' or created_purchase_id is not null)
);
create index ocr_jobs_queue_idx on lbg.ocr_jobs (created_at) where status = 'QUEUED';
create index ocr_jobs_business_idx on lbg.ocr_jobs (business_id, created_at desc);

-- WORKFLOWS §7: UPLOADED → QUEUED → PROCESSING → NEEDS_REVIEW → COMPLETED | DISCARDED;
-- PROCESSING → FAILED; FAILED → QUEUED (retry, at most 3 retries); FAILED → DISCARDED.
create function lbg.ocr_job_guard() returns trigger
language plpgsql set search_path = lbg, public, pg_temp as $$
begin
  if new.business_id is distinct from old.business_id or new.upload_id is distinct from old.upload_id
     or new.scan_type is distinct from old.scan_type or new.requested_by is distinct from old.requested_by then
    raise exception 'an OCR job cannot be re-targeted' using errcode = 'LB018';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'UPLOADED' and new.status = 'QUEUED')
    or (old.status = 'QUEUED' and new.status = 'PROCESSING')
    or (old.status = 'PROCESSING' and new.status in ('NEEDS_REVIEW', 'FAILED'))
    or (old.status = 'NEEDS_REVIEW' and new.status in ('COMPLETED', 'DISCARDED'))
    or (old.status = 'FAILED' and new.status = 'QUEUED' and old.attempts <= 3)
    or (old.status = 'FAILED' and new.status = 'DISCARDED')) then
    raise exception 'OCR job status % -> % not allowed', old.status, new.status using errcode = 'LB018';
  end if;
  if old.status in ('COMPLETED', 'DISCARDED') and new is distinct from old then
    raise exception 'a % OCR job is final', old.status using errcode = 'LB018';
  end if;
  return new;
end
$$;
create trigger ocr_jobs_guard before update on lbg.ocr_jobs
  for each row execute function lbg.ocr_job_guard();

-- The job runner claims work across tenants without tenant context, so this
-- narrow definer function is the only cross-tenant access: it moves one
-- QUEUED job to PROCESSING (SKIP LOCKED: concurrent runners never share a job)
-- and returns only what is needed to continue under that job's tenant context.
-- Jobs stuck in PROCESSING longer than p_stale_seconds are failed first.
create function lbg.claim_ocr_job(p_stale_seconds integer)
returns table (job_id uuid, business_id uuid, requested_by uuid)
language plpgsql security definer set search_path = lbg, public, pg_temp as $$
#variable_conflict use_column
begin
  update ocr_jobs set status = 'FAILED', error_code = 'ABANDONED', finished_at = now()
   where status = 'PROCESSING' and started_at < now() - make_interval(secs => p_stale_seconds);
  return query
    update ocr_jobs j set status = 'PROCESSING', attempts = j.attempts + 1, started_at = now()
     where j.id = (select q.id from ocr_jobs q where q.status = 'QUEUED' order by q.created_at
                    for update skip locked limit 1)
    returning j.id, j.business_id, j.requested_by;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['uploads', 'ocr_jobs'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;

grant select, insert on lbg.uploads to lbgos_app;
grant select, insert on lbg.ocr_jobs to lbgos_app;
grant update (status, attempts, error_code, provider, extraction, manual_entry, created_purchase_id, started_at,
              finished_at) on lbg.ocr_jobs to lbgos_app;
revoke execute on function lbg.ocr_job_guard(), lbg.claim_ocr_job(integer) from public;
grant execute on function lbg.claim_ocr_job(integer) to lbgos_app;
