// Increment 6.5: dashboard tiles (FR-LED-3 AC1–2, FR-INV-7 AC1, D-051). The
// tiles must equal the report endpoints for the same periods. Sales are made
// now (the dashboard is about today), so absolute checks use today's figures.
// Synthetic data only.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  get,
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
let shop: Shop;
let other: Shop;
let billing: Session;
let accountant: Session;
let inventory: Session;

interface Tile {
  key: string;
  label: string;
  definition: string;
  unit: string;
  today?: number;
  month?: number;
  now?: number;
  source: string;
}
interface Dashboard {
  today: string;
  month: { from: string; to: string };
  tiles: Tile[];
}

const board = async (who: Session = shop.owner, s: Shop = shop) => {
  const res = await get(h, `${s.base}/dashboard`, who);
  if (res.statusCode !== 200) throw new Error(`dashboard ${String(res.statusCode)} ${res.body}`);
  return res.json<{ dashboard: Dashboard }>().dashboard;
};
const report = async <T>(name: string, query: string) =>
  (await get(h, `${shop.base}/reports/${name}${query ? `?${query}` : ''}`, shop.owner)).json<{ report: T }>().report;
const tileOf = (d: Dashboard, key: string) => d.tiles.find((t) => t.key === key);

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'dash-a');
  other = await activeShop(h, 'dash-b');
  billing = (await staff(h, shop, 'dash-billing@example.test', 'Billing')).session;
  accountant = (await staff(h, shop, 'dash-accountant@example.test', 'Accountant')).session;
  inventory = (await staff(h, shop, 'dash-inventory@example.test', 'Inventory')).session;
  // Cable ₹1,000, cost ₹100, reorder level 20 with 10 in stock (low after the sale too); charger not low.
  const cable = await variant(h, shop, 'DASH-CB', { serialized: false });
  const charger = await variant(h, shop, 'DASH-CH', { serialized: false });
  await patch(h, `${shop.base}/variants/${cable}`, { reorderLevel: 20 }, shop.owner);
  await patch(h, `${shop.base}/variants/${charger}`, { reorderLevel: 1 }, shop.owner);
  for (const v of [cable, charger]) {
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${shop.businessId}, ${v}, 'OPENING', 10, 10000)`.execute(h.admin);
    await sql`update lbg.product_variants set avg_cost_paise = 10000 where id = ${v}`.execute(h.admin);
  }
  const x = await post(h, `${shop.base}/customers`, { name: 'Dash Owes (synthetic)', mobile: '9850000001' }, billing);
  const xId = x.json<{ customer: { id: string } }>().customer.id;
  const y = await post(
    h,
    `${shop.base}/customers`,
    { name: 'Dash Advance (synthetic)', mobile: '9850000002' },
    billing,
  );
  const yId = y.json<{ customer: { id: string } }>().customer.id;
  // Today: 2 cables to X (₹2,000), ₹500 paid in cash; Y pays ₹300 in advance by UPI.
  const d = await post(
    h,
    `${shop.base}/sales`,
    { customerId: xId, lines: [{ variantId: cable, quantity: '2' }] },
    billing,
  );
  const sale = d.json<{ sale: { id: string; totals: { totalPaise: number } } }>().sale;
  const issued = await post(
    h,
    `${shop.base}/sales/${sale.id}/issue`,
    { expectedTotalPaise: sale.totals.totalPaise, payments: [{ method: 'CASH', amountPaise: 50_000 }] },
    billing,
  );
  if (issued.statusCode !== 201) throw new Error(issued.body);
  const adv = await post(
    h,
    `${shop.base}/customers/${yId}/payments`,
    { method: 'UPI', amountPaise: 30_000, reference: 'UPI-1' },
    billing,
  );
  if (adv.statusCode !== 201) throw new Error(adv.body);
  // One reminder waiting: payment due after 0 days for X's open invoice.
  await put(
    h,
    `${shop.base}/reminders/settings/PAYMENT_DUE`,
    {
      enabled: true,
      autoSend: false,
      channel: 'SMS',
      template: 'Hello {name}, {amount_due} is due at {shop}.',
      days: 0,
    },
    shop.owner,
  );
  const run = await post(h, `${shop.base}/reminders/run`, {}, shop.owner);
  if (run.statusCode !== 200) throw new Error(run.body);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('dashboard tiles (FR-LED-3 AC1)', () => {
  it('the owner sees every tile with its definition and today’s figures', async () => {
    const d = await board();
    expect(d.tiles.map((t) => t.key)).toEqual([
      'netSales',
      'cashReceived',
      'receivables',
      'customerAdvances',
      'grossMargin',
      'lowStock',
      'remindersWaiting',
    ]);
    for (const t of d.tiles) expect(t.definition.length).toBeGreaterThan(20);
    expect(tileOf(d, 'netSales')).toMatchObject({ today: 200_000, unit: 'paise', source: 'sales-summary' });
    expect(tileOf(d, 'cashReceived')?.today).toBe(80_000);
    expect(tileOf(d, 'receivables')?.now).toBe(150_000);
    expect(tileOf(d, 'customerAdvances')?.now).toBe(30_000);
    expect(tileOf(d, 'grossMargin')?.today).toBe(180_000); // ₹2,000 taxable (no GST) − ₹200 cost
    expect(tileOf(d, 'lowStock')).toMatchObject({ now: 1, unit: 'count' }); // the cable (8 ≤ 20); charger 10 > 1
    expect(tileOf(d, 'remindersWaiting')?.now).toBe(1);
    // FR-LED-3 AC2: sales are never labelled profit or cash.
    for (const key of ['netSales', 'receivables', 'grossMargin', 'customerAdvances']) {
      expect(tileOf(d, key)?.label).not.toMatch(/profit|cash/i);
    }
  });

  it('figures equal the report endpoints for the same periods (AC2)', async () => {
    const d = await board();
    const q = (kind: string) => `period=${kind}&date=${d.today}`;
    for (const kind of ['day', 'month'] as const) {
      const pick = (t: Tile | undefined) => (kind === 'day' ? t?.today : t?.month);
      const sales = await report<{ current: { netSalesPaise: number } }>('sales-summary', q(kind));
      const cash = await report<{ totals: { netPaise: number } }>('payments', q(kind));
      const margin = await report<{ grossMarginPaise: number }>('margin', q(kind));
      expect(pick(tileOf(d, 'netSales'))).toBe(sales.current.netSalesPaise);
      expect(pick(tileOf(d, 'cashReceived'))).toBe(cash.totals.netPaise);
      expect(pick(tileOf(d, 'grossMargin'))).toBe(margin.grossMarginPaise);
    }
    const ageing = await report<{ totals: { totalPaise: number }; customerAdvancesPaise: number }>('receivables', '');
    expect(tileOf(d, 'receivables')?.now).toBe(ageing.totals.totalPaise);
    expect(tileOf(d, 'customerAdvances')?.now).toBe(ageing.customerAdvancesPaise);
    const low = (await get(h, `${shop.base}/stock?lowOnly=true`, shop.owner)).json<{ stock: object[] }>().stock;
    expect(tileOf(d, 'lowStock')?.now).toBe(low.length);
    expect(d.month.from <= d.today && d.today <= d.month.to).toBe(true);
  });

  it('each tile needs its report’s permission', async () => {
    expect((await board(billing)).tiles.map((t) => t.key)).toEqual(['lowStock', 'remindersWaiting']);
    expect((await board(inventory)).tiles.map((t) => t.key)).toEqual(['lowStock']);
    expect((await board(accountant)).tiles.map((t) => t.key)).toEqual([
      'netSales',
      'cashReceived',
      'receivables',
      'customerAdvances',
      'grossMargin',
      'lowStock',
      'remindersWaiting',
    ]);
  });
});

describe('access', () => {
  it('other businesses get 404 and see only their own (empty) figures; read-only mode still shows the dashboard', async () => {
    expect((await get(h, `${shop.base}/dashboard`, other.owner)).statusCode).toBe(404);
    const theirs = await board(other.owner, other);
    expect(tileOf(theirs, 'netSales')?.today).toBe(0);
    expect(tileOf(theirs, 'remindersWaiting')?.now).toBe(0);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect(tileOf(await board(), 'netSales')?.today).toBe(200_000);
  });
});
