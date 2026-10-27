// Customer payments after checkout, advances, refunds, reversals, account and
// statement (increment 5.4: FR-LED-1, FR-LED-2, D-014, D-020, D-041). Every
// write locks the customer row first, so one customer's money movements are
// serialised; allocations also lock the invoice and payment (D-020).
import {
  allocate,
  AllocationError,
  paymentStatus,
  refundSources,
  type Allocation,
  type OpenInvoice,
  type PaymentFunds,
  type PaymentStatus,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { allocatePayment, withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { businessDate } from './pricing.ts';

export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';

export class PaymentError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CUSTOMER_NOT_FOUND'
    | 'PAYMENT_INVALID'
    | 'UNKNOWN_INVOICE'
    | 'INSUFFICIENT_ADVANCE'
    | 'ALREADY_REVERSED'
    | 'NOT_REVERSIBLE'
    | 'REFUNDED'
    | 'INVALID_PERIOD';

  constructor(code: PaymentError['code'], message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

const CARD_LIKE = /\d{13,19}/;

/** FR-POS-3 AC4: references never hold full card numbers (spaces and dashes are ignored). */
export function isCardLike(reference: string | null | undefined): boolean {
  return !!reference && CARD_LIKE.test(reference.replace(/[\s-]/g, ''));
}

/** Locks the customer for the rest of the transaction; throws if unknown or erased. */
export async function lockCustomer(trx: Trx, ctx: TenantContext, customerId: string): Promise<void> {
  const { rows } = await sql<{ erased: boolean }>`
    select erased_at is not null as erased from lbg.customers
     where business_id = ${ctx.businessId} and id = ${customerId} for update`.execute(trx);
  if (!rows[0] || rows[0].erased) throw new PaymentError('CUSTOMER_NOT_FOUND', 'Customer not found.');
}

/**
 * Unallocated parts of the customer's payments (advance), oldest first:
 * amount − allocations − refunds, excluding reversed payments and reversals.
 */
export async function customerFundsIn(trx: Trx, ctx: TenantContext, customerId: string): Promise<PaymentFunds[]> {
  const { rows } = await sql<{ id: string; unallocated: string }>`
    select p.id,
           p.amount_paise
             - coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                          where a.business_id = p.business_id and a.payment_id = p.id), 0)
             - coalesce((select sum(r.amount_paise) from lbg.payment_refunds r
                          where r.business_id = p.business_id and r.payment_id = p.id), 0) as unallocated
      from lbg.payments p
     where p.business_id = ${ctx.businessId} and p.customer_id = ${customerId} and p.reverses_payment_id is null
       and not exists (select 1 from lbg.payments x where x.business_id = p.business_id and x.reverses_payment_id = p.id)
     order by p.received_at, p.id`.execute(trx);
  return rows.map((r) => ({ id: r.id, unallocatedPaise: Number(r.unallocated) })).filter((f) => f.unallocatedPaise > 0);
}

/** The customer's issued, not cancelled, sale documents with an amount outstanding. */
export async function openInvoicesIn(trx: Trx, ctx: TenantContext, customerId: string): Promise<OpenInvoice[]> {
  const { rows } = await sql<{ id: string; date: string; number: string; outstanding: string }>`
    select i.id, i.invoice_date::text as date, i.invoice_number as number,
           i.total_paise - coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                                      where a.business_id = i.business_id and a.invoice_id = i.id), 0) as outstanding
      from lbg.invoices i
     where i.business_id = ${ctx.businessId} and i.customer_id = ${customerId} and i.status = 'ISSUED'
       and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY')`.execute(trx);
  return rows
    .map((r) => ({ id: r.id, date: r.date, number: r.number, outstandingPaise: Number(r.outstanding) }))
    .filter((i) => i.outstandingPaise > 0);
}

async function writeAllocations(trx: Trx, ctx: TenantContext, allocations: readonly Allocation[]): Promise<void> {
  for (const a of allocations) await allocatePayment(trx, ctx, a.paymentId, a.invoiceId, a.amountPaise);
}

function allocateOrThrow(funds: readonly PaymentFunds[], open: readonly OpenInvoice[], selected?: readonly string[]) {
  try {
    return allocate(funds, open, selected);
  } catch (err) {
    if (err instanceof AllocationError && err.code === 'UNKNOWN_INVOICE') {
      throw new PaymentError('UNKNOWN_INVOICE', 'One of the chosen invoices is not open for this customer.');
    }
    throw err;
  }
}

async function ledgerEntry(
  trx: Trx,
  ctx: TenantContext,
  e: {
    customerId: string;
    type: 'PAYMENT' | 'REFUND' | 'REVERSAL';
    amountPaise: number;
    referenceType: string;
    referenceId: string;
    reversesEntryId?: string;
  },
): Promise<void> {
  await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                     reference_type, reference_id, reverses_entry_id, created_by)
            values (${ctx.businessId}, ${e.customerId}, ${e.type}, ${e.amountPaise}, ${e.referenceType},
                    ${e.referenceId}, ${e.reversesEntryId ?? null}, ${ctx.userId})`.execute(trx);
}

export interface PaymentInput {
  readonly method: PaymentMethod;
  readonly amountPaise: number;
  readonly reference?: string | null | undefined;
  readonly tenderedPaise?: number | null | undefined;
  /** Invoices to pay, in this order; otherwise oldest first (D-014). */
  readonly invoiceIds?: readonly string[] | undefined;
  readonly notes?: string | null | undefined;
}

export interface RecordedPayment {
  readonly paymentId: string;
  readonly allocations: readonly { readonly invoiceId: string; readonly amountPaise: number }[];
  /** Left on the payment as customer advance. */
  readonly advancePaise: number;
  readonly changePaise: number;
}

/** A payment received from a customer after checkout (FR-LED-2 AC1). */
export async function recordPayment(
  db: Db,
  ctx: TenantContext,
  customerId: string,
  input: PaymentInput,
  requestId?: string,
): Promise<RecordedPayment> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0)
    throw new PaymentError('PAYMENT_INVALID', 'Enter a positive amount.');
  if (isCardLike(input.reference))
    throw new PaymentError('PAYMENT_INVALID', 'Do not enter full card numbers; record only the last 4 digits.');
  let changePaise = 0;
  if (input.tenderedPaise !== undefined && input.tenderedPaise !== null) {
    if (input.method !== 'CASH')
      throw new PaymentError('PAYMENT_INVALID', 'Only cash payments have a tendered amount.');
    if (input.tenderedPaise < input.amountPaise)
      throw new PaymentError('PAYMENT_INVALID', 'The cash tendered is less than the amount.');
    changePaise = input.tenderedPaise - input.amountPaise;
  }
  return withTenant(db, ctx, async (trx) => {
    await lockCustomer(trx, ctx, customerId);
    const open = await openInvoicesIn(trx, ctx, customerId);
    const { rows } = await sql<{ id: string }>`
      insert into lbg.payments (business_id, customer_id, method, amount_paise, reference, recorded_by,
                                cash_tendered_paise, notes)
      values (${ctx.businessId}, ${customerId}, ${input.method}, ${input.amountPaise}, ${input.reference ?? null},
              ${ctx.userId}, ${input.tenderedPaise ?? null}, ${input.notes ?? null})
      returning id`.execute(trx);
    const paymentId = rows[0]?.id;
    if (!paymentId) throw new Error('payment insert returned nothing');
    const allocations = allocateOrThrow(
      [{ id: paymentId, unallocatedPaise: input.amountPaise }],
      open,
      input.invoiceIds,
    );
    await writeAllocations(trx, ctx, allocations);
    await ledgerEntry(trx, ctx, {
      customerId,
      type: 'PAYMENT',
      amountPaise: -input.amountPaise,
      referenceType: 'payment',
      referenceId: paymentId,
    });
    const allocated = allocations.reduce((s, a) => s + a.amountPaise, 0);
    await recordTenantEvent(trx, ctx, {
      action: 'payment.record',
      targetType: 'payment',
      targetId: paymentId,
      metadata: { method: input.method, amountPaise: input.amountPaise, allocatedPaise: allocated },
      ...(requestId ? { requestId } : {}),
    });
    return {
      paymentId,
      allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amountPaise: a.amountPaise })),
      advancePaise: input.amountPaise - allocated,
      changePaise,
    };
  });
}

/** Uses the customer's advance on open invoices (selected, else oldest first). */
export async function applyAdvance(
  db: Db,
  ctx: TenantContext,
  customerId: string,
  input: { readonly invoiceIds?: readonly string[] | undefined },
  requestId?: string,
): Promise<{ allocations: { paymentId: string; invoiceId: string; amountPaise: number }[] }> {
  return withTenant(db, ctx, async (trx) => {
    await lockCustomer(trx, ctx, customerId);
    const funds = await customerFundsIn(trx, ctx, customerId);
    const open = await openInvoicesIn(trx, ctx, customerId);
    const allocations = allocateOrThrow(funds, open, input.invoiceIds);
    await writeAllocations(trx, ctx, allocations);
    if (allocations.length > 0) {
      await recordTenantEvent(trx, ctx, {
        action: 'payment.apply_advance',
        targetType: 'customer',
        targetId: customerId,
        metadata: { allocatedPaise: allocations.reduce((s, a) => s + a.amountPaise, 0) },
        ...(requestId ? { requestId } : {}),
      });
    }
    return { allocations: [...allocations] };
  });
}

/** Pays advance back to the customer (needs refunds.approve, checked by the API). */
export async function refundAdvance(
  db: Db,
  ctx: TenantContext,
  customerId: string,
  input: {
    readonly amountPaise: number;
    readonly method: PaymentMethod;
    readonly reference?: string | null | undefined;
    readonly reason: string;
  },
  requestId?: string,
): Promise<{ refundIds: string[]; amountPaise: number }> {
  if (isCardLike(input.reference))
    throw new PaymentError('PAYMENT_INVALID', 'Do not enter full card numbers; record only the last 4 digits.');
  if (input.reason.trim().length < 10)
    throw new PaymentError('PAYMENT_INVALID', 'Give a reason of at least 10 characters.');
  return withTenant(db, ctx, async (trx) => {
    await lockCustomer(trx, ctx, customerId);
    const funds = await customerFundsIn(trx, ctx, customerId);
    let sources: { paymentId: string; amountPaise: number }[];
    try {
      sources = refundSources(funds, input.amountPaise);
    } catch (err) {
      if (err instanceof AllocationError)
        throw new PaymentError('INSUFFICIENT_ADVANCE', 'The refund is larger than the advance held.');
      throw err;
    }
    const refundIds: string[] = [];
    for (const s of sources) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${'payment:' + s.paymentId}, 0))`.execute(trx);
      const { rows } = await sql<{ id: string }>`
        insert into lbg.payment_refunds (business_id, payment_id, customer_id, amount_paise, method, reference,
                                         reason, recorded_by)
        values (${ctx.businessId}, ${s.paymentId}, ${customerId}, ${s.amountPaise}, ${input.method},
                ${input.reference ?? null}, ${input.reason.trim()}, ${ctx.userId})
        returning id`.execute(trx);
      const id = rows[0]?.id;
      if (!id) throw new Error('refund insert returned nothing');
      refundIds.push(id);
      await ledgerEntry(trx, ctx, {
        customerId,
        type: 'REFUND',
        amountPaise: s.amountPaise,
        referenceType: 'refund',
        referenceId: id,
      });
    }
    await recordTenantEvent(trx, ctx, {
      action: 'payment.refund',
      targetType: 'customer',
      targetId: customerId,
      metadata: { amountPaise: input.amountPaise, method: input.method },
      ...(requestId ? { requestId } : {}),
    });
    return { refundIds, amountPaise: input.amountPaise };
  });
}

