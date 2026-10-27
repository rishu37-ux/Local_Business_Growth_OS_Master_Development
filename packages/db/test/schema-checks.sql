-- Schema checks run against the MIGRATED database (pnpm -F @lbgos/db test:db).
-- Carried over from the Phase 1 draft checks (TR-0002)
-- (throwaway PostgreSQL cluster, synthetic data only). Any failed check raises
-- and stops psql (ON_ERROR_STOP), so a zero exit status means every check passed.
--
-- Fixed synthetic IDs:
--   business A  00000000-0000-0000-0000-0000000000a1   business B  ...0000b1
--   user U1 (member of A and B) ...000001, user U2 (member of B only) ...000002

\set ON_ERROR_STOP 1
\set QUIET 1

create schema t;
create function t.expect_error(p_sql text, p_state text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      raise notice 'PASS %', p_label;
      return;
    end if;
    raise exception 'FAIL %: expected SQLSTATE %, got % (%)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL %: expected SQLSTATE %, but the statement succeeded', p_label, p_state;
end
$$;
create function t.ok(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL %', p_label;
  end if;
  raise notice 'PASS %', p_label;
end
$$;
grant usage on schema t to lbgos_app, lbgos_platform, lbgos_auth;
grant execute on all functions in schema t to lbgos_app, lbgos_platform, lbgos_auth;

-- ===========================================================================
-- Platform role: business lifecycle
-- ===========================================================================
set role lbgos_platform;

insert into lbg.businesses (id, legal_name, category, state_code, status) values
  ('00000000-0000-0000-0000-0000000000a1', 'Alpha Mobiles (synthetic)', 'MOBILE_ELECTRONICS', '09', 'APPROVED_SETUP_PENDING'),
  ('00000000-0000-0000-0000-0000000000b1', 'Beta Phones (synthetic)',   'MOBILE_ELECTRONICS', '27', 'APPROVED_SETUP_PENDING');
update lbg.businesses set status = 'ACTIVE';
select t.ok((select count(*) = 2 from lbg.businesses where status = 'ACTIVE'),
  'T01 platform role creates and activates businesses via allowed transitions');

select t.expect_error($$update lbg.businesses set status = 'PENDING_APPROVAL'
  where id = '00000000-0000-0000-0000-0000000000a1'$$, 'LB002',
  'T02 invalid business status transition ACTIVE -> PENDING_APPROVAL rejected');
select t.expect_error($$insert into lbg.businesses (legal_name, category, status)
  values ('Gamma (synthetic)', 'MOBILE_ELECTRONICS', 'ACTIVE')$$, 'LB002',
  'T02b new business cannot start ACTIVE');

select t.expect_error($$select count(*) from lbg.invoices$$, '42501',
  'T19a platform role has no access to invoices (D-015)');
select t.expect_error($$select count(*) from lbg.customers$$, '42501',
  'T19b platform role has no access to customers');
select t.expect_error($$select count(*) from lbg.products$$, '42501',
  'T19c platform role has no access to products');
select t.expect_error($$select count(*) from lbg.stock_movements$$, '42501',
  'T19d platform role has no access to stock movements');
reset role;

-- Synthetic users and memberships (seeded as superuser)
insert into lbg.users (id, email, display_name) values
  ('00000000-0000-0000-0000-000000000001', 'owner.a@example.test', 'Owner A'),
  ('00000000-0000-0000-0000-000000000002', 'owner.b@example.test', 'Owner B');
insert into lbg.memberships (business_id, user_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000002');

-- ===========================================================================
-- Tenant role: seed A, then B
-- ===========================================================================
set role lbgos_app;
select set_config('app.business_id', '00000000-0000-0000-0000-0000000000a1', false),
       set_config('app.user_id',     '00000000-0000-0000-0000-000000000001', false) \gset

insert into lbg.tax_rates (business_id, id, name, rate_percent, effective_from) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0a1', 'Test rate (synthetic)', 18, '2026-04-01');
insert into lbg.products (business_id, id, model_name, is_serialized) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0b1', 'Phone X (synthetic)', true);
insert into lbg.product_variants (business_id, id, product_id, sku, ram, storage, colour,
  selling_price_paise, tax_rate_id, hsn_code) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0c1',
   '00000000-0000-0000-0000-00000000a0b1', 'PX-8-128-BLK', '8GB', '128GB', 'Black', 1180000,
   '00000000-0000-0000-0000-00000000a0a1', '1234');

select t.ok((select count(*) = 1 from lbg.businesses)
        and (select id = '00000000-0000-0000-0000-0000000000a1' from lbg.businesses),
  'T04 tenant sees only its own business row');
select t.expect_error($$update lbg.businesses set status = 'SUSPENDED'$$, '42501',
  'T03 tenant cannot change its own business status (column not granted)');
update lbg.businesses set display_name = 'Alpha';
select t.ok((select display_name = 'Alpha' from lbg.businesses), 'T03b tenant can edit granted columns');
select t.expect_error($$insert into lbg.businesses (legal_name, category) values ('X', 'Y')$$, '42501',
  'T23a tenant cannot insert businesses directly');

select t.expect_error($$insert into lbg.products (business_id, model_name)
  values ('00000000-0000-0000-0000-0000000000b1', 'Injected (synthetic)')$$, '42501',
  'T06 tenant A cannot insert a row for business B (RLS WITH CHECK)');

-- Tenant B
select set_config('app.business_id', '00000000-0000-0000-0000-0000000000b1', false),
       set_config('app.user_id',     '00000000-0000-0000-0000-000000000002', false) \gset
insert into lbg.products (business_id, id, model_name, is_serialized) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000b0b1', 'Phone Y (synthetic)', true);
insert into lbg.product_variants (business_id, id, product_id, sku, selling_price_paise) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000b0c1',
   '00000000-0000-0000-0000-00000000b0b1', 'PY-6-64', 990000);
select t.ok((select count(*) = 2 from lbg.users), 'T22b context B (user U2) sees both members of B');

-- Back to A
select set_config('app.business_id', '00000000-0000-0000-0000-0000000000a1', false),
       set_config('app.user_id',     '00000000-0000-0000-0000-000000000001', false) \gset
select t.ok((select count(*) = 1 from lbg.products), 'T07 tenant A sees only its own products');
select t.ok(not exists (select 1 from lbg.products where business_id <> '00000000-0000-0000-0000-0000000000a1'),
  'T07b no foreign-tenant product visible to A');
select t.expect_error($$insert into lbg.product_variants (business_id, product_id, sku, selling_price_paise)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000b0b1', 'X', 1)$$, '23503',
  'T08 composite FK blocks referencing another tenant''s product');

select t.ok((select count(*) = 2 from lbg.memberships)
        and not exists (select 1 from lbg.memberships where user_id = '00000000-0000-0000-0000-000000000002'),
  'T21 memberships: own memberships + current business only');
select t.ok((select count(*) = 1 from lbg.users), 'T22 context A sees only users who are members of A');

-- Fail closed without tenant context
select set_config('app.business_id', '', false) \gset
select t.ok((select count(*) = 0 from lbg.products), 'T05 no tenant context -> no rows (fail closed)');
select t.expect_error($$insert into lbg.categories (business_id, name)
  values ('00000000-0000-0000-0000-0000000000a1', 'X')$$, '42501',
  'T05b no tenant context -> inserts rejected');

-- Self-registration via SECURITY DEFINER function
select lbg.register_application('Delta Mobiles (synthetic)', 'MOBILE_ELECTRONICS', '07') as new_business_id \gset
select set_config('app.business_id', '00000000-0000-0000-0000-0000000000a1', false) \gset

-- ===========================================================================
-- IMEI rules (D-008, FR-INV-3)
-- ===========================================================================
insert into lbg.serialized_units (business_id, id, variant_id, status, unit_cost_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0d1',
   '00000000-0000-0000-0000-00000000a0c1', 'IN_STOCK', 950000),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0d2',
   '00000000-0000-0000-0000-00000000a0c1', 'IN_STOCK', 950000);
insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot) values
  ('00000000-0000-0000-0000-0000000000a1', '353456789012348', '00000000-0000-0000-0000-00000000a0d1', 1),
  ('00000000-0000-0000-0000-0000000000a1', '353456789012355', '00000000-0000-0000-0000-00000000a0d1', 2);
select t.ok((select count(*) = 2 from lbg.serialized_unit_imeis), 'T09 valid IMEIs (Luhn) accepted');
select t.expect_error($$insert into lbg.serialized_unit_imeis values
  ('00000000-0000-0000-0000-0000000000a1', '353456789012349', '00000000-0000-0000-0000-00000000a0d2', 1)$$,
  '23514', 'T09b IMEI with bad Luhn check digit rejected');
select t.expect_error($$insert into lbg.serialized_unit_imeis values
  ('00000000-0000-0000-0000-0000000000a1', '35345678901234', '00000000-0000-0000-0000-00000000a0d2', 1)$$,
  '23514', 'T09c 14-digit IMEI rejected');
select t.expect_error($$insert into lbg.serialized_unit_imeis values
  ('00000000-0000-0000-0000-0000000000a1', '353456789012355', '00000000-0000-0000-0000-00000000a0d2', 1)$$,
  '23505', 'T10 IMEI already used as another unit''s IMEI 2 rejected in same business');
