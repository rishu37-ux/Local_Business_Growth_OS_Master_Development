// Phase 5 exit test in a real browser (Chromium via Playwright) against the
// real API, the built web app and a migrated throwaway DB (PHASE5_PLAN §Exit).
// A cashier sells a phone chosen by IMEI and an accessory to a new customer
// with a discount within the cashier's limit, part-paid by UPI and cash; the
// invoice gets the next consecutive number and prints in A4 and 80 mm and as
// a PDF; the customer's balance shows the amount due and a later payment
// clears it; a credit note returns the phone into inspection; the sales, tax
// and receivables reports equal the expected values. New screens are audited
// with axe at 1280/768/360 px for overflow and CSP violations. Also: a
// single-item sale to a known customer is counted in interactions (FR-POS-1
// AC3) and counter search is timed over 10,000 variants (FR-POS-1 AC1).
// Synthetic data only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import {
  activeShop,
  get,
  imei,
  patch,
  post,
  put,
  resetFixture,
  SHOP_PW,
  staff,
  variant,
  type Shop,
} from './shop-fixture.ts';

const PORT = 4320;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const SHOTS = process.env.SHOTS_DIR;
const CASHIER = 'p5-cashier@example.test';
const IMEI_A = imei(9501);
const IMEI_B = imei(9502);

let h: Harness;
let browser: Browser;
let shop: Shop;
let cashier: Page;
let owner: Page;
let phoneUnit = '';
let invoiceId = '';
let invoiceNumber = '';
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
    if (overflow > 0) {
      // Name the widest elements that stick out, to make the failure actionable.
      const culprits = String(
        await page.evaluate(`[...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
          .map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 3).join('.') + ' ' + Math.round(e.getBoundingClientRect().width))
          .slice(-4).join(' | ')`),
      );
      problems.push(`${label} @${String(width)}px overflows horizontally by ${String(overflow)}px: ${culprits}`);
    }
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

const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name, exact: true }).click();

