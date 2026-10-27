// Increment 5.2: customers, document numbering, re-authentication for tax
// settings (FR-POS-4, FR-POS-5, FR-CRM-1/2, FR-TAX-2 AC2).
import { withTenant } from '@lbgos/db';
import { nextDocumentNumber } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookiesFrom,
  post as rawPost,
  SESSION_COOKIE,
  signIn,
  startHarness,
  totp,
  type Harness,
} from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  patch,
  post,
  put,
  resetFixture,
  SHOP_PW,
  staff,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let inventory: Session;

interface Customer {
  id: string;
  name: string;
  mobileE164: string;
  gstin: string | null;
  stateCode: string | null;
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'sal-a');
  other = await activeShop(h, 'sal-b');
  billing = (await staff(h, shop, 'sal-billing@example.test', 'Billing')).session;
  inventory = (await staff(h, shop, 'sal-inventory@example.test', 'Inventory')).session;
}, 120_000);
afterAll(async () => {
  await h.close();
});

describe('customers (FR-POS-5, FR-CRM-1, FR-CRM-2)', () => {
  let customerId = '';

  it('creates with name and mobile only; the mobile is normalised to E.164', async () => {
    const res = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Ravi Kumar (synthetic)', mobile: '98765 43210' },
      billing,
    );
    expect(res.statusCode).toBe(201);
    const c = res.json<{ customer: Customer }>().customer;
    expect(c).toMatchObject({ mobileE164: '+919876543210', gstin: null, stateCode: null });
    customerId = c.id;
  });

  it('the same mobile in another format is the same customer: lookup finds it, a second create is refused', async () => {
    const found = (await get(h, `${shop.base}/customers?mobile=${encodeURIComponent('098765-43210')}`, billing)).json<{
      customers: Customer[];
    }>().customers;
    expect(found.map((c) => c.id)).toEqual([customerId]);
    const dup = await post(h, `${shop.base}/customers`, { name: 'Someone else', mobile: '+91 98765 43210' }, billing);
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: { existingCustomerId: string } }>().error.existingCustomerId).toBe(customerId);
    // Another business may have its own customer with that mobile.
    expect(
      (await post(h, `${other.base}/customers`, { name: 'Other shop customer', mobile: '9876543210' }, other.owner))
        .statusCode,
    ).toBe(201);
  });

  it('searches by name or mobile digits', async () => {
    const byName = (await get(h, `${shop.base}/customers?q=ravi`, billing)).json<{ customers: Customer[] }>().customers;
    const byDigits = (await get(h, `${shop.base}/customers?q=43210`, billing)).json<{ customers: Customer[] }>()
      .customers;
    expect(byName.map((c) => c.id)).toEqual([customerId]);
    expect(byDigits.map((c) => c.id)).toEqual([customerId]);
  });

  it('B2B: a valid GSTIN sets the state; invalid GSTINs and mobiles are refused', async () => {
    const b2b = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Bengaluru Traders (synthetic)', mobile: '9123456780', gstin: '29aagcb7383j1z4' },
      shop.owner,
    );
    expect(b2b.json<{ customer: Customer }>().customer).toMatchObject({ gstin: '29AAGCB7383J1Z4', stateCode: '29' });
    const bad = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Bad', mobile: '9123456781', gstin: '29AAGCB7383J1Z5' },
      shop.owner,
    );
    expect(errorCode(bad)).toBe('GSTIN_INVALID');
    expect(errorCode(await post(h, `${shop.base}/customers`, { name: 'Bad', mobile: '1234567' }, shop.owner))).toBe(
      'MOBILE_INVALID',
    );
  });

  it('corrections are audited with field names only', async () => {
    const res = await patch(h, `${shop.base}/customers/${customerId}`, { address: '12 MG Road (synthetic)' }, billing);
    expect(res.statusCode).toBe(200);
    const { rows } = await sql<{ metadata: { fields: string[] } }>`
      select metadata from lbg.audit_events where target_id = ${customerId} and action = 'customer.update'`.execute(
      h.admin,
    );
    expect(rows[0]?.metadata).toEqual({ fields: ['address'] });
  });

  it('permissions and tenancy', async () => {
    expect((await get(h, `${shop.base}/customers`, inventory)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/customers/${customerId}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/customers/${customerId}`, other.owner)).statusCode).toBe(404);
    expect((await patch(h, `${other.base}/customers/${customerId}`, { name: 'x' }, other.owner)).statusCode).toBe(404);
  });
});

describe('document numbering (FR-POS-4, D-012, D-020)', () => {
  it('shows the prefix chosen at setup and an example number', async () => {
    const n = (await get(h, `${shop.base}/numbering`, shop.owner)).json<{
      prefix: string;
      numberFormat: string;
      example: string;
    }>();
    expect(n.prefix).toBe('T');
    expect(n.numberFormat).toBe('{PREFIX}{FY}/{SEQ:4}');
    expect(n.example).toMatch(/^T\d{2}-\d{2}\/0001$/);
  });

  it('refuses formats that could exceed 16 characters (AC3) and saves valid ones', async () => {
    const long = await put(
      h,
      `${shop.base}/numbering`,
      { prefix: 'EXMOB1', numberFormat: '{PREFIX}/{FYLONG}/{SEQ:6}' },
      shop.owner,
    );
    expect([long.statusCode, errorCode(long)]).toEqual([422, 'TOO_LONG']);
    const ok = await put(
      h,
      `${shop.base}/numbering`,
      { prefix: 'EX', numberFormat: '{PREFIX}/{FY}/{SEQ:5}' },
      shop.owner,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ example: string }>().example).toMatch(/^EX\/\d{2}-\d{2}\/00001$/);
    expect(
      (await put(h, `${shop.base}/numbering`, { prefix: 'EX', numberFormat: '{SEQ:4}' }, billing)).statusCode,
    ).toBe(403);
  });

  it('a new financial year starts a new series; 31 March and 1 April fall in different years (AC4)', async () => {
    const ctx = { businessId: shop.businessId, userId: shop.ownerId };
    // 31 March 2027 23:30 IST and 1 April 2027 00:30 IST.
    const march = await withTenant(h.appDb, ctx, (trx) =>
      nextDocumentNumber(trx, ctx, 'DEBIT_NOTE', new Date('2027-03-31T18:00:00Z')),
    );
    const april = await withTenant(h.appDb, ctx, (trx) =>
      nextDocumentNumber(trx, ctx, 'DEBIT_NOTE', new Date('2027-03-31T19:00:00Z')),
    );
    expect([march.financialYear, march.sequence]).toEqual(['2026-27', 1]);
    expect([april.financialYear, april.sequence]).toEqual(['2027-28', 1]);
    expect(april.number).toBe('EX/27-28/00001');
    expect(march.seriesId).not.toBe(april.seriesId);
  });

  it('concurrent issuers with rollbacks: consecutive numbers, no gaps or duplicates (AC1–2)', async () => {
    const ctx = { businessId: shop.businessId, userId: shop.ownerId };
    const at = new Date('2026-10-27T06:00:00Z');
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        withTenant(h.appDb, ctx, async (trx) => {
          const n = await nextDocumentNumber(trx, ctx, 'CREDIT_NOTE', at);
          if (i % 5 === 0) throw new Error('simulated failure after taking a number');
          return n;
        }),
      ),
    );
    const committed = results
      .flatMap((r) => (r.status === 'fulfilled' ? [r.value.sequence] : []))
      .sort((a, b) => a - b);
    expect(committed).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    const next = await withTenant(h.appDb, ctx, (trx) => nextDocumentNumber(trx, ctx, 'CREDIT_NOTE', at));
    expect(next.sequence).toBe(25);
  });
});

describe('re-authentication for tax settings (FR-TAX-2 AC2)', () => {
  it('a session older than 10 minutes must sign in again before changing tax settings', async () => {
    await sql`update auth."session" set "createdAt" = now() - interval '1 hour' where "userId" = ${shop.ownerId}`.execute(
      h.admin,
    );
    const body = { name: 'Stale rate', ratePercent: '5', effectiveFrom: '2025-04-01' };
    for (const res of [
      await post(h, `${shop.base}/tax-rates`, body, shop.owner),
      await put(h, `${shop.base}/numbering`, { prefix: 'EX', numberFormat: '{SEQ:4}' }, shop.owner),
      await put(h, `${shop.base}/setup/tax`, { registrationType: 'UNREGISTERED', invoicePrefix: 'T' }, shop.owner),
    ]) {
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'REAUTH_REQUIRED']);
    }
    // Other routes still work with the old session.
    expect((await get(h, `${shop.base}/customers`, shop.owner)).statusCode).toBe(200);
    // Signing in again (password + TOTP) gives a fresh session that may change them.
    const first = await signIn(h, shop.ownerEmail, SHOP_PW);
    const verify = await rawPost(
      h,
      '/api/auth/two-factor/verify-totp',
      { code: totp(shop.ownerSecret) },
      first.cookies,
    );
    expect(verify.statusCode).toBe(200);
    const fresh = { [SESSION_COOKIE]: cookiesFrom(verify)[SESSION_COOKIE] ?? '' };
    expect((await post(h, `${shop.base}/tax-rates`, body, fresh)).statusCode).toBe(201);
  });
});