select t.expect_error($$insert into lbg.serialized_unit_imeis values
  ('00000000-0000-0000-0000-0000000000a1', '860123456789014', '00000000-0000-0000-0000-00000000a0d1', 1)$$,
  '23505', 'T10b a unit cannot have two IMEI 1 values');

select set_config('app.business_id', '00000000-0000-0000-0000-0000000000b1', false) \gset
insert into lbg.serialized_units (business_id, id, variant_id, status, unit_cost_paise) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000b0d1',
   '00000000-0000-0000-0000-00000000b0c1', 'IN_STOCK', 800000);
insert into lbg.serialized_unit_imeis values
  ('00000000-0000-0000-0000-0000000000b1', '353456789012348', '00000000-0000-0000-0000-00000000b0d1', 1);
select t.ok((select count(*) = 1 from lbg.serialized_unit_imeis where imei = '353456789012348'),
  'T11 same IMEI accepted in another business, and B sees only its own record');
select set_config('app.business_id', '00000000-0000-0000-0000-0000000000a1', false) \gset

-- ===========================================================================
-- Stock ledger (FR-INV-4)
-- ===========================================================================
insert into lbg.stock_movements (business_id, id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0e1',
   '00000000-0000-0000-0000-00000000a0c1', '00000000-0000-0000-0000-00000000a0d1', 'PURCHASE', 1, 950000);
select t.expect_error($$update lbg.stock_movements set reason = 'edit'$$, '42501',
  'T12 app role cannot UPDATE stock movements');
select t.expect_error($$delete from lbg.stock_movements$$, '42501',
  'T12b app role cannot DELETE stock movements');
select t.expect_error($$insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0c1',
          '00000000-0000-0000-0000-00000000a0d2', 'PURCHASE', 2)$$, '23514',
  'T13 serialized movement must be +/-1');
select t.expect_error($$insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0c1', 'ADJUSTMENT', -1)$$,
  '23514', 'T13b adjustment without reason rejected');
insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, reverses_movement_id, reason) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0c1',
   '00000000-0000-0000-0000-00000000a0d1', 'REVERSAL', -1, '00000000-0000-0000-0000-00000000a0e1', 'entered twice');
select t.expect_error($$insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, reverses_movement_id, reason)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0c1',
          '00000000-0000-0000-0000-00000000a0d1', 'REVERSAL', -1, '00000000-0000-0000-0000-00000000a0e1', 'again')$$,
  '23505', 'T28 a movement can be reversed only once');
select t.ok((select sum(quantity_delta) = 0 from lbg.stock_movements
              where unit_id = '00000000-0000-0000-0000-00000000a0d1'),
  'T28b stock on hand equals sum of movements after reversal');

-- ===========================================================================
-- Customers (FR-CRM-1)
-- ===========================================================================
insert into lbg.customers (business_id, id, name, mobile_e164) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0f1', 'Customer One (synthetic)', '+919800000001');
select t.expect_error($$insert into lbg.customers (business_id, name, mobile_e164)
  values ('00000000-0000-0000-0000-0000000000a1', 'Dup', '+919800000001')$$, '23505',
  'T27 duplicate customer mobile rejected within a business');
select t.expect_error($$insert into lbg.customers (business_id, name, mobile_e164)
  values ('00000000-0000-0000-0000-0000000000a1', 'Bad', '98000')$$, '23514',
  'T27b malformed mobile rejected');

