// Increment 9.3: accessibility and responsive sweep (NFR-1, NFR-16,
// PHASE9_PLAN). In Chromium, as the owner of a shop with data, every screen of
// the business menu plus the overview, tax rates and the main detail pages at
// 1280/768/360 px: no serious/critical axe violations (WCAG 2.2 AA tags), no
// horizontal page overflow, no CSP violations or page errors. Keyboard: the
// first Tab stops show a visible focus indicator. Synthetic data only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, post, resetFixture, SHOP_PW, variant, type Shop } from './shop-fixture.ts';

const PORT = 4360;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');

let h: Harness;
let browser: Browser;
let shop: Shop;
let page: Page;
const pages: [string, string][] = [];
const problems: string[] = [];
const results: { page: string; width: number; violations: string[] }[] = [];
const focusMissing: string[] = [];

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'a11y');
  const ctx = { businessId: shop.businessId, userId: shop.ownerId };
  const cable = await variant(h, shop, 'A11Y-CB', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 5, 20000)`.execute(h.admin);
  const c = await post(
    h,
    `${shop.base}/customers`,
    { name: 'Accessibility customer (synthetic)', mobile: '9865000001' },
    shop.owner,
  );
  const customerId = c.json<{ customer: { id: string } }>().customer.id;
  const access = { discount: { limits: undefined }, priceOverride: true };
  const draft = await createSaleDraft(h.appDb, ctx, access, {
    customerId,
    lines: [{ variantId: cable, quantity: '1' }],
  });
  await issueSale(h.appDb, ctx, access, draft.id, {
    expectedTotalPaise: draft.totals.totalPaise,
    payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
  });
  const productId =
    (await sql<{ id: string }>`select product_id as id from lbg.product_variants where id = ${cable}`.execute(h.admin))
      .rows[0]?.id ?? '';
  const b = `/b/${shop.businessId}`;
  pages.push(
    ['overview', b],
    ...[
      'assistants',
      'pos',
      'online',
      'invoices',
      'customers',
      'reminders',
      'catalogue',
      'stock',
      'purchases',
      'scans',
      'suppliers',
      'approvals',
      'expenses',
      'offers',
      'studio',
      'campaigns',
      'integrations',
      'usage',
      'reports',
      'members',
      'account',
      'branding',
      'tax-rates',
    ].map((p): [string, string] => [p, `${b}/${p}`]),
    ['product detail', `${b}/catalogue/${productId}`],
    ['customer detail', `${b}/customers/${customerId}`],
    ['invoice detail', `${b}/invoices/${draft.id}`],
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByLabel('Email').fill(shop.ownerEmail);
  await page.getByLabel('Password').fill(SHOP_PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Six-digit code from your authenticator app').fill(totp(shop.ownerSecret));
  await page.getByRole('button', { name: 'Verify code' }).click();
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
}, 180_000);
afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('accessibility and responsive sweep (NFR-1, NFR-16)', () => {
  it('every screen at 1280, 768 and 360 px', async () => {
    for (const [label, url] of pages) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${ORIGIN}${url}`);
      await page.locator('main h1').first().waitFor();
      await page.waitForLoadState('networkidle');
      // Keyboard: the first focusable control after the skip link shows a focus indicator.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      // A string expression: this package has no DOM types.
      const visible = await page.evaluate<boolean>(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return false;
          const s = getComputedStyle(el);
          return (s.outlineStyle !== 'none' && s.outlineWidth !== '0px') || s.boxShadow !== 'none';
        })()`);
      if (!visible) focusMissing.push(label);
      for (const width of [1280, 768, 360]) {
        await page.setViewportSize({ width, height: 900 });
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        results.push({
          page: label,
          width,
          violations: r.violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
        });
        const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth'));
        if (overflow > 0) problems.push(`${label} @${String(width)}px overflows by ${String(overflow)}px`);
      }
    }
    expect(results.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(problems).toEqual([]);
    expect(focusMissing).toEqual([]);
    expect(results.length).toBe(pages.length * 3);
    expect(pages.length).toBe(27);
  }, 600_000);
});
