// Increment 6.6: erase a customer's personal data and the owner's full data
// export (FR-PRV-1 AC2, FR-PRV-2, D-052). Synthetic data only.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMessage, MessagingError } from '@lbgos/modules/messaging';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  patch,
  post,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const run = promisify(execFile);

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let manager: Session;
let meera: string;
let invoiceId: string;
let approvedId: string;

const MOBILE = '9860000001';
const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });
const erase = (id: string, who: Session = shop.owner, reason = 'Customer asked in writing on 28 Oct') =>
  post(h, `${shop.base}/customers/${id}/erase`, { reason }, who);
const staleSession = (userId: string) =>
  sql`update auth."session" set "createdAt" = now() - interval '1 hour' where "userId" = ${userId}`.execute(h.admin);
const freshSession = (userId: string) =>
  sql`update auth."session" set "createdAt" = now() where "userId" = ${userId}`.execute(h.admin);

/** Files of a ZIP, read by Python's zipfile (an independent reader). */
async function unzip(bytes: Buffer): Promise<Record<string, string>> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'export-')), 'data.zip');
  writeFileSync(file, bytes);
  const out = await run('python3', [
    '-I',
    '-c',
    'import sys, zipfile, json\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))',
    file,
  ]);
  return JSON.parse(out.stdout) as Record<string, string>;
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'prv-a');
  other = await activeShop(h, 'prv-b');
  billing = (await staff(h, shop, 'prv-billing@example.test', 'Billing')).session;
  manager = (await staff(h, shop, 'prv-manager@example.test', 'Manager')).session;
  const cable = await variant(h, shop, 'PRV-CB', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 10, 10000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 10000 where id = ${cable}`.execute(h.admin);
  const c = await post(
    h,
    `${shop.base}/customers`,
    {
      name: 'Meera Synthetic',
      mobile: MOBILE,
      email: 'meera.synthetic@example.test',
      dob: '1991-03-03',
      address: '12 Test Lane, Pune',
      notes: 'Prefers calls after 6 pm.',
      tags: ['VIP'],
      contactChannels: ['WHATSAPP'],
    },
    billing,
  );
  meera = c.json<{ customer: { id: string } }>().customer.id;
  await post(
    h,
    `${shop.base}/customers/${meera}/consents`,
    { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Signed the offers form' },
    billing,
  );
  // A sale (its invoice keeps what was printed).
  const d = await post(
    h,
    `${shop.base}/sales`,
    { customerId: meera, lines: [{ variantId: cable, quantity: '1' }] },
    billing,
  );
  const sale = d.json<{ sale: { id: string; totals: { totalPaise: number } } }>().sale;
  const issued = await post(
    h,
    `${shop.base}/sales/${sale.id}/issue`,
    { expectedTotalPaise: sale.totals.totalPaise, payments: [{ method: 'CASH', amountPaise: sale.totals.totalPaise }] },
    billing,
  );
  if (issued.statusCode !== 201) throw new Error(issued.body);
  invoiceId = sale.id;
  // A past message (failed: no provider) and an approved one still pending.
  await post(
    h,
    `${shop.base}/messages`,
    {
      customerId: meera,
      channel: 'SMS',
      purpose: 'TRANSACTIONAL',
      body: 'Thanks Meera, receipt attached.',
      send: true,
    },
    billing,
  );
  const m = await post(
    h,
    `${shop.base}/messages`,
    { customerId: meera, channel: 'WHATSAPP', purpose: 'MARKETING', body: 'Meera, new covers are in.' },
    manager,
  );
  approvedId = m.json<{ message: { id: string } }>().message.id;
  await post(h, `${shop.base}/messages/${approvedId}/submit`, {}, manager);
  await post(h, `${shop.base}/messages/${approvedId}/approve`, {}, shop.owner);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('erase personal data (FR-PRV-1 AC2)', () => {
  it('only the owner, with a reason and a recent sign-in', async () => {
    expect([(await erase(meera, manager)).statusCode, errorCode(await erase(meera, manager))]).toEqual([
      403,
      'OWNER_ONLY',
    ]);
    expect((await erase(meera, billing)).statusCode).toBe(403);
    expect((await erase(meera, shop.owner, 'too short')).statusCode).toBe(400);
    await staleSession(shop.ownerId);
    const stale = await erase(meera);
    expect([stale.statusCode, errorCode(stale)]).toEqual([403, 'REAUTH_REQUIRED']);
    await freshSession(shop.ownerId);
    expect((await erase(meera, other.owner)).statusCode).toBe(404);
  });

  it('anonymises the profile, withdraws consent, suppresses, cancels pending and redacts past messages', async () => {
    const res = await erase(meera);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ erasure: object }>().erasure).toMatchObject({
      customerId: meera,
      cancelledMessages: 1,
      redactedMessages: 2,
      consentsWithdrawn: 6,
    });
    const c = (await get(h, `${shop.base}/customers/${meera}`, billing)).json<{ customer: object }>().customer;
    expect(c).toMatchObject({
      name: 'Erased customer',
      mobileE164: null,
      alternateMobileE164: null,
      email: null,
      address: null,
      dob: null,
      notes: null,
      tags: [],
      contactChannels: [],
      erased: true,
    });
    expect((await get(h, `${shop.base}/customers?q=Meera`, billing)).json<{ customers: object[] }>().customers).toEqual(
      [],
    );
    const consents = (await get(h, `${shop.base}/customers/${meera}/consents`, billing)).json<{
      consents: {
        channels: { marketingAllowed: boolean; transactionalAllowed: boolean }[];
        history: { status: string }[];
      };
    }>().consents;
    expect(consents.channels.every((x) => !x.marketingAllowed && !x.transactionalAllowed)).toBe(true);
    expect(consents.history.filter((x) => x.status === 'WITHDRAWN')).toHaveLength(6);
    const sup = (await get(h, `${shop.base}/suppressions`, billing)).json<{
      suppressions: { channel: string; address: string; reason: string }[];
    }>().suppressions;
    expect(
      sup
        .filter((x) => x.reason === 'ERASED')
        .map((x) => x.channel)
        .sort(),
    ).toEqual(['EMAIL', 'SMS', 'WHATSAPP']);
    const messages = (await get(h, `${shop.base}/messages?customerId=${meera}`, billing)).json<{
      messages: {
        id: string;
        status: string;
        statusReason: string | null;
        body: string;
        toAddress: string;
        events: { status: string }[];
      }[];
    }>().messages;
    expect(messages.map((m) => [m.status, m.body, m.toAddress])).toEqual([
      ['CANCELLED', '[erased]', '[erased]'],
      ['FAILED', '[erased]', '[erased]'],
    ]);
    expect(messages[0]?.statusReason).toBe('CUSTOMER_ERASED');
    // The status history stays.
    expect(messages[0]?.events.map((e) => e.status)).toEqual(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED']);
    // Nothing can be sent to the erased customer any more.
    await expect(
      createMessage(h.appDb, ctx(), { customerId: meera, channel: 'SMS', purpose: 'TRANSACTIONAL', body: 'Hi' }),
    ).rejects.toBeInstanceOf(MessagingError);
  });

  it('the issued invoice still prints the details that were on it', async () => {
    const page = await get(h, `${shop.base}/invoices/${invoiceId}/print`, shop.owner);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Meera Synthetic');
  });

  it('is audited without personal data; the reason is kept with the request; no second erasure or edit', async () => {
    const audit = await sql<{ metadata: object }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'customer.erase'`.execute(h.admin);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toMatch(/Meera|9860000001|asked in writing/i);
    const req = await sql<{
      reason: string;
    }>`select reason from lbg.privacy_requests where customer_id = ${meera}`.execute(h.admin);
    expect(req.rows.map((r) => r.reason)).toEqual(['Customer asked in writing on 28 Oct']);
    expect(errorCode(await erase(meera))).toBe('ALREADY_ERASED');
    expect((await patch(h, `${shop.base}/customers/${meera}`, { name: 'Meera again' }, shop.owner)).statusCode).toBe(
      404,
    );
    await expect(
      sql`update lbg.messages set redacted_at = null, body = 'restored' where id = ${approvedId}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB003' });
    // The number is free for a new customer record, and stays suppressed (the opt-out is honoured).
    const again = await post(h, `${shop.base}/customers`, { name: 'New Person (synthetic)', mobile: MOBILE }, billing);
    expect(again.statusCode).toBe(201);
    const id = again.json<{ customer: { id: string } }>().customer.id;
    const state = (await get(h, `${shop.base}/customers/${id}/consents`, billing)).json<{
      consents: { channels: { suppressed: boolean }[] };
    }>().consents;
    expect(state.channels[0]?.suppressed).toBe(true);
  });
});

describe('tenant data export (FR-PRV-2)', () => {
  it('owner only, recent sign-in; a ZIP with every business table as CSV; audited', async () => {
    expect(errorCode(await get(h, `${shop.base}/export/business-data`, manager))).toBe('OWNER_ONLY');
    expect((await get(h, `${shop.base}/export/business-data`, other.owner)).statusCode).toBe(404);
    const res = await get(h, `${shop.base}/export/business-data`, shop.owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="business-data.zip"');
    const files = await unzip(res.rawPayload);
    expect(Object.keys(files)).toEqual([
      'README.txt',
      'categories.csv',
      'brands.csv',
      'tax_rates.csv',
      'products.csv',
      'product_variants.csv',
      'suppliers.csv',
      'purchases.csv',
      'purchase_lines.csv',
      'serialized_units.csv',
      'serialized_unit_imeis.csv',
      'stock_movements.csv',
      'stock_levels.csv',
      'customers.csv',
      'customer_consents.csv',
      'invoices.csv',
      'invoice_lines.csv',
      'payments.csv',
      'payment_allocations.csv',
      'payment_refunds.csv',
      'customer_ledger_entries.csv',
      'expenses.csv',
      'messages.csv',
    ]);
    const lines = (name: string) => (files[name] ?? '').slice(1).trim().split('\r\n');
    expect(lines('customers.csv')[0]).toMatch(/^id,name,mobile_e164,email,dob/);
    expect(lines('customers.csv')).toHaveLength(1 + 2);
    expect(files['customers.csv']).toContain('Erased customer');
    expect(files['customers.csv']).not.toContain('meera.synthetic@example.test');
    expect(files['invoices.csv']).toContain('Meera Synthetic'); // the party snapshot of the issued invoice
    expect(lines('invoice_lines.csv')).toHaveLength(1 + 1);
    expect(
      lines('messages.csv')
        .slice(1)
        .every((l) => l.includes('[erased]')),
    ).toBe(true);
    expect(files['README.txt']).toContain('customers.csv: 2 rows');
    expect(Object.values(files).join('')).not.toContain(other.businessId);
    const audit = await sql<{
      metadata: { files: number; rows: Record<string, number> };
    }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'business.export'`.execute(h.admin);
    expect(audit.rows[0]?.metadata).toMatchObject({ files: 22, rows: { 'customers.csv': 2, 'invoices.csv': 1 } });
  });

  it('works in read-only mode but needs a recent sign-in; another business gets only its own rows', async () => {
    const theirs = await unzip((await get(h, `${other.base}/export/business-data`, other.owner)).rawPayload);
    expect((theirs['customers.csv'] ?? '').slice(1).trim().split('\r\n')).toHaveLength(1);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/export/business-data`, shop.owner)).statusCode).toBe(200);
    expect(errorCode(await erase(meera))).toBe('TENANT_READ_ONLY');
    await staleSession(shop.ownerId);
    expect(errorCode(await get(h, `${shop.base}/export/business-data`, shop.owner))).toBe('REAUTH_REQUIRED');
  });
});