-- ===========================================================================
-- Invoices (D-012, D-016, FR-TAX-1)
-- ===========================================================================
-- iA1: consistent draft, then issue
insert into lbg.invoices (business_id, id, document_type, financial_year, invoice_date, customer_id,
  place_of_supply_state, taxable_paise, cgst_paise, sgst_paise, total_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1001', 'TAX_INVOICE', '2026-27',
   '2026-10-27', '00000000-0000-0000-0000-00000000a0f1', '09', 100000, 9000, 9000, 118000);
insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, description, quantity,
  unit_price_paise, tax_rate_percent, taxable_paise, cgst_paise, sgst_paise, line_total_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1001', 1,
   '00000000-0000-0000-0000-00000000a0c1', 'Accessory (synthetic)', 1, 118000, 18, 100000, 9000, 9000, 118000);
update lbg.invoices set status = 'ISSUED', invoice_number = 'A/0001', issued_at = now()
 where id = '00000000-0000-0000-0000-0000000a1001';
select t.ok((select status = 'ISSUED' from lbg.invoices where id = '00000000-0000-0000-0000-0000000a1001'),
  'T14 draft invoice with reconciling lines can be issued');

select t.expect_error($$insert into lbg.invoices (business_id, document_type, financial_year, invoice_date,
  place_of_supply_state, taxable_paise, cgst_paise, sgst_paise, total_paise)
  values ('00000000-0000-0000-0000-0000000000a1', 'TAX_INVOICE', '2026-27', '2026-10-27', '09', 100000, 9000, 9000, 117999)$$,
  '23514', 'T15 invoice total must equal taxable + taxes + round-off');
select t.expect_error($$insert into lbg.invoices (business_id, document_type, financial_year, invoice_date,
  place_of_supply_state, taxable_paise, cgst_paise, igst_paise, total_paise)
  values ('00000000-0000-0000-0000-0000000000a1', 'TAX_INVOICE', '2026-27', '2026-10-27', '09', 100000, 9000, 9000, 118000)$$,
  '23514', 'T15b IGST cannot be combined with CGST/SGST');

-- iA2: header does not match lines -> cannot issue
insert into lbg.invoices (business_id, id, document_type, financial_year, invoice_date,
  place_of_supply_state, taxable_paise, cgst_paise, sgst_paise, total_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1002', 'TAX_INVOICE', '2026-27',
   '2026-10-27', '09', 60000, 4500, 4500, 69000);
insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, description, quantity,
  unit_price_paise, tax_rate_percent, taxable_paise, cgst_paise, sgst_paise, line_total_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1002', 1,
   '00000000-0000-0000-0000-00000000a0c1', 'Accessory (synthetic)', 1, 59000, 18, 50000, 4500, 4500, 59000);
select t.expect_error($$update lbg.invoices set status = 'ISSUED', invoice_number = 'A/0009', issued_at = now()
  where id = '00000000-0000-0000-0000-0000000a1002'$$, 'LB004',
  'T15c invoice whose totals do not reconcile with its lines cannot be issued');

-- iA3 / iA4: numbering uniqueness per financial year
insert into lbg.invoices (business_id, id, document_type, financial_year, invoice_date,
  place_of_supply_state, taxable_paise, cgst_paise, sgst_paise, total_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1003', 'TAX_INVOICE', '2026-27',
   '2026-10-27', '09', 100000, 9000, 9000, 118000),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1004', 'TAX_INVOICE', '2027-28',
   '2027-04-01', '09', 100000, 9000, 9000, 118000);
insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, description, quantity,
  unit_price_paise, tax_rate_percent, taxable_paise, cgst_paise, sgst_paise, line_total_paise)
select '00000000-0000-0000-0000-0000000000a1', i, 1, '00000000-0000-0000-0000-00000000a0c1',
       'Accessory (synthetic)', 1, 118000, 18, 100000, 9000, 9000, 118000
  from unnest(array['00000000-0000-0000-0000-0000000a1003', '00000000-0000-0000-0000-0000000a1004']::uuid[]) i;
select t.expect_error($$update lbg.invoices set status = 'ISSUED', invoice_number = 'A/0001', issued_at = now()
  where id = '00000000-0000-0000-0000-0000000a1003'$$, '23505',
  'T14b duplicate invoice number in the same financial year rejected');
select t.expect_error($$update lbg.invoices set status = 'ISSUED', invoice_number = 'A/2026-27/0000001', issued_at = now()
  where id = '00000000-0000-0000-0000-0000000a1003'$$, '23514',
  'T14c invoice number longer than 16 characters rejected');
