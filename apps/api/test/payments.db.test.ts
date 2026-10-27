// Increment 5.4: later payments, allocation, advances, refunds, reversals,
// statements (FR-LED-1, FR-LED-2, D-014, D-020, D-041). Synthetic data only.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  post,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop; // unregistered: Bill of Supply, no tax, so amounts are simple
let other: Shop;
let billing: Session;
let manager: Session;
let inventory: Session;
let item: string; // ₹1,000 each

interface Account {
  balancePaise: number;
  receivablePaise: number;
  advancePaise: number;
  openInvoices: { id: string; outstandingPaise: number; totalPaise: number; status: string }[];
  payments: { id: string; amountPaise: number; reversed: boolean; reversesPaymentId: string | null }[];
}

async function newCustomer(name: string, mobile: string): Promise<string> {
  const res = await post(h, `${shop.base}/customers`, { name, mobile }, shop.owner);
  if (res.statusCode !== 201) throw new Error(`customer failed: ${res.statusCode} ${res.body}`);
  return res.json<{ customer: { id: string } }>().customer.id;
}

/** Issues a sale of `qty` items to `customerId`, paying `paidPaise` in cash at the counter. */
async function sell(customerId: string, qty: number, paidPaise: number): Promise<string> {
  const d = await post(
    h,
    `${shop.base}/sales`,
    { customerId, lines: [{ variantId: item, quantity: String(qty) }] },
    billing,
  );
  if (d.statusCode !== 201) throw new Error(`draft failed: ${d.statusCode} ${d.body}`);
  const id = d.json<{ sale: { id: string } }>().sale.id;
  const res = await post(
    h,
    `${shop.base}/sales/${id}/issue`,
    {
      expectedTotalPaise: qty * 100_000,
      payments: paidPaise > 0 ? [{ method: 'CASH', amountPaise: paidPaise }] : [],
    },
    billing,
  );
  if (res.statusCode !== 201) throw new Error(`issue failed: ${res.statusCode} ${res.body}`);
  return id;
}

async function account(customerId: string, session: Session = billing): Promise<Account> {
  const res = await get(h, `${shop.base}/customers/${customerId}/account`, session);
  if (res.statusCode !== 200) throw new Error(`account failed: ${res.statusCode} ${res.body}`);
  return res.json<{ account: Account }>().account;
}

const pay = (customerId: string, body: object, session: Session = billing) =>
  post(h, `${shop.base}/customers/${customerId}/payments`, body, session);

const outstanding = (a: Account, invoiceId: string) =>
  a.openInvoices.find((i) => i.id === invoiceId)?.outstandingPaise ?? 0;

