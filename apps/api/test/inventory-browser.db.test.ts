// Phase 4 exit test in a real browser (Chromium via Playwright) against the
// real API, the built web app and a migrated throwaway DB. A synthetic shop:
// tax rate → phone model with a variant → supplier → purchase with IMEIs
// typed like a barcode scanner → post → a duplicate IMEI refused → a scanned
// supplier invoice reviewed and turned into a draft → posted → a staff
// adjustment request approved by the owner → lookup by IMEI → reconciliation
// clean. Every new screen is audited with axe at 1280/768/360 px, for
// horizontal overflow and for CSP violations. Synthetic data only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdf } from '../../../packages/domain/test/fixtures/files.ts';
import { get, startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, imei, post, resetFixture, SHOP_PW, staff, type Shop } from './shop-fixture.ts';

const PORT = 4318;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');

let h: Harness;
let browser: Browser;
let shop: Shop;
let owner: Page;
let cableId = '';
const problems: string[] = [];
const a11y: { page: string; width: number; violations: string[] }[] = [];
const IMEI_A = imei(501);
const IMEI_B = imei(502);
const IMEI_C = imei(503);

async function context(): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  ctx.on('page', (p) => {
    p.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
        problems.push(`CSP: ${m.text()}`);
    });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  });
  return ctx;
}

async function auditAllWidths(page: Page, label: string) {
  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 800 });
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
  await page.setViewportSize({ width: 1280, height: 800 });
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

const available = async (variantId: string) =>
  (await get(h, `${shop.base}/stock`, shop.owner))
    .json<{ stock: { variantId: string; available: string }[] }>()
    .stock.find((r) => r.variantId === variantId)?.available;

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'p4-exit');
  // A quantity-counted product with stock, for the adjustment step (set up through the API).
  cableId =
    (
      await post(
        h,
        `${shop.base}/products`,
        { modelName: 'USB-C cable', isSerialized: false, variants: [{ sku: 'CBL-1M', sellingPricePaise: 19_900 }] },
        shop.owner,
      )
    ).json<{ variantIds: string[] }>().variantIds[0] ?? '';
  const ctx = await context();
  owner = await ctx.newPage();
  await signIn(owner, shop.ownerEmail, shop.ownerSecret);
}, 120_000);

afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 4 exit: catalogue → purchase with IMEIs → scan review → approval → reconciliation', () => {
  it('the owner adds a tax rate, a phone model with a variant, and a supplier', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await owner.getByRole('link', { name: 'Catalogue' }).click();
    await owner.getByRole('link', { name: 'Tax rates' }).click();
    await owner.getByLabel('Name', { exact: true }).fill('GST 18 (test)');
    await owner.getByLabel('Rate (%)').fill('18');
    await owner.getByLabel('Effective from (YYYY-MM-DD)').fill('2025-04-01');
    await owner.getByRole('button', { name: 'Save tax rate' }).click();
    await owner.getByText('Tax rate saved.').waitFor();
    await owner.getByRole('cell', { name: 'GST 18 (test)' }).waitFor();
    await auditAllWidths(owner, 'tax rates');

    await owner.goto(`${ORIGIN}/b/${shop.businessId}/catalogue`);
    await owner.getByLabel('Model name').fill('Acme X1');
    await owner.getByLabel('Model number (optional)').fill('AX1-2026');
    expect(await owner.getByLabel('Track each unit by IMEI or serial number (phones)').isChecked()).toBe(true);
    await owner.getByLabel('SKU', { exact: true }).fill('AX1-8-128');
    await owner.getByLabel('Barcode (optional)').fill('8901234567890');
    await owner.getByLabel('RAM', { exact: true }).fill('8 GB');
    await owner.getByLabel('Storage', { exact: true }).fill('128 GB');
    await owner.getByLabel('Colour', { exact: true }).fill('Black');
    await owner.getByLabel('Selling price (₹)').fill('19999');
    await owner.getByLabel('Purchase price (₹, optional)').fill('15000');
    await owner.getByLabel('Tax rate').selectOption({ label: 'GST 18 (test) (18.00%)' });
    await owner.getByRole('button', { name: 'Add product' }).click();
    await owner.getByText('Acme X1 added.').waitFor();
    await owner.getByRole('link', { name: 'Acme X1' }).waitFor();
    await auditAllWidths(owner, 'catalogue');

    await owner.goto(`${ORIGIN}/b/${shop.businessId}/suppliers`);
    await owner.getByLabel('Supplier name').fill('Sai Distributors (synthetic)');
    await owner.getByLabel('GSTIN (optional)').fill('27AAPFU0939F1ZV');
    await owner.getByRole('button', { name: 'Add supplier' }).click();
    await owner.getByText('Sai Distributors (synthetic) added.').waitFor();
    await auditAllWidths(owner, 'suppliers');
  }, 120_000);

  it('a purchase with IMEIs typed like a barcode scanner is checked, posted and appears in stock', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}/purchases/new`);
    await owner.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Sai Distributors (synthetic)' });
    await owner.getByLabel('Supplier invoice number').fill('SD/0001');
    await owner.getByLabel('Invoice date (YYYY-MM-DD)').fill('2026-10-20');
    const product = owner.getByLabel('Line 1 product');
    const phoneOption = await product.locator('option', { hasText: 'AX1-8-128' }).getAttribute('value');
    await product.selectOption(phoneOption ?? '');
    await owner.getByLabel('Line 1 quantity').fill('2');
    await owner.getByLabel('Line 1 unit cost before tax (₹)').fill('15000');
    await owner.getByLabel('Line 1 tax rate').selectOption({ label: 'GST 18 (test) (18.00%)' });
    // A keyboard-wedge scanner types the digits and presses Enter after each scan.
    const imeis = owner.getByLabel('Line 1 IMEIs');
    await imeis.pressSequentially(IMEI_A);
    await imeis.press('Enter');
    await imeis.pressSequentially(IMEI_B);
    await owner.getByRole('button', { name: 'Save draft' }).click();
    await owner.getByText('No problems found.').waitFor();
    await owner.getByRole('cell', { name: '₹35,400.00' }).waitFor(); // 2 × ₹15,000 + 18 %
    await auditAllWidths(owner, 'purchase editor');
    await owner.getByRole('button', { name: 'Post purchase' }).click();
    await owner.getByText('Posted. The stock has been added.').waitFor();
    await owner.getByText('Status: posted').waitFor();
  }, 120_000);

  it('a second purchase with an IMEI already in stock shows a blocking check and cannot be posted', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}/purchases/new`);
    await owner.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Sai Distributors (synthetic)' });
    await owner.getByLabel('Supplier invoice number').fill('SD/0002');
    await owner.getByLabel('Invoice date (YYYY-MM-DD)').fill('2026-10-21');
    const product = owner.getByLabel('Line 1 product');
    await product.selectOption((await product.locator('option', { hasText: 'AX1-8-128' }).getAttribute('value')) ?? '');
    await owner.getByLabel('Line 1 unit cost before tax (₹)').fill('15000');
    await owner.getByLabel('Line 1 IMEIs').fill(IMEI_A);
    await owner.getByRole('button', { name: 'Save draft' }).click();
    await owner.getByText('A unit with this IMEI already exists in this business.').waitFor();
    await owner.getByRole('button', { name: 'Post purchase' }).click();
    await owner.getByRole('alert').getByText('This purchase cannot be posted yet.').waitFor();
    await owner.getByRole('button', { name: 'Discard draft' }).click();
    await owner.getByText('Draft discarded.').waitFor();
  }, 60_000);

  it('a scanned supplier invoice is reviewed field by field and becomes a draft that the owner posts', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}/scans`);
    await owner.getByLabel('What are you scanning?').selectOption('SUPPLIER_INVOICE');
    await owner.getByLabel('Photo or PDF').setInputFiles({
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: pdf(1, [
        'Sai Distributors (synthetic)',
        'GSTIN: 27AAPFU0939F1ZV',
        'Invoice No: SD/0003',
        'Date: 22/10/2026',
        'Acme X1 8/128 Black 1 15,000.00 15,000.00',
        `IMEI ${IMEI_C}`,
        'Grand Total 17,700.00',
      ]),
    });
    await owner.getByRole('button', { name: 'Upload' }).click();
    await owner.getByText('Uploaded. Reading the document…').waitFor();
    await auditAllWidths(owner, 'scans');
    // The server's job loop is not running in the harness; process the queue as it would.
    expect((await h.runOcr()).map((r) => r.status)).toEqual(['NEEDS_REVIEW']);
    await owner.getByRole('cell', { name: 'needs review' }).waitFor();
    await owner.getByRole('link', { name: 'Supplier invoice' }).click();
    await owner.getByRole('heading', { name: 'What was read' }).waitFor();
    await owner.getByRole('cell', { name: 'SD/0003' }).first().waitFor();
    const create = owner.getByRole('button', { name: 'Create draft purchase' });
    expect(await create.isDisabled()).toBe(true);
    await auditAllWidths(owner, 'scan review');
    for (const box of await owner.getByRole('checkbox', { name: /^Confirm / }).all()) await box.check();
    await owner.getByLabel('Line 1 tax rate').selectOption({ label: 'GST 18 (test) (18.00%)' });
    expect(await owner.getByLabel('Line 1 IMEIs').inputValue()).toBe(IMEI_C);
    await create.click();
    await owner.getByText('Status: draft').waitFor();
    await owner.getByText('No problems found.').waitFor();
    await owner.getByRole('button', { name: 'Post purchase' }).click();
    await owner.getByText('Posted. The stock has been added.').waitFor();
  }, 120_000);

  it('a staff adjustment request changes nothing until the owner approves it', async () => {
    const supplierId = (await get(h, `${shop.base}/suppliers`, shop.owner)).json<{ suppliers: { id: string }[] }>()
      .suppliers[0]?.id;
    const d = await post(
      h,
      `${shop.base}/purchases`,
      {
        supplierId,
        supplierInvoiceNo: 'CBL-1',
        supplierInvoiceDate: '2026-10-20',
        lines: [{ variantId: cableId, quantity: '5', unitCostPaise: 5000 }],
      },
      shop.owner,
    );
    await post(h, `${shop.base}/purchases/${d.json<{ id: string }>().id}/post`, {}, shop.owner);
    const inventory = await staff(h, shop, 'p4-inventory@example.test', 'Inventory');
    expect(inventory.id).toMatch(/^[0-9a-f-]{36}$/);
    const ctx = await context();
    const page = await ctx.newPage();
    await signIn(page, 'p4-inventory@example.test');
    await page.goto(`${ORIGIN}/b/${shop.businessId}/stock`);
    await page.getByLabel('Product to adjust').selectOption(cableId);
    await page.getByLabel('Change in quantity (e.g. -2 or 3)').fill('-1');
    await page.getByLabel('Reason (at least 10 characters)').fill('One cable found cut in the box.');
    await page.getByRole('button', { name: 'Request adjustment' }).click();
    await page.getByText('Sent for approval. The stock changes once it is approved.').waitFor();
    await auditAllWidths(page, 'stock');
    expect(await available(cableId)).toBe('5.000');
    await ctx.close();

    await owner.goto(`${ORIGIN}/b/${shop.businessId}/approvals`);
    await owner.getByRole('heading', { name: /Change a stock count: USB-C cable/ }).waitFor();
    await auditAllWidths(owner, 'approvals');
    await owner.getByRole('button', { name: 'Approve' }).click();
    await owner.getByText('Approved and carried out.').waitFor();
    expect(await available(cableId)).toBe('4.000');
  }, 120_000);

  it('the stock page finds a unit by IMEI from the scanner field, and the ledger reconciles', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}/stock`);
    await owner.getByText('Stock levels match the stock ledger.').waitFor();
    const field = owner.getByLabel('Find by code');
    await field.pressSequentially(IMEI_B);
    await field.press('Enter');
    await owner
      .getByRole('status')
      .getByText(/AX1-8-128 \(matched by imei\), unit in stock/)
      .waitFor();
    // Camera scanning is offered only where the browser can detect barcodes; otherwise
    // the manual field is all there is, without errors (FR-INV-9 AC2).
    const detector: unknown = await owner.evaluate('typeof globalThis.BarcodeDetector === "function"');
    const hasDetector = detector === true;
    expect(await owner.getByRole('button', { name: 'Scan with camera' }).count()).toBe(hasDetector ? 1 : 0);
    const phones = (await get(h, `${shop.base}/stock`, shop.owner))
      .json<{ stock: { sku: string; available: string }[] }>()
      .stock.find((r) => r.sku === 'AX1-8-128');
    expect(phones?.available).toBe('3.000');
  }, 60_000);

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(a11y.length).toBe(24); // 8 screens × 3 widths
  });
});