/**
 * Reverses a payment recorded by mistake (needs refunds.approve, D-041): a
 * reversal payment, negative allocations for each of its allocations and a
 * REVERSAL ledger entry. A payment with refunds cannot be reversed.
 */
export async function reversePayment(
  db: Db,
  ctx: TenantContext,
  paymentId: string,
  reason: string,
  requestId?: string,
): Promise<{ reversalId: string; invoiceIds: string[] }> {
  if (reason.trim().length < 10) throw new PaymentError('PAYMENT_INVALID', 'Give a reason of at least 10 characters.');
  return withTenant(db, ctx, async (trx) => {
    const find = () =>
      sql<{ customer_id: string | null; method: string; amount_paise: string; reverses_payment_id: string | null }>`
        select customer_id, method, amount_paise, reverses_payment_id from lbg.payments
         where business_id = ${ctx.businessId} and id = ${paymentId}`.execute(trx);
    const first = (await find()).rows[0];
    if (!first) throw new PaymentError('NOT_FOUND', 'payment not found');
    if (first.customer_id) await lockCustomer(trx, ctx, first.customer_id);
    await sql`select pg_advisory_xact_lock(hashtextextended(${'payment:' + paymentId}, 0))`.execute(trx);
    if (first.reverses_payment_id) throw new PaymentError('NOT_REVERSIBLE', 'A reversal cannot be reversed.');
    const { rows: state } = await sql<{ reversed: boolean; refunded: boolean }>`
      select exists (select 1 from lbg.payments where business_id = ${ctx.businessId}
                       and reverses_payment_id = ${paymentId}) as reversed,
             exists (select 1 from lbg.payment_refunds where business_id = ${ctx.businessId}
                       and payment_id = ${paymentId}) as refunded`.execute(trx);
    if (state[0]?.reversed) throw new PaymentError('ALREADY_REVERSED', 'This payment has already been reversed.');
    if (state[0]?.refunded)
      throw new PaymentError('REFUNDED', 'Part of this payment was refunded; it cannot be reversed.');
    const { rows: rev } = await sql<{ id: string }>`
      insert into lbg.payments (business_id, customer_id, method, amount_paise, reverses_payment_id, recorded_by, notes)
      values (${ctx.businessId}, ${first.customer_id}, ${first.method}, ${first.amount_paise}, ${paymentId},
              ${ctx.userId}, ${reason.trim()})
      returning id`.execute(trx);
    const reversalId = rev[0]?.id;
    if (!reversalId) throw new Error('reversal insert returned nothing');
    // Every allocation of this payment that is not yet reversed (advance use is reversed too).
    const { rows: allocs } = await sql<{ id: string; invoice_id: string; amount_paise: string }>`
      select a.id, a.invoice_id, a.amount_paise from lbg.payment_allocations a
       where a.business_id = ${ctx.businessId} and a.payment_id = ${paymentId} and a.amount_paise > 0
         and not exists (select 1 from lbg.payment_allocations r
                          where r.business_id = a.business_id and r.reverses_allocation_id = a.id)
       order by a.invoice_id`.execute(trx);
    for (const a of allocs) {
      await trx.selectFrom('lbg.invoices').select('id').where('id', '=', a.invoice_id).forUpdate().execute();
      await sql`insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise,
                                                     reverses_allocation_id)
                values (${ctx.businessId}, ${paymentId}, ${a.invoice_id}, ${-Number(a.amount_paise)}, ${a.id})`.execute(
        trx,
      );
    }
    if (first.customer_id) {
      const { rows: entries } = await sql<{ id: string; amount_paise: string }>`
        select id, amount_paise from lbg.customer_ledger_entries
         where business_id = ${ctx.businessId} and entry_type = 'PAYMENT' and reference_type = 'payment'
           and reference_id = ${paymentId}`.execute(trx);
      for (const e of entries) {
        await ledgerEntry(trx, ctx, {
          customerId: first.customer_id,
          type: 'REVERSAL',
          amountPaise: -Number(e.amount_paise),
          referenceType: 'payment',
          referenceId: reversalId,
          reversesEntryId: e.id,
        });
      }
    }
    await recordTenantEvent(trx, ctx, {
      action: 'payment.reverse',
      targetType: 'payment',
      targetId: paymentId,
      metadata: { reversalId, amountPaise: Number(first.amount_paise) },
      ...(requestId ? { requestId } : {}),
    });
    return { reversalId, invoiceIds: [...new Set(allocs.map((a) => a.invoice_id))] };
  });
}

