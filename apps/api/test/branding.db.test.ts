// Increment 11.1: shop branding (FR-ONB-2 AC1, D-069). The logo and brand
// colour are checked, stored privately, and printed on invoices from the
// issue-time snapshot. Synthetic data only.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, freshIp, startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let a: Shop;
let b: Shop;
let billing: Session;
let cable: string;

/** A real PNG of one colour (valid chunks and CRCs), so Chromium can draw it. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const upload = (shop: Shop, bytes: Buffer, who: Session = shop.owner) =>
  h.app.inject({
    method: 'POST',
    url: `${shop.base}/branding/logo`,
    remoteAddress: freshIp(),
    headers: { origin: h.origin, cookie: cookieHeader(who), 'content-type': 'application/octet-stream' },
    payload: bytes,
  });

async function issued(shop: Shop): Promise<string> {
  const ctx = { businessId: shop.businessId, userId: shop.ownerId };
  const access = { discount: { limits: undefined }, priceOverride: true };
  const draft = await createSaleDraft(h.appDb, ctx, access, { lines: [{ variantId: cable, quantity: '1' }] });
  await issueSale(h.appDb, ctx, access, draft.id, {
    expectedTotalPaise: draft.totals.totalPaise,
    payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
  });
  return draft.id;
}

/** Number of images in a PDF, counted by poppler's pdfimages (an independent reader). */
async function pdfImages(pdf: Buffer): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lbgos-pdf-'));
  const file = path.join(dir, 'doc.pdf');
  writeFileSync(file, pdf);
  return new Promise((resolve, reject) => {
    execFile('pdfimages', ['-list', file], (err, stdout) => {
      if (err) reject(new Error(`pdfimages failed: ${err.message}`));
      else resolve(stdout.trim().split('\n').slice(2).filter(Boolean).length);
    });
  });
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  a = await activeShop(h, 'brand-a');
  b = await activeShop(h, 'brand-b');
  billing = (await staff(h, a, 'brand-a-billing@example.test', 'Billing')).session;
  cable = await variant(h, a, 'BRAND-CB', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${a.businessId}, ${cable}, 'OPENING', 20, 20000)`.execute(h.admin);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('branding (11.1)', () => {
  let before: string;
  let after: string;
  const red = png(40, 20, [200, 30, 30]);

  it('AC1: only PNG or JPEG within 1 MB and 2000 px; SVG and other files are refused', async () => {
    before = await issued(a);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const bad = await upload(a, svg);
    expect([bad.statusCode, errorCode(bad)]).toEqual([422, 'LOGO_INVALID']);
    const huge = await upload(a, png(2001, 1, [0, 0, 0]));
    expect(errorCode(huge)).toBe('LOGO_INVALID');
    const pdf = await upload(a, Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF'));
    expect(errorCode(pdf)).toBe('LOGO_INVALID');
    const tooBig = await upload(a, Buffer.concat([png(10, 10, [0, 0, 0]), Buffer.alloc(1024 * 1024 + 2048)]));
    expect(tooBig.statusCode).toBe(413);
    expect((await upload(a, red, billing)).statusCode).toBe(403);
    const ok = await upload(a, red);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ branding: { hasLogo: boolean } }>().branding.hasLogo).toBe(true);
    const audit = await sql<{ n: number }>`select count(*)::int as n from lbg.audit_events
      where business_id = ${a.businessId} and action = 'branding.logo_set'`.execute(h.admin);
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('every member sees the branding and the logo; another business gets 404', async () => {
    const seen = await get(h, `${a.base}/branding`, billing);
    expect(seen.json<{ branding: { hasLogo: boolean } }>().branding.hasLogo).toBe(true);
    const logo = await get(h, `${a.base}/branding/logo`, billing);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(logo.rawPayload, red)).toBe(0);
    expect((await get(h, `${a.base}/branding`, b.owner)).statusCode).toBe(404);
    expect((await get(h, `${a.base}/branding/logo`, b.owner)).statusCode).toBe(404);
  });

  it('brand colour and shop address rules', async () => {
    const color = await put(h, `${a.base}/branding`, { brandColor: '#0A7A55' }, a.owner);
    expect(color.json<{ branding: { brandColor: string } }>().branding.brandColor).toBe('#0a7a55');
    expect((await put(h, `${a.base}/branding`, { brandColor: 'red' }, a.owner)).statusCode).toBe(400);
    expect((await put(h, `${a.base}/branding`, { brandColor: '#123456' }, billing)).statusCode).toBe(403);
    const noAddress = await put(h, `${a.base}/branding`, { storeEnabled: true }, a.owner);
    expect([noAddress.statusCode, errorCode(noAddress)]).toEqual([422, 'STORE_NEEDS_ADDRESS']);
    for (const slug of ['ab', '-brand', 'brand-', 'br--and', 'Brand A', 'admin', 'x'.repeat(41)]) {
      const r = await put(h, `${a.base}/branding`, { storeSlug: slug }, a.owner);
      expect({ slug, code: r.statusCode }).toEqual({ slug, code: slug.length > 40 ? 400 : 422 });
    }
    const set = await put(h, `${a.base}/branding`, { storeSlug: 'Brand-A-Mobiles', storeEnabled: true }, a.owner);
    expect(set.json<{ branding: { storeSlug: string; storePath: string } }>().branding).toMatchObject({
      storeSlug: 'brand-a-mobiles',
      storePath: '/s/brand-a-mobiles',
    });
    const taken = await put(h, `${b.base}/branding`, { storeSlug: 'brand-a-mobiles' }, b.owner);
    expect([taken.statusCode, errorCode(taken)]).toEqual([409, 'SLUG_TAKEN']);
  });

  it('AC2: invoices issued after the change print the logo and accent; earlier ones stay as issued', async () => {
    after = await issued(a);
    const html = (await get(h, `${a.base}/invoices/${after}/print?size=A4`, a.owner)).body;
    expect(html).toContain(`src="data:image/png;base64,${red.toString('base64')}"`);
    expect(html).toContain('border-bottom-color: #0a7a55');
    expect(html).toContain('class="brandbar"');
    const narrow = (await get(h, `${a.base}/invoices/${after}/print?size=80MM`, a.owner)).body;
    expect(narrow).toContain('class="logo"');
    const old = (await get(h, `${a.base}/invoices/${before}/print?size=A4`, a.owner)).body;
    expect(old).not.toContain('class="logo"');
    expect(old).not.toContain('#0a7a55');

    // A new logo does not change what was issued.
    const blue = png(30, 30, [20, 40, 200]);
    await upload(a, blue);
    const reprint = (await get(h, `${a.base}/invoices/${after}/print?size=A4`, a.owner)).body;
    expect(reprint).toContain(red.toString('base64'));
    expect(reprint).not.toContain(blue.toString('base64'));
    const latest = await issued(a);
    expect((await get(h, `${a.base}/invoices/${latest}/print?size=A4`, a.owner)).body).toContain(
      blue.toString('base64'),
    );
  });

  it('AC2: the PDF carries the logo image; one without a logo has none', async () => {
    const withLogo = await get(h, `${a.base}/invoices/${after}/pdf?size=A4`, a.owner);
    expect(withLogo.headers['content-type']).toBe('application/pdf');
    expect(await pdfImages(withLogo.rawPayload)).toBeGreaterThanOrEqual(1);
    const without = await get(h, `${a.base}/invoices/${before}/pdf?size=A4`, a.owner);
    expect(await pdfImages(without.rawPayload)).toBe(0);
  }, 60_000);

  it('removing the logo keeps issued invoices unchanged', async () => {
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `${a.base}/branding/logo`,
      remoteAddress: freshIp(),
      headers: { origin: h.origin, cookie: cookieHeader(a.owner) },
    });
    expect(removed.json<{ branding: { hasLogo: boolean } }>().branding.hasLogo).toBe(false);
    expect((await get(h, `${a.base}/branding/logo`, a.owner)).statusCode).toBe(404);
    expect((await get(h, `${a.base}/invoices/${after}/print?size=A4`, a.owner)).body).toContain('class="logo"');
  });
});
