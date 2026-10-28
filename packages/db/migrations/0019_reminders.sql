-- Migration 0019 — reminders (increment 6.3: FR-REM-1, D-049). Reminders are
-- drafted as messages (origin REMINDER) and go through the send-time gate of
-- 0018; nothing here sends anything by itself.

-- One row per business and reminder type. Off until the owner turns it on;
-- auto-send is off by default and needs marketing.approve to enable (application).
create table lbg.reminder_settings (
  business_id    uuid not null references lbg.businesses(id),
  reminder_type  text not null check (reminder_type in ('BIRTHDAY', 'WARRANTY_EXPIRY', 'SERVICE_DUE', 'PAYMENT_DUE')),
  enabled        boolean not null default false,
  auto_send      boolean not null default false,
  channel        text not null default 'WHATSAPP' check (channel in ('WHATSAPP', 'SMS', 'EMAIL')),
  template       text not null check (length(template) between 1 and 1000),
  -- BIRTHDAY / WARRANTY_EXPIRY: days ahead; SERVICE_DUE: days after the sale; PAYMENT_DUE: days overdue.
  days           smallint not null check (days between 0 and 730),
  auto_send_approved_by uuid,
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  primary key (business_id, reminder_type),
  check (not auto_send or auto_send_approved_by is not null)
);

-- A summary per run (counts only, no personal data).
create table lbg.reminder_runs (
  business_id    uuid not null references lbg.businesses(id),
  id             uuid not null default gen_random_uuid(),
  run_date       date not null,
  created_count  integer not null check (created_count >= 0),
  skipped        jsonb not null default '{}',
  ran_by         uuid,
  ran_at         timestamptz not null default now(),
  primary key (id),
  unique (business_id, id)
);

-- One reminder per type and subject (a birthday year, a sale line, an
-- invoice): running the job again never drafts a second one.
create table lbg.reminders (
  business_id    uuid not null references lbg.businesses(id),
  id             uuid not null default gen_random_uuid(),
  reminder_type  text not null check (reminder_type in ('BIRTHDAY', 'WARRANTY_EXPIRY', 'SERVICE_DUE', 'PAYMENT_DUE')),
  subject_key    text not null check (length(subject_key) <= 100),
  customer_id    uuid not null,
  due_date       date not null,
  message_id     uuid not null,
  run_id         uuid not null,
  created_at     timestamptz not null default now(),
  primary key (id),
  unique (business_id, reminder_type, subject_key),
  foreign key (business_id, customer_id) references lbg.customers(business_id, id),
  foreign key (business_id, message_id) references lbg.messages(business_id, id),
  -- The run summary is written last, in the same transaction.
  foreign key (business_id, run_id) references lbg.reminder_runs(business_id, id) deferrable initially deferred
);
create index reminders_customer_idx on lbg.reminders (business_id, customer_id, created_at desc);
create trigger reminders_append_only before update or delete on lbg.reminders
  for each row execute function lbg.forbid_mutation();
create trigger reminder_runs_append_only before update or delete on lbg.reminder_runs
  for each row execute function lbg.forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['reminder_settings', 'reminder_runs', 'reminders'] loop
    execute format('alter table lbg.%I enable row level security', t);
    execute format('alter table lbg.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on lbg.%I to lbgos_app
         using (business_id = lbg.current_business_id())
         with check (business_id = lbg.current_business_id())', t);
  end loop;
end
$$;
grant select, insert, update on lbg.reminder_settings to lbgos_app;
grant select, insert on lbg.reminder_runs, lbg.reminders to lbgos_app;

-- Message events written in one transaction share now(): keep their order with
-- an insertion sequence and the wall-clock time (fixes event order from 0018).
alter table lbg.message_events
  add column seq bigint generated always as identity,
  alter column at set default clock_timestamp();
create index message_events_seq_idx on lbg.message_events (business_id, message_id, seq);
