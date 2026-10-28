// Increment 5.7: reports and exports on a seeded dataset with exact values
// (FR-RPT-1 AC2, FR-RPT-2, FR-RPT-3, FR-RPT-4, FR-LED-3, D-045). Sales are
// issued through the sales module with chosen times so day, week and
// financial-year boundaries in IST are exercised. Synthetic data only.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  cancelInvoice,
  createSaleDraft,
  issueCreditNote,
  issueSale,
  recordPayment,
  type SaleLineSpec,
} from '@lbgos/modules/sales';
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
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const run = promisify(execFile);
const ACCESS = { discount: { limits: undefined }, priceOverride: true };
const DAY = 86_400_000;

let h: Harness;
let shop: Shop; // GST-registered, Maharashtra: the sales dataset
let aged: Shop; // unregistered: receivables ageing and stock valuation
let other: Shop;
let billing: Session;
let accountant: Session;
let inventory: Session;
let customerX: string;

const ctxOf = (s: Shop) => ({ businessId: s.businessId, userId: s.ownerId });

async function sellAt(
  s: Shop,
  lines: SaleLineSpec[],
  customerId: string | null,
  paid: { method: 'CASH' | 'UPI' | 'CARD'; paise: number } | null,
  at: Date,
) {
  const draft = await createSaleDraft(h.appDb, ctxOf(s), ACCESS, { customerId, lines }, at);
  const total = draft.totals.totalPaise;
  const issued = await issueSale(
    h.appDb,
    ctxOf(s),
    ACCESS,
    draft.id,
    {
      expectedTotalPaise: total,
      payments: paid
        ? [{ method: paid.method, amountPaise: paid.paise, reference: paid.method === 'CASH' ? null : 'REF-1' }]
        : [],
    },
    { at },
  );
  return issued;
}

const report = async <T>(s: Shop, name: string, query: string, session: Session = s.owner): Promise<T> => {
  const res = await get(h, `${s.base}/reports/${name}${query ? `?${query}` : ''}`, session);
  if (res.statusCode !== 200) throw new Error(`${name}: ${String(res.statusCode)} ${res.body}`);
  return res.json<{ report: T }>().report;
};

