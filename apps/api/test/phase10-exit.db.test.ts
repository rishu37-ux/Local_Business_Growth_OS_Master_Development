// Phase 10 exit (PHASE10_PLAN): in a real browser, the platform admin issues
// a billing invoice and records a manual payment; the owner sees it as paid,
// grants view-only support access, the admin reads the business and cannot
// change it, the owner sees each support action and ends the access, and the
// admin is then shut out. axe at 1280/768/360 px. Synthetic data only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, fixtureAdminLogin, post, resetFixture, SHOP_PW, type Shop } from './shop-fixture.ts';

const PORT = 4370;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');

let h: Harness;
let browser: Browser;
let shop: Shop;
let ownerCtx: BrowserContext;
let adminCtx: BrowserContext;
let owner: Page;
let admin: Page;
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

async function signIn(page: Page, email: string, secret: string) {
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(SHOP_PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Six-digit code from your authenticator app').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify code' }).click();
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
}

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'p10');
  await post(h, `${shop.base}/customers`, { name: 'Phase ten customer (synthetic)', mobile: '9862000001' }, shop.owner);
  ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await ownerCtx.newPage();
  admin = await adminCtx.newPage();
  await signIn(owner, shop.ownerEmail, shop.ownerSecret);
  const login = fixtureAdminLogin();
  await signIn(admin, login.email, login.secret);
}, 180_000);
afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 10 exit (browser)', () => {
  it('the admin issues an invoice and records a manual payment; the owner sees it paid', async () => {
    await admin.goto(`${ORIGIN}/platform`);
    await admin.getByRole('heading', { name: 'Billing invoices' }).waitFor();
    await admin.getByLabel('Business ID').fill(shop.businessId);
    await admin.getByLabel('Period start (YYYY-MM-DD)').fill('2026-11-01');
    await admin.getByLabel('Period end (YYYY-MM-DD)').fill('2026-12-01');
    await admin.getByRole('button', { name: 'Issue invoice' }).click();
    await admin.getByText('Invoice issued.').waitFor();
    const row = admin
      .getByRole('row')
      .filter({ hasText: shop.businessId.slice(0, 8) })
      .filter({ hasText: '2026-11-01' });
    await row.getByText('Due').waitFor();
    await audit(admin, 'platform billing');
    await admin.getByLabel('Payment reference').fill('UPI-SYNTH-P10');
    await admin.getByLabel('Paid on (YYYY-MM-DD)').fill('2026-11-02');
    await row.getByRole('button', { name: 'Record payment' }).click();
    await row.getByText('Paid (manual) 2026-11-02').waitFor();

    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await owner
      .getByRole('navigation', { name: 'Business' })
      .getByRole('link', { name: 'Billing and support' })
      .click();
    await owner.getByRole('heading', { name: 'Billing and support' }).waitFor();
    await owner.getByText('Paid on 2026-11-02').waitFor();
    expect(await owner.getByText(/LBG\/2026-27\/\d+/).count()).toBe(1);
  }, 120_000);

  it('the owner grants support; the admin reads but cannot change; each action is listed', async () => {
    await owner.getByLabel('Why support needs access (at least 10 characters)').fill('Check why a customer is missing');
    await owner.locator('#select-supportHours').selectOption('1');
    await owner.getByRole('button', { name: 'Allow support access' }).click();
    await owner.getByText('Support access granted.').waitFor();
    await owner.getByRole('row').filter({ hasText: 'Check why a customer is missing' }).getByText('Active').waitFor();

    await admin.goto(`${ORIGIN}/b/${shop.businessId}/customers`);
    await admin.getByText('Phase ten customer (synthetic)').waitFor();
    // A change is refused by the API with a clear reason.
    const res = await admin.evaluate(
      async ([url, origin]) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ name: 'Written by support', mobile: '9862000002' }),
        });
        return { status: r.status, body: await r.text() };
      },
      [`/api/businesses/${shop.businessId}/customers`, ORIGIN] as const,
    );
    expect(res.status).toBe(403);
    expect(res.body).toContain('SUPPORT_READ_ONLY');

    await owner.reload();
    await owner.getByRole('heading', { name: 'What support did' }).waitFor();
    // Wait for the list to load (the heading renders before the data arrives).
    await owner.getByRole('cell', { name: 'customers', exact: true }).first().waitFor();
    await owner.getByText('Tried to change (refused)').first().waitFor();
    await audit(owner, 'billing and support');
  }, 120_000);

  it('the owner ends the access and the admin is shut out at once', async () => {
    await owner.getByRole('button', { name: 'End access' }).click();
    await owner.getByText('Support access ended.').waitFor();
    await owner.getByText('Ended by you').waitFor();
    const status = await admin.evaluate(async (url) => (await fetch(url)).status, `/api/businesses/${shop.businessId}`);
    expect(status).toBe(404);
  }, 60_000);

  it('no accessibility, overflow, CSP or page errors', () => {
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(problems).toEqual([]);
    expect(a11y.length).toBe(6);
  });
});
