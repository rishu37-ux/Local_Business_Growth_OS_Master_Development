// Phase 13 (D-072): online order details — the platform's details of an
// order and the buyer's details, masking without customers.view, updates when
// the feed sends an order again, erasure and the data export. The
// marketplace is the mock connector; nothing external is contacted.
// Synthetic data only.
import { parseFeedOrders, mockMarketplace } from '@lbgos/modules/integrations';
import { getSale, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
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
let inventory: Session;
let billing: Session;
let phone: string;
let sku: string;

const GSTIN = '27AAPFU0939F1ZV';
const ADDRESS = {
  name: 'Asha Verma (synthetic)',
  phone: '+91 98600 11111',
  line1: 'Flat 4, Test Residency',
  line2: 'Baner Road',
  landmark: 'Near the test park',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411045',
  country: 'IN',
};
const fullOrder = (id: string, extra: object = {}) => ({
  id,
  status: 'NEW',
  placedAt: '2026-10-27T10:15:00Z',
  lines: [{ sku, quantity: 1, unitPricePaise: 1_199_900, title: 'Lava Blaze Pro 5G (Glass Blue, 128 GB)' }],
  buyer: { name: 'Asha Verma (synthetic)', phone: '9860011111', email: 'Asha@Example.test', gstin: GSTIN },
  shipTo: ADDRESS,
  billTo: { ...ADDRESS, line1: 'Office 9, Test Park', line2: null, landmark: null },
  payment: { method: 'PREPAID', status: 'PAID' },
  fulfilment: {
    by: 'SELLER',
    status: 'UNSHIPPED',
    shipBy: '2026-10-29T18:00:00Z',
    deliverBy: '2026-11-02T18:00:00Z',
  },
  totals: {
    itemsPaise: 1_199_900,
    shippingPaise: 4_000,
    discountPaise: 10_000,
    taxPaise: 183_036,
    totalPaise: 1_193_900,
    marketplaceFeesPaise: 95_912,
  },
  ...extra,
});

interface Order {
  id: string;
  externalOrderId: string;
  customerName: string | null;
  customerMobile: string | null;
  buyerEmail: string | null;
  buyerGstin: string | null;
  shipTo: Record<string, string | null> | null;
  billTo: Record<string, string | null> | null;
  buyerErased: boolean;
  masked: boolean;
  paymentMethod: string | null;
  paymentStatus: string | null;
  fulfilledBy: string | null;
  platformStatus: string | null;
  shipBy: string | null;
  deliverBy: string | null;
  carrier: string | null;
  trackingId: string | null;
  totals: Record<string, number | null>;
  droppedFields: string[];
  saleId: string | null;
  state: string;
  lines: { title: string | null; externalSku: string; quantity: number; unitPricePaise: number | null }[];
}
const orders = async (who: Session = a.owner, shop: Shop = a) =>
  (await get(h, `${shop.base}/channel-orders`, who)).json<{ orders: Order[] }>().orders;
const byExternal = async (id: string, who: Session = a.owner) =>
  (await orders(who)).find((o) => o.externalOrderId === id);
const sync = () => post(h, `${a.base}/channels/sync`, {}, a.owner);
const freshSession = (userId: string) =>
  sql`update auth."session" set "createdAt" = now() where "userId" = ${userId}`.execute(h.admin);

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  mockMarketplace.reset();
  a = await activeShop(h, 'od-a');
  b = await activeShop(h, 'od-b');
  inventory = (await staff(h, a, 'od-a-inventory@example.test', 'Inventory')).session;
  billing = (await staff(h, a, 'od-a-billing@example.test', 'Billing')).session;
  phone = await variant(h, a, 'OD-PH', { serialized: false });
  sku =
    (await sql<{ sku: string }>`select sku from lbg.product_variants where id = ${phone}`.execute(h.admin)).rows[0]
      ?.sku ?? '';
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${a.businessId}, ${phone}, 'OPENING', 10, 900000)`.execute(h.admin);
  const integ = await post(
    h,
    `${a.base}/integrations`,
    { category: 'MARKETPLACE', provider: 'mock', label: 'Amazon (mock)', authMethod: 'NONE', config: { store: 'od' } },
    a.owner,
  );
  const integrationId = integ.json<{ integration: { id: string } }>().integration.id;
  await post(h, `${a.base}/integrations/${integrationId}/test`, {}, a.owner);
  const ch = await post(h, `${a.base}/channels`, { name: 'Amazon', integrationId }, a.owner);
  const channelId = ch.json<{ channelId: string }>().channelId;
  await put(h, `${a.base}/channels/${channelId}/listings`, { variantId: phone }, a.owner);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('13.1 the order contract and its storage', () => {
  it('AC1: an order with every section is stored and returned with all fields', async () => {
    mockMarketplace.place('od', fullOrder('402-1111111-1111111'));
    expect((await sync()).statusCode).toBe(200);
    const o = await byExternal('402-1111111-1111111');
    expect(o).toMatchObject({
      customerName: 'Asha Verma (synthetic)',
      customerMobile: '+919860011111',
      buyerEmail: 'asha@example.test',
      buyerGstin: GSTIN,
      shipTo: { ...ADDRESS, phone: '+919860011111' },
      billTo: { city: 'Pune', line1: 'Office 9, Test Park', line2: null, landmark: null },
      buyerErased: false,
      masked: false,
      paymentMethod: 'PREPAID',
      paymentStatus: 'PAID',
      fulfilledBy: 'SELLER',
      platformStatus: 'UNSHIPPED',
      shipBy: '2026-10-29T18:00:00.000Z',
      deliverBy: '2026-11-02T18:00:00.000Z',
      carrier: null,
      trackingId: null,
      totals: {
        itemsPaise: 1_199_900,
        shippingPaise: 4_000,
        discountPaise: 10_000,
        taxPaise: 183_036,
        totalPaise: 1_193_900,
        marketplaceFeesPaise: 95_912,
      },
      droppedFields: [],
      state: 'OPEN',
      lines: [
        { title: 'Lava Blaze Pro 5G (Glass Blue, 128 GB)', externalSku: sku, quantity: 1, unitPricePaise: 1_199_900 },
      ],
    });
    // The detail route returns the same order.
    const one = await get(h, `${a.base}/channel-orders/${o?.id ?? ''}`, a.owner);
    expect(one.json<{ order: Order }>().order.buyerEmail).toBe('asha@example.test');
  });

  it('AC1: an order without the optional sections imports as before', async () => {
    mockMarketplace.place('od', {
      id: '402-2222222-2222222',
      status: 'NEW',
      placedAt: '2026-10-27T11:00:00Z',
      lines: [{ sku, quantity: 1, unitPricePaise: null }],
    });
    await sync();
    expect(await byExternal('402-2222222-2222222')).toMatchObject({
      customerName: null,
      shipTo: null,
      paymentMethod: null,
      totals: { totalPaise: null },
      droppedFields: [],
      lines: [{ title: null }],
    });
  });

  it('AC2: invalid optional fields are dropped one by one and listed; the rest is kept', async () => {
    mockMarketplace.place(
      'od',
      fullOrder('402-3333333-3333333', {
        buyer: { name: 'B'.repeat(121), phone: '12345', email: 'nope', gstin: '27AAPFU0939F1ZX' },
        shipTo: { ...ADDRESS, pincode: '0110', city: 'Pune\u0007' },
        payment: { method: 'BITCOIN', status: 'PAID' },
        fulfilment: { by: 'SELLER', shipBy: 'tomorrow' },
        totals: { totalPaise: -5, itemsPaise: 1.5, shippingPaise: 0 },
      }),
    );
    await sync();
    const o = await byExternal('402-3333333-3333333');
    expect(o?.droppedFields.sort()).toEqual(
      [
        'buyer.name',
        'buyer.phone',
        'buyer.email',
        'buyer.gstin',
        'shipTo.pincode',
        'shipTo.city',
        'payment.method',
        'fulfilment.shipBy',
        'totals.totalPaise',
        'totals.itemsPaise',
      ].sort(),
    );
    // The name falls back to the delivery name; the valid parts stay.
    expect(o).toMatchObject({
      customerName: 'Asha Verma (synthetic)',
      customerMobile: '+919860011111',
      buyerEmail: null,
      buyerGstin: null,
      shipTo: { line1: ADDRESS.line1, city: null, pincode: null },
      paymentMethod: null,
      paymentStatus: 'PAID',
      shipBy: null,
      totals: { totalPaise: null, itemsPaise: null, shippingPaise: 0 },
    });
  });

  it('AC2: a malformed required field still rejects the whole feed', () => {
    expect(parseFeedOrders({ orders: [fullOrder('ok-1'), { ...fullOrder('bad'), placedAt: 'yesterday' }] })).toBeNull();
    expect(parseFeedOrders({ orders: [{ ...fullOrder('bad-2'), lines: [] }] })).toBeNull();
    expect(parseFeedOrders({ orders: ['not an order'] })).toBeNull();
    expect(parseFeedOrders({ orders: [fullOrder('ok-2', { buyer: 'not an object' })] })?.[0]?.dropped).toEqual([
      'buyer',
    ]);
  });

  it('AC3: the order sent again updates status and tracking only; an erased buyer is not filled in again', async () => {
    mockMarketplace.place(
      'od',
      fullOrder('402-1111111-1111111', {
        buyer: { name: 'Changed name', phone: '9860099999' },
        lines: [{ sku, quantity: 5, unitPricePaise: 1 }],
        payment: { method: 'COD', status: 'REFUNDED' },
        fulfilment: { status: 'SHIPPED', carrier: 'Test Couriers', trackingId: 'TRK-0001' },
      }),
    );
    await sync();
    const o = await byExternal('402-1111111-1111111');
    expect(o).toMatchObject({
      platformStatus: 'SHIPPED',
      carrier: 'Test Couriers',
      trackingId: 'TRK-0001',
      paymentStatus: 'REFUNDED',
      // Kept as first received:
      paymentMethod: 'PREPAID',
      shipBy: '2026-10-29T18:00:00.000Z',
      customerName: 'Asha Verma (synthetic)',
      customerMobile: '+919860011111',
      lines: [{ quantity: 1, unitPricePaise: 1_199_900 }],
    });
    const audit = await sql<{ n: number }>`select count(*)::int as n from lbg.audit_events
      where business_id = ${a.businessId} and action = 'channel.order_updated' and target_id = ${o?.id ?? ''}`.execute(
      h.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('AC4: without customers.view the buyer is masked; another business gets 404', async () => {
    const o = await byExternal('402-1111111-1111111', inventory);
    expect(o).toMatchObject({
      masked: true,
      customerName: 'A…',
      customerMobile: '••••••1111',
      buyerEmail: null,
      buyerGstin: null,
      shipTo: {
        name: null,
        phone: null,
        line1: null,
        line2: null,
        landmark: null,
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411045',
      },
      // The platform details are not personal data.
      platformStatus: 'SHIPPED',
      trackingId: 'TRK-0001',
      totals: { totalPaise: 1_193_900 },
    });
    const one = await get(h, `${a.base}/channel-orders/${o?.id ?? ''}`, inventory);
    expect(JSON.stringify(one.json())).not.toMatch(/Verma|asha@|98600|Test Residency|AAPFU/);
    // Billing staff have customers.view: full details.
    expect((await byExternal('402-1111111-1111111', billing))?.buyerEmail).toBe('asha@example.test');
    expect((await get(h, `${b.base}/channel-orders/${o?.id ?? ''}`, b.owner)).statusCode).toBe(404);
    expect((await get(h, `${a.base}/channel-orders/${o?.id ?? ''}`, b.owner)).statusCode).toBe(404);
  });

  it('billing creates the customer with the buyer’s name, mobile, email, address and GSTIN', async () => {
    const o = await byExternal('402-1111111-1111111');
    const billed = await post(h, `${a.base}/channel-orders/${o?.id ?? ''}/bill`, {}, a.owner);
    expect(billed.statusCode).toBe(200);
    const c = await sql<{ name: string; mobile_e164: string; email: string; address: string; gstin: string }>`
      select c.name, c.mobile_e164, c.email::text as email, c.address, c.gstin from lbg.invoices i
        join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id
       where i.id = ${billed.json<{ saleId: string }>().saleId}`.execute(h.admin);
    expect(c.rows[0]).toEqual({
      name: 'Asha Verma (synthetic)',
      mobile_e164: '+919860011111',
      email: 'asha@example.test',
      address: 'Office 9, Test Park, Pune, Maharashtra 411045',
      gstin: GSTIN,
    });
  });
});

describe('13.2 privacy', () => {
  it('AC2: erase the buyer of one order — owner only, reason, recent sign-in; 409 the second time', async () => {
    const o = await byExternal('402-3333333-3333333');
    const url = `${a.base}/channel-orders/${o?.id ?? ''}/erase-buyer`;
    const reason = { reason: 'Buyer asked in writing on 28 Oct' };
    expect((await post(h, url, reason, billing)).statusCode).toBe(403);
    expect((await post(h, url, { reason: 'short' }, a.owner)).statusCode).toBe(400);
    await sql`update auth."session" set "createdAt" = now() - interval '1 hour' where "userId" = ${a.ownerId}`.execute(
      h.admin,
    );
    const stale = await post(h, url, reason, a.owner);
    expect([stale.statusCode, errorCode(stale)]).toEqual([403, 'REAUTH_REQUIRED']);
    await freshSession(a.ownerId);
    expect((await post(h, url, reason, b.owner)).statusCode).toBe(404);
    const done = await post(h, url, reason, a.owner);
    expect(done.statusCode).toBe(200);
    const after = await byExternal('402-3333333-3333333');
    expect(after).toMatchObject({
      buyerErased: true,
      customerName: null,
      customerMobile: null,
      buyerEmail: null,
      shipTo: null,
      billTo: null,
      paymentStatus: 'PAID',
      lines: [{ quantity: 1 }],
    });
    const again = await post(h, url, reason, a.owner);
    expect([again.statusCode, errorCode(again)]).toEqual([409, 'ALREADY_ERASED']);
    const req = await sql<{
      kind: string;
      customer_id: string | null;
    }>`select kind, customer_id from lbg.privacy_requests
      where business_id = ${a.businessId} and channel_order_id = ${o?.id ?? ''}`.execute(h.admin);
    expect(req.rows).toEqual([{ kind: 'ERASE_ORDER_BUYER', customer_id: null }]);
    // The audit has no personal data and not the reason.
    const audit = await sql<{ metadata: unknown }>`select metadata from lbg.audit_events
      where business_id = ${a.businessId} and action = 'channel.order_buyer_erased'`.execute(h.admin);
    expect(JSON.stringify(audit.rows)).not.toMatch(/Verma|asked in writing/);
    // Sent again by the platform: progress may change, the buyer stays erased.
    mockMarketplace.place('od', fullOrder('402-3333333-3333333', { fulfilment: { status: 'DELIVERED' } }));
    await sync();
    expect(await byExternal('402-3333333-3333333')).toMatchObject({
      platformStatus: 'DELIVERED',
      buyerErased: true,
      customerName: null,
      shipTo: null,
    });
  });

  it('AC1: erasing a customer erases the buyer details of their orders (billed or same mobile)', async () => {
    const billedOrder = await byExternal('402-1111111-1111111');
    // Issue the sale billed from the order (as Point of sale would).
    const ctx = { businessId: a.businessId, userId: a.ownerId };
    const access = { discount: { limits: undefined }, priceOverride: true };
    const draft = await getSale(h.appDb, ctx, access, billedOrder?.saleId ?? '');
    await issueSale(h.appDb, ctx, access, draft.id, {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: [{ method: 'UPI', amountPaise: draft.totals.totalPaise, reference: 'AMZ-SETTLE-OD' }],
    });
    // A second, unbilled order from the same mobile.
    mockMarketplace.place('od', fullOrder('402-4444444-4444444'));
    await sync();
    const customer = await sql<{
      id: string;
    }>`select customer_id as id from lbg.invoices where id = ${billedOrder?.saleId ?? ''}`.execute(h.admin);
    const res = await post(
      h,
      `${a.base}/customers/${customer.rows[0]?.id ?? ''}/erase`,
      { reason: 'Customer asked in writing on 28 Oct' },
      a.owner,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<{ erasure: { erasedOrderBuyers: number } }>().erasure.erasedOrderBuyers).toBe(2);
    for (const id of ['402-1111111-1111111', '402-4444444-4444444']) {
      expect(await byExternal(id)).toMatchObject({ buyerErased: true, customerName: null, shipTo: null });
    }
    // An order of someone else is untouched.
    expect((await byExternal('402-2222222-2222222'))?.buyerErased).toBe(false);
  });

  it('AC3: the data export contains the channel tables', async () => {
    const res = await get(h, `${a.base}/export/business-data`, a.owner);
    expect(res.statusCode).toBe(200);
    const body = res.rawPayload.toString('latin1');
    for (const f of ['sales_channels.csv', 'channel_listings.csv', 'channel_orders.csv', 'channel_order_lines.csv'])
      expect(body).toContain(f);
  });
});