export interface CustomerAccount {
  /** Σ ledger entries: positive = the customer owes, negative = advance held (FR-LED-1 AC2). */
  readonly balancePaise: number;
  readonly receivablePaise: number;
  readonly advancePaise: number;
  readonly openInvoices: readonly (OpenInvoice & { readonly totalPaise: number; readonly status: PaymentStatus })[];
  readonly payments: readonly {
    readonly id: string;
    readonly method: string;
    readonly amountPaise: number;
    readonly reference: string | null;
    readonly receivedAt: string;
    readonly reversesPaymentId: string | null;
    readonly reversed: boolean;
    readonly unallocatedPaise: number;
  }[];
}

export async function customerAccount(db: Db, ctx: TenantContext, customerId: string): Promise<CustomerAccount> {
  return withTenant(db, ctx, async (trx) => {
    const exists =
      await sql`select 1 from lbg.customers where business_id = ${ctx.businessId} and id = ${customerId}`.execute(trx);
    if (exists.rows.length === 0) throw new PaymentError('CUSTOMER_NOT_FOUND', 'Customer not found.');
    const { rows: bal } = await sql<{ balance: string }>`
      select coalesce(sum(amount_paise), 0) as balance from lbg.customer_ledger_entries
       where business_id = ${ctx.businessId} and customer_id = ${customerId}`.execute(trx);
    const open = await openInvoicesIn(trx, ctx, customerId);
    const funds = await customerFundsIn(trx, ctx, customerId);
    const { rows: totals } = await sql<{ id: string; total_paise: string }>`
      select id, total_paise from lbg.invoices
       where business_id = ${ctx.businessId} and id = any(${open.map((i) => i.id)}::uuid[])`.execute(trx);
    const totalOf = new Map(totals.map((t) => [t.id, Number(t.total_paise)]));
    const { rows: pays } = await sql<{
      id: string;
      method: string;
      amount_paise: string;
      reference: string | null;
      received_at: Date;
      reverses_payment_id: string | null;
      reversed: boolean;
    }>`
      select p.id, p.method, p.amount_paise, p.reference, p.received_at, p.reverses_payment_id,
             exists (select 1 from lbg.payments x where x.business_id = p.business_id
                       and x.reverses_payment_id = p.id) as reversed
        from lbg.payments p
       where p.business_id = ${ctx.businessId} and p.customer_id = ${customerId}
       order by p.received_at desc, p.id limit 200`.execute(trx);
    const fundOf = new Map(funds.map((f) => [f.id, f.unallocatedPaise]));
    return {
      balancePaise: Number(bal[0]?.balance ?? 0),
      receivablePaise: open.reduce((s, i) => s + i.outstandingPaise, 0),
      advancePaise: funds.reduce((s, f) => s + f.unallocatedPaise, 0),
      openInvoices: open.map((i) => {
        const total = totalOf.get(i.id) ?? i.outstandingPaise;
        return { ...i, totalPaise: total, status: paymentStatus(total, total - i.outstandingPaise) };
      }),
      payments: pays.map((p) => ({
        id: p.id,
        method: p.method,
        amountPaise: Number(p.amount_paise),
        reference: p.reference,
        receivedAt: p.received_at.toISOString(),
        reversesPaymentId: p.reverses_payment_id,
        reversed: p.reversed,
        unallocatedPaise: fundOf.get(p.id) ?? 0,
      })),
    };
  });
}

