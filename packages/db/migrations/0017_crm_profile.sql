-- Migration 0017 — customer profile (increment 6.1: FR-CRM-1, FR-CRM-2, D-047).

-- Optional profile fields; only name and mobile are required (FR-CRM-2 AC1).
-- The date of birth is checked against today by the application (a CHECK must be immutable).
alter table lbg.customers
  add column alternate_mobile_e164 text check (alternate_mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column tags text[] not null default '{}',
  -- Channels the customer prefers to be contacted on: a preference, not consent (customer_consents).
  add column contact_channels text[] not null default '{}',
  add constraint customers_tags check (cardinality(tags) <= 10 and array_position(tags, null) is null
    and coalesce(length(array_to_string(tags, ',')), 0) <= 340),
  add constraint customers_contact_channels check (contact_channels <@ array['WHATSAPP', 'SMS', 'EMAIL', 'CALL']::text[]),
  add constraint customers_dob check (dob is null or dob >= date '1900-01-01');
create index customers_tags_idx on lbg.customers using gin (tags);

-- Warranty promised at the sale, as recorded then (the variant's warranty months and provider).
-- 0 means no warranty; null (lines issued before this migration) means not recorded.
alter table lbg.invoice_lines
  add column warranty_months smallint check (warranty_months between 0 and 240),
  add column warranty_provider text check (length(warranty_provider) <= 120);