select t.expect_error($$update lbg.invoices set status = 'ISSUED', invoice_number = 'A 0002', issued_at = now()
  where id = '00000000-0000-0000-0000-0000000a1003'$$, '23514',
  'T14d invoice number with disallowed character rejected');
update lbg.invoices set status = 'ISSUED', invoice_number = 'A/0002', issued_at = now()
 where id = '00000000-0000-0000-0000-0000000a1003';
update lbg.invoices set status = 'ISSUED', invoice_number = 'A/0001', issued_at = now()
 where id = '00000000-0000-0000-0000-0000000a1004';
select t.ok((select count(*) = 2 from lbg.invoices where invoice_number = 'A/0001'),
  'T14e same number allowed in a different financial year');

-- Immutability and cancellation
select t.expect_error($$update lbg.invoices set total_paise = 1, taxable_paise = 1, cgst_paise = 0, sgst_paise = 0
  where id = '00000000-0000-0000-0000-0000000a1001'$$, 'LB003',
  'T16 issued invoice amounts cannot be edited');
select t.expect_error($$insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, description,
  quantity, unit_price_paise, tax_rate_percent, taxable_paise, line_total_paise)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a1001', 2,
          '00000000-0000-0000-0000-00000000a0c1', 'Extra', 1, 100, 0, 100, 100)$$, 'LB003',
  'T16b lines cannot be added to an issued invoice');
select t.expect_error($$update lbg.invoices set status = 'CANCELLED', cancelled_at = now()
  where id = '00000000-0000-0000-0000-0000000a1001'$$, '23514',
  'T16c cancellation without a reason rejected');
select t.expect_error($$delete from lbg.invoices where id = '00000000-0000-0000-0000-0000000a1001'$$, '42501',
  'T16d app role cannot delete invoices');
update lbg.invoices set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'Customer changed mind before handover'
 where id = '00000000-0000-0000-0000-0000000a1001';
select t.ok((select status = 'CANCELLED' and invoice_number = 'A/0001' from lbg.invoices
              where id = '00000000-0000-0000-0000-0000000a1001'),
  'T16e cancellation with reason allowed; number retained');
select t.expect_error($$update lbg.invoices set status = 'ISSUED'
  where id = '00000000-0000-0000-0000-0000000a1001'$$, 'LB003',
  'T16f cancelled invoice cannot be re-issued');

-- ===========================================================================
-- Payments, allocations, ledger (D-014, FR-LED-1/2)
-- ===========================================================================
insert into lbg.payments (business_id, id, customer_id, method, amount_paise, reference) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a2001',
   '00000000-0000-0000-0000-00000000a0f1', 'UPI', 100000, 'UPIREF12345'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a2002',
   '00000000-0000-0000-0000-00000000a0f1', 'CASH', 50000, null);
select t.expect_error($$insert into lbg.payments (business_id, method, amount_paise, reference)
  values ('00000000-0000-0000-0000-0000000000a1', 'CARD', 1000, 'card 4111111111111111')$$, '23514',
  'T24 full card number in payment reference rejected');
insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a2001',
   '00000000-0000-0000-0000-0000000a1003', 100000);
select t.expect_error($$insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a2002',
          '00000000-0000-0000-0000-0000000a1003', 18001)$$, 'LB005',
  'T17 allocation beyond invoice total rejected');
insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a2002',
   '00000000-0000-0000-0000-0000000a1003', 18000);
select t.expect_error($$insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000a2002',
          '00000000-0000-0000-0000-0000000a1004', 32001)$$, 'LB005',
  'T17b allocation beyond payment amount rejected');
select t.ok((select sum(amount_paise) = 118000 from lbg.payment_allocations
              where invoice_id = '00000000-0000-0000-0000-0000000a1003'),
  'T17c invoice fully allocated from two payments');

insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0f1', 'INVOICE', 118000),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0f1', 'PAYMENT', -100000),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0f1', 'PAYMENT', -50000);
select t.ok((select sum(amount_paise) = -32000 from lbg.customer_ledger_entries),
  'T18 ledger balance = debits - credits (negative = advance held)');
select t.expect_error($$insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000a0f1', 'INVOICE', -5)$$,
  '23514', 'T18b ledger entry sign enforced by type');
