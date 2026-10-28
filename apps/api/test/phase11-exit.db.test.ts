// Phase 11 exit (PHASE11_PLAN), in a real browser:
// 1. The owner uploads a logo, sets a colour and turns the website on, then
//    offers a product on the website and on a marketplace (mock connector).
// 2. A visitor sees it on the shop's website with the logo and sends an order
//    request.
// 3. The owner bills that order in Point of sale; the invoice carries the logo
//    and the stock goes down.
// 4. The marketplace receives the new quantity, and an order imported from it
//    reserves stock and lowers what the website shows.
// axe runs at 1280/768/360 px. Synthetic data only; no marketplace is
// contacted.
import { crc32, deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { mockMarketplace } from '@lbgos/modules/integrations';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, post, resetFixture, SHOP_PW, variant, type Shop } from './shop-fixture.ts';

const PORT = 4380;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const SLUG = 'p11-mobiles';
/** Optional: a directory for review screenshots (never stored in the repository). */
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

let h: Harness;
let browser: Browser;
let shop: Shop;
let owner: Page;
let visitor: Page;
let cable: string;
let cableSku: string;
const a11y: { page: string; width: number; violations: string[] }[] = [];
const problems: string[] = [];

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
  ihdr.writeUInt32BE(48, 0);
  ihdr.writeUInt32BE(24, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => [10, 122, 85]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 24 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

const stock = async () =>
  Number(
    (
      await sql<{ q: string }>`select quantity::text as q from lbg.stock_levels
        where business_id = ${shop.businessId} and variant_id = ${cable} and bucket = 'AVAILABLE'`.execute(h.admin)
    ).rows[0]?.q,
  );
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
  shop = await activeShop(h, 'p11');
  cable = await variant(h, shop, 'P11-CB', { serialized: false });
  cableSku =
    (await sql<{ sku: string }>`select sku from lbg.product_variants where id = ${cable}`.execute(h.admin)).rows[0]
      ?.sku ?? '';
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 5, 20000)`.execute(h.admin);
  // The marketplace connector (mock) and its channel, as the API Hub would create them.
  const integ = await post(
    h,
    `${shop.base}/integrations`,
    {
      category: 'MARKETPLACE',
      provider: 'mock',
      label: 'Amazon connector (mock)',
      authMethod: 'NONE',
      config: { store: 'p11-amz' },
    },
    shop.owner,
  );
  const integId = integ.json<{ integration: { id: string } }>().integration.id;
  await post(h, `${shop.base}/integrations/${integId}/test`, {}, shop.owner);
  await post(h, `${shop.base}/channels`, { name: 'Amazon', integrationId: integId, stockBuffer: 1 }, shop.owner);

  owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  visitor = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(owner);
  watch(visitor);
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

describe('Phase 11 exit (browser)', () => {
  it('the owner sets the logo, colour and website, and offers a product on the website and Amazon', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(owner, 'Branding and website');
    await owner.getByRole('heading', { name: 'Branding and online store' }).waitFor();
    await owner.locator('#logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png() });
    await owner.getByRole('button', { name: 'Upload logo' }).click();
    await owner.getByText('Logo saved.').waitFor();
    await owner.getByRole('img', { name: 'Current logo' }).waitFor();
    await owner.getByLabel('Brand colour (e.g. #0a7a55)').fill('#0a7a55');
    await owner.getByLabel('Website address (3–40 letters, digits or hyphens)').fill(SLUG);
    await owner.getByLabel(/Show my website/).check();
    await owner.getByRole('button', { name: 'Save', exact: true }).click();
    await owner.getByText('Saved.').waitFor();
    await owner.getByRole('link', { name: /Open your shop's website/ }).waitFor();
    // The dashboard shows the shop's own logo next to its name (same dashboard for everyone).
    await owner.getByRole('img', { name: 'p11 Mobiles logo' }).waitFor();
    await audit(owner, 'branding');
    await shot(owner, 'branding');

    await menu(owner, 'Online selling');
    await owner.getByRole('heading', { name: 'Online selling' }).waitFor();
    for (const [channel, price] of [
      ['Website', ''],
      ['Amazon', '1050'],
    ] as const) {
      await owner.locator('#select-listVariant').selectOption(cable);
      await owner.locator('#select-listChannel').selectOption({ label: channel });
      await owner.getByLabel('Price on this channel in ₹ (optional)').fill(price);
      await owner.getByRole('button', { name: 'Offer this product' }).click();
      await owner.getByText(`Offered on ${channel}.`).waitFor();
    }
    await owner.getByRole('button', { name: 'Sync marketplaces now' }).click();
    await owner.getByText(/^Synced:/).waitFor();
    // 5 in stock, 1 kept back for Amazon.
    expect(mockMarketplace.pushes.at(-1)?.items).toEqual([{ sku: cableSku, quantity: 4, pricePaise: 105000 }]);
    await audit(owner, 'online selling');
    await shot(owner, 'online-selling');
  }, 120_000);

  it('a visitor sees the website with the logo and sends an order request', async () => {
    await visitor.goto(`${ORIGIN}/s/${SLUG}`);
    await visitor.getByRole('heading', { name: 'p11 Mobiles', level: 1 }).waitFor();
    await visitor.getByRole('img', { name: 'p11 Mobiles logo' }).waitFor();
    await visitor.getByText('In stock').waitFor();
    await audit(visitor, 'website');
    await shot(visitor, 'website');
    await visitor.getByRole('link', { name: 'Model P11-CB' }).click();
    await visitor.getByRole('button', { name: 'Send order request' }).waitFor();
    await audit(visitor, 'website product');
    await visitor.getByLabel('Your name').fill('Website buyer (synthetic)');
    await visitor.getByLabel('Mobile number').fill('9859000001');
    await visitor.getByLabel('Quantity').fill('1');
    await visitor.getByRole('button', { name: 'Send order request' }).click();
    await visitor.getByText(/has your request for 1/).waitFor();
  }, 60_000);

  it('the owner bills the order in Point of sale; the invoice has the logo; stock goes down', async () => {
    // The page was open before the request arrived: reload it, as the owner would.
    await owner.reload();
    const row = owner.getByRole('row').filter({ hasText: 'Website buyer (synthetic)' });
    await row.getByText('New — stock kept').waitFor();
    await row.getByRole('button', { name: /Bill in Point of sale/ }).click();
    await owner.waitForURL(/\/pos$/);
    await owner.getByText('Website buyer (synthetic)').first().waitFor();
    const before = await stock();
    await owner.getByRole('button', { name: 'Complete sale' }).click();
    const done = owner.getByRole('heading', { name: /^Sale complete: invoice / });
    await done.waitFor();
    expect(await stock()).toBe(before - 1);
    const inv = await sql<{ id: string }>`select id from lbg.invoices where business_id = ${shop.businessId}
                                            and status = 'ISSUED' order by issued_at desc limit 1`.execute(h.admin);
    const print = await owner.request.get(
      `${ORIGIN}/api/businesses/${shop.businessId}/invoices/${inv.rows[0]?.id ?? ''}/print?size=A4`,
    );
    const html = await print.text();
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('border-bottom-color: #0a7a55');
    await menu(owner, 'Online selling');
    await owner.getByRole('row').filter({ hasText: 'Website buyer (synthetic)' }).getByText('Billed').waitFor();
  }, 90_000);

  it('an Amazon order reserves stock: Amazon gets the new quantity and the website shows less', async () => {
    mockMarketplace.place('p11-amz', {
      id: 'AMZ-P11-1',
      status: 'NEW',
      placedAt: new Date().toISOString(),
      lines: [{ sku: cableSku, quantity: 2, unitPricePaise: 105000 }],
    });
    await owner.getByRole('button', { name: 'Sync marketplaces now' }).click();
    await owner.getByText(/^Synced: 1 order change/).waitFor();
    await owner.getByRole('row').filter({ hasText: 'AMZ-P11-1' }).getByText('New — stock kept').waitFor();
    // 4 in stock − 2 kept for the order − 1 kept back.
    expect(mockMarketplace.pushes.at(-1)?.items).toEqual([{ sku: cableSku, quantity: 1, pricePaise: 105000 }]);
    await visitor.goto(`${ORIGIN}/s/${SLUG}`);
    await visitor.getByText('Only 2 left').waitFor();
    await shot(owner, 'online-orders');
  }, 60_000);

  it('no accessibility, overflow, CSP or page errors', () => {
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(problems).toEqual([]);
    expect(a11y.length).toBe(12);
  });
});
