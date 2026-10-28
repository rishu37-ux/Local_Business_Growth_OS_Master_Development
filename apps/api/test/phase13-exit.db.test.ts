// Phase 13 exit (PHASE13_PLAN), in a real browser:
// 1. A marketplace order with full buyer, address, payment, fulfilment and
//    totals is synced (mock connector) and shows in Online selling.
// 2. The owner opens it and sees every detail, then bills it in Point of
//    sale: the invoice goes to a customer with the buyer's name.
// 3. Inventory staff (no customers.view) see the same order with the buyer
//    masked.
// axe runs at 1280/768/360 px. Synthetic data only; no marketplace is
// contacted.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { mockMarketplace } from '@lbgos/modules/integrations';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import {
  activeShop,
  post,
  put,
  resetFixture,
  SHOP_PW,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const PORT = 4392;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const ORDER_ID = '407-5550001-1234567';
/** Optional: a directory for review screenshots (never stored in the repository). */
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

let h: Harness;
let browser: Browser;
let shop: Shop;
let owner: Page;
let inventory: Session;
let sku: string;
const a11y: { page: string; width: number; violations: string[] }[] = [];
const problems: string[] = [];

async function audit(page: Page, label: string) {
  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const r = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    a11y.push({
      page: label,
      width,
      violations: r.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    });
    const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth'));
    if (overflow > 0) problems.push(`${label} @${String(width)}px overflows by ${String(overflow)}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
function watch(page: Page) {
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
}
const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name, exact: true }).click();

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  mockMarketplace.reset();
  shop = await activeShop(h, 'p13');
  inventory = (await staff(h, shop, 'p13-inventory@example.test', 'Inventory')).session;
  const phone = await variant(h, shop, 'P13-PH', { serialized: false });
  sku =
    (await sql<{ sku: string }>`select sku from lbg.product_variants where id = ${phone}`.execute(h.admin)).rows[0]
      ?.sku ?? '';
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${phone}, 'OPENING', 3, 900000)`.execute(h.admin);
  const integ = await post(
    h,
    `${shop.base}/integrations`,
    { category: 'MARKETPLACE', provider: 'mock', label: 'Amazon (mock)', authMethod: 'NONE', config: { store: 'p13' } },
    shop.owner,
  );
  const integId = integ.json<{ integration: { id: string } }>().integration.id;
  await post(h, `${shop.base}/integrations/${integId}/test`, {}, shop.owner);
  const ch = await post(h, `${shop.base}/channels`, { name: 'Amazon', integrationId: integId }, shop.owner);
  await put(
    h,
    `${shop.base}/channels/${ch.json<{ channelId: string }>().channelId}/listings`,
    { variantId: phone },
    shop.owner,
  );
  mockMarketplace.place('p13', {
    id: ORDER_ID,
    status: 'NEW',
    placedAt: '2026-10-28T09:30:00Z',
    lines: [{ sku, quantity: 1, unitPricePaise: 1_199_900, title: 'Lava Blaze Pro 5G (Glass Blue, 128 GB)' }],
    buyer: {
      name: 'Asha Verma (synthetic)',
      phone: '9860011111',
      email: 'asha@example.test',
      gstin: '27AAPFU0939F1ZV',
    },
    shipTo: {
      name: 'Asha Verma (synthetic)',
      phone: '9860011111',
      line1: 'Flat 4, Test Residency',
      line2: 'Baner Road',
      landmark: 'Test Park',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411045',
      country: 'IN',
    },
    billTo: {
      name: 'Verma Traders (synthetic)',
      line1: 'Office 9, Test Market',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
    },
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
  });

  owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(owner);
  await owner.goto(`${ORIGIN}/sign-in`);
  await owner.getByLabel('Email').fill(shop.ownerEmail);
  await owner.getByLabel('Password').fill(SHOP_PW);
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.getByLabel('Six-digit code from your authenticator app').fill(totp(shop.ownerSecret));
  await owner.getByRole('button', { name: 'Verify code' }).click();
  await owner.getByRole('heading', { name: /Welcome/ }).waitFor();
}, 180_000);
afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 13 exit (browser)', () => {
  it('1. the synced marketplace order shows in Online selling with buyer, city and payment', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(owner, 'Online selling');
    await owner.getByRole('button', { name: 'Sync marketplaces now' }).click();
    await owner.getByText(/Synced: 1 order change/).waitFor();
    const row = owner.getByRole('row').filter({ hasText: ORDER_ID });
    await row.getByText('Asha Verma (synthetic)').waitFor();
    await row.getByText('Pune 411045').waitFor();
    await row.getByText('Prepaid').waitFor();
    await row.getByText('UNSHIPPED').waitFor();
    await owner.getByLabel('Show orders from').selectOption({ label: 'Amazon' });
    await owner.getByLabel('Status').selectOption({ label: 'New — stock kept' });
    await row.waitFor();
    await shot(owner, 'p13-1-orders');
    await audit(owner, 'online selling with order details');
  }, 90_000);

  it('2. the owner sees every detail and bills it; the invoice goes to the buyer', async () => {
    await owner.getByRole('link', { name: `${ORDER_ID} — open order details` }).click();
    await owner.getByRole('heading', { name: `Order ${ORDER_ID}` }).waitFor();
    const main = owner.getByRole('main');
    for (const text of [
      'Amazon (marketplace)',
      'UNSHIPPED',
      'You ship it',
      'asha@example.test',
      '27AAPFU0939F1ZV',
      'Flat 4, Test Residency',
      'Baner Road',
      'Near Test Park',
      'Pune, Maharashtra 411045',
      'Verma Traders (synthetic)',
      'Office 9, Test Market',
      'Pune, Maharashtra 411001',
      'Prepaid',
      'paid',
      'Lava Blaze Pro 5G (Glass Blue, 128 GB)',
      '₹11,939.00',
      '− ₹959.12',
      '₹10,979.88',
    ]) {
      await main.getByText(text, { exact: true }).first().waitFor();
    }
    await main.getByRole('link', { name: '+919860011111' }).waitFor();
    await shot(owner, 'p13-2-order-page');
    await audit(owner, 'order page (owner)');
    await owner.getByRole('button', { name: 'Bill in Point of sale' }).click();
    await owner.waitForURL(/\/pos$/);
    await owner.getByText('Asha Verma (synthetic)').first().waitFor();
    await owner.getByRole('button', { name: 'Complete sale' }).click();
    await owner.getByRole('heading', { name: /^Sale complete: invoice / }).waitFor();
    const c = await sql<{ name: string; email: string }>`
      select c.name, c.email::text as email from lbg.invoices i join lbg.customers c on c.id = i.customer_id
       where i.business_id = ${shop.businessId} and i.status = 'ISSUED'`.execute(h.admin);
    expect(c.rows).toEqual([{ name: 'Asha Verma (synthetic)', email: 'asha@example.test' }]);
  }, 90_000);

  it('3. inventory staff see the order with the buyer masked', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(Object.entries(inventory).map(([name, value]) => ({ name, value, url: ORIGIN })));
    const staffPage = await ctx.newPage();
    watch(staffPage);
    const orderId = (
      await sql<{ id: string }>`select id from lbg.channel_orders where external_order_id = ${ORDER_ID}`.execute(
        h.admin,
      )
    ).rows[0]?.id;
    await staffPage.goto(`${ORIGIN}/b/${shop.businessId}/online/orders/${orderId ?? ''}`);
    await staffPage.getByRole('heading', { name: `Order ${ORDER_ID}` }).waitFor();
    await staffPage
      .getByText('Contact details and addresses are hidden: you need permission to see customer details.')
      .waitFor();
    const text = await staffPage.getByRole('main').innerText();
    expect(text).toContain('A…');
    expect(text).toContain('••••••1111');
    expect(text).toContain('Pune, Maharashtra 411045');
    expect(text).toContain('Billed');
    expect(text).not.toMatch(/Verma|asha@|Test Residency|AAPFU|9860011111/);
    await shot(staffPage, 'p13-3-order-page-masked');
    await audit(staffPage, 'order page (inventory staff)');
    await ctx.close();
  }, 60_000);

  it('no accessibility, overflow, CSP or page errors', () => {
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(problems).toEqual([]);
    expect(a11y.length).toBe(9);
  });
});
