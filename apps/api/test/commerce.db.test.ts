// Increments 11.2–11.3: sales channels, listings, available-to-sell, the
// stock push queue, channel orders with reservations and billing (D-070).
// The marketplace is the mock connector; nothing external is contacted.
// Synthetic data only.
import { createWebsiteOrder } from '@lbgos/modules/commerce';
import { mockMarketplace } from '@lbgos/modules/integrations';
import { issueSale, getSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
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
let a: Shop;
let b: Shop;
let billing: Session;
let inventory: Session;
let cable: string;
let cableSku: string;
let charger: string;
let websiteId: string;
let amazonId: string;

interface Listing {
  id: string;
  channelId: string;
  variantId: string;
  externalSku: string;
  available: number;
  reserved: number;
  availableToSell: number;
  lastPushedQuantity: number | null;
  pushPending: boolean;
}
interface Order {
  id: string;
  externalOrderId: string;
  state: string;
  oversold: boolean;
  needsAttention: boolean;
  saleId: string | null;
  invoiceNumber: string | null;
}

const listings = async (shop: Shop = a) =>
  (await get(h, `${shop.base}/channel-listings`, shop.owner)).json<{ listings: Listing[] }>().listings;
const listing = async (channelId: string, variantId: string) =>
  (await listings()).find((l) => l.channelId === channelId && l.variantId === variantId);
const orders = async () => (await get(h, `${a.base}/channel-orders`, a.owner)).json<{ orders: Order[] }>().orders;
const sync = () => post(h, `${a.base}/channels/sync`, {}, a.owner);
const lastPush = (store: string) => mockMarketplace.pushes.filter((p) => p.label === store).at(-1)?.items ?? [];
const stockOf = async (variantId: string) =>
  Number(
    (
      await sql<{ q: string }>`select coalesce(sum(quantity), 0)::text as q from lbg.stock_levels
        where business_id = ${a.businessId} and variant_id = ${variantId} and bucket = 'AVAILABLE'`.execute(h.admin)
    ).rows[0]?.q,
  );
const ctxA = () => ({ businessId: a.businessId, userId: a.ownerId });

async function connector(shop: Shop, store: string, label: string): Promise<string> {
  const res = await post(
    h,
    `${shop.base}/integrations`,
    { category: 'MARKETPLACE', provider: 'mock', label, authMethod: 'NONE', config: { store } },
    shop.owner,
  );
  if (res.statusCode !== 201) throw new Error(`connector: ${String(res.statusCode)} ${res.body}`);
  const id = res.json<{ integration: { id: string } }>().integration.id;
  const tested = await post(h, `${shop.base}/integrations/${id}/test`, {}, shop.owner);
  if (tested.statusCode !== 200) throw new Error(`connector test: ${String(tested.statusCode)} ${tested.body}`);
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  mockMarketplace.reset();
  a = await activeShop(h, 'com-a');
  b = await activeShop(h, 'com-b');
  billing = (await staff(h, a, 'com-a-billing@example.test', 'Billing')).session;
  inventory = (await staff(h, a, 'com-a-inventory@example.test', 'Inventory')).session;
  cable = await variant(h, a, 'COM-CB', { serialized: false });
  charger = await variant(h, a, 'COM-CH', { serialized: false });
  cableSku =
    (await sql<{ sku: string }>`select sku from lbg.product_variants where id = ${cable}`.execute(h.admin)).rows[0]
      ?.sku ?? '';
  for (const v of [cable, charger]) {
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${a.businessId}, ${v}, 'OPENING', 10, 20000)`.execute(h.admin);
  }
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('channels and listings (11.2)', () => {
  it('AC1: the website channel exists; a marketplace channel needs a Marketplace connector', async () => {
    const chans = (await get(h, `${a.base}/channels`, a.owner)).json<{ channels: { id: string; kind: string }[] }>()
      .channels;
    expect(chans.map((c) => c.kind)).toEqual(['WEBSITE']);
    websiteId = chans[0]?.id ?? '';
    const llm = await post(
      h,
      `${a.base}/integrations`,
      { category: 'LLM', provider: 'mock', label: 'Not a marketplace', authMethod: 'NONE' },
      a.owner,
    );
    const wrong = await post(
      h,
      `${a.base}/channels`,
      { name: 'Wrong', integrationId: llm.json<{ integration: { id: string } }>().integration.id },
      a.owner,
    );
    expect([wrong.statusCode, errorCode(wrong)]).toEqual([422, 'NOT_A_MARKETPLACE_CONNECTOR']);
    const integ = await connector(a, 'amz-a', 'Amazon connector (mock)');
    const created = await post(
      h,
      `${a.base}/channels`,
      { name: 'Amazon', integrationId: integ, stockBuffer: 1 },
      a.owner,
    );
    expect(created.statusCode).toBe(201);
    amazonId = created.json<{ channelId: string }>().channelId;
    const dup = await post(h, `${a.base}/channels`, { name: 'Amazon again', integrationId: integ }, a.owner);
    expect([dup.statusCode, errorCode(dup)]).toEqual([409, 'CHANNEL_EXISTS']);
    expect((await post(h, `${a.base}/channels`, { name: 'X', integrationId: integ }, billing)).statusCode).toBe(403);
  });

  it('AC2/AC3: listings with the SKU defaulted, unique per channel; exact available-to-sell', async () => {
    for (const ch of [websiteId, amazonId]) {
      for (const v of [cable, charger]) {
        const r = await put(h, `${a.base}/channels/${ch}/listings`, { variantId: v }, a.owner);
        expect(r.statusCode).toBe(200);
      }
    }
    const taken = await put(
      h,
      `${a.base}/channels/${amazonId}/listings`,
      { variantId: charger, externalSku: cableSku },
      a.owner,
    );
    expect([taken.statusCode, errorCode(taken)]).toEqual([409, 'SKU_TAKEN']);
    expect((await put(h, `${a.base}/channels/${amazonId}/listings`, { variantId: cable }, billing)).statusCode).toBe(
      403,
    );
    const site = await listing(websiteId, cable);
    const amz = await listing(amazonId, cable);
    expect(site).toMatchObject({ externalSku: cableSku, available: 10, reserved: 0, availableToSell: 10 });
    expect(amz).toMatchObject({ availableToSell: 9, pushPending: true });
    // Cost price never appears in a listing.
    expect(JSON.stringify(await listings())).not.toMatch(/cost/i);
  });

  it('AC4: the queue is sent through the connector; a stock change queues a new push', async () => {
    const r = await sync();
    expect(r.json<{ pushed: number }>().pushed).toBe(2);
    expect(lastPush('amz-a').find((i) => i.sku === cableSku)?.quantity).toBe(9);
    expect((await listing(amazonId, cable))?.pushPending).toBe(false);
    expect((await listing(amazonId, cable))?.lastPushedQuantity).toBe(9);
    // The website channel is never pushed (the store reads live).
    expect(mockMarketplace.pushes.every((p) => p.label === 'amz-a')).toBe(true);
    // A stock change in the shop queues the listing again, by the database trigger.
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${a.businessId}, ${cable}, 'PURCHASE', 2, 20000)`.execute(h.admin);
    expect((await listing(amazonId, cable))?.pushPending).toBe(true);
    await sync();
    expect(lastPush('amz-a').find((i) => i.sku === cableSku)?.quantity).toBe(11);
    // A new buffer changes what is sent.
    await patch(h, `${a.base}/channels/${amazonId}`, { stockBuffer: 3 }, a.owner);
    await sync();
    expect(lastPush('amz-a').find((i) => i.sku === cableSku)?.quantity).toBe(9);
    await patch(h, `${a.base}/channels/${amazonId}`, { stockBuffer: 1 }, a.owner);
    await sync();
  });

  it('AC4: an unpublished listing is sent as 0', async () => {
    await put(h, `${a.base}/channels/${amazonId}/listings`, { variantId: charger, published: false }, a.owner);
    await sync();
    const sku = (await listing(amazonId, charger))?.externalSku ?? '';
    expect(lastPush('amz-a').find((i) => i.sku === sku)?.quantity).toBe(0);
    await put(h, `${a.base}/channels/${amazonId}/listings`, { variantId: charger, published: true }, a.owner);
    await sync();
  });
});

