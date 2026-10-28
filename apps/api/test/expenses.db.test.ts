// Increment 6.4: expenses, the expenses report and the operating-profit
// estimate (FR-EXP-1, FR-RPT-1, D-050). Synthetic data only.
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { png } from '../../../packages/domain/test/fixtures/files.ts';
import { cookieHeader, freshIp, startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  post,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const ACCESS = { discount: { limits: undefined }, priceOverride: true };

let h: Harness;
let shop: Shop;
let other: Shop;
let manager: Session;
let accountant: Session;

interface Expense {
  id: string;
  date: string;
  category: string;
  amountPaise: number;
  method: string;
  uploadId: string | null;
  reversesExpenseId: string | null;
  reversedBy: string | null;
}
interface OperatingProfit {
  label: string;
  taxableValuePaise: number;
  cogsPaise: number;
  grossMarginPaise: number;
  expensesPaise: number;
  operatingProfitPaise: number;
  notes: string[];
  definitions: Record<string, { label: string }>;
}

const expense = (body: object, who: Session = shop.owner, s: Shop = shop) => post(h, `${s.base}/expenses`, body, who);
const rent = {
  date: '2026-10-05',
  category: 'RENT',
  amountPaise: 1_000_000,
  method: 'BANK_TRANSFER',
  reference: 'NEFT-OCT',
};
const attach = (bytes: Buffer, who: Session = shop.owner, s: Shop = shop) =>
  h.app.inject({
    method: 'POST',
    url: `${s.base}/expenses/attachments?name=receipt.png`,
    payload: bytes,
    remoteAddress: freshIp(),
    headers: { origin: h.origin, cookie: cookieHeader(who), 'content-type': 'application/octet-stream' },
  });
const profit = async (query = 'period=month&date=2026-10-15', who: Session = shop.owner) => {
  const res = await get(h, `${shop.base}/reports/operating-profit?${query}`, who);
  if (res.statusCode !== 200) throw new Error(`operating profit: ${String(res.statusCode)} ${res.body}`);
  return res.json<{ report: OperatingProfit }>().report;
};

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'exp-a');
  other = await activeShop(h, 'exp-b');
  manager = (await staff(h, shop, 'exp-manager@example.test', 'Manager')).session;
  accountant = (await staff(h, shop, 'exp-accountant@example.test', 'Accountant')).session;
  // October sales: 3 cables at ₹1,000 (cost ₹100 each), unregistered shop (no tax).
  const cable = await variant(h, shop, 'EXP-CB', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 10, 10000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 10000 where id = ${cable}`.execute(h.admin);
  const ctx = { businessId: shop.businessId, userId: shop.ownerId };
  const at = new Date('2026-10-10T06:00:00Z');
  const draft = await createSaleDraft(
    h.appDb,
    ctx,
    ACCESS,
    { customerId: null, lines: [{ variantId: cable, quantity: '3' }] },
    at,
  );
  await issueSale(
    h.appDb,
    ctx,
    ACCESS,
    draft.id,
    {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
    },
    { at },
  );
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('module switch (FR-EXP-1 AC1)', () => {
  it('is off by default; only the owner (business.settings.manage) turns it on', async () => {
    expect((await get(h, `${shop.base}/expenses/settings`, manager)).json()).toEqual({ settings: { enabled: false } });
    const off = await expense(rent);
    expect([off.statusCode, errorCode(off)]).toEqual([409, 'MODULE_DISABLED']);
    expect((await attach(png(4, 4))).statusCode).toBe(409);
    expect((await put(h, `${shop.base}/expenses/settings`, { enabled: true }, manager)).statusCode).toBe(403);
    expect((await put(h, `${shop.base}/expenses/settings`, { enabled: true }, shop.owner)).json()).toEqual({
      settings: { enabled: true },
    });
    const audit = await sql<{ metadata: object }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'expenses.settings'`.execute(h.admin);
    expect(audit.rows.map((r) => r.metadata)).toEqual([{ enabled: true }]);
  });
});

