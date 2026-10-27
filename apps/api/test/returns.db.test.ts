// Increment 5.5: cancellation, credit and debit notes, returns into
// inspection (FR-TAX-3, FR-POS-3 AC5, FR-INV-6 AC1, D-016, D-042). Synthetic data only.
import { cancelInvoice } from '@lbgos/modules/sales';
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
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop; // GST-registered, Maharashtra
let other: Shop;
let billing: Session;
let manager: Session;
let phone: string; // ₹15,000 incl. 18 %
let cable: string; // ₹500 incl. 18 %
let odd: string; // ₹333.33 incl. 18 % (round-off)
let imeiSeq = 7000;

interface Account {
  balancePaise: number;
  receivablePaise: number;
  advancePaise: number;
}

async function seedUnit(costPaise: number): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
    values (${shop.businessId}, ${phone}, 'IN_STOCK', ${costPaise}) returning id`.execute(h.admin);
  const unitId = rows[0]?.id ?? '';
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
            values (${shop.businessId}, ${imei(imeiSeq++)}, ${unitId}, 1)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${phone}, ${unitId}, 'OPENING', 1, ${costPaise})`.execute(h.admin);
  return unitId;
}

async function newCustomer(name: string, mobile: string): Promise<string> {
  const res = await post(h, `${shop.base}/customers`, { name, mobile }, shop.owner);
  return res.json<{ customer: { id: string } }>().customer.id;
}

/** Issues a sale; `paid` is paid in cash (null: the whole total). */
async function sell(lines: object[], customerId: string | null, paid: number | null = null) {
  const d = await post(h, `${shop.base}/sales`, { customerId, lines }, billing);
  if (d.statusCode !== 201) throw new Error(`draft failed: ${d.statusCode} ${d.body}`);
  const sale = d.json<{ sale: { id: string; totals: { totalPaise: number } } }>().sale;
  const amount = paid ?? sale.totals.totalPaise;
  const res = await post(
    h,
    `${shop.base}/sales/${sale.id}/issue`,
    {
      expectedTotalPaise: sale.totals.totalPaise,
      payments: amount > 0 ? [{ method: 'CASH', amountPaise: amount }] : [],
    },
    billing,
  );
  if (res.statusCode !== 201) throw new Error(`issue failed: ${res.statusCode} ${res.body}`);
  return { id: sale.id, total: sale.totals.totalPaise };
}

const account = async (customerId: string) =>
  (await get(h, `${shop.base}/customers/${customerId}/account`, manager)).json<{ account: Account }>().account;

const unitStatus = async (unitId: string) =>
  (await sql<{ status: string }>`select status from lbg.serialized_units where id = ${unitId}`.execute(h.admin)).rows[0]
    ?.status;

const level = async (variantId: string, bucket: string) =>
  Number(
    (
      await sql<{ q: string }>`select coalesce((select quantity from lbg.stock_levels where variant_id = ${variantId}
                                                  and bucket = ${bucket}), 0)::text as q`.execute(h.admin)
    ).rows[0]?.q,
  );

const cancel = (invoiceId: string, body: object, session: Session = manager) =>
  post(h, `${shop.base}/invoices/${invoiceId}/cancel`, body, session);
