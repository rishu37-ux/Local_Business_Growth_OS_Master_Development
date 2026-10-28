// Phase 12 exit (PHASE12_PLAN), in a real browser with the real OCR engine
// (Tesseract) and a fake camera:
// 1. A product is added from a photo of its box label.
// 2. A supplier bill photo becomes a purchase draft, which is posted (stock up).
// 3. In Point of sale the live camera (Chromium's fake camera shows a
//    generated IMEI label) reads the IMEI, adds that phone and the sale
//    completes.
// 4. Stock: a photo of the IMEI finds the phone as sold.
// axe runs at 1280/768/360 px. Images are generated from synthetic text.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { TESSERACT_ADAPTER_URL } from '@lbgos/modules/ocr';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, imei, post, resetFixture, SHOP_PW, type Shop } from './shop-fixture.ts';

const PORT = 4390;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const IMEI_A = imei(9401);
const IMEI_B = imei(9402);
const GSTIN = '27AAPFU0939F1ZV';

let h: Harness;
let browser: Browser;
let shop: Shop;
let owner: Page;
const dir = mkdtempSync(path.join(tmpdir(), 'lbgos-cam-'));
const a11y: { page: string; width: number; violations: string[] }[] = [];
const problems: string[] = [];

async function render(b: Browser, lines: readonly string[], type: 'png' | 'jpeg'): Promise<Buffer> {
  const page = await b.newPage({ viewport: { width: 960, height: 80 + lines.length * 46 } });
  await page.setContent(
    `<body style="margin:0;padding:24px;background:#fff;font-family:Arial,sans-serif;font-size:30px;line-height:1.5">${lines
      .map((l) => `<div>${l}</div>`)
      .join('')}</body>`,
  );
  const shot = await page.screenshot({ type, ...(type === 'jpeg' ? { quality: 95 } : {}) });
  await page.close();
  return shot;
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
const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name, exact: true }).click();
const unitStatus = async (value: string) =>
  (
    await sql<{
      status: string;
    }>`select u.status from lbg.serialized_unit_imeis i join lbg.serialized_units u on u.id = i.unit_id
      where i.business_id = ${shop.businessId} and i.imei = ${value}`.execute(h.admin)
  ).rows[0]?.status;

const files: Record<string, string> = {};