interface Summary {
  period: { from: string; to: string; previous: { from: string; to: string } };
  current: {
    invoiceCount: number;
    grossSalesPaise: number;
    returnsPaise: number;
    netSalesPaise: number;
    taxableValuePaise: number;
    taxCollectedPaise: number;
  };
  previous: { netSalesPaise: number };
  definitions: Record<string, { label: string; definition: string }>;
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'rpt-a', { gstin: '27AAPFU0939F1ZV' });
  aged = await activeShop(h, 'rpt-b');
  other = await activeShop(h, 'rpt-c');
  billing = (await staff(h, shop, 'rpt-billing@example.test', 'Billing')).session;
  accountant = (await staff(h, shop, 'rpt-accountant@example.test', 'Accountant')).session;
  inventory = (await staff(h, shop, 'rpt-inventory@example.test', 'Inventory')).session;

  // Dataset A — 18 % inclusive: phone ₹15,000 (unit cost ₹11,000), cable ₹500 (average cost ₹200).
  const taxRateId = (
    await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
      shop.owner,
    )
  ).json<{ id: string }>().id;
  const phone = await variant(h, shop, 'RPT-PH', { serialized: true, taxRateId });
  const cable = await variant(h, shop, 'RPT-CB', { serialized: false, taxRateId });
  await patch(h, `${shop.base}/variants/${phone}`, { sellingPricePaise: 1_500_000 }, shop.owner);
  await patch(h, `${shop.base}/variants/${cable}`, { sellingPricePaise: 50_000 }, shop.owner);
  const unit =
    (
      await sql<{ id: string }>`insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
      values (${shop.businessId}, ${phone}, 'IN_STOCK', 1100000) returning id`.execute(h.admin)
    ).rows[0]?.id ?? '';
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot) values (${shop.businessId}, ${imei(8301)}, ${unit}, 1)`.execute(
    h.admin,
  );
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${phone}, ${unit}, 'OPENING', 1, 1100000)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 50, 20000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 20000 where id = ${cable}`.execute(h.admin);
  customerX = (
    await post(
      h,
      `${shop.base}/customers`,
      { name: "=cmd|' /C calc'!A0 (synthetic)", mobile: '9830000001' },
      shop.owner,
    )
  ).json<{ customer: { id: string } }>().customer.id;

  // A: 31 Mar 2026 23:30 IST, 1 cable, cash. B: 1 Apr 2026 00:15 IST, 2 cables, cash.
  await sellAt(shop, [{ variantId: cable }], null, { method: 'CASH', paise: 50_000 }, new Date('2026-03-31T18:00:00Z'));
  await sellAt(
    shop,
    [{ variantId: cable, quantity: '2' }],
    null,
    { method: 'CASH', paise: 100_000 },
    new Date('2026-03-31T18:45:00Z'),
  );
  // C: 5 Oct 2026 23:30 IST, phone + cable to X, ₹10,000 by UPI. D: 6 Oct 2026 00:30 IST, 4 cables, card.
  const c = await sellAt(
    shop,
    [{ unitId: unit }, { variantId: cable }],
    customerX,
    { method: 'UPI', paise: 1_000_000 },
    new Date('2026-10-05T18:00:00Z'),
  );
  await sellAt(
    shop,
    [{ variantId: cable, quantity: '4' }],
    null,
    { method: 'CARD', paise: 200_000 },
    new Date('2026-10-05T19:00:00Z'),
  );
  // E: 7 Oct 2026, a cable sold and cancelled the same day (cash refunded): it counts nowhere.
  const e = await sellAt(
    shop,
    [{ variantId: cable }],
    null,
    { method: 'CASH', paise: 50_000 },
    new Date('2026-10-07T06:00:00Z'),
  );
  await cancelInvoice(
    h.appDb,
    ctxOf(shop),
    { canRefund: true },
    e.invoiceId,
    { reason: 'Billed by mistake at the counter.', goods: 'NOT_TAKEN', settlement: 'REFUND', refundMethod: 'CASH' },
    { at: new Date('2026-10-07T07:00:00Z') },
  );
  // Credit note for C's cable on Sunday 11 Oct 2026 (as advance; nothing paid back).
  await issueCreditNote(
    h.appDb,
    ctxOf(shop),
    { canRefund: true },
    c.invoiceId,
    { reason: 'Cable returned unused.', lines: [{ lineNo: 2 }], settlement: 'ADVANCE' },
    { at: new Date('2026-10-11T06:00:00Z') },
  );

  // Dataset B — dates relative to today, so ageing does not depend on when the test runs.
  const item = await variant(h, aged, 'AGE-IT', { serialized: false });
  const agedPhone = await variant(h, aged, 'AGE-PH', { serialized: true });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${aged.businessId}, ${item}, 'OPENING', 10, 40000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 40000 where id = ${item}`.execute(h.admin);
  const agedUnit = (
    await sql<{ id: string }>`insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
      values (${aged.businessId}, ${agedPhone}, 'IN_STOCK', 900000) returning id`.execute(h.admin)
  ).rows[0]?.id;
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${aged.businessId}, ${agedPhone}, ${agedUnit}, 'OPENING', 1, 900000)`.execute(h.admin);
  const mk = async (name: string, mobile: string) =>
    (await post(h, `${aged.base}/customers`, { name, mobile }, aged.owner)).json<{ customer: { id: string } }>()
      .customer.id;
  const y = await mk('Yash (synthetic)', '9830000011');
  const z = await mk('Zara (synthetic)', '9830000012');
  const w = await mk('Wasim (synthetic)', '9830000013');
  const now = Date.now();
  for (const days of [10, 45, 100]) await sellAt(aged, [{ variantId: item }], y, null, new Date(now - days * DAY));
  await sellAt(aged, [{ variantId: item }], z, { method: 'CASH', paise: 30_000 }, new Date(now - 70 * DAY));
  await recordPayment(h.appDb, ctxOf(aged), w, { method: 'CASH', amountPaise: 50_000 });
  // 2 of the 6 remaining items found damaged (moved out of sellable stock).
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, bucket, reason)
            values (${aged.businessId}, ${item}, 'RECLASSIFY', -2, 'AVAILABLE', 'Found damaged in count.'),
                   (${aged.businessId}, ${item}, 'RECLASSIFY', 2, 'DAMAGED', 'Found damaged in count.')`.execute(
    h.admin,
  );
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('sales summary (FR-RPT-1, FR-RPT-3)', () => {
  it('days follow the business timezone: 23:30 and 00:30 IST land on their own dates', async () => {
    const day = async (date: string) =>
      (await report<Summary>(shop, 'sales-summary', `period=day&date=${date}`)).current;
    expect(await day('2026-03-31')).toMatchObject({ invoiceCount: 1, grossSalesPaise: 50_000 });
    expect(await day('2026-04-01')).toMatchObject({ invoiceCount: 1, grossSalesPaise: 100_000 });
    expect(await day('2026-10-05')).toMatchObject({ invoiceCount: 1, grossSalesPaise: 1_550_000 });
    expect(await day('2026-10-06')).toMatchObject({ invoiceCount: 1, grossSalesPaise: 200_000 });
  });

  it('financial years split at 31 March / 1 April; exact totals for 2026-27', async () => {
    const fy25 = await report<Summary>(shop, 'sales-summary', 'period=fy&date=2026-03-31');
    expect(fy25.period).toMatchObject({ from: '2025-04-01', to: '2026-03-31' });
    expect(fy25.current).toMatchObject({ invoiceCount: 1, grossSalesPaise: 50_000, netSalesPaise: 50_000 });
    const fy26 = await report<Summary>(shop, 'sales-summary', 'period=fy&date=2026-04-01');
    expect(fy26.current).toEqual({
      invoiceCount: 3,
      grossSalesPaise: 1_850_000,
      returnsPaise: 50_000,
      netSalesPaise: 1_800_000,
      taxableValuePaise: 1_525_424,
      taxCollectedPaise: 274_576,
    });
    expect(fy26.previous.netSalesPaise).toBe(50_000);
  });

  it('month with previous-period comparison; weeks start on the configured day', async () => {
    const oct = await report<Summary>(shop, 'sales-summary', 'period=month&date=2026-10-15');
    expect(oct.current).toMatchObject({
      invoiceCount: 2,
      grossSalesPaise: 1_750_000,
      returnsPaise: 50_000,
      netSalesPaise: 1_700_000,
    });
    expect(oct.period.previous).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(oct.previous.netSalesPaise).toBe(0);
    // Monday weeks: 5–11 Oct includes the Sunday credit note.
    const mon = await report<Summary>(shop, 'sales-summary', 'period=week&date=2026-10-07');
    expect(mon.period).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
    expect(mon.current.returnsPaise).toBe(50_000);
    await sql`update lbg.business_settings set week_start = 7 where business_id = ${shop.businessId}`.execute(h.admin);
    const sun = await report<Summary>(shop, 'sales-summary', 'period=week&date=2026-10-07');
    expect(sun.period).toMatchObject({ from: '2026-10-04', to: '2026-10-10' });
    expect(sun.current.returnsPaise).toBe(0);
    await sql`update lbg.business_settings set week_start = 1 where business_id = ${shop.businessId}`.execute(h.admin);
  });

  it('every metric carries its definition; sales are never labelled profit or cash (FR-RPT-2, FR-LED-3)', async () => {
    const r = await report<Summary>(shop, 'sales-summary', 'period=month&date=2026-10-15');
    expect(Object.keys(r.definitions)).toEqual(['grossSales', 'returns', 'netSales', 'taxableValue', 'taxCollected']);
    for (const d of Object.values(r.definitions)) {
      expect(d.definition.length).toBeGreaterThan(10);
      expect(d.label).not.toMatch(/profit|cash/i);
    }
    expect(
      errorCode(
        await get(h, `${shop.base}/reports/sales-summary?period=custom&from=2026-10-10&to=2026-10-01`, shop.owner),
      ),
    ).toBe('INVALID_PERIOD');
  });
});

describe('item, margin, payments, returns and tax (FR-RPT-1 AC2)', () => {
  it('sales by model with margin for financial roles only', async () => {
    type Rows = {
      rows: {
        name: string;
        quantity: string;
        netSalesPaise: number;
        taxableValuePaise: number;
        cogsPaise?: number;
        grossMarginPaise?: number;
      }[];
    };
    const q = 'period=month&date=2026-10-15&groupBy=model';
    const owner = await report<Rows>(shop, 'sales-by-item', q);
    expect(owner.rows).toEqual([
      {
        name: 'Model RPT-PH',
        quantity: '1.000',
        netSalesPaise: 1_500_000,
        taxableValuePaise: 1_271_186,
        cogsPaise: 1_100_000,
        grossMarginPaise: 171_186,
        linesWithoutCost: 0,
      },
      {
        name: 'Model RPT-CB',
        quantity: '4.000',
        netSalesPaise: 200_000,
        taxableValuePaise: 169_492,
        cogsPaise: 80_000,
        grossMarginPaise: 89_492,
        linesWithoutCost: 0,
      },
    ]);
    const margin = await report<{
      taxableValuePaise: number;
      cogsPaise: number;
      grossMarginPaise: number;
      grossMarginBp: number;
    }>(shop, 'margin', 'period=month&date=2026-10-15');
    expect(margin).toMatchObject({
      taxableValuePaise: 1_440_678,
      cogsPaise: 1_180_000,
      grossMarginPaise: 260_678,
      grossMarginBp: 1809,
    });
    // Billing has no reports at all; Accountant sees margin.
    expect((await get(h, `${shop.base}/reports/sales-by-item?${q}`, billing)).statusCode).toBe(403);
    expect((await report<Rows>(shop, 'sales-by-item', q, accountant)).rows[0]?.cogsPaise).toBe(1_100_000);
  });

  it('cash received by method, by business date of the payment', async () => {
    type P = { rows: { method: string; receivedPaise: number; netPaise: number }[]; totals: { netPaise: number } };
    const oct = await report<P>(shop, 'payments', 'period=custom&from=2026-10-01&to=2026-10-31');
    // The cancelled cash sale: ₹500 received and ₹500 refunded the same day.
    expect(oct.rows.map((r) => [r.method, r.receivedPaise, r.netPaise])).toEqual([
      ['CARD', 200_000, 200_000],
      ['CASH', 50_000, 0],
      ['UPI', 1_000_000, 1_000_000],
    ]);
    expect(oct.totals.netPaise).toBe(1_200_000);
    const d5 = await report<P>(shop, 'payments', 'period=day&date=2026-10-05');
    expect(d5.rows.map((r) => r.method)).toEqual(['UPI']);
    const mar = await report<P>(shop, 'payments', 'period=day&date=2026-03-31');
    expect(mar.totals.netPaise).toBe(50_000);
  });

  it('returns and the tax summary (labelled as not a filing)', async () => {
    const ret = await report<{ rows: { totalPaise: number; customerName: string }[]; totalPaise: number }>(
      shop,
      'returns',
      'period=month&date=2026-10-15',
    );
    expect(ret.totalPaise).toBe(50_000);
    expect(ret.rows).toHaveLength(1);
    type T = {
      rows: { documentType: string; documents: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }[];
      totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };
      note: string;
    };
    const tax = await report<T>(shop, 'tax', 'period=month&date=2026-10-15');
    expect(tax.rows.map((r) => [r.documentType, r.documents, r.taxablePaise, r.cgstPaise, r.sgstPaise])).toEqual([
      ['CREDIT_NOTE', 1, -42_373, -3_813, -3_814],
      ['TAX_INVOICE', 2, 1_483_051, 133_474, 133_475],
    ]);
    expect(tax.totals).toEqual({
      taxablePaise: 1_440_678,
      cgstPaise: 129_661,
      sgstPaise: 129_661,
      igstPaise: 0,
      cessPaise: 0,
    });
    expect(tax.note).toMatch(/not a GST return/);
  });
});

describe('receivables ageing and stock valuation', () => {
  it('ages what is owed by document date; advances are shown separately', async () => {
    type A = {
      customers: { name: string; buckets: Record<string, number>; totalPaise: number }[];
      totals: Record<string, number>;
      customerAdvancesPaise: number;
    };
    const r = await report<A>(aged, 'receivables', '');
    expect(r.customers.map((c) => [c.name, c.buckets, c.totalPaise])).toEqual([
      ['Yash (synthetic)', { '0-30': 100_000, '31-60': 100_000, '61-90': 0, '90+': 100_000 }, 300_000],
      ['Zara (synthetic)', { '0-30': 0, '31-60': 0, '61-90': 70_000, '90+': 0 }, 70_000],
    ]);
    expect(r.totals).toEqual({
      '0-30': 100_000,
      '31-60': 100_000,
      '61-90': 70_000,
      '90+': 100_000,
      totalPaise: 370_000,
    });
    expect(r.customerAdvancesPaise).toBe(50_000);
  });

  it('values sellable and non-sellable stock at cost', async () => {
    type V = {
      rows: {
        sku: string;
        sellableQuantity: string;
        sellableValuePaise: number;
        otherQuantity: string;
        otherValuePaise: number;
      }[];
      totals: { sellableValuePaise: number; otherValuePaise: number; valuePaise: number };
    };
    const v = await report<V>(aged, 'stock-valuation', '');
    expect(
      v.rows.map((r) => [r.sku, r.sellableQuantity, r.sellableValuePaise, r.otherQuantity, r.otherValuePaise]),
    ).toEqual([
      ['AGE-IT', '4.000', 160_000, '2.000', 80_000],
      ['AGE-PH', '1.000', 900_000, '0.000', 0],
    ]);
    expect(v.totals).toEqual({ sellableValuePaise: 1_060_000, otherValuePaise: 80_000, valuePaise: 1_140_000 });
    expect((await get(h, `${aged.base}/reports/stock-valuation`, other.owner)).statusCode).toBe(404);
  });
});

describe('exports (FR-RPT-4)', () => {
  const exportUrl = (name: string, q: string) => `${shop.base}/reports/${name}/export?${q}`;

  it('CSV: same totals as the report, rupees with 2 decimals, formula-like text neutralised, audited', async () => {
    const res = await get(h, exportUrl('sales-summary', 'period=month&date=2026-10-15&format=csv'), accountant);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(String(res.headers['content-disposition'])).toContain('sales-summary-2026-10-01-2026-10-31.csv');
    expect(res.body.charCodeAt(0)).toBe(0xfeff); // byte-order mark for spreadsheet programs
    const lines = res.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Date,Invoices,Gross sales (₹),Returns (₹),Net sales (₹)');
    expect(lines).toContain('2026-10-05,1,15500.00,0.00,15500.00');
    expect(lines).toContain('2026-10-11,0,0.00,500.00,-500.00');
    expect(lines.at(-1)).toBe('Total,2,17500.00,500.00,17000.00');
    const ret = await get(h, exportUrl('returns', 'period=month&date=2026-10-15&format=csv'), accountant);
    // The formula-like customer name is written with a leading apostrophe, so it stays text.
    expect(ret.body).toContain(",'=cmd|' /C calc'!A0 (synthetic),");
    const audit = await sql<{ n: number }>`select count(*)::int as n from lbg.audit_events
                                             where business_id = ${shop.businessId} and action = 'report.export'`.execute(
      h.admin,
    );
    expect(audit.rows[0]?.n).toBe(2);
  });

  it('XLSX opens as a well-formed workbook with numeric cells', async () => {
    const res = await get(h, exportUrl('tax', 'period=month&date=2026-10-15&format=xlsx'), accountant);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const dir = mkdtempSync(path.join(tmpdir(), 'xlsx-'));
    const file = path.join(dir, 'tax.xlsx');
    writeFileSync(file, res.rawPayload);
    const listing = (await run('unzip', ['-l', file])).stdout;
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'])
      expect(listing).toContain(part);
    // Every part parses as XML, and the taxable total is a number cell.
    const check = await run('python3', [
      '-I',
      '-c',
      'import sys, zipfile, xml.dom.minidom as m\nz = zipfile.ZipFile(sys.argv[1])\n[m.parseString(z.read(n)) for n in z.namelist()]\nprint(z.read("xl/worksheets/sheet1.xml").decode())',
      file,
    ]);
    expect(check.stdout).toContain('<v>14406.78</v>');
    expect(check.stdout).toContain('Tax summary');
  });

  it('PDF for the tax summary and a customer statement; formats a report does not offer are refused', async () => {
    const pdf = await get(h, exportUrl('tax', 'period=month&date=2026-10-15&format=pdf'), accountant);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const st = await get(
      h,
      `${shop.base}/customers/${customerX}/statement/export?from=2026-10-01&to=2026-10-31&format=pdf`,
      accountant,
    );
    expect(st.headers['content-type']).toBe('application/pdf');
    const csv = await get(
      h,
      `${shop.base}/customers/${customerX}/statement/export?from=2026-10-01&to=2026-10-31&format=csv`,
      accountant,
    );
    // ₹15,500 invoice, ₹10,000 paid, ₹500 credit note: closing ₹5,000.
    expect(csv.body.trim().split('\r\n').at(-1)).toBe('2026-10-31,Closing balance,,,5000.00');
    expect(errorCode(await get(h, exportUrl('returns', 'period=month&date=2026-10-15&format=pdf'), accountant))).toBe(
      'FORMAT_UNAVAILABLE',
    );
  });

  it('exports need reports.export and the report permission; other businesses get 404', async () => {
    expect((await get(h, exportUrl('tax', 'period=month&format=csv'), billing)).statusCode).toBe(403);
    expect((await get(h, exportUrl('tax', 'period=month&format=csv'), inventory)).statusCode).toBe(403);
    expect((await get(h, `${other.base}/reports/tax/export?period=month&format=csv`, shop.owner)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/reports/tax?period=month`, other.owner)).statusCode).toBe(404);
    expect(
      (
        await get(
          h,
          `${other.base}/customers/${customerX}/statement/export?from=2026-10-01&to=2026-10-31&format=csv`,
          other.owner,
        )
      ).statusCode,
    ).toBe(404);
  });
});