/** FR-LED-1 AC2 and D-014: the ledger balance equals receivables minus advance. */
function expectConsistent(a: Account) {
  expect(a.balancePaise).toBe(a.receivablePaise - a.advancePaise);
}

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'pay-a');
  other = await activeShop(h, 'pay-b');
  billing = (await staff(h, shop, 'pay-billing@example.test', 'Billing')).session;
  manager = (await staff(h, shop, 'pay-manager@example.test', 'Manager')).session;
  inventory = (await staff(h, shop, 'pay-inventory@example.test', 'Inventory')).session;
  item = await variant(h, shop, 'PAY-IT', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${item}, 'OPENING', 500, 50000)`.execute(h.admin);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('later payments (FR-LED-2 AC1, D-014)', () => {
  it('oldest invoice first by default; a remainder stays as advance; status follows the allocations', async () => {
    const c = await newCustomer('Kiran Desai (synthetic)', '9800000101');
    const a = await sell(c, 1, 0); // ₹1,000 due
    const b = await sell(c, 2, 0); // ₹2,000 due
    const res = await pay(c, { method: 'UPI', amountPaise: 150_000, reference: 'UPI-REF-1' });
    expect(res.statusCode).toBe(201);
    expect(
      res.json<{ payment: { allocations: { invoiceId: string; amountPaise: number }[]; advancePaise: number } }>()
        .payment,
    ).toEqual(
      expect.objectContaining({
        allocations: [
          { invoiceId: a, amountPaise: 100_000 },
          { invoiceId: b, amountPaise: 50_000 },
        ],
        advancePaise: 0,
      }),
    );
    let acc = await account(c);
    expect(acc.openInvoices.map((i) => [i.id, i.outstandingPaise, i.status])).toEqual([[b, 150_000, 'PARTIALLY_PAID']]);
    expectConsistent(acc);
    const invoices = (await get(h, `${shop.base}/invoices?customerId=${c}`, billing)).json<{
      invoices: { id: string; paymentStatus: string }[];
    }>().invoices;
    expect(Object.fromEntries(invoices.map((i) => [i.id, i.paymentStatus]))).toEqual({
      [a]: 'PAID',
      [b]: 'PARTIALLY_PAID',
    });

    // Overpaying the rest: ₹1,500 settles B, ₹500 is advance; cash tendered gives change.
    const over = await pay(c, { method: 'CASH', amountPaise: 200_000, tenderedPaise: 250_000 });
    expect(over.json<{ payment: { advancePaise: number; changePaise: number } }>().payment).toMatchObject({
      advancePaise: 50_000,
      changePaise: 50_000,
    });
    acc = await account(c);
    expect(acc).toMatchObject({ balancePaise: -50_000, receivablePaise: 0, advancePaise: 50_000 });
    expectConsistent(acc);
  });

  it('a payment for chosen invoices pays only those, in the order given', async () => {
    const c = await newCustomer('Neha Joshi (synthetic)', '9800000102');
    const older = await sell(c, 1, 0);
    const newer = await sell(c, 1, 0);
    const res = await pay(c, { method: 'BANK_TRANSFER', amountPaise: 60_000, invoiceIds: [newer] });
    expect(res.json<{ payment: { allocations: { invoiceId: string }[] } }>().payment.allocations).toEqual([
      { invoiceId: newer, amountPaise: 60_000 },
    ]);
    const acc = await account(c);
    expect([outstanding(acc, older), outstanding(acc, newer)]).toEqual([100_000, 40_000]);
    // An invoice of another customer, or one already paid, cannot be chosen.
    const someoneElse = await newCustomer('Other (synthetic)', '9800000103');
    const foreign = await sell(someoneElse, 1, 100_000);
    expect(errorCode(await pay(c, { method: 'CASH', amountPaise: 1000, invoiceIds: [foreign] }))).toBe(
      'UNKNOWN_INVOICE',
    );
    expect(errorCode(await pay(c, { method: 'CARD', amountPaise: 1000, reference: '4111-1111-1111-1111' }))).toBe(
      'PAYMENT_INVALID',
    );
  });

  it('advance held is applied to a later invoice (oldest first)', async () => {
    const c = await newCustomer('Farhan Shaikh (synthetic)', '9800000104');
    await pay(c, { method: 'CASH', amountPaise: 70_000 }); // advance before any invoice
    expect((await account(c)).advancePaise).toBe(70_000);
    const inv = await sell(c, 1, 0);
    const res = await post(h, `${shop.base}/customers/${c}/apply-advance`, {}, billing);
    expect(res.json<{ allocations: { invoiceId: string; amountPaise: number }[] }>().allocations).toEqual([
      expect.objectContaining({ invoiceId: inv, amountPaise: 70_000 }),
    ]);
    const acc = await account(c);
    expect(acc).toMatchObject({ advancePaise: 0, receivablePaise: 30_000, balancePaise: 30_000 });
  });
});

describe('refunds and reversals (FR-LED-2 AC1, D-041)', () => {
  it('advance is refunded only by refunds.approve holders and only up to the advance held', async () => {
    const c = await newCustomer('Pooja Nair (synthetic)', '9800000105');
    await pay(c, { method: 'CASH', amountPaise: 30_000 });
    await pay(c, { method: 'UPI', amountPaise: 20_000, reference: 'UPI-REF-2' });
    const body = { amountPaise: 40_000, method: 'CASH', reason: 'Customer no longer needs the order.' };
    expect((await post(h, `${shop.base}/customers/${c}/refunds`, body, billing)).statusCode).toBe(403);
    const tooMuch = await post(h, `${shop.base}/customers/${c}/refunds`, { ...body, amountPaise: 50_001 }, manager);
    expect(errorCode(tooMuch)).toBe('INSUFFICIENT_ADVANCE');
    const res = await post(h, `${shop.base}/customers/${c}/refunds`, body, manager);
    expect(res.statusCode).toBe(201);
    const acc = await account(c);
    expect(acc).toMatchObject({ advancePaise: 10_000, balancePaise: -10_000 });
    const entries = await sql<{ entry_type: string; amount_paise: string }>`
      select entry_type, amount_paise from lbg.customer_ledger_entries where customer_id = ${c} and entry_type = 'REFUND'
       order by amount_paise`.execute(h.admin);
    // Oldest payment first: ₹300 from the cash payment, ₹100 from the UPI one.
    expect(entries.rows.map((e) => Number(e.amount_paise))).toEqual([10_000, 30_000]);
  });

  it('a reversal undoes the payment, its allocations and its ledger entry; once only', async () => {
    const c = await newCustomer('Rahul Verma (synthetic)', '9800000106');
    const inv = await sell(c, 2, 0);
    const p = (await pay(c, { method: 'UPI', amountPaise: 120_000, reference: 'UPI-WRONG' })).json<{
      payment: { paymentId: string };
    }>().payment.paymentId;
    expect(outstanding(await account(c), inv)).toBe(80_000);
    const url = `${shop.base}/payments/${p}/reverse`;
    const reason = { reason: 'Entered for the wrong customer.' };
    expect((await post(h, url, reason, billing)).statusCode).toBe(403);
    const res = await post(h, url, reason, manager);
    expect(res.statusCode).toBe(201);
    const reversalId = res.json<{ reversal: { reversalId: string; invoiceIds: string[] } }>().reversal;
    expect(reversalId.invoiceIds).toEqual([inv]);
    const acc = await account(c);
    expect(outstanding(acc, inv)).toBe(200_000);
    expect(acc).toMatchObject({ balancePaise: 200_000, advancePaise: 0 });
    expectConsistent(acc);
    expect(acc.payments.find((x) => x.id === p)?.reversed).toBe(true);
    expect(errorCode(await post(h, url, reason, manager))).toBe('ALREADY_REVERSED');
    expect(errorCode(await post(h, `${shop.base}/payments/${reversalId.reversalId}/reverse`, reason, manager))).toBe(
      'NOT_REVERSIBLE',
    );
    const ledger = await sql<{ entry_type: string; amount_paise: string; reverses_entry_id: string | null }>`
      select entry_type, amount_paise, reverses_entry_id from lbg.customer_ledger_entries
       where customer_id = ${c} and entry_type = 'REVERSAL'`.execute(h.admin);
    expect(ledger.rows.map((e) => [Number(e.amount_paise), e.reverses_entry_id !== null])).toEqual([[120_000, true]]);
  });

  it('a payment with refunds cannot be reversed; the DB refuses refunds above the advance', async () => {
    const c = await newCustomer('Sana Khan (synthetic)', '9800000107');
    const p = (await pay(c, { method: 'CASH', amountPaise: 50_000 })).json<{ payment: { paymentId: string } }>().payment
      .paymentId;
    await post(
      h,
      `${shop.base}/customers/${c}/refunds`,
      { amountPaise: 10_000, method: 'CASH', reason: 'Partial refund of advance.' },
      manager,
    );
    expect(
      errorCode(await post(h, `${shop.base}/payments/${p}/reverse`, { reason: 'Should not be allowed.' }, manager)),
    ).toBe('REFUNDED');
    // Backstops below the application: bounds and append-only.
    await expect(
      sql`insert into lbg.payment_refunds (business_id, payment_id, customer_id, amount_paise, method, reason)
          values (${shop.businessId}, ${p}, ${c}, 40001, 'CASH', 'Direct insert beyond the advance.')`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB019' });
    await expect(
      sql`update lbg.payment_refunds set amount_paise = 1 where payment_id = ${p}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB001' });
    await expect(
      sql`update lbg.customer_ledger_entries set amount_paise = 1 where customer_id = ${c}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB001' });
  });
});

describe('concurrency (FR-LED-2 AC2, D-020)', () => {
  it('parallel payments to one invoice never over-allocate; the rest becomes advance', async () => {
    const c = await newCustomer('Imran Ali (synthetic)', '9800000108');
    const inv = await sell(c, 2, 0); // ₹2,000 due
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        pay(c, { method: 'UPI', amountPaise: 60_000, reference: `UPI-PAR-${String(i)}` }, i % 2 ? billing : manager),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const alloc = await sql<{ total: string }>`select sum(amount_paise) as total from lbg.payment_allocations
                                                 where invoice_id = ${inv}`.execute(h.admin);
    expect(Number(alloc.rows[0]?.total)).toBe(200_000);
    const acc = await account(c);
    expect(acc).toMatchObject({ receivablePaise: 0, advancePaise: 100_000, balancePaise: -100_000 });
  });
});

describe('statement (FR-LED-1 AC3)', () => {
  it('opening balance, entries and closing balance for business dates (IST midnight boundaries)', async () => {
    const c = await newCustomer('Tanvi Kulkarni (synthetic)', '9800000109');
    const entry = (type: string, amount: number, at: string) =>
      sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise, created_at)
          values (${shop.businessId}, ${c}, ${type}, ${amount}, ${at}::timestamptz)`.execute(h.admin);
    await entry('INVOICE', 500_000, '2026-03-10T06:00:00Z');
    await entry('PAYMENT', -200_000, '2026-03-31T18:00:00Z'); // 31 March 23:30 IST
    await entry('PAYMENT', -100_000, '2026-03-31T18:45:00Z'); // 1 April 00:15 IST
    await entry('INVOICE', 50_000, '2026-04-30T18:29:00Z'); // 30 April 23:59 IST
    await entry('INVOICE', 70_000, '2026-04-30T18:31:00Z'); // 1 May 00:01 IST
    const res = await get(h, `${shop.base}/customers/${c}/statement?from=2026-04-01&to=2026-04-30`, billing);
    const st = res.json<{
      statement: {
        openingPaise: number;
        closingPaise: number;
        entries: { date: string; amountPaise: number; balancePaise: number }[];
      };
    }>().statement;
    expect(st.openingPaise).toBe(300_000);
    expect(st.entries.map((e) => [e.date, e.amountPaise, e.balancePaise])).toEqual([
      ['2026-04-01', -100_000, 200_000],
      ['2026-04-30', 50_000, 250_000],
    ]);
    expect(st.closingPaise).toBe(250_000);
    expect(
      errorCode(await get(h, `${shop.base}/customers/${c}/statement?from=2026-04-30&to=2026-04-01`, billing)),
    ).toBe('INVALID_PERIOD');
  });
});

