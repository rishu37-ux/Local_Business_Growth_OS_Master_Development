// Increment 4.4: inspection outcomes, stock reports and code lookup
// (FR-INV-6, FR-INV-7, FR-INV-9 AC1). Customer returns arrive with invoices
// in Phase 5, so returns are simulated here with ledger rows written by the
// database owner role (synthetic data only).
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

let h: Harness;
let shop: Shop;
let other: Shop;
let inspector: Session;
let billing: Session;
let phoneId: string;
let cableId: string;
let units: string[] = [];

const levels = async (variantId: string) => {
  const { rows } = await sql<{ bucket: string; q: string }>`
    select bucket, quantity::text as q from lbg.stock_levels where variant_id = ${variantId}`.execute(h.admin);
  return Object.fromEntries(rows.map((r) => [r.bucket, r.q]));
};
const unitStatus = async (id: string) =>
  (await sql<{ status: string }>`select status from lbg.serialized_units where id = ${id}`.execute(h.admin)).rows[0]
    ?.status;
const inspect = (body: object, who: Session = inspector) => post(h, `${shop.base}/stock/inspections`, body, who);

async function movement(
  variantId: string,
  type: string,
  qty: number,
  bucket: string,
  unitId: string | null,
  daysAgo = 0,
) {
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, bucket, created_at)
            values (${shop.businessId}, ${variantId}, ${unitId}, ${type}, ${qty}, ${bucket},
                    now() - make_interval(days => ${daysAgo}))`.execute(h.admin);
}

/** A sold unit brought back by the customer: SOLD, then PENDING_INSPECTION in the INSPECTION bucket. */
async function simulateUnitReturn(unitId: string) {
  await movement(phoneId, 'SALE', -1, 'AVAILABLE', unitId);
  await sql`update lbg.serialized_units set status = 'SOLD' where id = ${unitId}`.execute(h.admin);
  await movement(phoneId, 'SALE_RETURN', 1, 'INSPECTION', unitId);
  await sql`update lbg.serialized_units set status = 'PENDING_INSPECTION' where id = ${unitId}`.execute(h.admin);
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'insp-a');
  other = await activeShop(h, 'insp-b');
  inspector = (await staff(h, shop, 'insp-inventory@example.test', 'Inventory')).session;
  billing = (await staff(h, shop, 'insp-billing@example.test', 'Billing')).session;
  phoneId = await variant(h, shop, 'IN-PH', { serialized: true });
  const cable = await post(
    h,
    `${shop.base}/products`,
    {
      modelName: 'USB-C cable',
      isSerialized: false,
      variants: [{ sku: 'IN-CB-1M', barcode: '8900000000017', sellingPricePaise: 19_900 }],
    },
    shop.owner,
  );
  cableId = cable.json<{ variantIds: string[] }>().variantIds[0] ?? '';
  const supplierId = (await post(h, `${shop.base}/suppliers`, { name: 'Inspection Supplier' }, shop.owner)).json<{
    id: string;
  }>().id;
  const draft = await post(
    h,
    `${shop.base}/purchases`,
    {
      supplierId,
      supplierInvoiceNo: 'IN-1',
      supplierInvoiceDate: '2026-10-20',
      lines: [
        { variantId: cableId, quantity: '10', unitCostPaise: 5000, taxRateId: null },
        {
          variantId: phoneId,
          quantity: '3',
          unitCostPaise: 800_000,
          taxRateId: null,
          units: [{ imei1: imei(201) }, { imei1: imei(202) }, { imei1: imei(203), imei2: imei(204) }],
        },
      ],
    },
    shop.owner,
  );
  const purchaseId = draft.json<{ id: string }>().id;
  const posted = await post(h, `${shop.base}/purchases/${purchaseId}/post`, {}, shop.owner);
  if (posted.statusCode !== 200) throw new Error(posted.body);
  units = (
    await sql<{
      id: string;
    }>`select id from lbg.serialized_units where purchase_id = ${purchaseId} order by created_at`.execute(h.admin)
  ).rows.map((r) => r.id);
  await simulateUnitReturn(units[0] ?? '');
  await simulateUnitReturn(units[1] ?? '');
  await movement(cableId, 'SALE', -3, 'AVAILABLE', null);
  await movement(cableId, 'SALE_RETURN', 3, 'INSPECTION', null);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('inspection (FR-INV-6)', () => {
  it('returned goods are counted but not sellable, and appear in the inspection queue', async () => {
    expect(await levels(cableId)).toEqual({ AVAILABLE: '7.000', INSPECTION: '3.000' });
    expect(await levels(phoneId)).toEqual({ AVAILABLE: '1.000', INSPECTION: '2.000' });
    const queue = (await get(h, `${shop.base}/stock/inspections`, inspector)).json<{
      queue: { unitId: string | null; status: string; quantity: string; sku: string }[];
    }>().queue;
    expect(queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unitId: units[0], status: 'PENDING_INSPECTION' }),
        expect.objectContaining({ unitId: units[1], status: 'PENDING_INSPECTION' }),
        expect.objectContaining({ unitId: null, sku: 'IN-CB-1M', quantity: '3.000' }),
      ]),
    );
  });

  it('needs returns.inspect', async () => {
    expect((await inspect({ unitId: units[0], outcome: 'RESTOCK' }, billing)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/stock/inspections`, billing)).statusCode).toBe(403);
  });

  it('RESTOCK makes a unit sellable again (AC3); the step cannot be repeated', async () => {
    const res = await inspect({ unitId: units[0], outcome: 'RESTOCK', notes: 'Sealed box, unused.' });
    expect(res.statusCode).toBe(201);
    expect(await unitStatus(units[0] ?? '')).toBe('IN_STOCK');
    expect(await levels(phoneId)).toMatchObject({ AVAILABLE: '2.000', INSPECTION: '1.000' });
    const again = await inspect({ unitId: units[0], outcome: 'RESTOCK' });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('INVALID_UNIT_TRANSITION');
  });

  it('REPAIR → REPAIRED → DAMAGED keeps the unit out of sellable stock', async () => {
    expect((await inspect({ unitId: units[1], outcome: 'REPAIR', notes: 'Charging port loose.' })).statusCode).toBe(
      201,
    );
    expect(await unitStatus(units[1] ?? '')).toBe('IN_REPAIR');
    expect(await levels(phoneId)).toMatchObject({ AVAILABLE: '2.000', INSPECTION: '0.000', REPAIR: '1.000' });
    // A unit in repair cannot be restocked directly; it comes back to inspection first.
    expect((await inspect({ unitId: units[1], outcome: 'RESTOCK' })).statusCode).toBe(409);
    expect((await inspect({ unitId: units[1], outcome: 'REPAIRED' })).statusCode).toBe(201);
    expect(await unitStatus(units[1] ?? '')).toBe('PENDING_INSPECTION');
    expect((await inspect({ unitId: units[1], outcome: 'DAMAGED', notes: 'Repair failed.' })).statusCode).toBe(201);
    expect(await unitStatus(units[1] ?? '')).toBe('DAMAGED');
    expect(await levels(phoneId)).toMatchObject({ AVAILABLE: '2.000', DAMAGED: '1.000', REPAIR: '0.000' });
  });

  it('non-serialized quantities: only RESTOCK adds to AVAILABLE; RETURN_TO_SUPPLIER leaves stock; no overdrawing', async () => {
    expect((await inspect({ variantId: cableId, quantity: '1', outcome: 'RESTOCK' })).statusCode).toBe(201);
    expect((await inspect({ variantId: cableId, quantity: '1', outcome: 'DAMAGED' })).statusCode).toBe(201);
    expect((await inspect({ variantId: cableId, quantity: '1', outcome: 'RETURN_TO_SUPPLIER' })).statusCode).toBe(201);
    expect(await levels(cableId)).toEqual({ AVAILABLE: '8.000', INSPECTION: '0.000', DAMAGED: '1.000' });
    const over = await inspect({ variantId: cableId, quantity: '1', outcome: 'RESTOCK' });
    expect(over.statusCode).toBe(409);
    expect(errorCode(over)).toBe('INSUFFICIENT_STOCK');
    const serialized = await inspect({ variantId: phoneId, quantity: '1', outcome: 'RESTOCK' });
    expect(serialized.statusCode).toBe(422);
  });

  it('records each inspection with its movements and an audit event; the ledger reconciles', async () => {
    const { rows } = await sql<{ outcome: string; moves: number }>`
      select i.outcome, (select count(*)::int from lbg.stock_movements m where m.reference_id = i.id) as moves
        from lbg.inspections i where i.business_id = ${shop.businessId} order by i.created_at`.execute(h.admin);
    expect(rows).toEqual([
      { outcome: 'RESTOCK', moves: 2 },
      { outcome: 'REPAIR', moves: 2 },
      { outcome: 'REPAIRED', moves: 2 },
      { outcome: 'DAMAGED', moves: 2 },
      { outcome: 'RESTOCK', moves: 2 },
      { outcome: 'DAMAGED', moves: 2 },
      { outcome: 'RETURN_TO_SUPPLIER', moves: 1 },
    ]);
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from lbg.audit_events where business_id = ${shop.businessId} and action = 'inventory.inspect'`.execute(
      h.admin,
    );
    expect(audit.rows[0]?.n).toBe(7);
    expect(
      (await get(h, `${shop.base}/stock/reconciliation`, shop.owner)).json<{ consistent: boolean }>().consistent,
    ).toBe(true);
  });
});

describe('stock reports (FR-INV-7)', () => {
  let deadId = '';
  let slowId = '';
  let reorderId = '';

  beforeAll(async () => {
    deadId = await variant(h, shop, 'OLD-CB', { serialized: false });
    await movement(deadId, 'OPENING', 5, 'AVAILABLE', null, 130);
    slowId = await variant(h, shop, 'SLOW-CB', { serialized: false });
    await movement(slowId, 'OPENING', 5, 'AVAILABLE', null, 200);
    await movement(slowId, 'SALE', -1, 'AVAILABLE', null, 70);
    reorderId = await variant(h, shop, 'RO-CB', { serialized: false });
    expect((await patch(h, `${shop.base}/variants/${reorderId}`, { reorderLevel: 5 }, shop.owner)).statusCode).toBe(
      204,
    );
    await movement(reorderId, 'OPENING', 20, 'AVAILABLE', null, 40);
    for (const [qty, ago] of [
      [-6, 25],
      [-5, 10],
      [-4, 2],
    ] as const) {
      await movement(reorderId, 'SALE', qty, 'AVAILABLE', null, ago);
    }
    await movement(reorderId, 'SALE', -100, 'AVAILABLE', null, 0).catch(() => undefined); // refused: not enough stock
  });

  it('low-stock list: available ≤ reorder level (AC1)', async () => {
    const low = (await get(h, `${shop.base}/stock?lowOnly=true`, shop.owner)).json<{
      stock: { sku: string; available: string; low: boolean }[];
    }>().stock;
    expect(low).toEqual([expect.objectContaining({ sku: 'RO-CB', available: '5.000', low: true })]);
  });

  it('slow-moving and dead stock with default and custom thresholds (AC2)', async () => {
    const def = (await get(h, `${shop.base}/stock/reports/aged`, shop.owner)).json<{
      slowDays: number;
      deadDays: number;
      rows: { sku: string; age: string; daysWithoutSale: number; lastSaleAt: string | null }[];
    }>();
    expect([def.slowDays, def.deadDays]).toEqual([60, 120]);
    expect(def.rows.map((r) => [r.sku, r.age, r.daysWithoutSale])).toEqual([
      ['OLD-CB', 'DEAD', 130],
      ['SLOW-CB', 'SLOW', 70],
    ]);
    expect(def.rows[0]?.lastSaleAt).toBeNull();
    const custom = (await get(h, `${shop.base}/stock/reports/aged?slowDays=1&deadDays=69`, shop.owner)).json<{
      rows: { sku: string; age: string }[];
    }>().rows;
    expect(custom.map((r) => [r.sku, r.age])).toEqual([
      ['OLD-CB', 'DEAD'],
      ['SLOW-CB', 'DEAD'],
      ['RO-CB', 'SLOW'],
    ]);
    expect((await get(h, `${shop.base}/stock/reports/aged?slowDays=50&deadDays=10`, shop.owner)).statusCode).toBe(400);
  });

  it('reorder suggestion shows the formula, the data period and the label (AC3)', async () => {
    const r = (await get(h, `${shop.base}/stock/reports/reorder?leadTimeDays=7`, shop.owner)).json<{
      label: string;
      formula: string;
      period: { days: number; from: string; to: string };
      onOrderNote: string;
      rows: {
        sku: string;
        soldInWindow: string;
        averageDailySales: string;
        suggestedQuantity: string;
        suggestedUnits: number;
      }[];
    }>();
    expect(r.label).toBe('suggestion');
    expect(r.formula).toContain('average daily sales × lead-time days + reorder level − on hand − on order');
    expect(r.period.days).toBe(30);
    expect(new Date(r.period.to).getTime() - new Date(r.period.from).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(r.onOrderNote).toMatch(/not tracked/);
    // 15 sold in 30 days = 0.5/day; × 7 = 3.5; + level 5 − on hand 5 = 3.5 → order 4.
    expect(r.rows.find((x) => x.sku === 'RO-CB')).toEqual(
      expect.objectContaining({
        soldInWindow: '15.000',
        averageDailySales: '0.500',
        suggestedQuantity: '3.500',
        suggestedUnits: 4,
      }),
    );
  });
});

describe('code lookup (FR-INV-9 AC1)', () => {
  const lookup = (code: string, who: Session = billing, s: Shop = shop) =>
    get(h, `${s.base}/lookup?code=${encodeURIComponent(code)}`, who);

  it('resolves barcode, then SKU (any case), then IMEI 1 or 2', async () => {
    expect((await lookup('8900000000017')).json()).toMatchObject({ match: 'BARCODE', variantId: cableId });
    expect((await lookup('in-cb-1m')).json()).toMatchObject({ match: 'SKU', variantId: cableId });
    expect((await lookup(` ${imei(204)} `)).json()).toMatchObject({
      match: 'IMEI',
      unitId: units[2],
      unitStatus: 'IN_STOCK',
    });
    expect((await lookup('0000')).statusCode).toBe(404);
  });

  it('never matches another business’s codes', async () => {
    expect((await lookup('8900000000017', other.owner, other)).statusCode).toBe(404);
    expect((await lookup(imei(204), other.owner, other)).statusCode).toBe(404);
    expect((await lookup('8900000000017', other.owner, shop)).statusCode).toBe(404);
    for (const path of ['stock/inspections', 'stock/reports/aged', 'stock/reports/reorder']) {
      expect((await get(h, `${shop.base}/${path}`, other.owner)).statusCode).toBe(404);
    }
  });
});