const report = async <T>(name: string, query = '') =>
  (await get(h, `${shop.base}/reports/${name}${query ? `?${query}` : ''}`, shop.owner)).json<{ report: T }>().report;

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'p5-exit', { gstin: '27AAPFU0939F1ZV' });
  await staff(h, shop, CASHIER, 'Billing'); // limit 2 % / ₹500
  await put(
    h,
    `${shop.base}/print-settings`,
    {
      printSize: 'A4',
      address: '7 Station Road, Pune (synthetic)',
      phone: '9800099900',
      terms: 'Exchange within 7 days with the bill.',
    },
    shop.owner,
  );
  const taxRateId = (
    await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
      shop.owner,
    )
  ).json<{ id: string }>().id;
  const phone = await variant(h, shop, 'P5-PH', { serialized: true, taxRateId });
  const cable = await variant(h, shop, 'P5-CB', { serialized: false, taxRateId });
  await patch(h, `${shop.base}/variants/${phone}`, { sellingPricePaise: 1_500_000, hsnCode: '8517' }, shop.owner);
  await patch(h, `${shop.base}/variants/${cable}`, { sellingPricePaise: 50_000, hsnCode: '8544' }, shop.owner);
  for (const [code, cost] of [
    [IMEI_A, 1_100_000],
    [IMEI_B, 1_100_000],
  ] as const) {
    const unit =
      (
        await sql<{ id: string }>`insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
        values (${shop.businessId}, ${phone}, 'IN_STOCK', ${cost}) returning id`.execute(h.admin)
      ).rows[0]?.id ?? '';
    if (code === IMEI_A) phoneUnit = unit;
    await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot) values (${shop.businessId}, ${code}, ${unit}, 1)`.execute(
      h.admin,
    );
    await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
              values (${shop.businessId}, ${phone}, ${unit}, 'OPENING', 1, ${cost})`.execute(h.admin);
  }
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 20, 20000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 20000 where id = ${cable}`.execute(h.admin);
  // An earlier sale today (₹500 cash), so the POS sale must take the next number.
  const earlier = (await post(h, `${shop.base}/sales`, { lines: [{ variantId: cable }] }, shop.owner)).json<{
    sale: { id: string };
  }>().sale;
  await post(
    h,
    `${shop.base}/sales/${earlier.id}/issue`,
    { expectedTotalPaise: 50_000, payments: [{ method: 'CASH', amountPaise: 50_000 }] },
    shop.owner,
  );

  cashier = await newPage();
  await signIn(cashier, CASHIER);
  owner = await newPage();
  await signIn(owner, shop.ownerEmail, shop.ownerSecret);
}, 180_000);

afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 5 exit: sell → print → pay → return → reports', () => {
  it('the cashier sells a phone by IMEI and a cable to a new customer, with a discount, part-paid by UPI and cash', async () => {
    const p = cashier;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(p, 'Point of sale');
    await p.getByRole('heading', { name: 'New sale' }).waitFor();
    // Scanner input: the IMEI, then Enter.
    await p.getByLabel('Scan or search').fill(IMEI_A);
    await p.getByLabel('Scan or search').press('Enter');
    await p.getByRole('cell', { name: new RegExp(`^Model P5-PH.*IMEI ${IMEI_A}`) }).waitFor();
    await p.getByLabel('Scan or search').fill('P5-CB');
    await p.getByLabel('Scan or search').press('Enter');
    await p.getByRole('cell', { name: /^Model P5-CB ₹500\.00 each$/ }).waitFor();
    // New customer by mobile.
    await p.getByLabel('Customer mobile (optional for a fully paid sale)').fill('9876512345');
    await p.getByLabel("New customer's name").fill('Priya Sharma (synthetic)');
    await p.getByRole('button', { name: 'Add customer' }).click();
    await p.getByText('Priya Sharma (synthetic)').waitFor();
    // ₹200 off the phone: within the cashier's 2 % / ₹500 limit.
    await p.getByLabel(/Discount on Model P5-PH/).fill('200');
    await p.getByLabel(/Discount on Model P5-PH/).press('Tab');
    await p.getByTestId('pos-total').getByText('₹15,300.00').waitFor();
    // Split payment: ₹10,000 UPI + ₹3,000 cash; ₹2,300 stays due.
    await p.getByRole('button', { name: 'UPI', exact: true }).click();
    await p.getByLabel('Payment 1 amount (₹)').fill('10000');
    await p.getByLabel('Reference (UPI ref or card last 4 digits)').fill('UPI-EXIT-1');
    await p.getByRole('button', { name: 'Split payment' }).click();
    await p.getByLabel('Payment 2 method').selectOption('CASH');
    await p.getByLabel('Payment 2 amount (₹)').fill('3000');
    await p.getByText('Balance due: ₹2,300.00').waitFor();
    await audit(p, 'pos');
    if (SHOTS) {
      await p.evaluate('window.scrollTo(0, 0)');
      await p.screenshot({ path: path.join(SHOTS, 'pos.png'), fullPage: false });
    }
    await p.getByRole('button', { name: 'Complete sale' }).click();
    const done = p.getByRole('heading', { name: /^Sale complete: invoice / });
    await done.waitFor();
    invoiceNumber = ((await done.textContent()) ?? '').replace('Sale complete: invoice ', '').trim();
    // The next consecutive number after the earlier sale.
    expect(invoiceNumber).toMatch(/^T\d{2}-\d{2}\/0002$/);
    expect(await p.locator('main').innerText()).toContain('₹2,300.00');
    const row = await sql<{ id: string }>`select id from lbg.invoices where business_id = ${shop.businessId}
                                           and invoice_number = ${invoiceNumber}`.execute(h.admin);
    invoiceId = row.rows[0]?.id ?? '';
  }, 90_000);

  it('the invoice prints in A4 and 80 mm and downloads as a PDF', async () => {
    const p = cashier;
    const a4 = await p.getByRole('link', { name: 'Print A4' }).getAttribute('href');
    await p.goto(`${ORIGIN}${a4 ?? ''}`);
    const a4Text = await p.locator('main').innerText();
    for (const t of [
      'TAX INVOICE',
      invoiceNumber,
      IMEI_A,
      'Priya Sharma (synthetic)',
      '₹15,300.00',
      'Rupees Fifteen Thousand Three Hundred Only',
      '₹2,300.00',
      '7 Station Road, Pune (synthetic)',
    ]) {
      expect(a4Text, t).toContain(t);
    }
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'print-a4.png'), fullPage: true });
    await p.goto(`${ORIGIN}${(a4 ?? '').replace('size=A4', 'size=80MM')}`);
    expect(await p.locator('main').innerText()).toContain(IMEI_A);
    const pdf = await p.request.get(`${ORIGIN}${shop.base}/invoices/${invoiceId}/pdf?size=A4`);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60_000);

  it("the customer's balance shows the amount due; a later payment clears it", async () => {
    const p = cashier;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(p, 'Customers');
    await p.getByLabel('Name or mobile').fill('Priya');
    await p.getByRole('link', { name: 'Priya Sharma (synthetic)' }).click();
    await p.getByTestId('customer-balance').getByText('₹2,300.00').waitFor();
    await p.getByText('The customer owes the shop.', { exact: true }).waitFor();
    await audit(p, 'customer');
    await p.getByLabel('Method').selectOption('UPI');
    await p.getByLabel('Amount (₹)').fill('2300');
    await p.getByRole('button', { name: 'Record payment' }).click();
    await p.getByText('Payment recorded.').waitFor();
    await p.getByText('Nothing owed.').waitFor();
    await menu(p, 'Customers');
    await audit(p, 'customers');
  }, 60_000);

  it('the owner issues a credit note that returns the phone into inspection', async () => {
    const p = owner;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(p, 'Invoices');
    await audit(p, 'invoices');
    await p.getByRole('link', { name: invoiceNumber }).click();
    await p.getByRole('heading', { name: 'Return or correct with a credit note' }).waitFor();
    await audit(p, 'invoice detail');
    await p.getByLabel(/^Return line 1:/).check();
    await p.getByLabel('Reason (at least 10 characters)').fill('Phone returned within 7 days.');
    await p.getByLabel('Money paid for the returned items').selectOption('ADVANCE');
    await p.getByRole('button', { name: 'Issue credit note' }).click();
    await p.getByText('Credit note issued.').waitFor();
    const unit = await sql<{ status: string }>`select status from lbg.serialized_units where id = ${phoneUnit}`.execute(
      h.admin,
    );
    expect(unit.rows[0]?.status).toBe('PENDING_INSPECTION');
  }, 60_000);

  it('sales, tax and receivables reports equal the expected values', async () => {
    // Today: ₹500 cable (earlier) + ₹15,300 POS sale; credit note ₹14,800 (the phone after its ₹200 discount).
    const summary = await report<{ current: Record<string, number> }>('sales-summary', 'period=day');
    expect(summary.current).toEqual({
      invoiceCount: 2,
      grossSalesPaise: 1_580_000,
      returnsPaise: 1_480_000,
      netSalesPaise: 100_000,
      taxableValuePaise: 84_746,
      taxCollectedPaise: 15_254,
    });
    const tax = await report<{ totals: Record<string, number> }>('tax', 'period=day');
    expect(tax.totals).toEqual({
      taxablePaise: 84_746,
      cgstPaise: 7_626,
      sgstPaise: 7_628,
      igstPaise: 0,
      cessPaise: 0,
    });
    const ageing = await report<{ totals: { totalPaise: number }; customerAdvancesPaise: number }>('receivables');
    // Fully paid, then ₹14,800 credited: nothing due, ₹14,800 held as advance.
    expect(ageing.totals.totalPaise).toBe(0);
    expect(ageing.customerAdvancesPaise).toBe(1_480_000);
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(owner, 'Reports');
    await owner.getByRole('heading', { name: 'Sales and accounts' }).waitFor();
    await owner.getByRole('combobox', { name: 'Period', exact: true }).selectOption('day');
    await owner.getByText('Gross sales minus returns.').waitFor();
    expect(await owner.locator('main').innerText()).toContain('₹1,000.00');
  }, 60_000);

  it('FR-POS-1 AC3: a single-item sale to a known customer takes at most 6 interactions', async () => {
    const p = cashier;
    await p.goto(`${ORIGIN}/b/${shop.businessId}/pos`);
    await p.getByRole('heading', { name: 'New sale' }).waitFor();
    let interactions = 0;
    const act = async (fn: () => Promise<void>) => {
      interactions++;
      await fn();
    };
    await act(() => p.getByLabel('Scan or search').fill(IMEI_B));
    await act(() => p.getByLabel('Scan or search').press('Enter'));
    await p.getByRole('cell', { name: new RegExp(`^Model P5-PH.*IMEI ${IMEI_B}`) }).waitFor();
    await act(() => p.getByLabel('Customer mobile (optional for a fully paid sale)').fill('9876512345'));
    await p.getByText('Priya Sharma (synthetic)').waitFor();
    await act(() => p.getByRole('button', { name: 'Cash', exact: true }).click());
    await p.getByText('Paid in full.').waitFor();
    await act(() => p.getByRole('button', { name: 'Complete sale' }).click());
    await p.getByRole('heading', { name: /^Sale complete: invoice T\d{2}-\d{2}\/0003$/ }).waitFor();
    expect(interactions).toBeLessThanOrEqual(6);
    expect(interactions).toBe(5);
  }, 60_000);

  it('FR-POS-1 AC1: counter search over 10,000 variants (dev container, not the reference environment)', async () => {
    const big = await activeShop(h, 'p5-search');
    await sql`
      with p as (
        insert into lbg.products (business_id, model_name, is_serialized)
        select ${big.businessId}, 'Model ' || g || case when g % 7 = 0 then ' Galaxy' else ' Note' end, false
          from generate_series(1, 10000) g
        returning id, model_name)
      insert into lbg.product_variants (business_id, product_id, sku, selling_price_paise, barcode)
      select ${big.businessId}, p.id, 'SKU-' || row_number() over (), 10000, '890' || lpad((row_number() over ())::text, 10, '0')
        from p`.execute(h.admin);
    const queries = ['Galaxy', 'SKU-42', '8900000005000', 'Note', 'Model 99', 'xyz-none'];
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const q = queries[i % queries.length] ?? 'Note';
      const t0 = performance.now();
      const res = await get(h, `${big.base}/pos/search?q=${encodeURIComponent(q)}`, big.owner);
      times.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? 0;
    console.log(
      `pos search over 10,000 variants: p95 ${p95.toFixed(1)} ms, median ${(times[30] ?? 0).toFixed(1)} ms (dev container)`,
    );
    expect(p95).toBeLessThan(300);
  }, 120_000);

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(a11y.length).toBe(15); // 5 screens × 3 widths
  });
});
