// Increment 5.3: selling and issuing through the API (FR-POS-1…3, FR-INV-5
// AC2–4, FR-LED-1, FR-TAX-1 AC4). Synthetic data only.
import { computeSale } from '@lbgos/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  patch,
  post,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let reg: Shop; // REGULAR GST registrant, Maharashtra
let unreg: Shop; // unregistered: Bill of Supply
let other: Shop;
let billing: Session;
let manager: Session;
let managerId: string;
let inventory: Session;
let phone: string;
let cable: string;
let imeiSeq = 5000;
let rateId: string;

interface SaleView {
  id: string;
  status: string;
  documentType: string;
  placeOfSupply: string;
  interState: boolean;
  contentSha256: string;
  discountApproved: boolean;
  totals: { grossPaise: number; discountPaise: number; taxablePaise: number; totalPaise: number } & Record<
    string,
    number
  >;
  problems: { code: string; lineIndex?: number }[];
}
interface Issued {
  invoiceId: string;
  documentType: string;
  number: string;
  totalPaise: number;
  paidPaise: number;
  balanceDuePaise: number;
  advanceAddedPaise: number;
  advanceUsedPaise: number;
  changePaise: number;
}

async function seedUnit(shop: Shop, variantId: string, costPaise: number): Promise<{ unitId: string; imei: string }> {
  const code = imei(imeiSeq++);
  const { rows } = await sql<{ id: string }>`
    insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
    values (${shop.businessId}, ${variantId}, 'IN_STOCK', ${costPaise}) returning id`.execute(h.admin);
  const unitId = rows[0]?.id ?? '';
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
            values (${shop.businessId}, ${code}, ${unitId}, 1)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${variantId}, ${unitId}, 'OPENING', 1, ${costPaise})`.execute(h.admin);
  return { unitId, imei: code };
}

async function seedStock(shop: Shop, variantId: string, qty: number, avgCostPaise: number): Promise<void> {
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${variantId}, 'OPENING', ${qty}, ${avgCostPaise})`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = ${avgCostPaise}
             where business_id = ${shop.businessId} and id = ${variantId}`.execute(h.admin);
}

async function createCustomer(shop: Shop, name: string, mobile: string, gstin?: string): Promise<string> {
  const res = await post(h, `${shop.base}/customers`, { name, mobile, ...(gstin ? { gstin } : {}) }, shop.owner);
  if (res.statusCode !== 201) throw new Error(`customer failed: ${res.statusCode} ${res.body}`);
  return res.json<{ customer: { id: string } }>().customer.id;
}

async function draft(shop: Shop, body: object, session: Session = shop.owner): Promise<SaleView> {
  const res = await post(h, `${shop.base}/sales`, body, session);
  if (res.statusCode !== 201) throw new Error(`draft failed: ${res.statusCode} ${res.body}`);
  return res.json<{ sale: SaleView }>().sale;
}

const issue = (shop: Shop, sale: { id: string }, body: object, session: Session = shop.owner) =>
  post(h, `${shop.base}/sales/${sale.id}/issue`, body, session);

async function ledgerBalance(shop: Shop, customerId: string): Promise<number> {
  const { rows } = await sql<{ balance: string }>`
    select coalesce(sum(amount_paise), 0) as balance from lbg.customer_ledger_entries
     where business_id = ${shop.businessId} and customer_id = ${customerId}`.execute(h.admin);
  return Number(rows[0]?.balance);
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  reg = await activeShop(h, 'sl-reg', { gstin: '27AAPFU0939F1ZV' });
  unreg = await activeShop(h, 'sl-unr');
  other = await activeShop(h, 'sl-oth');
  billing = (await staff(h, reg, 'sl-billing@example.test', 'Billing')).session;
  const m = await staff(h, reg, 'sl-manager@example.test', 'Manager');
  manager = m.session;
  managerId = m.id;
  inventory = (await staff(h, reg, 'sl-inventory@example.test', 'Inventory')).session;
  const rate = await post(
    h,
    `${reg.base}/tax-rates`,
    { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
    reg.owner,
  );
  rateId = rate.json<{ id: string }>().id;
  phone = await variant(h, reg, 'SL-PH', { serialized: true, taxRateId: rateId });
  cable = await variant(h, reg, 'SL-CB', { serialized: false, taxRateId: rateId });
  await patch(h, `${reg.base}/variants/${phone}`, { sellingPricePaise: 1_500_000, hsnCode: '8517' }, reg.owner);
  await patch(h, `${reg.base}/variants/${cable}`, { sellingPricePaise: 50_000, hsnCode: '8544' }, reg.owner);
  await seedStock(reg, cable, 50, 20_000);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('issuing a sale (FR-INV-5 AC2–4, FR-TAX-1)', () => {
  it('walk-in: phone by unit and two cables, cash with change; one transaction writes everything', async () => {
    const u = await seedUnit(reg, phone, 1_100_000);
    const sale = await draft(reg, { lines: [{ unitId: u.unitId }, { variantId: cable, quantity: '2' }] }, billing);
    expect(sale.documentType).toBe('TAX_INVOICE');
    expect(sale.problems).toEqual([]);
    // 18 % inclusive: ₹15,000 → taxable 12,711.86; 2 × ₹500 → taxable 847.46 (D-038).
    expect(sale.totals).toMatchObject({
      grossPaise: 1_600_000,
      taxablePaise: 1_355_932,
      cgstPaise: 122_034,
      sgstPaise: 122_034,
      igstPaise: 0,
      totalPaise: 1_600_000,
    });
    const res = await issue(
      reg,
      sale,
      {
        expectedTotalPaise: 1_600_000,
        payments: [{ method: 'CASH', amountPaise: 1_600_000, tenderedPaise: 1_700_000 }],
      },
      billing,
    );
    expect(res.statusCode).toBe(201);
    const inv = res.json<{ invoice: Issued }>().invoice;
    expect(inv).toMatchObject({ documentType: 'TAX_INVOICE', balanceDuePaise: 0, changePaise: 100_000 });
    expect(inv.number).toMatch(/^T\d{2}-\d{2}\/0001$/);

    const unit = await sql<{ status: string }>`select status from lbg.serialized_units where id = ${u.unitId}`.execute(
      h.admin,
    );
    expect(unit.rows[0]?.status).toBe('SOLD');
    const moves = await sql<{ variant_id: string; quantity_delta: string; unit_cost_paise: string }>`
      select variant_id, quantity_delta::text, unit_cost_paise from lbg.stock_movements
       where reference_type = 'invoice' and reference_id = ${inv.invoiceId} order by unit_id nulls first`.execute(
      h.admin,
    );
    expect(moves.rows.map((m) => [m.variant_id, Number(m.quantity_delta), Number(m.unit_cost_paise)])).toEqual([
      [cable, -2, 20_000],
      [phone, -1, 1_100_000],
    ]);
    const lines = await sql<{ cost_paise: string; description: string }>`
      select cost_paise, description from lbg.invoice_lines where invoice_id = ${inv.invoiceId} order by line_no`.execute(
      h.admin,
    );
    expect(lines.rows.map((l) => Number(l.cost_paise))).toEqual([1_100_000, 40_000]);
    expect(lines.rows[0]?.description).toContain(`IMEI ${u.imei}`);
    const alloc = await sql<{ total: string }>`select sum(amount_paise) as total from lbg.payment_allocations
                                                 where invoice_id = ${inv.invoiceId}`.execute(h.admin);
    expect(Number(alloc.rows[0]?.total)).toBe(1_600_000);
    const tendered = await sql<{ cash_tendered_paise: string }>`
      select p.cash_tendered_paise from lbg.payments p join lbg.payment_allocations a on a.payment_id = p.id
       where a.invoice_id = ${inv.invoiceId}`.execute(h.admin);
    expect(Number(tendered.rows[0]?.cash_tendered_paise)).toBe(1_700_000);
    // Walk-in: no customer ledger; the sale is audited.
    const audit = await sql<{ n: number }>`select count(*)::int as n from lbg.audit_events
                                             where target_id = ${inv.invoiceId} and action = 'sale.issue'`.execute(
      h.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
    // An issued sale is no longer a draft.
    expect(errorCode(await get(h, `${reg.base}/sales/${sale.id}`, billing))).toBe('NOT_DRAFT');
    const detail = (await get(h, `${reg.base}/invoices/${inv.invoiceId}`, billing)).json<{
      invoice: { lines: Record<string, unknown>[]; partySnapshot: { seller: { gstin: string }; buyer: null } };
    }>().invoice;
    expect(detail.partySnapshot).toMatchObject({ seller: { gstin: '27AAPFU0939F1ZV' }, buyer: null });
    // Costs are hidden from staff without catalogue.cost.view.
    expect(detail.lines[0]).not.toHaveProperty('costPaise');
    const ownerView = (await get(h, `${reg.base}/invoices/${inv.invoiceId}`, reg.owner)).json<{
      invoice: { lines: { costPaise: number }[] };
    }>().invoice;
    expect(ownerView.lines[0]?.costPaise).toBe(1_100_000);
  });

  it('inter-state B2B customer: place of supply from the GSTIN, IGST instead of CGST/SGST', async () => {
    const b2b = await createCustomer(reg, 'Bengaluru Traders (synthetic)', '9123400001', '29AAGCB7383J1Z4');
    const sale = await draft(reg, { customerId: b2b, lines: [{ variantId: cable, quantity: '1' }] });
    expect(sale).toMatchObject({ placeOfSupply: '29', interState: true });
    expect(sale.totals).toMatchObject({ taxablePaise: 42_373, igstPaise: 7_627, cgstPaise: 0, sgstPaise: 0 });
    const res = await issue(reg, sale, {
      expectedTotalPaise: 50_000,
      payments: [{ method: 'UPI', amountPaise: 50_000, reference: 'UPI-REF-881234' }],
    });
    expect(res.statusCode).toBe(201);
  });

  it('a Bill of Supply for a shop that is not GST-registered: no tax, total rounded to the rupee', async () => {
    const item = await variant(h, unreg, 'UN-CB', { serialized: false });
    await patch(h, `${unreg.base}/variants/${item}`, { sellingPricePaise: 33_333 }, unreg.owner);
    await seedStock(unreg, item, 5, 10_000);
    const sale = await draft(unreg, { lines: [{ variantId: item, quantity: '1' }] });
    expect(sale.documentType).toBe('BILL_OF_SUPPLY');
    expect(sale.totals).toMatchObject({
      taxablePaise: 33_333,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      roundOffPaise: -33,
      totalPaise: 33_300,
    });
    const res = await issue(unreg, sale, {
      expectedTotalPaise: 33_300,
      payments: [{ method: 'CASH', amountPaise: 33_300 }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ invoice: Issued }>().invoice.documentType).toBe('BILL_OF_SUPPLY');
  });

  it('totals equal the tax engine for a mixed sale with line and invoice discounts', async () => {
    const u = await seedUnit(reg, phone, 1_000_000);
    const body = {
      lines: [
        { unitId: u.unitId, discount: { kind: 'PERCENT', bp: 100 } },
        { variantId: cable, quantity: '3', unitPricePaise: 49_900 },
      ],
      invoiceDiscount: { kind: 'AMOUNT', paise: 1_001 },
    };
    const sale = await draft(reg, body);
    const expected = computeSale({
      lines: [
        {
          qtyMilli: 1000,
          unitPricePaise: 1_500_000,
          priceIncludesTax: true,
          rateBp: 1800,
          cessBp: 0,
          discount: { kind: 'PERCENT', bp: 100 },
        },
        { qtyMilli: 3000, unitPricePaise: 49_900, priceIncludesTax: true, rateBp: 1800, cessBp: 0 },
      ],
      invoiceDiscount: { kind: 'AMOUNT', paise: 1_001 },
      interState: false,
      chargeTax: true,
      roundOff: true,
    });
    // toEqual ignores the undefined `lines`: every total must match the engine.
    expect(sale.totals).toEqual({ ...expected, lines: undefined });
    const res = await issue(reg, sale, {
      expectedTotalPaise: expected.totalPaise,
      payments: [{ method: 'CARD', amountPaise: expected.totalPaise, reference: '4242' }],
    });
    expect(res.statusCode).toBe(201);
    // The database reconciled the header with the lines (LB004 would have refused otherwise).
    const db = await sql<{ total_paise: string; discount_paise: string }>`
      select total_paise, discount_paise from lbg.invoices where id = ${sale.id}`.execute(h.admin);
    expect(Number(db.rows[0]?.total_paise)).toBe(expected.totalPaise);
    expect(Number(db.rows[0]?.discount_paise)).toBe(expected.discountPaise);
  });

  it('refuses to issue when the total the cashier confirmed is not the current total', async () => {
    const sale = await draft(reg, { lines: [{ variantId: cable }] });
    const res = await issue(reg, sale, {
      expectedTotalPaise: 49_000,
      payments: [{ method: 'CASH', amountPaise: 49_000 }],
    });
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'TOTAL_CHANGED']);
  });

  it('a failure late in issuing writes nothing: number, stock, unit and draft are unchanged', async () => {
    const u = await seedUnit(reg, phone, 1_000_000);
    const sale = await draft(reg, { lines: [{ unitId: u.unitId }] });
    const series = await sql<{ next: number }>`select next_number as next from lbg.invoice_series
                                                  where business_id = ${reg.businessId} and document_type = 'TAX_INVOICE'`.execute(
      h.admin,
    );
    const nextBefore = series.rows[0]?.next ?? 0;
    // A one-digit series that is already at 9 cannot give another number.
    await sql`update lbg.invoice_series set number_format = '{PREFIX}{SEQ:1}', next_number = 10
               where business_id = ${reg.businessId} and document_type = 'TAX_INVOICE'`.execute(h.admin);
    const before = await sql<{ n: number }>`select count(*)::int as n from lbg.stock_movements
                                              where business_id = ${reg.businessId}`.execute(h.admin);
    const res = await issue(reg, sale, {
      expectedTotalPaise: 1_500_000,
      payments: [{ method: 'CASH', amountPaise: 1_500_000 }],
    });
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'SERIES_EXHAUSTED']);
    const after = await sql<{ n: number }>`select count(*)::int as n from lbg.stock_movements
                                             where business_id = ${reg.businessId}`.execute(h.admin);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const state = await sql<{ unit: string; invoice: string; next: number; payments: number }>`
      select (select status from lbg.serialized_units where id = ${u.unitId}) as unit,
             (select status from lbg.invoices where id = ${sale.id}) as invoice,
             (select next_number from lbg.invoice_series where business_id = ${reg.businessId}
                 and document_type = 'TAX_INVOICE') as next,
             (select count(*)::int from lbg.payments where business_id = ${reg.businessId}
                 and received_at > now() - interval '5 seconds' and amount_paise = 1500000) as payments`.execute(
      h.admin,
    );
    expect(state.rows[0]).toEqual({ unit: 'IN_STOCK', invoice: 'DRAFT', next: 10, payments: 0 });
    // Restore the series: the next sale takes the next consecutive number.
    await sql`update lbg.invoice_series set number_format = '{PREFIX}{FY}/{SEQ:4}', next_number = ${nextBefore}
               where business_id = ${reg.businessId} and document_type = 'TAX_INVOICE'`.execute(h.admin);
    const ok = await issue(reg, sale, {
      expectedTotalPaise: 1_500_000,
      payments: [{ method: 'CASH', amountPaise: 1_500_000 }],
    });
    expect(ok.json<{ invoice: Issued }>().invoice.number).toMatch(
      new RegExp(`/${String(nextBefore).padStart(4, '0')}$`),
    );
  });
});

describe('concurrency (FR-INV-5 AC4)', () => {
  it('two checkouts selling the same IMEI at once: exactly one succeeds', async () => {
    const u = await seedUnit(reg, phone, 1_000_000);
    const a = await draft(reg, { lines: [{ unitId: u.unitId }] }, billing);
    const b = await draft(reg, { lines: [{ unitId: u.unitId }] }, manager);
    const body = { expectedTotalPaise: 1_500_000, payments: [{ method: 'CASH', amountPaise: 1_500_000 }] };
    const results = await Promise.all([issue(reg, a, body, billing), issue(reg, b, body, manager)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.map((r) => errorCode(r)).filter(Boolean)).toEqual(['UNIT_NOT_AVAILABLE']);
    const sold = await sql<{ n: number }>`select count(*)::int as n from lbg.stock_movements
                                            where unit_id = ${u.unitId} and movement_type = 'SALE'`.execute(h.admin);
    expect(sold.rows[0]?.n).toBe(1);
  });

  it('the same draft issued twice at once (double tap): one invoice, the other is told it is done', async () => {
    const sale = await draft(reg, { lines: [{ variantId: cable }] });
    const body = { expectedTotalPaise: 50_000, payments: [{ method: 'CASH', amountPaise: 50_000 }] };
    const results = await Promise.all([issue(reg, sale, body), issue(reg, sale, body)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.map((r) => errorCode(r)).filter(Boolean)).toEqual(['NOT_DRAFT']);
    const pays = await sql<{ n: number }>`select count(*)::int as n from lbg.payment_allocations
                                            where invoice_id = ${sale.id}`.execute(h.admin);
    expect(pays.rows[0]?.n).toBe(1);
  });

  it('the last units of an item cannot be sold twice; never below zero', async () => {
    const item = await variant(h, reg, 'SL-LAST', { serialized: false, taxRateId: rateId });
    await seedStock(reg, item, 1, 5_000);
    const a = await draft(reg, { lines: [{ variantId: item }] });
    const b = await draft(reg, { lines: [{ variantId: item }] });
    const body = { expectedTotalPaise: 100_000, payments: [{ method: 'CASH', amountPaise: 100_000 }] };
    const results = await Promise.all([issue(reg, a, body), issue(reg, b, body)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.map((r) => errorCode(r)).filter(Boolean)).toEqual(['INSUFFICIENT_STOCK']);
    const level = await sql<{ quantity: string }>`select quantity::text from lbg.stock_levels
                                                    where variant_id = ${item} and bucket = 'AVAILABLE'`.execute(
      h.admin,
    );
    expect(Number(level.rows[0]?.quantity)).toBe(0);
  });
});

describe('payments (FR-POS-3, D-014, FR-LED-1)', () => {
  it('a balance due needs a customer with a mobile; with one, the ledger shows what is owed', async () => {
    const walkIn = await draft(reg, { lines: [{ variantId: cable, quantity: '4' }] }, billing);
    const part = {
      expectedTotalPaise: 200_000,
      payments: [{ method: 'UPI', amountPaise: 50_000, reference: 'UPI-1' }],
    };
    const refused = await issue(reg, walkIn, part, billing);
    expect([refused.statusCode, errorCode(refused)]).toEqual([422, 'BALANCE_NEEDS_CUSTOMER']);

    const customer = await createCustomer(reg, 'Asha Patil (synthetic)', '9876500001');
    await put(
      h,
      `${reg.base}/sales/${walkIn.id}`,
      { customerId: customer, lines: [{ variantId: cable, quantity: '4' }] },
      billing,
    );
    const res = await issue(
      reg,
      walkIn,
      {
        expectedTotalPaise: 200_000,
        payments: [
          { method: 'UPI', amountPaise: 50_000, reference: 'UPI-2' },
          { method: 'CASH', amountPaise: 30_000 },
        ],
      },
      billing,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json<{ invoice: Issued }>().invoice).toMatchObject({ paidPaise: 80_000, balanceDuePaise: 120_000 });
    expect(await ledgerBalance(reg, customer)).toBe(120_000);
    const entries = await sql<{ entry_type: string; amount_paise: string }>`
      select entry_type, amount_paise from lbg.customer_ledger_entries where customer_id = ${customer}
       order by amount_paise desc`.execute(h.admin);
    expect(entries.rows.map((e) => [e.entry_type, Number(e.amount_paise)])).toEqual([
      ['INVOICE', 200_000],
      ['PAYMENT', -30_000],
      ['PAYMENT', -50_000],
    ]);
  });

  it('paying more than the total: refused for walk-ins, kept as advance for a customer and used on the next sale', async () => {
    const over = { expectedTotalPaise: 50_000, payments: [{ method: 'CASH', amountPaise: 80_000 }] };
    const walkIn = await draft(reg, { lines: [{ variantId: cable }] });
    expect(errorCode(await issue(reg, walkIn, over))).toBe('OVERPAYMENT_NEEDS_CUSTOMER');

    const customer = await createCustomer(reg, 'Vikram Rao (synthetic)', '9876500002');
    const first = await draft(reg, { customerId: customer, lines: [{ variantId: cable }] });
    const res = await issue(reg, first, over);
    expect(res.json<{ invoice: Issued }>().invoice.advanceAddedPaise).toBe(30_000);
    expect(await ledgerBalance(reg, customer)).toBe(-30_000);

    const second = await draft(reg, { customerId: customer, lines: [{ variantId: cable }] });
    const tooMuch = await issue(reg, second, {
      expectedTotalPaise: 50_000,
      useAdvancePaise: 40_000,
      payments: [{ method: 'CASH', amountPaise: 10_000 }],
    });
    expect(errorCode(tooMuch)).toBe('INSUFFICIENT_ADVANCE');
    const used = await issue(reg, second, {
      expectedTotalPaise: 50_000,
      useAdvancePaise: 30_000,
      payments: [{ method: 'CASH', amountPaise: 20_000 }],
    });
    expect(used.json<{ invoice: Issued }>().invoice).toMatchObject({ advanceUsedPaise: 30_000, balanceDuePaise: 0 });
    expect(await ledgerBalance(reg, customer)).toBe(0);
    const alloc = await sql<{ total: string }>`select sum(amount_paise) as total from lbg.payment_allocations
                                                 where invoice_id = ${second.id}`.execute(h.admin);
    expect(Number(alloc.rows[0]?.total)).toBe(50_000);
  });

  it('full card numbers are never accepted in a payment reference (FR-POS-3 AC4)', async () => {
    const sale = await draft(reg, { lines: [{ variantId: cable }] });
    const res = await issue(reg, sale, {
      expectedTotalPaise: 50_000,
      payments: [{ method: 'CARD', amountPaise: 50_000, reference: '4111 1111 1111 1111' }],
    });
    expect([res.statusCode, errorCode(res)]).toEqual([422, 'PAYMENT_INVALID']);
    const tendered = await issue(reg, sale, {
      expectedTotalPaise: 50_000,
      payments: [{ method: 'UPI', amountPaise: 50_000, tenderedPaise: 60_000 }],
    });
    expect(errorCode(tendered)).toBe('PAYMENT_INVALID');
  });
});

describe('discounts and prices (FR-POS-2)', () => {
  it('within the cashier limit the sale goes through; above it, approval by a member whose limit covers it', async () => {
    // Billing: 2 % / ₹500. A ₹15,000 phone at 1 % is fine; at 3 % (₹450) it needs approval.
    const u1 = await seedUnit(reg, phone, 1_000_000);
    const ok = await draft(reg, { lines: [{ unitId: u1.unitId, discount: { kind: 'PERCENT', bp: 100 } }] }, billing);
    expect(ok.problems).toEqual([]);
    expect(
      (
        await issue(
          reg,
          ok,
          {
            expectedTotalPaise: ok.totals.totalPaise,
            payments: [{ method: 'CASH', amountPaise: ok.totals.totalPaise }],
          },
          billing,
        )
      ).statusCode,
    ).toBe(201);

    const u2 = await seedUnit(reg, phone, 1_000_000);
    const over = await draft(reg, { lines: [{ unitId: u2.unitId, discount: { kind: 'PERCENT', bp: 300 } }] }, billing);
    expect(over.problems.map((p) => p.code)).toEqual(['DISCOUNT_NEEDS_APPROVAL']);
    const pay = {
      expectedTotalPaise: over.totals.totalPaise,
      payments: [{ method: 'CASH', amountPaise: over.totals.totalPaise }],
    };
    const blocked = await issue(reg, over, pay, billing);
    expect([blocked.statusCode, errorCode(blocked)]).toEqual([422, 'NOT_READY']);

    const requested = await post(
      h,
      `${reg.base}/sales/${over.id}/discount-approval`,
      { reason: 'Regular customer, matching a competitor price.' },
      billing,
    );
    expect(requested.statusCode).toBe(201);
    const { id: requestId, payloadSha256 } = requested.json<{
      approvalRequest: { id: string; payloadSha256: string };
    }>().approvalRequest;
    // The cashier cannot approve it (no approvals.decide, and the limit would not cover it).
    expect(
      (await post(h, `${reg.base}/approvals/${requestId}/decide`, { approve: true, payloadSha256 }, billing))
        .statusCode,
    ).toBe(403);
    const decided = await post(
      h,
      `${reg.base}/approvals/${requestId}/decide`,
      { approve: true, payloadSha256 },
      manager,
    );
    expect(decided.json<{ request: { status: string } }>().request.status).toBe('EXECUTED');

    const res = await issue(reg, over, pay, billing);
    expect(res.statusCode).toBe(201);
    const inv = await sql<{ discount_approved_by: string; discount_approval_id: string }>`
      select discount_approved_by, discount_approval_id from lbg.invoices where id = ${over.id}`.execute(h.admin);
    expect(inv.rows[0]).toEqual({ discount_approved_by: managerId, discount_approval_id: requestId });
  });

  it("an approver's own limit must cover the discount; changing the sale after approval needs a new approval", async () => {
    // Manager: 10 % / ₹5,000. 20 % of ₹15,000 = ₹3,000 is within the amount but not the percentage.
    const u = await seedUnit(reg, phone, 1_000_000);
    const big = await draft(reg, { lines: [{ unitId: u.unitId, discount: { kind: 'PERCENT', bp: 2000 } }] }, billing);
    const r1 = (
      await post(
        h,
        `${reg.base}/sales/${big.id}/discount-approval`,
        { reason: 'Damaged box, customer asked.' },
        billing,
      )
    ).json<{ approvalRequest: { id: string; payloadSha256: string } }>().approvalRequest;
    const refused = await post(
      h,
      `${reg.base}/approvals/${r1.id}/decide`,
      { approve: true, payloadSha256: r1.payloadSha256 },
      manager,
    );
    expect([refused.statusCode, errorCode(refused)]).toEqual([403, 'FORBIDDEN']);
    // The owner (unlimited) approves.
    const approved = await post(
      h,
      `${reg.base}/approvals/${r1.id}/decide`,
      { approve: true, payloadSha256: r1.payloadSha256 },
      reg.owner,
    );
    expect(approved.json<{ request: { status: string } }>().request.status).toBe('EXECUTED');
    expect(
      (await get(h, `${reg.base}/sales/${big.id}`, billing)).json<{ sale: SaleView }>().sale.discountApproved,
    ).toBe(true);

    // Adding an item changes what was approved.
    const changed = await put(
      h,
      `${reg.base}/sales/${big.id}`,
      { lines: [{ unitId: u.unitId, discount: { kind: 'PERCENT', bp: 2000 } }, { variantId: cable }] },
      billing,
    );
    expect(changed.json<{ sale: SaleView }>().sale.problems.map((p) => p.code)).toEqual(['DISCOUNT_NEEDS_APPROVAL']);
    // Asking for approval of a discount within one's own limit is refused.
    const small = await draft(reg, { lines: [{ variantId: cable }] }, billing);
    expect(
      errorCode(
        await post(
          h,
          `${reg.base}/sales/${small.id}/discount-approval`,
          { reason: 'No discount at all here.' },
          billing,
        ),
      ),
    ).toBe('APPROVAL_NOT_NEEDED');
  });

  it('an approval executed after the sale changed fails instead of approving the new content', async () => {
    const u = await seedUnit(reg, phone, 1_000_000);
    const lines = [{ unitId: u.unitId, discount: { kind: 'PERCENT', bp: 500 } }];
    const sale = await draft(reg, { lines }, billing);
    const r = (
      await post(
        h,
        `${reg.base}/sales/${sale.id}/discount-approval`,
        { reason: 'Festival offer for this phone.' },
        billing,
      )
    ).json<{ approvalRequest: { id: string; payloadSha256: string } }>().approvalRequest;
    await put(
      h,
      `${reg.base}/sales/${sale.id}`,
      { lines: [{ unitId: u.unitId, discount: { kind: 'PERCENT', bp: 900 } }] },
      billing,
    );
    const decided = await post(
      h,
      `${reg.base}/approvals/${r.id}/decide`,
      { approve: true, payloadSha256: r.payloadSha256 },
      manager,
    );
    expect(decided.json<{ request: { status: string; errorCode: string } }>().request).toMatchObject({
      status: 'EXECUTION_FAILED',
      errorCode: 'SALE_CHANGED',
    });
  });

  it('selling below the minimum price needs pos.price_override', async () => {
    const item = await variant(h, reg, 'SL-MIN', { serialized: false, taxRateId: rateId });
    await patch(h, `${reg.base}/variants/${item}`, { minSellingPricePaise: 90_000 }, reg.owner);
    await seedStock(reg, item, 5, 50_000);
    const low = { lines: [{ variantId: item, unitPricePaise: 85_000 }] };
    const byBilling = await draft(reg, low, billing);
    expect(byBilling.problems.map((p) => p.code)).toEqual(['BELOW_MIN_PRICE']);
    const byManager = await draft(reg, low, manager);
    expect(byManager.problems).toEqual([]);
    expect(
      (
        await issue(
          reg,
          byManager,
          { expectedTotalPaise: 85_000, payments: [{ method: 'CASH', amountPaise: 85_000 }] },
          manager,
        )
      ).statusCode,
    ).toBe(201);
  });
});

describe('carts, rules and access', () => {
  it('serialized items need a unit; a unit not in stock is reported; the same unit twice is refused', async () => {
    const noUnit = await draft(reg, { lines: [{ variantId: phone }] });
    expect(noUnit.problems.map((p) => p.code)).toEqual(['UNIT_REQUIRED']);
    const { rows } = await sql<{ id: string }>`select id from lbg.serialized_units
                                                where variant_id = ${phone} and status = 'SOLD' limit 1`.execute(
      h.admin,
    );
    const soldUnit = rows[0]?.id ?? '';
    const sold = await draft(reg, { lines: [{ unitId: soldUnit }] });
    expect(sold.problems.map((p) => p.code)).toEqual(['UNIT_NOT_AVAILABLE']);
    const u = await seedUnit(reg, phone, 1_000_000);
    const twice = await post(
      h,
      `${reg.base}/sales`,
      { lines: [{ unitId: u.unitId }, { unitId: u.unitId }] },
      reg.owner,
    );
    expect([twice.statusCode, errorCode(twice)]).toEqual([422, 'INVALID_LINE']);
    const qty = await post(h, `${reg.base}/sales`, { lines: [{ unitId: u.unitId, quantity: '2' }] }, reg.owner);
    expect(errorCode(qty)).toBe('INVALID_LINE');
  });

  it('held carts are listed and can be discarded; a discarded cart cannot be issued', async () => {
    const sale = await draft(reg, { lines: [{ variantId: cable }] }, billing);
    const held = (await get(h, `${reg.base}/sales`, billing)).json<{ sales: { id: string }[] }>().sales;
    expect(held.map((s) => s.id)).toContain(sale.id);
    expect((await post(h, `${reg.base}/sales/${sale.id}/discard`, {}, billing)).statusCode).toBe(204);
    const res = await issue(
      reg,
      sale,
      { expectedTotalPaise: 50_000, payments: [{ method: 'CASH', amountPaise: 50_000 }] },
      billing,
    );
    expect(errorCode(res)).toBe('NOT_DRAFT');
  });

  it('permissions and tenancy: other businesses and roles without pos.sell get nothing', async () => {
    const sale = await draft(reg, { lines: [{ variantId: cable }] });
    expect((await get(h, `${reg.base}/sales`, inventory)).statusCode).toBe(403);
    expect((await post(h, `${reg.base}/sales`, { lines: [{ variantId: cable }] }, inventory)).statusCode).toBe(403);
    expect((await get(h, `${reg.base}/sales/${sale.id}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/sales/${sale.id}`, other.owner)).statusCode).toBe(404);
    const foreign = await issue(
      other,
      sale,
      { expectedTotalPaise: 50_000, payments: [{ method: 'CASH', amountPaise: 50_000 }] },
      other.owner,
    );
    expect(foreign.statusCode).toBe(404);
    // Another business's items and customers cannot be put on a sale.
    expect(errorCode(await post(h, `${other.base}/sales`, { lines: [{ variantId: cable }] }, other.owner))).toBe(
      'INVALID_LINE',
    );
    const customer = await createCustomer(reg, 'Meera Iyer (synthetic)', '9876500003');
    const otherItem = await variant(h, other, 'OT-CB', { serialized: false });
    expect(
      errorCode(
        await post(h, `${other.base}/sales`, { customerId: customer, lines: [{ variantId: otherItem }] }, other.owner),
      ),
    ).toBe('CUSTOMER_NOT_FOUND');
    const invoices = (await get(h, `${reg.base}/invoices`, reg.owner)).json<{ invoices: { id: string }[] }>().invoices;
    const someInvoice = invoices[0]?.id ?? '';
    expect((await get(h, `${other.base}/invoices/${someInvoice}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${reg.base}/invoices/${someInvoice}`, inventory)).statusCode).toBe(403);
  });

  it('a suspended (read-only) business can read invoices but not sell or change approvals', async () => {
    const held = await draft(unreg, { lines: [] as object[] }).catch(() => null);
    expect(held).toBeNull(); // an empty cart is refused (schema: at least one line)
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${unreg.businessId}`.execute(h.admin);
    expect((await get(h, `${unreg.base}/invoices`, unreg.owner)).statusCode).toBe(200);
    for (const res of [
      await post(h, `${unreg.base}/sales`, { lines: [{ variantId: cable }] }, unreg.owner),
      await post(h, `${unreg.base}/approvals/${unreg.businessId}/cancel`, {}, unreg.owner),
    ]) {
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'TENANT_READ_ONLY']);
    }
  });
});