select t.expect_error($$update lbg.customer_ledger_entries set amount_paise = 1$$, '42501',
  'T18c app role cannot UPDATE ledger entries');

-- ===========================================================================
-- Audit (FR-AUD-1)
-- ===========================================================================
insert into lbg.audit_events (scope, business_id, actor_type, actor_user_id, action) values
  ('TENANT', '00000000-0000-0000-0000-0000000000a1', 'USER', '00000000-0000-0000-0000-000000000001', 'invoice.cancel');
select t.expect_error($$insert into lbg.audit_events (scope, business_id, actor_type, action)
  values ('PLATFORM', '00000000-0000-0000-0000-0000000000a1', 'SYSTEM', 'forged')$$, '42501',
  'T25 tenant cannot write PLATFORM-scope audit events');
select t.expect_error($$update lbg.audit_events set action = 'x'$$, '42501',
  'T25b app role cannot UPDATE audit events');
select set_config('app.business_id', '00000000-0000-0000-0000-0000000000b1', false) \gset
insert into lbg.audit_events (scope, business_id, actor_type, action) values
  ('TENANT', '00000000-0000-0000-0000-0000000000b1', 'USER', 'product.create');
select t.ok((select count(*) = 1 from lbg.audit_events), 'T25c tenant B sees only its own audit events');

-- RLS cannot be switched off by the app role
set row_security = off;
select t.expect_error($$select count(*) from lbg.products$$, '42501',
  'T20 app role cannot bypass RLS with row_security = off');
set row_security = on;
reset role;

-- ===========================================================================
-- Superuser-level checks: triggers hold even with RLS bypassed
-- ===========================================================================
select t.expect_error($$update lbg.stock_movements set reason = 'x'$$, 'LB001',
  'T12c append-only trigger blocks UPDATE even for privileged roles');
select t.expect_error($$delete from lbg.customer_ledger_entries$$, 'LB001',
  'T18d append-only trigger blocks DELETE on ledger even for privileged roles');
select t.expect_error($$delete from lbg.invoices$$, 'LB003',
  'T16g invoice delete blocked by trigger even for privileged roles');

set role lbgos_platform;
select t.ok((select status = 'PENDING_APPROVAL' from lbg.businesses where id = :'new_business_id'),
  'T23 self-registration always creates PENDING_APPROVAL');
insert into lbg.audit_events (scope, actor_type, action) values ('PLATFORM', 'PLATFORM_ADMIN', 'business.approve');
select t.ok((select count(*) = 1 from lbg.audit_events), 'T25d platform sees only PLATFORM-scope audit events');
select t.expect_error($$select password_hash from lbg.users$$, '42501',
  'T29 platform role cannot read password hashes');
reset role;

-- Meta-check: every table in lbg has RLS enabled and forced, except plans
-- (no tenant or personal data), and every RLS table has at least one policy.
select t.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'lbg' and c.relkind = 'r' and c.relname <> 'plans'
     and not (c.relrowsecurity and c.relforcerowsecurity)),
  'T26 every table (except plans) has RLS enabled and forced');
select t.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'lbg' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
  'T26b every RLS table has at least one policy');

-- Auth schema isolation (D-019, threat T32; Phase 3 increment 3.2 AC4)
select t.ok(not has_schema_privilege('lbgos_app', 'auth', 'USAGE'), 'T30 tenant role has no access to schema auth');
select t.ok(not has_schema_privilege('lbgos_platform', 'auth', 'USAGE'), 'T30b platform role has no access to schema auth');
select t.ok(has_schema_privilege('lbgos_auth', 'auth', 'USAGE'), 'T30c auth role can use schema auth');
select t.ok(not has_schema_privilege('lbgos_auth', 'lbg', 'USAGE'), 'T30d auth role has no access to tenant schema lbg');
set role lbgos_owner;   -- default privileges apply to tables created by the owner role
create table auth.t30_probe (id int);
insert into auth.t30_probe values (1);
reset role;
set role lbgos_app;
select t.expect_error($$select * from auth.t30_probe$$, '42501', 'T30e tenant role cannot read a table in schema auth');
reset role;
set role lbgos_auth;
select t.ok((select count(*) = 1 from auth.t30_probe), 'T30f default privileges let the auth role read new auth tables');
reset role;
set role lbgos_owner;
drop table auth.t30_probe;
reset role;

\echo 'ALL SCHEMA CHECKS PASSED'
