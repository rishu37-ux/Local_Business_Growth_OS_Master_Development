// Increment 5.6: printed documents and PDFs (FR-PRN-1 AC1–3, FR-TAX-4,
// ADR-12, D-044). PDFs are rendered by real headless Chromium and their text
// is extracted with pdftotext (poppler-utils). Synthetic data only.
import { execFile } from 'node:child_process';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  patch,
  post,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const SIZES = ['A4', 'A5', '80MM', '58MM'] as const;

let h: Harness;
let shop: Shop;
let unreg: Shop;
let other: Shop;
let billing: Session;
let inventory: Session;
let invoiceId: string;
let phoneImei: string;

async function pdfText(pdf: Buffer): Promise<string> {
  const child = execFile('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-']);
  const out = new Promise<string>((resolve, reject) => {
    let text = '';
    child.stdout?.on('data', (c: Buffer) => (text += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(text);
      else reject(new Error(`pdftotext exit ${String(code)}`));
    });
  });
  child.stdin?.end(pdf);
  return out;
}

/** Visible text of a print page (no styles, no toolbar), as words. */
function htmlWords(html: string): string[] {
  const body = html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<nav class="toolbar"[\s\S]*?<\/nav>/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return body.split(/\s+/).filter(Boolean);
}

const printUrl = (s: Shop, id: string, size?: string) => `${s.base}/invoices/${id}/print${size ? `?size=${size}` : ''}`;
const pdfUrl = (s: Shop, id: string, size: string) => `${s.base}/invoices/${id}/pdf?size=${size}`;

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'prn-a', { gstin: '27AAPFU0939F1ZV' });
  unreg = await activeShop(h, 'prn-u');
  other = await activeShop(h, 'prn-b');
  billing = (await staff(h, shop, 'prn-billing@example.test', 'Billing')).session;
  inventory = (await staff(h, shop, 'prn-inventory@example.test', 'Inventory')).session;
  const settings = await put(
    h,
    `${shop.base}/print-settings`,
    {
      printSize: '80MM',
      address: '12 MG Road, Pune 411001 (synthetic)',
      phone: '9800011122',
      email: 'shop@example.test',
      terms: 'Goods once sold are exchanged only with the bill within 7 days.',
    },
    shop.owner,
  );
  if (settings.statusCode !== 200) throw new Error(`settings: ${settings.statusCode} ${settings.body}`);
  const taxRateId = (
    await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
      shop.owner,
    )
  ).json<{ id: string }>().id;
  const phone = await variant(h, shop, 'PRN-PH', { serialized: true, taxRateId });
  const cable = await variant(h, shop, 'PRN-CB', { serialized: false, taxRateId });
  await patch(h, `${shop.base}/variants/${phone}`, { sellingPricePaise: 1_500_000, hsnCode: '8517' }, shop.owner);
  await patch(h, `${shop.base}/variants/${cable}`, { sellingPricePaise: 50_000, hsnCode: '8544' }, shop.owner);
  phoneImei = imei(8101);
  const unit = (
    await sql<{ id: string }>`insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
      values (${shop.businessId}, ${phone}, 'IN_STOCK', 1000000) returning id`.execute(h.admin)
  ).rows[0]?.id;
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
            values (${shop.businessId}, ${phoneImei}, ${unit}, 1)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${phone}, ${unit}, 'OPENING', 1, 1000000)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 20, 20000)`.execute(h.admin);
  // A Karnataka B2B customer with a name that would be markup if not escaped.
  const customer = (
    await post(
      h,
      `${shop.base}/customers`,
      { name: 'Bengaluru <b>Traders</b> & Co (synthetic)', mobile: '9123400009', gstin: '29AAGCB7383J1Z4' },
      shop.owner,
    )
  ).json<{ customer: { id: string } }>().customer.id;
  const draft = (
    await post(
      h,
      `${shop.base}/sales`,
      { customerId: customer, lines: [{ unitId: unit }, { variantId: cable, quantity: '2' }] },
      billing,
    )
  ).json<{ sale: { id: string; totals: { totalPaise: number } } }>().sale;
  const issued = await post(
    h,
    `${shop.base}/sales/${draft.id}/issue`,
    { expectedTotalPaise: 1_600_000, payments: [{ method: 'UPI', amountPaise: 1_000_000, reference: 'UPI-PRN-77' }] },
    billing,
  );
  if (issued.statusCode !== 201) throw new Error(`issue: ${issued.statusCode} ${issued.body}`);
  invoiceId = draft.id;
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('print settings (FR-PRN-1 AC1)', () => {
  it('owner sets the default size and printed details; Billing cannot', async () => {
    const got = (await get(h, `${shop.base}/print-settings`, shop.owner)).json<{
      settings: { printSize: string; phone: string };
    }>().settings;
    expect(got).toMatchObject({ printSize: '80MM', phone: '+919800011122' });
    expect((await put(h, `${shop.base}/print-settings`, { printSize: 'A4' }, billing)).statusCode).toBe(403);
    expect(errorCode(await put(h, `${shop.base}/print-settings`, { printSize: 'A4', phone: '12' }, shop.owner))).toBe(
      'PHONE_INVALID',
    );
  });
});

describe('printed invoice (FR-PRN-1 AC1–2, FR-TAX-4)', () => {
  it('every size shows the required fields from the issued snapshot', async () => {
    for (const size of SIZES) {
      const res = await get(h, printUrl(shop, invoiceId, size), billing);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
      const html = res.body;
      expect(html).not.toMatch(/<script/i);
      for (const text of [
        'Tax Invoice',
        'prn-a Mobiles',
        '12 MG Road, Pune 411001 (synthetic)',
        '+919800011122',
        'GSTIN: <span class="bold">27AAPFU0939F1ZV</span>',
        '29AAGCB7383J1Z4',
        'Karnataka (29)',
        '8517',
        '8544',
        `IMEI ${phoneImei}`,
        '₹16,000.00',
        'Rupees Sixteen Thousand Only',
        'UPI',
        'UPI-PRN-77',
        '₹6,000.00', // balance due
        'Goods once sold are exchanged only with the bill within 7 days.',
      ]) {
        expect(html, `${size}: ${text}`).toContain(text);
      }
      // Inter-state: IGST, never CGST/SGST.
      expect(html).toContain('IGST');
      expect(html).not.toMatch(/>CGST</);
      // The customer name is shown as text, never as markup.
      expect(html).toContain('Bengaluru &lt;b&gt;Traders&lt;/b&gt; &amp; Co (synthetic)');
      expect(html).not.toContain('<b>Traders</b>');
      // FR-TAX-4: no e-invoice, IRN/QR or digital-signature statements.
      expect(html).not.toMatch(/digital signature|digitally signed|e-invoice|\bIRN\b|QR code|e-way/i);
    }
  });

  it('uses the default size from the settings; a reprint keeps the details as issued', async () => {
    const res = await get(h, printUrl(shop, invoiceId), billing);
    expect(res.body).toContain('size: 80mm auto');
    await put(h, `${shop.base}/print-settings`, { printSize: 'A4', address: 'New address after issue' }, shop.owner);
    const again = await get(h, printUrl(shop, invoiceId, 'A4'), billing);
    expect(again.body).toContain('12 MG Road, Pune 411001 (synthetic)');
    expect(again.body).not.toContain('New address after issue');
    expect((await get(h, printUrl(shop, invoiceId), billing)).body).toContain('size: A4');
  });

  it('a Bill of Supply has no tax columns; credit notes and cancelled invoices say what they are', async () => {
    const item = await variant(h, unreg, 'PRN-UN', { serialized: false });
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta)
              values (${unreg.businessId}, ${item}, 'OPENING', 5)`.execute(h.admin);
    const d = (await post(h, `${unreg.base}/sales`, { lines: [{ variantId: item }] }, unreg.owner)).json<{
      sale: { id: string };
    }>().sale;
    await post(
      h,
      `${unreg.base}/sales/${d.id}/issue`,
      { expectedTotalPaise: 100_000, payments: [{ method: 'CASH', amountPaise: 100_000 }] },
      unreg.owner,
    );
    const bos = (await get(h, printUrl(unreg, d.id, 'A4'), unreg.owner)).body;
    expect(bos).toContain('Bill of Supply');
    expect(bos).not.toContain('Tax summary');
    expect(bos).not.toMatch(/>GST</);

    const note = await post(
      h,
      `${unreg.base}/invoices/${d.id}/credit-notes`,
      { reason: 'Item returned unused.', lines: [{ lineNo: 1 }], settlement: 'REFUND', refundMethod: 'CASH' },
      unreg.owner,
    );
    const noteId = note.json<{ creditNote: { noteId: string } }>().creditNote.noteId;
    const cn = (await get(h, printUrl(unreg, noteId, '80MM'), unreg.owner)).body;
    expect(cn).toContain('Credit Note');
    expect(cn).toContain('Against invoice');

    const d2 = (await post(h, `${unreg.base}/sales`, { lines: [{ variantId: item }] }, unreg.owner)).json<{
      sale: { id: string };
    }>().sale;
    await post(
      h,
      `${unreg.base}/sales/${d2.id}/issue`,
      { expectedTotalPaise: 100_000, payments: [{ method: 'CASH', amountPaise: 100_000 }] },
      unreg.owner,
    );
    await post(
      h,
      `${unreg.base}/invoices/${d2.id}/cancel`,
      { reason: 'Billed by mistake today.', goods: 'NOT_TAKEN', settlement: 'REFUND', refundMethod: 'CASH' },
      unreg.owner,
    );
    expect((await get(h, printUrl(unreg, d2.id, 'A5'), unreg.owner)).body).toContain('CANCELLED');
  });
});