describe('recording (FR-EXP-1 AC1)', () => {
  it('needs expenses.manage; stores date, category, amount, method, reference and notes', async () => {
    expect((await expense(rent, manager)).statusCode).toBe(403);
    expect((await expense(rent, accountant)).statusCode).toBe(403);
    const res = await expense({ ...rent, notes: 'October rent (synthetic)' });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ expense: Expense }>().expense).toMatchObject({
      date: '2026-10-05',
      category: 'RENT',
      amountPaise: 1_000_000,
      method: 'BANK_TRANSFER',
      reversedBy: null,
    });
    const audit = await sql<{ metadata: object }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'expense.record'`.execute(h.admin);
    expect(audit.rows[0]?.metadata).toEqual({ category: 'RENT', amountPaise: 1_000_000, attachment: false });
  });

  it('refuses a future date, card numbers, zero amounts and unknown categories', async () => {
    const future = await expense({ ...rent, date: '2999-01-01' });
    expect([future.statusCode, errorCode(future)]).toEqual([422, 'DATE_INVALID']);
    expect((await expense({ ...rent, reference: '4111111111111111' })).statusCode).toBe(400);
    expect((await expense({ ...rent, amountPaise: 0 })).statusCode).toBe(400);
    expect((await expense({ ...rent, category: 'LUNCH' })).statusCode).toBe(400);
  });

  it('a receipt is checked and stored privately; it can be attached once and served sandboxed', async () => {
    const bad = await attach(Buffer.from('not an image at all'));
    expect(bad.statusCode).toBe(422);
    const up = await attach(png(8, 8));
    expect(up.statusCode).toBe(201);
    const uploadId = up.json<{ uploadId: string }>().uploadId;
    const res = await expense({
      date: '2026-10-08',
      category: 'SUPPLIES',
      amountPaise: 45_000,
      method: 'CASH',
      uploadId,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ expense: Expense }>().expense.id;
    const file = await get(h, `${shop.base}/expenses/${id}/attachment`, shop.owner);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(file.rawPayload.equals(png(8, 8))).toBe(true);
    const twice = await expense({ date: '2026-10-08', category: 'SUPPLIES', amountPaise: 1, method: 'CASH', uploadId });
    expect(errorCode(twice)).toBe('ATTACHMENT_INVALID');
    // Another business's upload cannot be attached.
    await put(h, `${other.base}/expenses/settings`, { enabled: true }, other.owner);
    const theirs = (await attach(png(4, 4), other.owner, other)).json<{ uploadId: string }>().uploadId;
    expect(errorCode(await expense({ ...rent, uploadId: theirs }))).toBe('ATTACHMENT_INVALID');
    expect((await get(h, `${other.base}/expenses/${id}/attachment`, other.owner)).statusCode).toBe(404);
  });
});

describe('corrections are reversals (FR-EXP-1 AC2)', () => {
  it('reverses in full with a reason, once; a reversal cannot be reversed; the database enforces it', async () => {
    const e = (
      await expense({
        date: '2026-10-12',
        category: 'ELECTRICITY',
        amountPaise: 234_567,
        method: 'UPI',
        reference: 'UPI-77',
      })
    ).json<{ expense: Expense }>().expense;
    expect((await post(h, `${shop.base}/expenses/${e.id}/reverse`, { reason: 'short' }, shop.owner)).statusCode).toBe(
      400,
    );
    const r = await post(
      h,
      `${shop.base}/expenses/${e.id}/reverse`,
      { reason: 'Entered twice by mistake' },
      shop.owner,
    );
    expect(r.statusCode).toBe(201);
    expect(r.json<{ reversal: Expense }>().reversal).toMatchObject({
      date: '2026-10-12',
      category: 'ELECTRICITY',
      amountPaise: -234_567,
      method: 'UPI',
      reversesExpenseId: e.id,
    });
    const again = await post(
      h,
      `${shop.base}/expenses/${e.id}/reverse`,
      { reason: 'Entered twice by mistake' },
      shop.owner,
    );
    expect([again.statusCode, errorCode(again)]).toEqual([409, 'ALREADY_REVERSED']);
    const rid = r.json<{ reversal: Expense }>().reversal.id;
    const rr = await post(
      h,
      `${shop.base}/expenses/${rid}/reverse`,
      { reason: 'Undo the reversal please' },
      shop.owner,
    );
    expect(errorCode(rr)).toBe('NOT_REVERSIBLE');
    const list = (await get(h, `${shop.base}/expenses?from=2026-10-01&to=2026-10-31`, shop.owner)).json<{
      expenses: Expense[];
    }>().expenses;
    expect(list.find((x) => x.id === e.id)?.reversedBy).toBe(rid);
    const audit = await sql<{ metadata: object }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'expense.reverse'`.execute(h.admin);
    expect(audit.rows.map((x) => x.metadata)).toEqual([{ reversalId: rid, amountPaise: 234_567 }]);
    // Direct SQL: no edits, no mismatched reversal.
    await expect(sql`update lbg.expenses set amount_paise = 1 where id = ${e.id}`.execute(h.admin)).rejects.toThrow();
    const rent2 = list.find((x) => x.category === 'RENT');
    await expect(
      sql`insert into lbg.expenses (business_id, expense_date, category, amount_paise, method, reverses_expense_id, reason, recorded_by)
          values (${shop.businessId}, '2026-10-05', 'RENT', -1, 'BANK_TRANSFER', ${rent2?.id}, 'partial reversal attempt', ${shop.ownerId})`.execute(
        h.admin,
      ),
    ).rejects.toMatchObject({ code: 'LB021' });
  });
});