export interface Statement {
  readonly from: string;
  readonly to: string;
  readonly openingPaise: number;
  readonly closingPaise: number;
  readonly entries: readonly {
    readonly date: string;
    readonly type: string;
    readonly amountPaise: number;
    readonly referenceType: string | null;
    readonly referenceId: string | null;
    readonly document: string | null;
    readonly balancePaise: number;
  }[];
}

/** Statement for business dates `from`…`to` inclusive (FR-LED-1 AC3). */
export async function customerStatement(
  db: Db,
  ctx: TenantContext,
  customerId: string,
  from: string,
  to: string,
): Promise<Statement> {
  if (to < from) throw new PaymentError('INVALID_PERIOD', 'The end date is before the start date.');
  return withTenant(db, ctx, async (trx) => {
    const { rows: tz } = await sql<{ timezone: string }>`
      select b.timezone from lbg.businesses b join lbg.customers c on c.business_id = b.id
       where b.id = ${ctx.businessId} and c.id = ${customerId}`.execute(trx);
    const timezone = tz[0]?.timezone;
    if (!timezone) throw new PaymentError('CUSTOMER_NOT_FOUND', 'Customer not found.');
    // Period boundaries are local midnights in the business's timezone.
    const start = sql`(${from}::date::timestamp at time zone ${timezone})`;
    const end = sql`((${to}::date + 1)::timestamp at time zone ${timezone})`;
    const { rows: opening } = await sql<{ amount: string }>`
      select coalesce(sum(amount_paise), 0) as amount from lbg.customer_ledger_entries
       where business_id = ${ctx.businessId} and customer_id = ${customerId} and created_at < ${start}`.execute(trx);
    const { rows } = await sql<{
      created_at: Date;
      entry_type: string;
      amount_paise: string;
      reference_type: string | null;
      reference_id: string | null;
      document: string | null;
    }>`
      select e.created_at, e.entry_type, e.amount_paise, e.reference_type, e.reference_id, i.invoice_number as document
        from lbg.customer_ledger_entries e
        left join lbg.invoices i on e.reference_type = 'invoice' and i.business_id = e.business_id
                                and i.id = e.reference_id
       where e.business_id = ${ctx.businessId} and e.customer_id = ${customerId}
         and e.created_at >= ${start} and e.created_at < ${end}
       order by e.created_at, e.amount_paise desc, e.id`.execute(trx);
    let balance = Number(opening[0]?.amount ?? 0);
    const openingPaise = balance;
    const entries = rows.map((r) => {
      balance += Number(r.amount_paise);
      return {
        date: businessDate(r.created_at, timezone),
        type: r.entry_type,
        amountPaise: Number(r.amount_paise),
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        document: r.document,
        balancePaise: balance,
      };
    });
    return { from, to, openingPaise, closingPaise: balance, entries };
  });
}