beforeAll(async () => {
  execFileSync('tesseract', ['--version']);
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  // The photos, and the frame the fake camera will show (an IMEI label), before the browser starts.
  const maker = await chromium.launch();
  const write = (name: string, bytes: Buffer) => {
    files[name] = path.join(dir, name);
    writeFileSync(files[name], bytes);
  };
  write(
    'label.png',
    await render(
      maker,
      [
        'Brand: Lava',
        'Model: Blaze Pro',
        'Model No: LXB-501',
        '6GB RAM + 128GB',
        'Colour: Glass Blue',
        `IMEI1: ${IMEI_A}`,
      ],
      'png',
    ),
  );
  write(
    'bill.png',
    await render(
      maker,
      [
        'Sai Distributors',
        `GSTIN: ${GSTIN}`,
        'Invoice No: SD-9001',
        'Date: 15/10/2026',
        'Blaze Pro 6/128 2 9,500.00 19,000.00',
        `IMEI: ${IMEI_A}`,
        `IMEI: ${IMEI_B}`,
        'Total 19,000.00',
      ],
      'png',
    ),
  );
  write('imei.png', await render(maker, ['Lava Blaze Pro', `IMEI 1: ${IMEI_A}`], 'png'));
  const frame = await render(maker, ['Lava Blaze Pro', `IMEI 1: ${IMEI_A}`], 'jpeg');
  write('camera.mjpeg', Buffer.concat([frame, frame, frame]));
  await maker.close();

  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT, ocrAdapterUrl: TESSERACT_ADAPTER_URL });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${files['camera.mjpeg'] ?? ''}`,
    ],
  });
  resetFixture();
  shop = await activeShop(h, 'p12');
  await post(h, `${shop.base}/suppliers`, { name: 'Sai Distributors (synthetic)', gstin: GSTIN }, shop.owner);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
  owner = await context.newPage();
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
}, 240_000);
afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 12 exit (browser, Tesseract, fake camera)', () => {
  it('1. a product is added from a photo of its box label', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(owner, 'Catalogue');
    await owner.getByRole('heading', { name: 'Add a product from a photo of its box' }).waitFor();
    await audit(owner, 'catalogue with camera');
    await owner.getByLabel('Or choose or take a photo of the box label').setInputFiles(files['label.png'] ?? '');
    await owner.waitForURL(/\/scans\/[0-9a-f-]{36}$/);
    await h.runOcr();
    await owner.getByRole('heading', { name: 'Add this product to the catalogue' }).waitFor({ timeout: 20_000 });
    expect(await owner.getByLabel('Brand', { exact: true }).inputValue()).toBe('Lava');
    expect(await owner.getByLabel('Model', { exact: true }).inputValue()).toBe('Blaze Pro');
    expect(await owner.getByLabel('RAM', { exact: true }).inputValue()).toBe('6 GB');
    expect(await owner.getByLabel('Storage', { exact: true }).inputValue()).toBe('128 GB');
    expect(await owner.getByLabel('Colour', { exact: true }).inputValue()).toBe('Glass Blue');
    await audit(owner, 'scan review with new product');
    await owner.getByLabel('Selling price (₹)').fill('11999');
    await owner.getByRole('button', { name: 'Save product' }).click();
    await owner.getByText('Blaze Pro added to the catalogue.').waitFor();
    const p = await sql<{ n: number }>`select count(*)::int as n from lbg.products
      where business_id = ${shop.businessId} and model_name = 'Blaze Pro' and model_number = 'LXB-501' and is_serialized`.execute(
      h.admin,
    );
    expect(p.rows[0]?.n).toBe(1);
  }, 120_000);

  it('2. a supplier bill photo becomes a purchase that is posted; stock goes up', async () => {
    await menu(owner, 'Scans');
    await owner.getByLabel('What are you scanning?').selectOption('SUPPLIER_INVOICE');
    await owner.getByLabel('Or choose or take a photo of the supplier bill').setInputFiles(files['bill.png'] ?? '');
    await owner.getByText('Uploaded. Reading the document…').waitFor();
    await h.runOcr();
    await owner.getByRole('cell', { name: 'needs review' }).first().waitFor({ timeout: 20_000 });
    await owner.getByRole('link', { name: 'Supplier invoice' }).first().click();
    await owner.getByRole('cell', { name: 'SD-9001' }).first().waitFor();
    for (const box of await owner.getByRole('checkbox', { name: /^Confirm / }).all()) await box.check();
    expect(await owner.getByLabel('Line 1 IMEIs').inputValue()).toBe(`${IMEI_A}\n${IMEI_B}`);
    await owner.getByRole('button', { name: 'Create draft purchase' }).click();
    await owner.getByText('Status: draft').waitFor();
    await owner.getByRole('button', { name: 'Post purchase' }).click();
    await owner.getByText('Posted. The stock has been added.').waitFor();
    expect(await unitStatus(IMEI_A)).toBe('IN_STOCK');
    expect(await unitStatus(IMEI_B)).toBe('IN_STOCK');
  }, 120_000);

  it('3. in Point of sale the live camera reads the IMEI, adds the phone, and the sale completes', async () => {
    await menu(owner, 'Point of sale');
    await owner.getByText('Add by photo (IMEI or barcode)').click();
    await audit(owner, 'pos with camera');
    await owner.getByRole('button', { name: 'Use camera for the IMEI or barcode' }).click();
    await owner.getByLabel('Camera preview for the IMEI or barcode').waitFor();
    // A function, not a string: the app's CSP forbids eval.
    await expect
      .poll(() => owner.locator('video').evaluate((v) => (v as unknown as { videoWidth: number }).videoWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await owner.getByRole('button', { name: 'Take photo of the IMEI or barcode' }).click();
    await owner.getByText(`Added Blaze Pro, IMEI ${IMEI_A}.`).waitFor({ timeout: 30_000 });
    await owner.getByRole('button', { name: 'Complete sale' }).click();
    await owner.getByRole('heading', { name: /^Sale complete: invoice / }).waitFor();
    expect(await unitStatus(IMEI_A)).toBe('SOLD');
  }, 120_000);

  it('4. stock: a photo of the IMEI finds the phone as sold', async () => {
    await menu(owner, 'Stock');
    await owner.getByText('Find by photo (IMEI or barcode)').click();
    await owner.getByLabel('Or choose or take a photo of the IMEI or barcode').setInputFiles(files['imei.png'] ?? '');
    await owner
      .getByText(new RegExp(`IMEI ${IMEI_A}: Blaze Pro \\(LXB-501-6-128\\), sold`))
      .waitFor({ timeout: 30_000 });
    await audit(owner, 'stock with photo lookup');
  }, 60_000);

  it('no accessibility, overflow, CSP or page errors', () => {
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(problems).toEqual([]);
    expect(a11y.length).toBe(12);
  });
});