describe('access', () => {
  it('permissions, tenancy and read-only mode', async () => {
    const c = await newCustomer('Access Test (synthetic)', '9800000110');
    expect((await get(h, `${shop.base}/customers/${c}/account`, inventory)).statusCode).toBe(403);
    expect((await pay(c, { method: 'CASH', amountPaise: 100 }, inventory)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/customers/${c}/account`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/customers/${c}/account`, other.owner)).statusCode).toBe(404);
    expect(
      (await post(h, `${other.base}/customers/${c}/payments`, { method: 'CASH', amountPaise: 100 }, other.owner))
        .statusCode,
    ).toBe(404);
    const p = (await pay(c, { method: 'CASH', amountPaise: 100 })).json<{ payment: { paymentId: string } }>().payment
      .paymentId;
    expect(
      (await post(h, `${other.base}/payments/${p}/reverse`, { reason: 'Cross-tenant attempt here.' }, other.owner))
        .statusCode,
    ).toBe(404);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${other.businessId}`.execute(h.admin);
    const oc = (
      await sql<{ id: string }>`insert into lbg.customers (business_id, name, mobile_e164)
                                 values (${other.businessId}, 'RO (synthetic)', '+919800000111') returning id`.execute(
        h.admin,
      )
    ).rows[0]?.id;
    expect((await get(h, `${other.base}/customers/${oc}/account`, other.owner)).statusCode).toBe(200);
    const ro = await post(
      h,
      `${other.base}/customers/${oc}/payments`,
      { method: 'CASH', amountPaise: 100 },
      other.owner,
    );
    expect([ro.statusCode, errorCode(ro)]).toEqual([403, 'TENANT_READ_ONLY']);
  });
});
