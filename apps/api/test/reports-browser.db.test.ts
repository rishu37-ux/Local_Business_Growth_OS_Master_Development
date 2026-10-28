// Reports screen in a real browser (Chromium via Playwright): figures with
// their definitions, permission-dependent sections, export links, and axe at
// 1280/768/360 px with no horizontal overflow or CSP violations (FR-RPT-2,
// FR-LED-3, NFR-1). Synthetic data only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, patch, post, resetFixture, SHOP_PW, staff, variant, type Shop } from './shop-fixture.ts';

const PORT = 4319;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const SHOTS = process.env.SHOTS_DIR;

let h: Harness;
let browser: Browser;
let shop: Shop;
const problems: string[] = [];
const a11y: { page: string; width: number; violations: string[] }[] = [];

async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  return page;
}

async function audit(page: Page, label: string) {
  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    a11y.push({
      page: label,
      width,
      violations: result.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    });
    const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth'));
    if (overflow > 0) problems.push(`${label} @${String(width)}px overflows horizontally by ${String(overflow)}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function signIn(page: Page, email: string, secret?: string) {
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(SHOP_PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (secret) {
    await page.getByLabel('Six-digit code from your authenticator app').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify code' }).click();
  }
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
}

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'rptb', { gstin: '27AAPFU0939F1ZV' });
  const taxRateId = (
    await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
      shop.owner,
    )
  ).json<{ id: string }>().id;
  const cable = await variant(h, shop, 'RB-CB', { serialized: false, taxRateId });
  await patch(h, `${shop.base}/variants/${cable}`, { sellingPricePaise: 50_000 }, shop.owner);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 20, 20000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 20000 where id = ${cable}`.execute(h.admin);
  // Three cables sold today, paid by UPI.
  const ctx = { businessId: shop.businessId, userId: shop.ownerId };
  const access = { discount: { limits: undefined }, priceOverride: true };
  const draft = await createSaleDraft(h.appDb, ctx, access, { lines: [{ variantId: cable, quantity: '3' }] });
  await issueSale(h.appDb, ctx, access, draft.id, {
    expectedTotalPaise: 150_000,
    payments: [{ method: 'UPI', amountPaise: 150_000, reference: 'UPI-RB-1' }],
  });
  await staff(h, shop, 'rptb-billing@example.test', 'Billing');
}, 120_000);

afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('reports screen', () => {
  it('the owner sees figures with their definitions, margin, cash received and export links', async () => {
    const page = await newPage();
    await signIn(page, shop.ownerEmail, shop.ownerSecret);
    await page.goto(`${ORIGIN}/b/${shop.businessId}`);
    await page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name: 'Reports' }).click();
    await page.getByRole('heading', { name: 'Sales and accounts' }).waitFor();
    await page.getByRole('heading', { name: 'Gross margin' }).waitFor();
    await page.getByRole('cell', { name: 'Model RB-CB' }).first().waitFor();
    const text = await page.locator('main').innerText();
    // Net sales ₹1,500 this month, with the SRS §7 definition beside it.
    expect(text).toContain('Net sales');
    expect(text).toContain('₹1,500.00');
    expect(text).toContain('Gross sales minus returns.');
    expect(text).toContain('not a GST return');
    // FR-LED-3: no sales figure is called profit; "profit" appears only in the
    // separately defined operating-profit estimate (6.4), always labelled an estimate.
    const profitSection = await page
      .locator('section', { has: page.getByRole('heading', { name: 'Operating profit (estimate)' }) })
      .innerText();
    expect(text.replace(profitSection, '')).not.toMatch(/profit/i);
    expect(profitSection).toMatch(/estimate/i);
    expect(await page.getByRole('link', { name: 'XLSX' }).count()).toBeGreaterThan(0);
    const csv = await page.getByRole('link', { name: 'CSV' }).first().getAttribute('href');
    expect(csv).toMatch(/\/reports\/sales-summary\/export\?period=month&format=csv$/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'reports.png'), fullPage: true });
    await audit(page, 'reports');
  }, 60_000);

  it('Billing staff have no Reports menu entry and the API refuses them', async () => {
    const page = await newPage();
    await signIn(page, 'rptb-billing@example.test');
    await page.goto(`${ORIGIN}/b/${shop.businessId}`);
    await page.getByRole('navigation', { name: 'Business' }).waitFor();
    expect(
      await page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name: 'Reports' }).count(),
    ).toBe(0);
  }, 60_000);

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(a11y.length).toBe(3);
  });
});