describe('concurrent corrections', () => {
  it('two simultaneous reversals of one expense: exactly one succeeds', async () => {
    const e = (await expense({ date: '2026-09-02', category: 'OTHER', amountPaise: 9_999, method: 'CASH' })).json<{
      expense: Expense;
    }>().expense;
    const body = { reason: 'Recorded in the wrong shop' };
    const both = await Promise.all([
      post(h, `${shop.base}/expenses/${e.id}/reverse`, body, shop.owner),
      post(h, `${shop.base}/expenses/${e.id}/reverse`, body, shop.owner),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('expenses report and operating profit (FR-RPT-1, exit)', () => {
  it('exact values on the seeded dataset; one more expense changes the estimate by exactly its amount', async () => {
    const report = (await get(h, `${shop.base}/reports/expenses?period=month&date=2026-10-15`, accountant)).json<{
      report: { byCategory: { category: string; amountPaise: number; count: number }[]; totalPaise: number };
    }>().report;
    expect(report.byCategory).toEqual([
      { category: 'RENT', amountPaise: 1_000_000, count: 1 },
      { category: 'SUPPLIES', amountPaise: 45_000, count: 1 },
    ]); // the reversed electricity bill nets to zero
    expect(report.totalPaise).toBe(1_045_000);
    const before = await profit('period=month&date=2026-10-15', accountant);
    expect(before).toMatchObject({
      label: 'estimate',
      taxableValuePaise: 300_000,
      cogsPaise: 30_000,
      grossMarginPaise: 270_000,
      expensesPaise: 1_045_000,
      operatingProfitPaise: -775_000,
    });
    expect(before.definitions.operatingProfit?.label).toBe('Operating profit (estimate)');
    expect(before.notes[0]).toMatch(/^An estimate/);
    await expense({ date: '2026-10-20', category: 'TRANSPORT', amountPaise: 12_345, method: 'CASH' });
    const after = await profit();
    expect(after.operatingProfitPaise - before.operatingProfitPaise).toBe(-12_345);
    expect((await profit('period=month&date=2026-09-15')).expensesPaise).toBe(0);
    // Billing has no financial reports.
    const billing = (await staff(h, shop, 'exp-billing@example.test', 'Billing')).session;
    expect(
      (await get(h, `${shop.base}/reports/operating-profit?period=month&date=2026-10-15`, billing)).statusCode,
    ).toBe(403);
    const csv = await get(
      h,
      `${shop.base}/reports/operating-profit/export?period=month&date=2026-10-15&format=csv`,
      accountant,
    );
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Operating profit (estimate),-7873.45');
  });

  it('switched off later: no new entries, earlier ones still count and the report says so', async () => {
    await put(h, `${shop.base}/expenses/settings`, { enabled: false }, shop.owner);
    expect(errorCode(await expense(rent))).toBe('MODULE_DISABLED');
    const p = await profit();
    expect(p.expensesPaise).toBe(1_057_345);
    expect(p.notes[1]).toMatch(/switched off/);
    await put(h, `${shop.base}/expenses/settings`, { enabled: true }, shop.owner);
  });
});

describe('access', () => {
  it('other businesses get 404 or nothing; read-only can list but not record or reverse', async () => {
    const mine = (await get(h, `${shop.base}/expenses?from=2026-10-01&to=2026-10-31`, shop.owner)).json<{
      expenses: Expense[];
    }>().expenses;
    const id = mine[0]?.id ?? '';
    expect(
      (await post(h, `${other.base}/expenses/${id}/reverse`, { reason: 'Cross-tenant attempt' }, other.owner))
        .statusCode,
    ).toBe(404);
    expect((await get(h, `${shop.base}/expenses?from=2026-10-01&to=2026-10-31`, other.owner)).statusCode).toBe(404);
    expect(
      (await get(h, `${other.base}/expenses?from=2026-10-01&to=2026-10-31`, other.owner)).json<{ expenses: object[] }>()
        .expenses,
    ).toEqual([]);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/expenses?from=2026-10-01&to=2026-10-31`, shop.owner)).statusCode).toBe(200);
    for (const res of [
      await expense(rent),
      await post(h, `${shop.base}/expenses/${id}/reverse`, { reason: 'Read-only attempt here' }, shop.owner),
    ]) {
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'TENANT_READ_ONLY']);
    }
  });
});