const credit = (invoiceId: string, body: object, session: Session = manager) =>
  post(h, `${shop.base}/invoices/${invoiceId}/credit-notes`, body, session);

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'ret-a', { gstin: '27AAPFU0939F1ZV' });
  other = await activeShop(h, 'ret-b');
  billing = (await staff(h, shop, 'ret-billing@example.test', 'Billing')).session;
  manager = (await staff(h, shop, 'ret-manager@example.test', 'Manager')).session;
  const rate = await post(
    h,
    `${shop.base}/tax-rates`,
    { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
    shop.owner,
  );
  const taxRateId = rate.json<{ id: string }>().id;
  phone = await variant(h, shop, 'RT-PH', { serialized: true, taxRateId });
  cable = await variant(h, shop, 'RT-CB', { serialized: false, taxRateId });
  odd = await variant(h, shop, 'RT-OD', { serialized: false, taxRateId });
  await patch(h, `${shop.base}/variants/${phone}`, { sellingPricePaise: 1_500_000 }, shop.owner);
  await patch(h, `${shop.base}/variants/${cable}`, { sellingPricePaise: 50_000 }, shop.owner);
  await patch(h, `${shop.base}/variants/${odd}`, { sellingPricePaise: 33_333 }, shop.owner);
  for (const v of [cable, odd]) {
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${shop.businessId}, ${v}, 'OPENING', 100, 20000)`.execute(h.admin);
    await sql`update lbg.product_variants set avg_cost_paise = 20000 where id = ${v}`.execute(h.admin);
  }
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('cancellation within the window (FR-TAX-3 AC1–2, D-016)', () => {
  it('goods never left: the unit goes back to stock, the payment becomes advance, the number is kept', async () => {
    const c = await newCustomer('Anil Shetty (synthetic)', '9810000001');
    const unit = await seedUnit(1_000_000);
    const inv = await sell([{ unitId: unit }], c, 500_000);
    const body = { reason: 'Customer changed their mind at the counter.', goods: 'NOT_TAKEN', settlement: 'ADVANCE' };
    expect((await cancel(inv.id, body, billing)).statusCode).toBe(403);
    const res = await cancel(inv.id, body);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ cancellation: { releasedPaise: number } }>().cancellation.releasedPaise).toBe(500_000);
    expect(await unitStatus(unit)).toBe('IN_STOCK');
    const moves = await sql<{ movement_type: string; bucket: string }>`
      select movement_type, bucket from lbg.stock_movements where unit_id = ${unit} order by created_at, id`.execute(
      h.admin,
    );
    expect(moves.rows.map((m) => `${m.movement_type}/${m.bucket}`)).toEqual([
      'OPENING/AVAILABLE',
      'SALE/AVAILABLE',
      'REVERSAL/AVAILABLE',
    ]);
    const detail = (await get(h, `${shop.base}/invoices/${inv.id}`, manager)).json<{
      invoice: { status: string; number: string; paymentStatus: string | null };
    }>().invoice;
    expect(detail).toMatchObject({ status: 'CANCELLED', paymentStatus: null });
    expect(detail.number).toMatch(/^T\d{2}-\d{2}\/\d{4}$/);
    expect(await account(c)).toEqual(
      expect.objectContaining({ balancePaise: -500_000, receivablePaise: 0, advancePaise: 500_000 }),
    );
    expect(errorCode(await cancel(inv.id, body))).toBe('NOT_ISSUED');
  });

  it('a walk-in sale is paid back; goods that came back go into inspection', async () => {
    const before = await level(cable, 'INSPECTION');
    const inv = await sell([{ variantId: cable, quantity: '2' }], null);
    const asAdvance = await cancel(inv.id, {
      reason: 'Wrong item billed for walk-in.',
      goods: 'RETURNED',
      settlement: 'ADVANCE',
    });
    expect(errorCode(asAdvance)).toBe('REFUND_REQUIRED');
    const res = await cancel(inv.id, {
      reason: 'Wrong item billed for walk-in.',
      goods: 'RETURNED',
      settlement: 'REFUND',
      refundMethod: 'CASH',
    });
    expect(res.json<{ cancellation: { refundedPaise: number } }>().cancellation.refundedPaise).toBe(100_000);
    expect(await level(cable, 'INSPECTION')).toBe(before + 2);
    const refunds = await sql<{ total: string; customer_id: string | null }>`
      select sum(amount_paise) as total, max(customer_id::text) as customer_id from lbg.payment_refunds
       where invoice_id = ${inv.id}`.execute(h.admin);
    expect(refunds.rows[0]).toEqual({ total: '100000', customer_id: null });
  });

  it('outside the window (default: same business day) cancellation is refused with a pointer to credit notes', async () => {
    const inv = await sell([{ variantId: cable }], null);
    const tomorrow = new Date(Date.now() + 36 * 3600 * 1000);
    await expect(
      cancelInvoice(
        h.appDb,
        { businessId: shop.businessId, userId: shop.ownerId },
        { canRefund: true },
        inv.id,
        { reason: 'Trying to cancel the next day.', goods: 'RETURNED', settlement: 'REFUND' },
        { at: tomorrow },
      ),
    ).rejects.toMatchObject({ code: 'OUTSIDE_WINDOW' });
    // Refunding needs refunds.approve as well as invoices.cancel.
    await expect(
      cancelInvoice(h.appDb, { businessId: shop.businessId, userId: shop.ownerId }, { canRefund: false }, inv.id, {
        reason: 'Refund without the permission.',
        goods: 'RETURNED',
        settlement: 'REFUND',
      }),
    ).rejects.toMatchObject({ code: 'REFUND_FORBIDDEN' });
  });
});

describe('credit notes (FR-TAX-3 AC3, FR-INV-6 AC1)', () => {
  it('partial returns use the original snapshots; the last return takes exactly what is left; never more than sold', async () => {
    const c = await newCustomer('Bela Sen (synthetic)', '9810000002');
    const inv = await sell([{ variantId: cable, quantity: '3' }], c, 0); // ₹1,500, unpaid
    const line = await sql<{ taxable_paise: string; cgst_paise: string; sgst_paise: string; line_total_paise: string }>`
      select taxable_paise, cgst_paise, sgst_paise, line_total_paise from lbg.invoice_lines where invoice_id = ${inv.id}`.execute(
      h.admin,
    );
    const original = line.rows[0];
    const inspection = await level(cable, 'INSPECTION');
    const first = await credit(inv.id, {
      reason: 'One cable returned, faulty.',
      lines: [{ lineNo: 1, quantity: '1' }],
      settlement: 'ADVANCE',
    });
    expect(first.statusCode).toBe(201);
    const n1 = first.json<{
      creditNote: { noteId: string; number: string; totalPaise: number; releasedPaise: number };
    }>().creditNote;
    // One third of the ₹1,500 line: taxable 42,373 of 1,27,119; total ₹500. Nothing was paid, so nothing is released.
    expect(n1).toMatchObject({ totalPaise: 50_000, releasedPaise: 0 });
    expect(n1.number).toMatch(/^T\d{2}-\d{2}\/0001$/);
    expect(await level(cable, 'INSPECTION')).toBe(inspection + 1);
    const second = await credit(inv.id, {
      reason: 'The other two returned too.',
      lines: [{ lineNo: 1 }],
      settlement: 'ADVANCE',
    });
    expect(second.json<{ creditNote: { number: string } }>().creditNote.number).toMatch(/\/0002$/);
    const sums = await sql<{ taxable: string; cgst: string; sgst: string; total: string }>`
      select sum(l.taxable_paise) as taxable, sum(l.cgst_paise) as cgst, sum(l.sgst_paise) as sgst,
             sum(l.line_total_paise) as total
        from lbg.invoice_lines l join lbg.invoices n on n.id = l.invoice_id
       where n.original_invoice_id = ${inv.id} and n.document_type = 'CREDIT_NOTE'`.execute(h.admin);
    expect(sums.rows[0]).toEqual({
      taxable: original?.taxable_paise,
      cgst: original?.cgst_paise,
      sgst: original?.sgst_paise,
      total: original?.line_total_paise,
    });
    const more = await credit(inv.id, {
      reason: 'Nothing left to return.',
      lines: [{ lineNo: 1, quantity: '1' }],
      settlement: 'ADVANCE',
    });
    expect(errorCode(more)).toBe('RETURN_EXCEEDS_SOLD');
    expect(await account(c)).toEqual(expect.objectContaining({ balancePaise: 0, receivablePaise: 0, advancePaise: 0 }));
    // With credit notes the invoice can no longer be cancelled.
    expect(
      errorCode(await cancel(inv.id, { reason: 'Too late to cancel now.', goods: 'RETURNED', settlement: 'ADVANCE' })),
    ).toBe('HAS_NOTES');
    // A credit note is not itself cancellable or creditable.
    expect(
      errorCode(
        await credit(n1.noteId, { reason: 'Credit of a credit.', lines: [{ lineNo: 1 }], settlement: 'ADVANCE' }),
      ),
    ).toBe('NOT_AN_INVOICE');
  });

  it('a returned phone goes into inspection; paid money becomes advance or is refunded with refunds.approve', async () => {
    const c = await newCustomer('Chirag Mehta (synthetic)', '9810000003');
    const unit = await seedUnit(1_000_000);
    const inv = await sell([{ unitId: unit }, { variantId: cable }], c); // fully paid ₹15,500
    const body = {
      reason: 'Phone returned within 7 days.',
      lines: [{ lineNo: 1 }],
      settlement: 'REFUND',
      refundMethod: 'UPI',
      refundReference: 'UPI-RF-1',
    };
    expect((await credit(inv.id, body, billing)).statusCode).toBe(403);
    const res = await credit(inv.id, body, manager);
    expect(res.statusCode).toBe(201);
    expect(
      res.json<{ creditNote: { totalPaise: number; releasedPaise: number; refundedPaise: number } }>().creditNote,
    ).toEqual(expect.objectContaining({ totalPaise: 1_500_000, releasedPaise: 1_500_000, refundedPaise: 1_500_000 }));
    expect(await unitStatus(unit)).toBe('PENDING_INSPECTION');
    expect(await account(c)).toEqual(expect.objectContaining({ balancePaise: 0, receivablePaise: 0, advancePaise: 0 }));
    const invoice = (await get(h, `${shop.base}/invoices/${inv.id}`, manager)).json<{
      invoice: { creditedPaise: number; outstandingPaise: number; paymentStatus: string };
    }>().invoice;
    expect(invoice).toMatchObject({ creditedPaise: 1_500_000, outstandingPaise: 0, paymentStatus: 'PAID' });
    // FR-INV-6 AC2–3: only RESTOCK makes it sellable again.
    expect(
      (await post(h, `${shop.base}/stock/inspections`, { unitId: unit, outcome: 'RESTOCK' }, manager)).statusCode,
    ).toBe(201);
    expect(await unitStatus(unit)).toBe('IN_STOCK');

    // The cable as advance instead.
    const asAdvance = await credit(
      inv.id,
      { reason: 'Cable returned unused.', lines: [{ lineNo: 2 }], settlement: 'ADVANCE' },
      manager,
    );
    expect(asAdvance.json<{ creditNote: { releasedPaise: number } }>().creditNote.releasedPaise).toBe(50_000);
    expect(await account(c)).toEqual(expect.objectContaining({ balancePaise: -50_000, advancePaise: 50_000 }));
  });

  it("a full credit note also takes the invoice's round-off, so it equals the invoice total", async () => {
    const c = await newCustomer('Divya Rao (synthetic)', '9810000004');
    const inv = await sell([{ variantId: odd }], c, 0);
    expect(inv.total).toBe(33_300); // ₹333.33 rounded down
    const res = await credit(inv.id, {
      reason: 'Item returned in full.',
      lines: [{ lineNo: 1 }],
      settlement: 'ADVANCE',
    });
    expect(res.json<{ creditNote: { totalPaise: number } }>().creditNote.totalPaise).toBe(33_300);
    expect(await account(c)).toEqual(expect.objectContaining({ balancePaise: 0, receivablePaise: 0 }));
  });

  it('two credit notes for the last unit at once: one succeeds', async () => {
    const inv = await sell([{ variantId: cable }], null);
    const body = {
      reason: 'Returned cable, refund cash.',
      lines: [{ lineNo: 1 }],
      settlement: 'REFUND',
      refundMethod: 'CASH',
    };
    const results = await Promise.all([credit(inv.id, body), credit(inv.id, body)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    expect(results.map((r) => errorCode(r)).filter(Boolean)).toEqual(['RETURN_EXCEEDS_SOLD']);
  });
});

describe('debit notes (FR-TAX-3 AC4)', () => {
  it('increase the amount due at the original rate and can be paid like an invoice', async () => {
    const c = await newCustomer('Esha Gupta (synthetic)', '9810000005');
    const inv = await sell([{ variantId: cable }], c); // paid
    const res = await post(
      h,
      `${shop.base}/invoices/${inv.id}/debit-notes`,
      { reason: 'Under-charged accessory price.', lines: [{ lineNo: 1, taxablePaise: 10_000 }] },
      manager,
    );
    expect(res.statusCode).toBe(201);
    const dn = res.json<{ debitNote: { noteId: string; totalPaise: number } }>().debitNote;
    expect(dn.totalPaise).toBe(11_800); // ₹100 + 9 % CGST + 9 % SGST
    expect(await account(c)).toEqual(expect.objectContaining({ balancePaise: 11_800, receivablePaise: 11_800 }));
    const pay = await post(h, `${shop.base}/customers/${c}/payments`, { method: 'CASH', amountPaise: 11_800 }, billing);
    expect(pay.json<{ payment: { allocations: { invoiceId: string }[] } }>().payment.allocations).toEqual([
      { invoiceId: dn.noteId, amountPaise: 11_800 },
    ]);
    const walkIn = await sell([{ variantId: cable }], null);
    expect(
      errorCode(
        await post(
          h,
          `${shop.base}/invoices/${walkIn.id}/debit-notes`,
          { reason: 'Walk-in, nobody to bill.', lines: [{ lineNo: 1, taxablePaise: 100 }] },
          manager,
        ),
      ),
    ).toBe('NEEDS_CUSTOMER');
  });
});

describe('access', () => {
  it('other businesses get 404; a suspended business cannot cancel or credit', async () => {
    const inv = await sell([{ variantId: cable }], null);
    const body = { reason: 'Cross-tenant attempt here.', goods: 'RETURNED', settlement: 'REFUND' };
    expect((await post(h, `${other.base}/invoices/${inv.id}/cancel`, body, other.owner)).statusCode).toBe(404);
    expect((await post(h, `${shop.base}/invoices/${inv.id}/cancel`, body, other.owner)).statusCode).toBe(404);
    expect(
      (
        await post(
          h,
          `${other.base}/invoices/${inv.id}/credit-notes`,
          { reason: body.reason, settlement: 'REFUND', lines: [{ lineNo: 1 }] },
          other.owner,
        )
      ).statusCode,
    ).toBe(404);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    const ro = await post(h, `${shop.base}/invoices/${inv.id}/cancel`, body, shop.owner);
    expect([ro.statusCode, errorCode(ro)]).toEqual([403, 'TENANT_READ_ONLY']);
  });
});
