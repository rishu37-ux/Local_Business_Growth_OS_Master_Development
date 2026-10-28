// Increments 12.1–12.3 (D-071): the real OCR engine (Tesseract 5, run
// locally) reads generated photos of a product label and a supplier invoice;
// scan lookup finds phones by IMEI and products by barcode for selling and
// stock; a product-label scan pre-fills a product. Images are rendered by
// Chromium from synthetic text. Requires the `tesseract` program
// (apt install tesseract-ocr). Synthetic data only.
import { execFileSync } from 'node:child_process';
import { TESSERACT_ADAPTER_URL } from '@lbgos/modules/ocr';
import { chromium, type Browser } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, freshIp, startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  post,
  resetFixture,
  staff,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let browser: Browser;
let a: Shop;
let b: Shop;
let accountant: Session;
let phoneVariant: string;
const SOLD_IMEI = imei(9101);
const STOCK_IMEI = imei(9102);
const NEW_IMEI_1 = imei(9201);
const NEW_IMEI_2 = imei(9202);

/** A PNG photo of the given text lines, as a phone would take of a clean label. */
async function photo(lines: readonly string[]): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 900, height: 80 + lines.length * 44 } });
  await page.setContent(
    `<body style="margin:0;padding:24px;background:#fff;font-family:Arial,sans-serif;font-size:28px;line-height:1.5">${lines
      .map((l) => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`)
      .join('')}</body>`,
  );
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

const raw = (url: string, bytes: Buffer, who: Session) =>
  h.app.inject({
    method: 'POST',
    url,
    payload: bytes,
    remoteAddress: freshIp(),
    headers: { origin: h.origin, cookie: cookieHeader(who), 'content-type': 'application/octet-stream' },
  });

interface Field {
  key: string;
  value: string | null;
}
interface ScanView {
  status: string;
  provider: string | null;
  errorCode: string | null;
  extraction: {
    fields: Field[];
    imeis?: Field[];
    lines?: { quantity: Field; unitPricePaise: Field; imeis: Field[] }[];
  } | null;
  catalogueMatches: { variantId: string }[];
}

beforeAll(async () => {
  execFileSync('tesseract', ['--version']); // fails clearly when the engine is not installed
  h = await startHarness({ ocrAdapterUrl: TESSERACT_ADAPTER_URL });
  browser = await chromium.launch();
  resetFixture();
  a = await activeShop(h, 'cam-a');
  b = await activeShop(h, 'cam-b');
  accountant = (await staff(h, a, 'cam-a-acct@example.test', 'Accountant')).session;
  const phone = await post(
    h,
    `${a.base}/products`,
    {
      modelName: 'Nova 12',
      modelNumber: 'NV12-128',
      isSerialized: true,
      variants: [{ sku: 'NV12-8-128', barcode: '8901234567890', sellingPricePaise: 1_499_900 }],
    },
    a.owner,
  );
  phoneVariant = phone.json<{ variantIds: string[] }>().variantIds[0] ?? '';
  const supplierId = (await post(h, `${a.base}/suppliers`, { name: 'Camera Supplier (synthetic)' }, a.owner)).json<{
    id: string;
  }>().id;
  const draft = await post(
    h,
    `${a.base}/purchases`,
    {
      supplierId,
      supplierInvoiceNo: 'CAM-1',
      supplierInvoiceDate: '2026-10-20',
      lines: [
        {
          variantId: phoneVariant,
          quantity: '2',
          unitCostPaise: 1_200_000,
          taxRateId: null,
          units: [{ imei1: SOLD_IMEI }, { imei1: STOCK_IMEI }],
        },
      ],
    },
    a.owner,
  );
  await post(h, `${a.base}/purchases/${draft.json<{ id: string }>().id}/post`, {}, a.owner);
  await sql`update lbg.serialized_units set status = 'SOLD' where business_id = ${a.businessId}
             and id = (select unit_id from lbg.serialized_unit_imeis where imei = ${SOLD_IMEI})`.execute(h.admin);
}, 180_000);
afterAll(async () => {
  await browser.close();
  await h.close();
});

const value = (fields: Field[] | undefined, key: string) => fields?.find((f) => f.key === key)?.value ?? null;

describe('Tesseract reads photos (12.1)', () => {
  let labelScan = '';

  it('AC1/AC2: a product label photo is read by Tesseract and parsed', async () => {
    const png = await photo([
      'Brand: Lava',
      'Model: Blaze Pro',
      'Model No: LXB-501',
      '6GB RAM + 128GB',
      'Colour: Glass Blue',
      `IMEI1: ${NEW_IMEI_1}`,
      `IMEI2: ${NEW_IMEI_2}`,
    ]);
    const up = await raw(`${a.base}/scans?type=PRODUCT_LABEL&name=label.png`, png, a.owner);
    expect(up.statusCode).toBe(202);
    labelScan = up.json<{ jobId: string }>().jobId;
    const results = await h.runOcr();
    expect(results.find((r) => r.jobId === labelScan)).toMatchObject({ status: 'NEEDS_REVIEW', errorCode: null });
    const s = (await get(h, `${a.base}/scans/${labelScan}`, a.owner)).json<{ scan: ScanView }>().scan;
    expect(s.provider).toBe('tesseract');
    const f = s.extraction?.fields;
    expect({
      brand: value(f, 'brand'),
      modelName: value(f, 'modelName'),
      modelNumber: value(f, 'modelNumber'),
      ram: value(f, 'ram'),
      storage: value(f, 'storage'),
      colour: value(f, 'colour'),
    }).toEqual({
      brand: 'Lava',
      modelName: 'Blaze Pro',
      modelNumber: 'LXB-501',
      ram: '6 GB',
      storage: '128 GB',
      colour: 'Glass Blue',
    });
    expect(s.extraction?.imeis?.map((x) => x.value)).toEqual([NEW_IMEI_1, NEW_IMEI_2]);
  }, 90_000);

  it('12.3 AC1: the label pre-fills a product, which is saved through the normal product route', async () => {
    const res = await get(h, `${a.base}/scans/${labelScan}/product-draft`, a.owner);
    const d = res.json<{
      draft: {
        brandName: string;
        brandId: string | null;
        modelName: string;
        modelNumber: string;
        isSerialized: boolean;
        variant: { ram: string; storage: string; colour: string; sku: string };
        imeis: string[];
        existing: unknown[];
      };
    }>().draft;
    expect(d).toMatchObject({
      brandName: 'Lava',
      brandId: null,
      modelName: 'Blaze Pro',
      modelNumber: 'LXB-501',
      isSerialized: true,
      variant: { ram: '6 GB', storage: '128 GB', colour: 'Glass Blue', sku: 'LXB-501-6-128' },
      imeis: [NEW_IMEI_1, NEW_IMEI_2],
      existing: [],
    });
    const brand = await post(h, `${a.base}/brands`, { name: d.brandName }, a.owner);
    const brandId = brand.json<{ id: string }>().id;
    const created = await post(
      h,
      `${a.base}/products`,
      {
        brandId,
        modelName: d.modelName,
        modelNumber: d.modelNumber,
        isSerialized: d.isSerialized,
        variants: [
          {
            sku: d.variant.sku,
            ram: d.variant.ram,
            storage: d.variant.storage,
            colour: d.variant.colour,
            sellingPricePaise: 1_199_900,
          },
        ],
      },
      a.owner,
    );
    expect(created.statusCode).toBe(201);
    // The brand is now reused, and the scan proposes the new product for its purchase draft.
    expect(
      (await get(h, `${a.base}/scans/${labelScan}/product-draft`, a.owner)).json<{ draft: { brandId: string } }>().draft
        .brandId,
    ).toBe(brandId);
    const s = (await get(h, `${a.base}/scans/${labelScan}`, a.owner)).json<{ scan: ScanView }>().scan;
    expect(s.catalogueMatches[0]?.variantId).toBe(created.json<{ variantIds: string[] }>().variantIds[0]);
    // Another business cannot read the draft; the accountant (no ocr.scan) neither.
    expect((await get(h, `${b.base}/scans/${labelScan}/product-draft`, b.owner)).statusCode).toBe(404);
    expect((await get(h, `${a.base}/scans/${labelScan}/product-draft`, accountant)).statusCode).toBe(403);
  }, 60_000);

  it('AC2: a supplier invoice photo is read into lines with quantities, prices and IMEIs', async () => {
    const png = await photo([
      'Sai Distributors',
      'Invoice No: INV-7781',
      'Date: 15/10/2026',
      'Nova 12 8/128 2 12,000.00 24,000.00',
      `IMEI: ${imei(9301)}`,
      `IMEI: ${imei(9302)}`,
      'Total 24,000.00',
    ]);
    const up = await raw(`${a.base}/scans?type=SUPPLIER_INVOICE&name=bill.png`, png, a.owner);
    const id = up.json<{ jobId: string }>().jobId;
    await h.runOcr();
    const s = (await get(h, `${a.base}/scans/${id}`, a.owner)).json<{ scan: ScanView }>().scan;
    expect(s.status).toBe('NEEDS_REVIEW');
    expect(value(s.extraction?.fields, 'invoiceNo')).toBe('INV-7781');
    expect(value(s.extraction?.fields, 'invoiceDate')).toBe('2026-10-15');
    const line = s.extraction?.lines?.[0];
    expect([line?.quantity.value, line?.unitPricePaise.value]).toEqual(['2', '1200000']);
    expect(line?.imeis.map((x) => x.value)).toEqual([imei(9301), imei(9302)]);
  }, 90_000);

  it('AC3: a PDF is not read by Tesseract and goes to manual entry', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n(Invoice No: X-1) Tj\n%%EOF');
    const up = await raw(`${a.base}/scans?type=SUPPLIER_INVOICE&name=bill.pdf`, pdf, a.owner);
    const id = up.json<{ jobId: string }>().jobId;
    const results = await h.runOcr();
    expect(results.find((r) => r.jobId === id)?.errorCode).toBe('PDF_NEEDS_TEXT_ENGINE');
  }, 60_000);
});

describe('scan to find (12.2)', () => {
  interface Lookup {
    provider: string;
    imeis: { imei: string; unit: { status: string; variantId: string; unitId: string } | null }[];
    products: { variantId: string; available: string; sellingPricePaise: number }[];
    barcode: string | null;
  }
  const lookup = async (png: Buffer, shop: Shop = a, who: Session = shop.owner) =>
    raw(`${shop.base}/scan-lookup`, png, who);

  it('AC1: IMEIs are matched to their phones with status; nothing is stored', async () => {
    const uploads = async () =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from lbg.uploads where business_id = ${a.businessId}`.execute(h.admin)
      ).rows[0]?.n;
    const before = await uploads();
    const res = await lookup(await photo([`IMEI 1: ${STOCK_IMEI}`, `IMEI 2: ${SOLD_IMEI}`, `IMEI: ${imei(9999)}`]));
    expect(res.statusCode).toBe(200);
    const l = res.json<{ lookup: Lookup }>().lookup;
    expect(l.provider).toBe('tesseract');
    expect(l.imeis.map((x) => [x.imei, x.unit?.status ?? null])).toEqual([
      [STOCK_IMEI, 'IN_STOCK'],
      [SOLD_IMEI, 'SOLD'],
      [imei(9999), null],
    ]);
    expect(l.imeis[0]?.unit?.variantId).toBe(phoneVariant);
    expect(await uploads()).toBe(before);
  }, 60_000);

  it('AC1: a barcode is matched to the product with its stock and price', async () => {
    const l = (await lookup(await photo(['Nova 12', '8901234567890']))).json<{ lookup: Lookup }>().lookup;
    expect(l.barcode).toBe('8901234567890');
    // The setup marks one unit SOLD directly (no sale), so the stock level still counts both units.
    expect(l.products[0]).toMatchObject({ variantId: phoneVariant, available: '2.000', sellingPricePaise: 1_499_900 });
  }, 60_000);

  it('AC4: another business never matches; permissions; file checks', async () => {
    const other = (await lookup(await photo([`IMEI: ${STOCK_IMEI}`, '8901234567890']), b)).json<{ lookup: Lookup }>()
      .lookup;
    expect(other.imeis).toEqual([{ imei: STOCK_IMEI, unit: null }]);
    expect(other.products).toEqual([]);
    expect((await lookup(await photo(['x']), a, accountant)).statusCode).toBe(200); // accountant has inventory.view
    const billingLess = await staff(h, b, 'cam-b-billing@example.test', 'Billing');
    expect((await lookup(await photo(['x']), b, billingLess.session)).statusCode).toBe(200); // pos.sell
    const bad = await lookup(Buffer.from('not an image'));
    expect([bad.statusCode, errorCode(bad)]).toEqual([415, 'UNSUPPORTED_TYPE']);
    expect((await lookup(await photo(['x']), a, b.owner)).statusCode).toBe(404);
  }, 90_000);
});