describe('channel orders (11.3)', () => {
  let webOrder: string;

  it('website order requests reserve stock, are refused above available-to-sell, and are idempotent', async () => {
    const site = await listing(websiteId, cable);
    const first = await createWebsiteOrder(h.appDb, ctxA(), {
      listingId: site?.id ?? '',
      quantity: 3,
      name: 'Web customer (synthetic)',
      mobile: '98610 00001',
      token: 'tok-0001',
    });
    webOrder = first.orderId;
    const again = await createWebsiteOrder(h.appDb, ctxA(), {
      listingId: site?.id ?? '',
      quantity: 3,
      name: 'Web customer (synthetic)',
      mobile: '9861000001',
      token: 'tok-0001',
    });
    expect(again).toEqual({ orderId: webOrder, created: false });
    expect(await listing(websiteId, cable)).toMatchObject({ available: 12, reserved: 3, availableToSell: 9 });
    await expect(
      createWebsiteOrder(h.appDb, ctxA(), {
        listingId: site?.id ?? '',
        quantity: 10,
        name: 'Too many',
        mobile: '9861000002',
        token: 'tok-0002',
      }),
    ).rejects.toMatchObject({ code: 'NOT_ENOUGH_STOCK', available: 9 });
    await expect(
      createWebsiteOrder(h.appDb, ctxA(), {
        listingId: site?.id ?? '',
        quantity: 1,
        name: 'Foreign',
        mobile: '+14155550100',
        token: 'tok-0003',
      }),
    ).rejects.toMatchObject({ code: 'MOBILE_INVALID' });
    // The reservation lowers what the marketplace is offered: 12 − 3 − buffer 1.
    await sync();
    expect(lastPush('amz-a').find((i) => i.sku === cableSku)?.quantity).toBe(8);
  });

  it('AC1/AC2: marketplace orders are imported once, unknown SKUs need attention, too large orders are flagged', async () => {
    mockMarketplace.place('amz-a', {
      id: 'AMZ-1001',
      status: 'NEW',
      placedAt: '2026-10-28T10:00:00Z',
      lines: [{ sku: cableSku, quantity: 2, unitPricePaise: 45000 }],
    });
    mockMarketplace.place('amz-a', {
      id: 'AMZ-1002',
      status: 'NEW',
      placedAt: '2026-10-28T10:05:00Z',
      lines: [{ sku: 'NOT-LISTED-1', quantity: 1, unitPricePaise: 1000 }],
    });
    mockMarketplace.place('amz-a', {
      id: 'AMZ-1003',
      status: 'NEW',
      placedAt: '2026-10-28T10:06:00Z',
      lines: [{ sku: cableSku, quantity: 50, unitPricePaise: 45000 }],
    });
    const r = await sync();
    expect(r.json<{ orders: number }>().orders).toBe(3);
    expect((await sync()).json<{ orders: number }>().orders).toBe(0);
    const all = await orders();
    const by = (id: string) => all.find((o) => o.externalOrderId === id);
    expect(by('AMZ-1001')).toMatchObject({ state: 'OPEN', oversold: false, needsAttention: false });
    expect(by('AMZ-1002')).toMatchObject({ needsAttention: true });
    expect(by('AMZ-1003')).toMatchObject({ oversold: true });
    expect(all.filter((o) => o.externalOrderId.startsWith('AMZ-')).length).toBe(3);
    // Reservations from every channel: 3 (web) + 2 + 50.
    expect((await listing(websiteId, cable))?.reserved).toBe(55);
    expect((await listing(websiteId, cable))?.availableToSell).toBe(0);
    const billNeedsAttention = await post(h, `${a.base}/channel-orders/${by('AMZ-1002')?.id ?? ''}/bill`, {}, a.owner);
    expect([billNeedsAttention.statusCode, errorCode(billNeedsAttention)]).toEqual([409, 'NEEDS_ATTENTION']);
    // The oversold order is cancelled by the shop.
    const cancelled = await post(
      h,
      `${a.base}/channel-orders/${by('AMZ-1003')?.id ?? ''}/cancel`,
      { reason: 'Not enough stock' },
      a.owner,
    );
    expect(cancelled.statusCode).toBe(204);
    expect((await listing(websiteId, cable))?.reserved).toBe(5);
  });

  it('AC3: billing makes a draft; issuing it ends the reservation and the SALE movement takes the stock', async () => {
    const amz = (await orders()).find((o) => o.externalOrderId === 'AMZ-1001');
    const bill = await post(h, `${a.base}/channel-orders/${amz?.id ?? ''}/bill`, {}, billing);
    expect(bill.statusCode).toBe(200);
    const saleId = bill.json<{ saleId: string }>().saleId;
    expect((await post(h, `${a.base}/channel-orders/${amz?.id ?? ''}/bill`, {}, billing)).json()).toEqual({ saleId });
    expect((await orders()).find((o) => o.id === amz?.id)?.state).toBe('BILLING');
    expect((await listing(websiteId, cable))?.reserved).toBe(5);
    const before = await stockOf(cable);
    const access = { discount: { limits: undefined }, priceOverride: true };
    const draft = await getSale(h.appDb, ctxA(), access, saleId);
    expect(draft.lines.map((l) => [l.variantId, l.unitPricePaise])).toEqual([[cable, 45000]]);
    await issueSale(h.appDb, ctxA(), access, saleId, {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: [{ method: 'UPI', amountPaise: draft.totals.totalPaise, reference: 'AMZ-SETTLE-1' }],
    });
    expect(await stockOf(cable)).toBe(before - 2);
    const billed = (await orders()).find((o) => o.id === amz?.id);
    expect(billed?.state).toBe('BILLED');
    expect(billed?.invoiceNumber).toBeTruthy();
    expect(await listing(websiteId, cable)).toMatchObject({ available: 10, reserved: 3, availableToSell: 7 });
    const late = await post(h, `${a.base}/channel-orders/${amz?.id ?? ''}/cancel`, { reason: 'Too late' }, a.owner);
    expect([late.statusCode, errorCode(late)]).toEqual([409, 'ORDER_BILLED']);
  });

  it('a website order is billed to the customer it names (created once by mobile)', async () => {
    const bill = await post(h, `${a.base}/channel-orders/${webOrder}/bill`, {}, a.owner);
    const access = { discount: { limits: undefined }, priceOverride: true };
    const draft = await getSale(h.appDb, ctxA(), access, bill.json<{ saleId: string }>().saleId);
    expect(draft.customer).toMatchObject({ name: 'Web customer (synthetic)', mobileE164: '+919861000001' });
  });

  it('a cancellation in the marketplace feed ends an open order; a billed one is flagged instead', async () => {
    mockMarketplace.place('amz-a', {
      id: 'AMZ-1004',
      status: 'NEW',
      placedAt: '2026-10-28T11:00:00Z',
      lines: [{ sku: cableSku, quantity: 1, unitPricePaise: 45000 }],
    });
    await sync();
    expect((await listing(websiteId, cable))?.reserved).toBe(4);
    mockMarketplace.place('amz-a', {
      id: 'AMZ-1004',
      status: 'CANCELLED',
      placedAt: '2026-10-28T11:00:00Z',
      lines: [{ sku: cableSku, quantity: 1, unitPricePaise: 45000 }],
    });
    mockMarketplace.place('amz-a', {
      id: 'AMZ-1001',
      status: 'CANCELLED',
      placedAt: '2026-10-28T10:00:00Z',
      lines: [{ sku: cableSku, quantity: 2, unitPricePaise: 45000 }],
    });
    await sync();
    const all = await orders();
    expect(all.find((o) => o.externalOrderId === 'AMZ-1004')?.state).toBe('CANCELLED');
    expect(all.find((o) => o.externalOrderId === 'AMZ-1001')).toMatchObject({ state: 'BILLED', needsAttention: true });
    expect((await listing(websiteId, cable))?.reserved).toBe(3);
  });

  it('a failing connector keeps the push queued with backoff and shows the error', async () => {
    mockMarketplace.failing.add('amz-a');
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${a.businessId}, ${cable}, 'PURCHASE', 1, 20000)`.execute(h.admin);
    const pushesBefore = mockMarketplace.pushes.length;
    await sync();
    const q = await sql<{ attempts: number; last_error: string; later: boolean }>`
      select q.attempts, q.last_error, q.next_attempt_at > now() as later from lbg.channel_sync_queue q
        join lbg.channel_listings l on l.id = q.listing_id where l.channel_id = ${amazonId} and l.variant_id = ${cable}`.execute(
      h.admin,
    );
    expect(q.rows[0]).toMatchObject({ attempts: 1, last_error: 'MOCK_UNAVAILABLE', later: true });
    const chan = (await get(h, `${a.base}/channels`, a.owner))
      .json<{ channels: { id: string; lastSyncError: string | null }[] }>()
      .channels.find((c) => c.id === amazonId);
    expect(chan?.lastSyncError).toBe('MOCK_UNAVAILABLE');
    // Not retried before its time.
    mockMarketplace.failing.delete('amz-a');
    await sync();
    expect(mockMarketplace.pushes.length).toBe(pushesBefore);
    await sql`update lbg.channel_sync_queue set next_attempt_at = now()`.execute(h.admin);
    await sync();
    expect(lastPush('amz-a').find((i) => i.sku === cableSku)?.quantity).toBe(11 - 3 - 1);
  });

  it('permissions, read-only mode and cross-tenant', async () => {
    expect((await get(h, `${a.base}/channel-orders`, inventory)).statusCode).toBe(200);
    expect((await get(h, `${a.base}/channels`, billing)).statusCode).toBe(200);
    const anyOrder = (await orders())[0]?.id ?? '';
    expect((await get(h, `${a.base}/channel-orders/${anyOrder}`, b.owner)).statusCode).toBe(404);
    expect((await get(h, `${b.base}/channel-orders/${anyOrder}`, b.owner)).statusCode).toBe(404);
    expect(
      (await post(h, `${b.base}/channel-orders/${anyOrder}/cancel`, { reason: 'Not mine' }, b.owner)).statusCode,
    ).toBe(404);
    expect((await put(h, `${b.base}/channels/${amazonId}/listings`, { variantId: cable }, b.owner)).statusCode).toBe(
      404,
    );
    const bListings = (await get(h, `${b.base}/channel-listings`, b.owner)).json<{ listings: unknown[] }>().listings;
    expect(bListings).toEqual([]);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${a.businessId}`.execute(h.admin);
    expect((await get(h, `${a.base}/channels`, a.owner)).statusCode).toBe(200);
    const ro = await put(h, `${a.base}/channels/${amazonId}/listings`, { variantId: cable, published: false }, a.owner);
    expect([ro.statusCode, errorCode(ro)]).toEqual([403, 'TENANT_READ_ONLY']);
    await sql`update lbg.businesses set status = 'ACTIVE' where id = ${a.businessId}`.execute(h.admin);
  });
});