describe('PDF (FR-PRN-1 AC3, ADR-12)', () => {
  it('each size is a PDF with the same text as the print page', async () => {
    for (const size of SIZES) {
      const res = await get(h, pdfUrl(shop, invoiceId, size), billing);
      expect(res.statusCode, size).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="T\d{2}-\d{2}-0001-/);
      const pdf = res.rawPayload;
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const text = (await pdfText(pdf)).replace(/\s+/g, ' ');
      const words = htmlWords((await get(h, printUrl(shop, invoiceId, size), billing)).body);
      // Headings are uppercased by CSS, so compare without case.
      const lower = text.toLowerCase();
      const missing = words.filter((w) => !lower.includes(w.toLowerCase()));
      expect(missing, `${size}: words of the print page missing from the PDF`).toEqual([]);
      expect(text).toContain(phoneImei);
      expect(text).toContain('Rupees Sixteen Thousand Only');
    }
  }, 60_000);
});

describe('access', () => {
  it('other businesses get 404; roles without customers.view get 403', async () => {
    expect((await get(h, printUrl(other, invoiceId, 'A4'), other.owner)).statusCode).toBe(404);
    expect((await get(h, printUrl(shop, invoiceId, 'A4'), other.owner)).statusCode).toBe(404);
    expect((await get(h, pdfUrl(other, invoiceId, 'A4'), other.owner)).statusCode).toBe(404);
    expect((await get(h, printUrl(shop, invoiceId, 'A4'), inventory)).statusCode).toBe(403);
    expect((await get(h, printUrl(shop, invoiceId, 'B4'), billing)).statusCode).toBe(400);
  });
});
