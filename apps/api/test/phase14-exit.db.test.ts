// Phase 14 exit (PHASE14_PLAN), in a real browser:
// 1. The registration form offers all 36 states and union territories.
// 2. A shop in Bihar (outside the old list) is set up with its full address;
//    after going live the address shows in Shop details and is printed on
//    the next invoice.
// 3. Catalogue, Stock and Online selling offer CSV and Excel downloads whose
//    rows match the screen.
// axe runs at 1280/768/360 px. Synthetic data only.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { get, resetFixture, setupShop, SHOP_PW, variant, type Shop } from './shop-fixture.ts';

const PORT = 4393;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const PRINTED = 'Shop 5, Test Arcade, Station Road, Near the bus stand, Hajipur, Dist. Vaishali, Bihar – 844101';
/** Optional: a directory for review screenshots (never stored in the repository). */
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

let h: Harness;
let browser: Browser;
let shop: Shop;
let owner: Page;
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
const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name, exact: true }).click();
/** Clicks a download link and returns the file's text. */
async function download(page: Page, name: string): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name }).click()]);
  return readFileSync(await file.path(), 'utf8');
}

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await setupShop(h, 'p14x', '10');
  owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
  owner.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  owner.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
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

describe('Phase 14 exit (browser)', () => {
  it('1. the registration form offers all 36 states and union territories', async () => {
    const select = owner.getByLabel('State or union territory of the shop');
    const options = await select.locator('option').allTextContents();
    expect(options).toHaveLength(37);
    expect(options[0]).toBe('Choose a state');
    for (const name of ['Bihar', 'Ladakh', 'Andaman and Nicobar Islands', 'West Bengal'])
      expect(options).toContain(name);
    await expect(owner.getByRole('button', { name: 'Submit application' }).isDisabled()).resolves.toBe(true);
  });

  it('2. the Bihar shop is set up with its full address; Shop details and the invoice show it', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await owner.getByRole('heading', { name: 'Set up your shop' }).waitFor();
    // The state from the application, once the saved details have loaded.
    await expect
      .poll(() => owner.getByLabel('State or union territory', { exact: true }).inputValue(), { timeout: 10_000 })
      .toBe('10');
    await owner.getByLabel('Shop name shown to customers').fill('P14 Hajipur Mobiles');
    await owner.getByLabel('Address line 1 (shop number, building, street)').fill('Shop 5, Test Arcade');
    await owner.getByLabel('Address line 2 (area, locality)').fill('Station Road');
    await owner.getByLabel('Landmark').fill('Near the bus stand');
    await owner.getByLabel('City or town').fill('Hajipur');
    await owner.getByLabel('District').fill('Vaishali');
    await owner.getByLabel('PIN code (6 digits)').fill('84410');
    await owner.getByRole('button', { name: 'Save details' }).click();
    await owner.getByText('Enter a 6-digit PIN code.').waitFor();
    await owner.getByLabel('PIN code (6 digits)').fill('844101');
    await owner.getByRole('button', { name: 'Save details' }).click();
    await owner.getByText('Details saved.').waitFor();
    await shot(owner, 'p14-1-setup-address');
    await audit(owner, 'setup wizard with address');
    await owner.getByRole('button', { name: 'Save tax settings' }).click();
    await owner.getByText('Tax settings saved.').waitFor();
    await owner.getByRole('button', { name: 'Go live' }).click();
    await owner.getByText('Your shop is live.').waitFor();
    await owner.reload();
    const details = owner
      .getByRole('region', { name: 'Shop details' })
      .or(owner.locator('section[aria-labelledby="shop-details-heading"]'));
    await details.getByText(PRINTED).waitFor();
    await details.getByText('Bihar', { exact: false }).first().waitFor();
    await details.getByText('(set during setup; contact support to change it)').waitFor();
    await shot(owner, 'p14-2-shop-details');
    await audit(owner, 'overview with shop details');
    // The next invoice prints the composed address.
    const phone = await variant(h, shop, 'P14X-PH', { serialized: false });
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${shop.businessId}, ${phone}, 'OPENING', 3, 900000)`.execute(h.admin);
    const ctx = { businessId: shop.businessId, userId: shop.ownerId };
    const access = { discount: { limits: undefined }, priceOverride: true };
    const draft = await createSaleDraft(h.appDb, ctx, access, { lines: [{ variantId: phone, quantity: '1' }] });
    await issueSale(h.appDb, ctx, access, draft.id, {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
    });
    expect((await get(h, `${shop.base}/invoices/${draft.id}/print?size=A4`, shop.owner)).body).toContain(PRINTED);
  }, 120_000);

  it('3. Catalogue, Stock and Online selling download CSV and Excel files matching the screen', async () => {
    await menu(owner, 'Catalogue');
    await owner.getByRole('heading', { name: 'Catalogue', exact: true }).waitFor();
    const catalogue = await download(owner, 'CSV file of the catalogue');
    expect(catalogue).toContain('Product,Brand,Category');
    expect(catalogue).toContain('P14X-PH');
    const [xlsx] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('link', { name: 'Excel file of the catalogue' }).click(),
    ]);
    expect(xlsx.suggestedFilename()).toBe('products.xlsx');
    expect(
      readFileSync(await xlsx.path())
        .subarray(0, 2)
        .toString(),
    ).toBe('PK');
    await shot(owner, 'p14-3-catalogue-export');
    await audit(owner, 'catalogue with export');
    await menu(owner, 'Stock');
    const stock = await download(owner, 'CSV file of stock levels');
    expect(stock.split('\r\n').find((l) => l.includes('P14X-PH'))).toMatch(/,2,0,0,0,/);
    await owner.getByRole('link', { name: 'CSV file of phones by IMEI' }).waitFor();
    await menu(owner, 'Online selling');
    const orders = await download(owner, 'CSV file of online orders');
    expect(orders).toContain('Platform order ID');
  }, 90_000);

  it('no accessibility, overflow, CSP or page errors', () => {
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(problems).toEqual([]);
    expect(a11y.length).toBe(9);
  });
});
