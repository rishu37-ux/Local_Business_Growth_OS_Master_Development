-- Migration 0016 — details printed on documents (increment 5.6: FR-PRN-1 AC2,
-- D-044). Copied into each document's party snapshot when it is issued, so a
-- reprint shows them as they were at issue time.
alter table lbg.business_settings
  add column business_address text check (length(business_address) <= 500),
  add column business_phone text check (business_phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column business_email citext check (length(business_email) <= 200),
  add column invoice_terms text check (length(invoice_terms) <= 1000);
