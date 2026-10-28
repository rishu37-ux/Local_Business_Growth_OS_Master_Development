// Increment 11.4: the shop's public website (D-069). Server-rendered, no
// scripts, own CSP; only published website listings; order requests reserve
// stock, are refused above available-to-sell, idempotent, spam-trapped and
// rate-limited. Synthetic data only.
import { crc32, deflateSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_ORDERS_PER_HOUR, headerColours } from '../src/routes/storefront.ts';
import { cookieHeader, freshIp, startHarness, type Harness } from './auth-harness.ts';
import { activeShop, get, put, resetFixture, variant, type Shop } from './shop-fixture.ts';

let h: Harness;
let a: Shop;
let cable: string;
let charger: string;
let cableListing: string;
let chargerListing: string;
const SLUG = 'sf-a-mobiles';

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 120)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const page = (url: string, ip = freshIp()) => h.app.inject({ method: 'GET', url, remoteAddress: ip });
const order = (listingId: string, fields: Record<string, string>, ip = freshIp()) =>
  h.app.inject({
    method: 'POST',
    url: `/s/${SLUG}/p/${listingId}/order`,
    remoteAddress: ip,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
const tokenOf = (html: string) => /name="token" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? '';
const reserved = async (variantId: string) =>
  (
    await sql<{ n: number }>`select coalesce(sum(l.quantity), 0)::int as n from lbg.channel_order_lines l
      join lbg.channel_orders o on o.id = l.order_id
     where l.variant_id = ${variantId} and o.status <> 'CANCELLED'`.execute(h.admin)
  ).rows[0]?.n ?? 0;

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  a = await activeShop(h, 'sf-a');
  cable = await variant(h, a, 'SF-CB', { serialized: false });
  charger = await variant(h, a, 'SF-CH', { serialized: false });
  await sql`update lbg.products set model_name = 'Fast <script>alert(1)</script> Cable'
             where id = (select product_id from lbg.product_variants where id = ${cable})`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${a.businessId}, ${cable}, 'OPENING', 5, 20000), (${a.businessId}, ${charger}, 'OPENING', 5, 20000)`.execute(
    h.admin,
  );
  await h.app.inject({
    method: 'POST',
    url: `${a.base}/branding/logo`,
    remoteAddress: freshIp(),
    headers: { origin: h.origin, cookie: cookieHeader(a.owner), 'content-type': 'application/octet-stream' },
    payload: png(),
  });
  await put(h, `${a.base}/branding`, { storeSlug: SLUG, storeEnabled: true, storeTagline: 'Phones & more' }, a.owner);
  const site = (await get(h, `${a.base}/channels`, a.owner)).json<{ channels: { id: string }[] }>().channels[0]?.id;
  cableListing = (await put(h, `${a.base}/channels/${site ?? ''}/listings`, { variantId: cable }, a.owner)).json<{
    listingId: string;
  }>().listingId;
  chargerListing = (
    await put(h, `${a.base}/channels/${site ?? ''}/listings`, { variantId: charger, published: false }, a.owner)
  ).json<{ listingId: string }>().listingId;
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('public store (11.4)', () => {
  it('AC1: published listings only, escaped, no scripts, its own CSP and the security headers', async () => {
    const res = await page(`/s/${SLUG}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Fast &lt;script&gt;alert(1)&lt;/script&gt; Cable');
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toContain('Model SF-CH');
    expect(res.body).toContain('₹1,000');
    expect(res.body).toContain('In stock');
    expect(res.body).toContain('Phones &amp; more');
    expect(res.body).toContain(`src="/s/${SLUG}/logo"`);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Nothing internal: no cost price, SKU or business ID on the page.
    expect(res.body).not.toContain('20000');
    expect(res.body).not.toContain('SF-CB');
    expect(res.body).not.toContain(a.businessId);
    const logo = await page(`/s/${SLUG}/logo`);
    expect(logo.headers['content-type']).toBe('image/png');
    expect((await page('/s/assets/store.css')).headers['content-type']).toContain('text/css');
  });

  it('AC3: unpublished listings, unknown addresses, disabled stores and inactive businesses are 404', async () => {
    expect((await page(`/s/${SLUG}/p/${chargerListing}`)).statusCode).toBe(404);
    expect((await page('/s/no-such-shop')).statusCode).toBe(404);
    expect((await page('/s/NOT VALID')).statusCode).toBe(400);
    await put(h, `${a.base}/branding`, { storeEnabled: false }, a.owner);
    expect((await page(`/s/${SLUG}`)).statusCode).toBe(404);
    await put(h, `${a.base}/branding`, { storeEnabled: true }, a.owner);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${a.businessId}`.execute(h.admin);
    expect((await page(`/s/${SLUG}`)).statusCode).toBe(404);
    await sql`update lbg.businesses set status = 'ACTIVE' where id = ${a.businessId}`.execute(h.admin);
    expect((await page(`/s/${SLUG}`)).statusCode).toBe(200);
  });

  it('the header text colour contrasts with the brand colour', () => {
    expect(headerColours('#f5d90a').fg).toBe('#111827');
    expect(headerColours('#1d1a5e').fg).toBe('#ffffff');
    expect(headerColours(null).bg).toBe('#302b86');
    expect(headerColours('red').bg).toBe('#302b86');
  });

  it('AC2: an order request reserves stock and is idempotent per form token', async () => {
    const form = await page(`/s/${SLUG}/p/${cableListing}`);
    expect(form.body).toContain('Send order request');
    expect(form.body).toContain('No payment online.');
    const token = tokenOf(form.body);
    expect(form.body).toContain('Delivery address (optional, if you want it delivered)');
    const fields = {
      token,
      name: 'Store visitor (synthetic)',
      mobile: '9860000001',
      quantity: '2',
      email: 'Visitor@Example.test',
      address: '12 Test Lane',
      city: 'Pune',
      pincode: '411001',
      website: '',
    };
    const sent = await order(cableListing, fields);
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('has your request for 2');
    expect(await reserved(cable)).toBe(2);
    expect((await order(cableListing, fields)).statusCode).toBe(200);
    expect(await reserved(cable)).toBe(2);
    // The page now shows what is left: 5 − 2 = 3.
    expect((await page(`/s/${SLUG}`)).body).toContain('Only 3 left');
  });

  it('AC2: refused above available-to-sell, with a bad mobile, or when the spam trap is filled', async () => {
    const token = () => tokenOf(form);
    const form = (await page(`/s/${SLUG}/p/${cableListing}`)).body;
    const tooMany = await order(cableListing, {
      token: token(),
      name: 'Big buyer',
      mobile: '9860000002',
      quantity: '4',
    });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.body).toContain('Only 3 available right now.');
    const badMobile = await order(cableListing, {
      token: tokenOf((await page(`/s/${SLUG}/p/${cableListing}`)).body),
      name: 'Someone',
      mobile: '12345',
      quantity: '1',
    });
    expect(badMobile.statusCode).toBe(400);
    // D-072: the optional delivery address is all or nothing, with a valid PIN code and email.
    const fresh = async () => tokenOf((await page(`/s/${SLUG}/p/${cableListing}`)).body);
    const base = { name: 'Someone', mobile: '9860000005', quantity: '1' };
    const badPin = await order(cableListing, {
      ...base,
      token: await fresh(),
      address: '1 Road',
      city: 'Pune',
      pincode: '0110',
    });
    expect([badPin.statusCode, badPin.body.includes('Enter a 6-digit PIN code.')]).toEqual([400, true]);
    const partial = await order(cableListing, { ...base, token: await fresh(), city: 'Pune' });
    expect([partial.statusCode, partial.body.includes('For delivery, enter the address, city and PIN code.')]).toEqual([
      400,
      true,
    ]);
    const badEmail = await order(cableListing, { ...base, token: await fresh(), email: 'not-an-email' });
    expect([badEmail.statusCode, badEmail.body.includes('Please check the email address.')]).toEqual([400, true]);
    const bot = await order(cableListing, {
      token: tokenOf((await page(`/s/${SLUG}/p/${cableListing}`)).body),
      name: 'Bot',
      mobile: '9860000003',
      quantity: '1',
      website: 'http://spam.example',
    });
    expect(bot.statusCode).toBe(400);
    expect(await reserved(cable)).toBe(2);
  });

  it('order requests are rate-limited per address', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i <= STORE_ORDERS_PER_HOUR; i++) {
      const r = await order(cableListing, { token: 'x', name: 'Repeat', mobile: '9860000004', quantity: '1' }, ip);
      statuses.push(r.statusCode);
    }
    expect(statuses.slice(0, STORE_ORDERS_PER_HOUR).every((s) => s === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('the order appears in the shop dashboard as a website order', async () => {
    const orders = (await get(h, `${a.base}/channel-orders`, a.owner)).json<{
      orders: { channelKind: string; customerName: string; customerMobile: string; state: string }[];
    }>().orders;
    expect(orders).toEqual([
      expect.objectContaining({
        channelKind: 'WEBSITE',
        customerName: 'Store visitor (synthetic)',
        customerMobile: '+919860000001',
        buyerEmail: 'visitor@example.test',
        shipTo: {
          name: 'Store visitor (synthetic)',
          phone: '+919860000001',
          line1: '12 Test Lane',
          line2: null,
          landmark: null,
          city: 'Pune',
          state: null,
          pincode: '411001',
          country: 'IN',
        },
        paymentStatus: 'PENDING',
        fulfilledBy: 'SELLER',
        state: 'OPEN',
      }),
    ]);
  });
});
