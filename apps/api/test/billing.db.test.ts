// Increment 10.2: platform billing invoices with manual payment (FR-SUB-1 AC3).
// Synthetic data only; no payment gateway is involved.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  fixtureAdmin,
  get,
  post,
  resetFixture,
  staff,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let a: Shop;
let b: Shop;
let admin: Session;

interface Invoice {
  id: string;
  number: string;
  amountPaise: number;
  status: string;
  taxStatus: string;
  paymentMethod: string | null;
  planCode: string;
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  a = await activeShop(h, 'bill-a');
  b = await activeShop(h, 'bill-b');
  admin = fixtureAdmin();
}, 180_000);
afterAll(async () => {
  await h.close();
});

const issue = (businessId: string, periodStart: string, periodEnd: string, who: Session = admin) =>
  post(h, '/api/platform/billing-invoices', { businessId, periodStart, periodEnd }, who);

describe('platform billing invoices (FR-SUB-1 AC3)', () => {
  let first: Invoice;

  it('AC1: issued at the plan price with a number per financial year; GST not computed', async () => {
    const price = await sql<{ p: string }>`select p.price_paise::text as p from lbg.subscriptions s
      join lbg.plans p on p.id = s.plan_id where s.business_id = ${a.businessId}`.execute(h.admin);
    const res = await issue(a.businessId, '2026-11-01', '2026-12-01');
    expect(res.statusCode).toBe(201);
    first = res.json<{ invoice: Invoice }>().invoice;
    expect(first).toMatchObject({
      status: 'ISSUED',
      taxStatus: 'NOT_COMPUTED',
      amountPaise: Number(price.rows[0]?.p),
      paymentMethod: null,
    });
    expect(first.number).toMatch(/^LBG\/2026-27\/\d+$/);
    const second = (await issue(b.businessId, '2026-11-01', '2026-12-01')).json<{ invoice: Invoice }>().invoice;
    expect(Number(second.number.split('/')[2])).toBe(Number(first.number.split('/')[2]) + 1);
    // A March period belongs to the previous financial year.
    const march = (await issue(b.businessId, '2027-03-01', '2027-04-01')).json<{ invoice: Invoice }>().invoice;
    expect(march.number).toMatch(/^LBG\/2026-27\//);
    const april = (await issue(b.businessId, '2027-04-01', '2027-05-01')).json<{ invoice: Invoice }>().invoice;
    expect(april.number).toBe('LBG/2027-28/1');
  });

  it('a period is billed once; an empty period is refused; only platform admins issue', async () => {
    const dup = await issue(a.businessId, '2026-11-15', '2026-12-15');
    expect([dup.statusCode, errorCode(dup)]).toEqual([409, 'PERIOD_BILLED']);
    expect((await issue(a.businessId, '2026-12-01', '2026-12-01')).statusCode).toBe(422);
    expect((await issue(a.businessId, '2027-01-01', '2027-02-01', a.owner)).statusCode).toBe(403);
    expect((await get(h, '/api/platform/billing-invoices', a.owner)).statusCode).toBe(403);
  });

  it('AC3: the owner sees only their business invoices; staff without subscription.manage do not', async () => {
    const mine = (await get(h, `${a.base}/billing-invoices`, a.owner)).json<{ invoices: Invoice[] }>().invoices;
    expect(mine.map((i) => i.number)).toEqual([first.number]);
    const theirs = (await get(h, `${b.base}/billing-invoices`, b.owner)).json<{ invoices: Invoice[] }>().invoices;
    expect(theirs.map((i) => i.id)).not.toContain(first.id);
    expect((await get(h, `${a.base}/billing-invoices`, b.owner)).statusCode).toBe(404);
    const acct = await staff(h, a, 'bill-a-acct@example.test', 'Accountant');
    expect((await get(h, `${a.base}/billing-invoices`, acct.session)).statusCode).toBe(403);
  });

  it('AC2: payment only as a manual record with a reference; once paid nothing changes', async () => {
    const paid = await post(
      h,
      `/api/platform/billing-invoices/${first.id}/payment`,
      { paidOn: '2026-11-03', reference: 'UPI-SYNTH-0001' },
      admin,
    );
    expect(paid.json<{ invoice: Invoice }>().invoice).toMatchObject({ status: 'PAID', paymentMethod: 'MANUAL' });
    const again = await post(
      h,
      `/api/platform/billing-invoices/${first.id}/payment`,
      { paidOn: '2026-11-04', reference: 'UPI-SYNTH-0002' },
      admin,
    );
    expect([again.statusCode, errorCode(again)]).toEqual([409, 'NOT_ISSUED']);
    const voided = await post(
      h,
      `/api/platform/billing-invoices/${first.id}/void`,
      { reason: 'Trying to void a paid one' },
      admin,
    );
    expect(voided.statusCode).toBe(409);
    // The database refuses changes to issued content and deletes, whatever the caller.
    await expect(
      sql`update lbg.billing_invoices set amount_paise = 1 where id = ${first.id}`.execute(h.admin),
    ).rejects.toThrow(/is PAID/);
    await expect(sql`delete from lbg.billing_invoices where id = ${first.id}`.execute(h.admin)).rejects.toThrow(
      /cannot be deleted/,
    );
    const audit = await sql<{ action: string; metadata: Record<string, unknown> }>`
      select action, metadata from lbg.audit_events where target_id = ${first.id} order by created_at`.execute(h.admin);
    expect(audit.rows.map((r) => r.action)).toEqual(['billing.invoice_issued', 'billing.payment_recorded']);
    expect(audit.rows[1]?.metadata).toMatchObject({ method: 'MANUAL' });
  });

  it('void needs a reason, frees the period, and keeps the number', async () => {
    const inv = (await issue(a.businessId, '2027-01-01', '2027-02-01')).json<{ invoice: Invoice }>().invoice;
    expect(
      (await post(h, `/api/platform/billing-invoices/${inv.id}/void`, { reason: 'short' }, admin)).statusCode,
    ).toBe(400);
    const v = await post(
      h,
      `/api/platform/billing-invoices/${inv.id}/void`,
      { reason: 'Issued for the wrong period' },
      admin,
    );
    expect(v.json<{ invoice: Invoice }>().invoice.status).toBe('VOID');
    const re = (await issue(a.businessId, '2027-01-01', '2027-02-01')).json<{ invoice: Invoice }>().invoice;
    expect(re.number).not.toBe(inv.number);
    const list = (await get(h, `/api/platform/billing-invoices?businessId=${a.businessId}`, admin)).json<{
      invoices: Invoice[];
    }>().invoices;
    expect(list.map((i) => i.status).sort()).toEqual(['ISSUED', 'PAID', 'VOID']);
  });

  it('a direct insert cannot start as paid', async () => {
    const sub = await sql<{ id: string }>`select id from lbg.subscriptions where business_id = ${a.businessId}`.execute(
      h.admin,
    );
    await sql`insert into lbg.billing_invoices (business_id, subscription_id, financial_year, sequence_number, number,
                plan_code, plan_name, period_start, period_end, amount_paise, issued_by, status, paid_on,
                payment_method, payment_reference, payment_recorded_by)
              values (${a.businessId}, ${sub.rows[0]?.id ?? ''}, '2030-31', 1, 'LBG/2030-31/1', 'X', 'X',
                      '2030-05-01', '2030-06-01', 1, ${a.ownerId}, 'PAID', '2030-05-01', 'MANUAL', 'forged', ${a.ownerId})`.execute(
      h.admin,
    );
    const row = await sql<{ status: string; paid_on: string | null }>`
      select status, paid_on from lbg.billing_invoices where number = 'LBG/2030-31/1'`.execute(h.admin);
    expect(row.rows[0]).toEqual({ status: 'ISSUED', paid_on: null });
  });
});
