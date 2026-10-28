// Phase 14 (D-073): every state and union territory, the shop's full address
// (setup and Shop details; printed on invoices) and the list exports of every
// section, with permissions, cost and buyer rules, the formula guard, an
// independent XLSX reader and audit. Synthetic data only.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gstinCheckChar, INDIAN_STATES } from '@lbgos/domain';
import { mockMarketplace } from '@lbgos/modules/integrations';
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { withTenant } from '@lbgos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUser, startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  post,
  put,
  resetFixture,
  setupShop,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const run = promisify(execFile);

let h: Harness;
let a: Shop;
let b: Shop;
let inventory: Session;
let billing: Session;
let accountant: Session;
let phone: string;
let exporterSession: Session;

const ADDRESS = {
  line1: 'Shop 5, Test Arcade',
  line2: 'Station Road',
  landmark: 'Near the bus stand',
  city: 'Hajipur',
  district: 'Vaishali',
  stateCode: '10',
  pincode: '844101',
};

/** The rows of the first sheet of an XLSX, read by Python's zipfile (an independent reader). */
async function xlsxRows(bytes: Buffer): Promise<string[][]> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'xlsx-')), 'list.xlsx');
  writeFileSync(file, bytes);
  const out = await run('python3', [
    '-I',
    '-c',
    [
      'import sys, zipfile, json, re, xml.etree.ElementTree as ET',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      "ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}",
      "root = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))",
      'rows = []',
      "for r in root.iter('{%s}row' % ns['m']):",
      "    rows.append([''.join(t.text or '' for t in c.iter('{%s}t' % ns['m'])) or (c.findtext('m:v', '', ns)) for c in r.iter('{%s}c' % ns['m'])])",
      'print(json.dumps(rows))',
    ].join('\n'),
    file,
  ]);
  return JSON.parse(out.stdout) as string[][];
}
const csvLines = (body: string) => body.replace(String.fromCharCode(0xfeff), '').trim().split('\r\n');
const exportOf = (list: string, who: Session = a.owner, format = 'csv', q = '') =>
  get(h, `${a.base}/exports/${list}?format=${format}${q}`, who);

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  mockMarketplace.reset();
  a = await activeShop(h, 'p14-a');
  b = await activeShop(h, 'p14-b');
  inventory = (await staff(h, a, 'p14-inventory@example.test', 'Inventory')).session;
  billing = (await staff(h, a, 'p14-billing@example.test', 'Billing')).session;
  accountant = (await staff(h, a, 'p14-accountant@example.test', 'Accountant')).session;
  phone = await variant(h, a, 'P14-PH', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${a.businessId}, ${phone}, 'OPENING', 4, 900000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 900000, barcode = '=HYPERLINK("x")' where id = ${phone}`.execute(
    h.admin,
  );
  await post(h, `${a.base}/suppliers`, { name: '+Sai Distributors (synthetic)', stateCode: '10' }, a.owner);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('14.1 every state and union territory', () => {
  it('AC1: 36 states and UTs; the web list matches; other codes are refused', async () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(INDIAN_STATES.map(([, n]) => n)).toEqual(
      expect.arrayContaining(['Bihar', 'Ladakh', 'Lakshadweep', 'Sikkim']),
    );
    // The web app's list (apps/web/src/api.ts) is the same, in the same order.
    const web = readFileSync(path.resolve(import.meta.dirname, '../../web/src/api.ts'), 'utf8');
    const block = web.slice(web.indexOf('export const STATES'), web.indexOf('];', web.indexOf('export const STATES')));
    const pairs = [...block.matchAll(/\['(\d{2})', '([^']+)'\]/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual(INDIAN_STATES.map(([c, n]) => [c, n]));
    const u = await newUser(h, 'p14-applicant@example.test', 'Shop-Fixture-2026');
    for (const code of ['97', '99', '25']) {
      const r = await post(
        h,
        '/api/applications',
        { legalName: 'Bad State Shop', category: 'MOBILE_ELECTRONICS', stateCode: code },
        u.cookies,
      );
      expect(r.statusCode).toBe(400);
    }
    const ok = await post(
      h,
      '/api/applications',
      { legalName: 'Bihar Shop (synthetic)', category: 'MOBILE_ELECTRONICS', stateCode: '10' },
      u.cookies,
    );
    expect(ok.statusCode).toBe(201);
    const badSupplier = await post(h, `${a.base}/suppliers`, { name: 'Nowhere', stateCode: '97' }, a.owner);
    expect(badSupplier.statusCode).toBe(400);
  });
});

describe('14.1 the shop’s address', () => {
  it('AC2: setup takes the full address; a bad PIN code is refused; it is composed for printing', async () => {
    const s = await setupShop(h, 'p14-setup', '07');
    const details = (address: object) =>
      put(
        h,
        `${s.base}/setup/details`,
        { displayName: 'P14 Setup Mobiles', timezone: 'Asia/Kolkata', fyStartMonth: 4, address },
        s.owner,
      );
    const bad = await details({ ...ADDRESS, pincode: '04410' });
    expect([bad.statusCode, errorCode(bad)]).toEqual([422, 'PINCODE_INVALID']);
    expect((await details({ ...ADDRESS, city: '' })).statusCode).toBe(400);
    // The state changes during setup (from Delhi to Bihar).
    expect((await details(ADDRESS)).statusCode).toBe(204);
    const shop = (await get(h, `${s.base}/shop-details`, s.owner)).json<{
      shop: { stateCode: string; stateEditable: boolean; address: object; printed: string };
    }>().shop;
    expect(shop).toMatchObject({
      stateCode: '10',
      stateEditable: true,
      address: {
        line1: 'Shop 5, Test Arcade',
        line2: 'Station Road',
        landmark: 'Near the bus stand',
        city: 'Hajipur',
        district: 'Vaishali',
        pincode: '844101',
      },
      printed: 'Shop 5, Test Arcade, Station Road, Near the bus stand, Hajipur, Dist. Vaishali, Bihar – 844101',
    });
    // A GSTIN of Bihar, then a state change that does not match it is refused.
    const g14 = '10AAPFU0939F1Z';
    const tax = await put(
      h,
      `${s.base}/setup/tax`,
      { registrationType: 'REGULAR', gstin: g14 + gstinCheckChar(g14), invoicePrefix: 'T' },
      s.owner,
    );
    expect(tax.statusCode).toBe(200);
    const mismatch = await put(h, `${s.base}/shop-details/address`, { ...ADDRESS, stateCode: '27' }, s.owner);
    expect([mismatch.statusCode, errorCode(mismatch)]).toEqual([422, 'STATE_GSTIN_MISMATCH']);
  });

  it('AC3: after going live the address can be edited but not the state; print settings keep it', async () => {
    const saved = await put(
      h,
      `${a.base}/shop-details/address`,
      { ...ADDRESS, stateCode: '27', city: 'Pune', district: 'Pune', pincode: '411001' },
      a.owner,
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ shop: { printed: string; stateEditable: boolean } }>().shop).toMatchObject({
      stateEditable: false,
      // The district is left out when it is the city.
      printed: 'Shop 5, Test Arcade, Station Road, Near the bus stand, Pune, Maharashtra – 411001',
    });
    const locked = await put(h, `${a.base}/shop-details/address`, ADDRESS, a.owner);
    expect([locked.statusCode, errorCode(locked)]).toEqual([422, 'STATE_LOCKED']);
    // The database refuses it too.
    await expect(
      withTenant(h.appDb, { businessId: a.businessId, userId: a.ownerId }, (trx) =>
        sql`update lbg.businesses set state_code = '10' where id = ${a.businessId}`.execute(trx),
      ),
    ).rejects.toThrow(/only during setup/);
    expect((await put(h, `${a.base}/shop-details/address`, ADDRESS, billing)).statusCode).toBe(403);
    expect((await get(h, `${a.base}/shop-details`, b.owner)).statusCode).toBe(404);
    // Saving print settings without an address keeps it, and the next invoice prints it.
    expect(
      (await put(h, `${a.base}/print-settings`, { printSize: 'A4', phone: '+919800000000' }, a.owner)).statusCode,
    ).toBe(200);
    const ctx = { businessId: a.businessId, userId: a.ownerId };
    const access = { discount: { limits: undefined }, priceOverride: true };
    const draft = await createSaleDraft(h.appDb, ctx, access, { lines: [{ variantId: phone, quantity: '1' }] });
    await issueSale(h.appDb, ctx, access, draft.id, {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
    });
    const html = (await get(h, `${a.base}/invoices/${draft.id}/print?size=A4`, a.owner)).body;
    expect(html).toContain('Shop 5, Test Arcade, Station Road, Near the bus stand, Pune, Maharashtra – 411001');
  });
});

describe('14.2 exports in every section', () => {
  const lists = [
    'products',
    'stock',
    'imeis',
    'suppliers',
    'purchases',
    'invoices',
    'payments',
    'expenses',
    'online-orders',
  ];

  it('AC1: every list downloads as CSV and as a valid XLSX, tenant-scoped, with nosniff', async () => {
    for (const list of lists) {
      const csv = await exportOf(list);
      expect([list, csv.statusCode]).toEqual([list, 200]);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['x-content-type-options']).toBe('nosniff');
      expect(csv.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="${list}\\.csv"`));
      const xlsx = await exportOf(list, a.owner, 'xlsx');
      expect(xlsx.statusCode).toBe(200);
      const rows = await xlsxRows(xlsx.rawPayload);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.flat().join(' ')).not.toContain('p14-b');
    }
    const products = csvLines((await exportOf('products')).body);
    expect(products[0]).toContain('Product,Brand,Category');
    expect(products.join('\n')).toContain('P14-PH');
    const stock = csvLines((await exportOf('stock')).body);
    expect(stock.find((l) => l.includes('P14-PH'))).toMatch(/,3,0,0,0,/);
    const invoices = csvLines((await exportOf('invoices')).body);
    expect(invoices).toHaveLength(2);
    // Another business sees only its own rows.
    const other = csvLines((await get(h, `${b.base}/exports/products?format=csv`, b.owner)).body);
    expect(other.join('\n')).not.toContain('P14-PH');
    expect((await get(h, `${a.base}/exports/products?format=csv`, b.owner)).statusCode).toBe(404);
    expect((await exportOf('everything')).statusCode).toBe(400);
    expect((await exportOf('products', a.owner, 'pdf')).statusCode).toBe(400);
  });

  it('AC2: reports.export and the section permission are both needed; cost needs catalogue.cost.view', async () => {
    // Billing staff have no reports.export.
    expect((await exportOf('invoices', billing)).statusCode).toBe(403);
    // The accountant has reports.export, the stock view and cost view, but not suppliers.manage — suppliers.view is enough.
    const acc = await exportOf('stock', accountant);
    expect(acc.statusCode).toBe(200);
    expect(csvLines(acc.body)[0]).toContain('Value at cost');
    // Without catalogue.cost.view (a role with reports.export and catalogue.view only): no cost columns.
    const { rows } = await sql<{ id: string }>`
      insert into lbg.roles (business_id, name, is_system) values (${a.businessId}, 'Exporter (no cost)', false) returning id`.execute(
      h.admin,
    );
    const roleId = rows[0]?.id ?? '';
    for (const p of ['catalogue.view', 'inventory.view', 'reports.export', 'pos.sell']) {
      await sql`insert into lbg.role_permissions (business_id, role_id, permission_key) values (${a.businessId}, ${roleId}, ${p})`.execute(
        h.admin,
      );
    }
    const exporter = await staff(h, a, 'p14-exporter@example.test', 'Exporter (no cost)');
    exporterSession = exporter.session;
    const noCost = await exportOf('products', exporter.session);
    expect(noCost.statusCode).toBe(200);
    expect(csvLines(noCost.body)[0]).not.toMatch(/cost|Last purchase price/i);
    expect(csvLines((await exportOf('stock', exporter.session)).body)[0]).not.toContain('Value at cost');
    // No customers.view: invoices are refused; inventory staff have no reports.export at all.
    expect((await exportOf('invoices', exporter.session)).statusCode).toBe(403);
    expect((await exportOf('products', inventory)).statusCode).toBe(403);
  });

  it('AC2: online orders are masked without customers.view', async () => {
    const integ = await post(
      h,
      `${a.base}/integrations`,
      {
        category: 'MARKETPLACE',
        provider: 'mock',
        label: 'Amazon (mock)',
        authMethod: 'NONE',
        config: { store: 'p14' },
      },
      a.owner,
    );
    const integrationId = integ.json<{ integration: { id: string } }>().integration.id;
    await post(h, `${a.base}/integrations/${integrationId}/test`, {}, a.owner);
    const ch = await post(h, `${a.base}/channels`, { name: 'Amazon', integrationId }, a.owner);
    await put(
      h,
      `${a.base}/channels/${ch.json<{ channelId: string }>().channelId}/listings`,
      { variantId: phone },
      a.owner,
    );
    const sku =
      (await sql<{ sku: string }>`select sku from lbg.product_variants where id = ${phone}`.execute(h.admin)).rows[0]
        ?.sku ?? '';
    mockMarketplace.place('p14', {
      id: '402-1414141-1414141',
      status: 'NEW',
      placedAt: '2026-10-28T09:00:00Z',
      lines: [{ sku, quantity: 1, unitPricePaise: 1_199_900, title: 'Blaze Pro' }],
      buyer: { name: 'Ravi Kumar (synthetic)', phone: '9860022222', email: 'ravi@example.test' },
      shipTo: { line1: '7 Test Lane', city: 'Patna', state: 'Bihar', pincode: '800001' },
      totals: { totalPaise: 1_199_900, marketplaceFeesPaise: 90_000 },
    });
    await post(h, `${a.base}/channels/sync`, {}, a.owner);
    const full = (await exportOf('online-orders')).body;
    expect(full).toContain('Ravi Kumar (synthetic)');
    expect(full).toContain('ravi@example.test');
    expect(full).toContain('7 Test Lane');
    // The exporter (reports.export and pos.sell, no customers.view) gets the buyer masked, as on screen.
    const masked = await exportOf('online-orders', exporterSession);
    expect(masked.statusCode).toBe(200);
    expect(masked.body).not.toMatch(/Ravi Kumar|ravi@|7 Test Lane|9860022222/);
    expect(masked.body).toContain('R…');
    expect(masked.body).toContain('••••••2222');
    expect(masked.body).toContain('Patna');
  });

  it('AC3: the formula guard applies; every export is audited without contents', async () => {
    const products = (await exportOf('products')).body;
    expect(products).toContain(`"'=HYPERLINK(""x"")"`);
    const suppliers = (await exportOf('suppliers')).body;
    expect(suppliers).toContain("'+Sai Distributors (synthetic)");
    const audit = await sql<{ metadata: { report: string; format: string } }>`
      select metadata from lbg.audit_events where business_id = ${a.businessId} and action = 'report.export'
       order by created_at`.execute(h.admin);
    const seen = new Set(audit.rows.map((r) => `${r.metadata.report}.${r.metadata.format}`));
    for (const list of lists) {
      expect(seen.has(`list:${list}.csv`)).toBe(true);
      expect(seen.has(`list:${list}.xlsx`)).toBe(true);
    }
    expect(JSON.stringify(audit.rows)).not.toMatch(/Ravi|P14-PH|Sai Distributors/);
  });

  it('dated lists take a period: from and to together', async () => {
    const inRange = csvLines((await exportOf('invoices', a.owner, 'csv', '&from=2000-01-01&to=2099-12-31')).body);
    expect(inRange).toHaveLength(2);
    const none = csvLines((await exportOf('invoices', a.owner, 'csv', '&from=2000-01-01&to=2000-01-31')).body);
    expect(none).toHaveLength(1);
    expect((await exportOf('invoices', a.owner, 'csv', '&from=2000-01-01')).statusCode).toBe(400);
    expect((await exportOf('invoices', a.owner, 'csv', '&from=2001-01-01&to=2000-01-01')).statusCode).toBe(400);
  });
});
