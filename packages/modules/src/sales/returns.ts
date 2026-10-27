// Cancellation, credit notes and debit notes (increment 5.5: FR-TAX-3,
// FR-POS-3 AC5, FR-INV-6 AC1, D-016, D-042). Issued documents never change:
// corrections are new documents, reversal movements and ledger entries.
import { computeSale, milliToQuantity, quantityToMilli, rateToBasisPoints } from '@lbgos/domain';
import { sql } from 'kysely';
import { allocatePayment, withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { lockUnit, setUnitStatus, writeMovement } from '../inventory/index.ts';
import { nextDocumentNumber } from './numbering.ts';
import { isCardLike, lockCustomer, type PaymentMethod } from './payments.ts';
import { businessDate } from './pricing.ts';

export class ReturnError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'NOT_ISSUED'
    | 'NOT_AN_INVOICE'
    | 'OUTSIDE_WINDOW'
    | 'HAS_NOTES'
    | 'INVALID'
    | 'RETURN_EXCEEDS_SOLD'
    | 'REFUND_REQUIRED'
    | 'REFUND_FORBIDDEN'
    | 'NEEDS_CUSTOMER'
    | 'UNIT_NOT_SOLD';
  readonly lineNo: number | undefined;

  constructor(code: ReturnError['code'], message: string, lineNo?: number) {
    super(message);
    this.name = 'ReturnError';
    this.code = code;
    this.lineNo = lineNo;
  }
}

/** How money already paid on the corrected amount is settled (WORKFLOWS §8 step 2). */
export interface Settlement {
  readonly settlement: 'ADVANCE' | 'REFUND';
  readonly refundMethod?: PaymentMethod | undefined;
  readonly refundReference?: string | null | undefined;
}

interface InvoiceHead {
  id: string;
  document_type: string;
  status: string;
  invoice_number: string;
  invoice_date: string;
  customer_id: string | null;
  place_of_supply_state: string;
  party_snapshot: { seller?: { stateCode?: string } } | null;
  total_paise: string;
  round_off_paise: number;
  timezone: string;
  cancel_window_days: number | null;
}

async function lockInvoice(trx: Trx, ctx: TenantContext, id: string): Promise<InvoiceHead> {
  const { rows } = await sql<InvoiceHead>`
    select i.id, i.document_type, i.status, i.invoice_number, i.invoice_date::text as invoice_date, i.customer_id,
           i.place_of_supply_state, i.party_snapshot, i.total_paise, i.round_off_paise, b.timezone,
           s.cancel_window_days
      from lbg.invoices i
      join lbg.businesses b on b.id = i.business_id
      left join lbg.business_settings s on s.business_id = i.business_id
     where i.business_id = ${ctx.businessId} and i.id = ${id}
       for update of i`.execute(trx);
  const head = rows[0];
  if (!head) throw new ReturnError('NOT_FOUND', 'invoice not found');
  if (head.document_type !== 'TAX_INVOICE' && head.document_type !== 'BILL_OF_SUPPLY')
    throw new ReturnError('NOT_AN_INVOICE', 'Only sale invoices can be cancelled or corrected.');
  if (head.status !== 'ISSUED') throw new ReturnError('NOT_ISSUED', `This invoice is ${head.status.toLowerCase()}.`);
  return head;
}

const pgLock = (trx: Trx, paymentId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${'payment:' + paymentId}, 0))`.execute(trx);

/**
 * Takes `amountPaise` of allocations off invoice `invoiceId`, latest first, so
 * the money becomes unallocated on its payments. An allocation is reversed
 * whole (it can be reversed once) and any part still needed is re-allocated.
 */
async function releaseAllocations(
  trx: Trx,
  ctx: TenantContext,
  invoiceId: string,
  amountPaise: number,
): Promise<{ paymentId: string; amountPaise: number }[]> {
  if (amountPaise <= 0) return [];
  const { rows } = await sql<{ id: string; payment_id: string; amount_paise: string }>`
    select a.id, a.payment_id, a.amount_paise from lbg.payment_allocations a
     where a.business_id = ${ctx.businessId} and a.invoice_id = ${invoiceId} and a.amount_paise > 0
       and not exists (select 1 from lbg.payment_allocations r
                        where r.business_id = a.business_id and r.reverses_allocation_id = a.id)
     order by a.created_at desc, a.id desc`.execute(trx);
  const released: { paymentId: string; amountPaise: number }[] = [];
  let left = amountPaise;
  for (const a of rows) {
    if (left === 0) break;
    const amount = Number(a.amount_paise);
    const take = Math.min(left, amount);
    await pgLock(trx, a.payment_id);
    await sql`insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise, reverses_allocation_id)
              values (${ctx.businessId}, ${a.payment_id}, ${invoiceId}, ${-amount}, ${a.id})`.execute(trx);
    if (take < amount) await allocatePayment(trx, ctx, a.payment_id, invoiceId, amount - take);
    released.push({ paymentId: a.payment_id, amountPaise: take });
    left -= take;
  }
  if (left > 0) throw new Error('fewer allocations than expected');
  return released;
}

/** Refunds the released money from the payments it came from (FR-POS-3 AC5). */
async function refundReleased(
  trx: Trx,
  ctx: TenantContext,
  customerId: string | null,
  documentId: string,
  released: readonly { paymentId: string; amountPaise: number }[],
  s: Settlement,
  reason: string,
): Promise<number> {
  let total = 0;
  for (const r of released) {
    const { rows } = await sql<{ id: string }>`
      insert into lbg.payment_refunds (business_id, payment_id, customer_id, amount_paise, method, reference, reason,
                                       recorded_by, invoice_id)
      values (${ctx.businessId}, ${r.paymentId}, ${customerId}, ${r.amountPaise}, ${s.refundMethod ?? 'CASH'},
              ${s.refundReference ?? null}, ${reason}, ${ctx.userId}, ${documentId})
      returning id`.execute(trx);
    const id = rows[0]?.id;
    if (!id) throw new Error('refund insert returned nothing');
    if (customerId) {
      await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                         reference_type, reference_id, created_by)
                values (${ctx.businessId}, ${customerId}, 'REFUND', ${r.amountPaise}, 'refund', ${id}, ${ctx.userId})`.execute(
        trx,
      );
    }
    total += r.amountPaise;
  }
  return total;
}

function checkSettlement(s: Settlement, canRefund: boolean, customerId: string | null, releasedPaise: number) {
  if (s.settlement === 'REFUND') {
    if (!canRefund) throw new ReturnError('REFUND_FORBIDDEN', 'Refunds need the refunds.approve permission.');
    if (isCardLike(s.refundReference))
      throw new ReturnError('INVALID', 'Do not enter full card numbers; record only the last 4 digits.');
  } else if (!customerId && releasedPaise > 0) {
    // Nobody to hold an advance for: a walk-in is paid back.
    throw new ReturnError('REFUND_REQUIRED', 'This sale has no customer: refund the amount paid.');
  }
}

async function paidOn(
  trx: Trx,
  ctx: TenantContext,
  invoiceId: string,
): Promise<{ allocated: number; credited: number }> {
  const { rows } = await sql<{ allocated: string; credited: string }>`
    select coalesce((select sum(amount_paise) from lbg.payment_allocations
                      where business_id = ${ctx.businessId} and invoice_id = ${invoiceId}), 0) as allocated,
           coalesce((select sum(total_paise) from lbg.invoices
                      where business_id = ${ctx.businessId} and original_invoice_id = ${invoiceId}
                        and document_type = 'CREDIT_NOTE' and status = 'ISSUED'), 0) as credited`.execute(trx);
  return { allocated: Number(rows[0]?.allocated ?? 0), credited: Number(rows[0]?.credited ?? 0) };
}

export interface CancelInput extends Settlement {
  readonly reason: string;
  /** NOT_TAKEN: the goods never left the shop (back to stock); RETURNED: they came back (into inspection). */
  readonly goods: 'NOT_TAKEN' | 'RETURNED';
}

/** Cancels an issued invoice within the window (FR-TAX-3 AC1–2, D-016). */
export async function cancelInvoice(
  db: Db,
  ctx: TenantContext,
  access: { readonly canRefund: boolean },
  invoiceId: string,
  input: CancelInput,
  options: { readonly at?: Date; readonly requestId?: string } = {},
): Promise<{ releasedPaise: number; refundedPaise: number }> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new ReturnError('INVALID', 'Give a reason of at least 10 characters.');
  const at = options.at ?? new Date();
  return withTenant(db, ctx, async (trx) => {
    const head = await lockInvoice(trx, ctx, invoiceId);
    const today = businessDate(at, head.timezone);
    const { rows: last } = await sql<{ last_day: string }>`
      select (${head.invoice_date}::date + ${head.cancel_window_days ?? 0}::int)::text as last_day`.execute(trx);
    if (today > (last[0]?.last_day ?? head.invoice_date)) {
      throw new ReturnError('OUTSIDE_WINDOW', 'The cancellation window has passed. Issue a credit note instead.');
    }
    const { rows: notes } = await sql`select 1 from lbg.invoices where business_id = ${ctx.businessId}
                                        and original_invoice_id = ${invoiceId} and status = 'ISSUED'`.execute(trx);
    if (notes.length > 0)
      throw new ReturnError(
        'HAS_NOTES',
        'Credit or debit notes exist for this invoice; correct it with a credit note.',
      );
    if (head.customer_id) await lockCustomer(trx, ctx, head.customer_id);
    const { allocated } = await paidOn(trx, ctx, invoiceId);
    checkSettlement(input, access.canRefund, head.customer_id, allocated);

    // Stock comes back: units sold by this invoice return to stock or into inspection.
    const { rows: moves } = await sql<{
      id: string;
      variant_id: string;
      unit_id: string | null;
      quantity: string;
      unit_cost_paise: string | null;
    }>`select id, variant_id, unit_id, (-quantity_delta)::text as quantity, unit_cost_paise from lbg.stock_movements
        where business_id = ${ctx.businessId} and reference_type = 'invoice' and reference_id = ${invoiceId}
          and movement_type = 'SALE' order by variant_id, unit_id`.execute(trx);
    for (const m of moves) {
      const cost = m.unit_cost_paise === null ? null : Number(m.unit_cost_paise);
      if (m.unit_id) {
        const unit = await lockUnit(trx, ctx, m.unit_id);
        if (unit.status !== 'SOLD') throw new ReturnError('UNIT_NOT_SOLD', 'A unit on this invoice is no longer sold.');
        await setUnitStatus(trx, ctx, unit, input.goods === 'NOT_TAKEN' ? 'IN_STOCK' : 'PENDING_INSPECTION');
      }
      await writeMovement(
        trx,
        ctx,
        input.goods === 'NOT_TAKEN'
          ? {
              variantId: m.variant_id,
              unitId: m.unit_id,
              type: 'REVERSAL',
              quantity: m.quantity,
              unitCostPaise: cost,
              reversesMovementId: m.id,
              referenceType: 'invoice_cancel',
              referenceId: invoiceId,
              reason,
            }
          : {
              variantId: m.variant_id,
              unitId: m.unit_id,
              type: 'SALE_RETURN',
              quantity: m.quantity,
              bucket: 'INSPECTION',
              unitCostPaise: cost,
              referenceType: 'invoice_cancel',
              referenceId: invoiceId,
            },
      );
    }

    const released = await releaseAllocations(trx, ctx, invoiceId, allocated);
    if (head.customer_id) {
      const { rows: entries } = await sql<{ id: string; amount_paise: string }>`
        select id, amount_paise from lbg.customer_ledger_entries
         where business_id = ${ctx.businessId} and entry_type = 'INVOICE' and reference_type = 'invoice'
           and reference_id = ${invoiceId}`.execute(trx);
      for (const e of entries) {
        await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                           reference_type, reference_id, reverses_entry_id, created_by)
                  values (${ctx.businessId}, ${head.customer_id}, 'REVERSAL', ${-Number(e.amount_paise)}, 'invoice',
                          ${invoiceId}, ${e.id}, ${ctx.userId})`.execute(trx);
      }
    }
    const refunded =
      input.settlement === 'REFUND'
        ? await refundReleased(trx, ctx, head.customer_id, invoiceId, released, input, reason)
        : 0;
    await sql`update lbg.invoices set status = 'CANCELLED', cancel_reason = ${reason}, cancelled_at = ${at}
               where business_id = ${ctx.businessId} and id = ${invoiceId}`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'invoice.cancel',
      targetType: 'invoice',
      targetId: invoiceId,
      metadata: { number: head.invoice_number, goods: input.goods, releasedPaise: allocated, refundedPaise: refunded },
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return { releasedPaise: allocated, refundedPaise: refunded };
  });
}

interface OriginalLine {
  id: string;
  line_no: number;
  variant_id: string;
  unit_id: string | null;
  description: string;
  hsn_code: string | null;
  qty_milli: string;
  unit_price_paise: string;
  tax_rate_id: string | null;
  tax_rate_percent: string;
  cess_percent: string;
  taxable_paise: string;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
  cess_paise: string;
  cost_paise: string | null;
  // Already credited by issued credit notes.
  c_qty: string;
  c_taxable: string;
  c_cgst: string;
  c_sgst: string;
  c_igst: string;
  c_cess: string;
  c_cost: string;
}

async function originalLines(trx: Trx, ctx: TenantContext, invoiceId: string): Promise<OriginalLine[]> {
  const { rows } = await sql<OriginalLine>`
    select l.id, l.line_no, l.variant_id, l.unit_id, l.description, l.hsn_code, (l.quantity * 1000)::bigint as qty_milli,
           l.unit_price_paise, l.tax_rate_id, l.tax_rate_percent::text as tax_rate_percent,
           l.cess_percent::text as cess_percent, l.taxable_paise, l.cgst_paise, l.sgst_paise, l.igst_paise,
           l.cess_paise, l.cost_paise,
           coalesce(sum(c.quantity * 1000), 0)::bigint as c_qty, coalesce(sum(c.taxable_paise), 0) as c_taxable,
           coalesce(sum(c.cgst_paise), 0) as c_cgst, coalesce(sum(c.sgst_paise), 0) as c_sgst,
           coalesce(sum(c.igst_paise), 0) as c_igst, coalesce(sum(c.cess_paise), 0) as c_cess,
           coalesce(sum(c.cost_paise), 0) as c_cost
      from lbg.invoice_lines l
      left join (lbg.invoice_lines c join lbg.invoices n on n.business_id = c.business_id and n.id = c.invoice_id
                                                         and n.document_type = 'CREDIT_NOTE' and n.status = 'ISSUED')
             on c.business_id = l.business_id and c.original_line_id = l.id
     where l.business_id = ${ctx.businessId} and l.invoice_id = ${invoiceId}
     group by l.id order by l.line_no`.execute(trx);
  return rows;
}

/** Share `qty` of `total` for `whole` (half up), or exactly the rest when the line is returned in full. */
function share(total: number, credited: number, qty: number, before: number, whole: number): number {
  if (qty + before === whole) return total - credited;
  return Math.min(total - credited, Number((BigInt(total) * BigInt(qty) * 2n + BigInt(whole)) / (BigInt(whole) * 2n)));
}

async function insertNote(
  trx: Trx,
  ctx: TenantContext,
  head: InvoiceHead,
  type: 'CREDIT_NOTE' | 'DEBIT_NOTE',
  reason: string,
  at: Date,
  lines: readonly {
    original: OriginalLine;
    qtyMilli: number;
    unitId: string | null;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
    cost: number | null;
    priceIncludesTax: boolean;
  }[],
  roundOff: number,
): Promise<{ id: string; number: string; totalPaise: number }> {
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess') => lines.reduce((s, l) => s + l[k], 0);
  const lineTotal = (l: (typeof lines)[number]) => l.taxable + l.cgst + l.sgst + l.igst + l.cess;
  const total = lines.reduce((s, l) => s + lineTotal(l), 0) + roundOff;
  const { rows } = await sql<{ id: string }>`
    insert into lbg.invoices (business_id, document_type, financial_year, invoice_date, customer_id,
                              original_invoice_id, place_of_supply_state, gross_paise, taxable_paise, cgst_paise,
                              sgst_paise, igst_paise, cess_paise, round_off_paise, total_paise, created_by, notes)
    values (${ctx.businessId}, ${type}, '2000-01', ${businessDate(at, head.timezone)}::date, ${head.customer_id},
            ${head.id}, ${head.place_of_supply_state}, ${total - roundOff}, ${sum('taxable')}, ${sum('cgst')},
            ${sum('sgst')}, ${sum('igst')}, ${sum('cess')}, ${roundOff}, ${total}, ${ctx.userId}, ${reason})
    returning id`.execute(trx);
  const id = rows[0]?.id;
  if (!id) throw new Error('note insert returned nothing');
  for (const [i, l] of lines.entries()) {
    const o = l.original;
    const t = lineTotal(l);
    await sql`
      insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, unit_id, description, hsn_code,
                                     quantity, unit_price_paise, tax_rate_percent, taxable_paise, cgst_paise,
                                     sgst_paise, igst_paise, cess_paise, line_total_paise, cost_paise, tax_rate_id,
                                     price_includes_tax, cess_percent, gross_paise, original_line_id)
      values (${ctx.businessId}, ${id}, ${i + 1}, ${o.variant_id}, ${l.unitId}, ${o.description}, ${o.hsn_code},
              ${milliToQuantity(l.qtyMilli)}::numeric, ${type === 'CREDIT_NOTE' ? Number(o.unit_price_paise) : l.taxable},
              ${o.tax_rate_percent}::numeric, ${l.taxable}, ${l.cgst}, ${l.sgst}, ${l.igst}, ${l.cess}, ${t}, ${l.cost},
              ${o.tax_rate_id}, ${l.priceIncludesTax}, ${o.cess_percent}::numeric,
              ${l.priceIncludesTax ? t : l.taxable}, ${o.id})`.execute(trx);
  }
  const number = await nextDocumentNumber(trx, ctx, type, at);
  const snapshot = head.party_snapshot ?? {};
  await sql`update lbg.invoices set status = 'ISSUED', series_id = ${number.seriesId},
              financial_year = ${number.financialYear}, invoice_number = ${number.number}, issued_at = ${at},
              issued_by = ${ctx.userId}, party_snapshot = ${JSON.stringify(snapshot)}::jsonb
             where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
  return { id, number: number.number, totalPaise: total };
}

export interface CreditNoteInput extends Settlement {
  readonly reason: string;
  /** Lines of the original invoice and the quantity returned (default: all that is left). */
  readonly lines: readonly { readonly lineNo: number; readonly quantity?: string | undefined }[];
}

export interface IssuedNote {
  readonly noteId: string;
  readonly number: string;
  readonly totalPaise: number;
  /** Paid money released from the invoice (now advance, or refunded). */
  readonly releasedPaise: number;
  readonly refundedPaise: number;
}

/**
 * Credit note against an invoice (FR-TAX-3 AC3): amounts come from the
 * original line snapshots in proportion to the quantity; returned goods go
 * into inspection (FR-INV-6 AC1); the customer owes less, and anything already
 * paid beyond what is now due becomes advance or is refunded.
 */
export async function issueCreditNote(
  db: Db,
  ctx: TenantContext,
  access: { readonly canRefund: boolean },
  invoiceId: string,
  input: CreditNoteInput,
  options: { readonly at?: Date; readonly requestId?: string } = {},
): Promise<IssuedNote> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new ReturnError('INVALID', 'Give a reason of at least 10 characters.');
  if (input.lines.length === 0) throw new ReturnError('INVALID', 'Choose at least one line.');
  const at = options.at ?? new Date();
  return withTenant(db, ctx, async (trx) => {
    const head = await lockInvoice(trx, ctx, invoiceId);
    if (head.customer_id) await lockCustomer(trx, ctx, head.customer_id);
    const originals = await originalLines(trx, ctx, invoiceId);
    const seen = new Set<number>();
    const lines = input.lines.map((req) => {
      const o = originals.find((x) => x.line_no === req.lineNo);
      if (!o || seen.has(req.lineNo)) throw new ReturnError('INVALID', 'Unknown or repeated line.', req.lineNo);
      seen.add(req.lineNo);
      const whole = Number(o.qty_milli);
      const before = Number(o.c_qty);
      let qty: number;
      try {
        qty = req.quantity === undefined ? whole - before : quantityToMilli(req.quantity);
      } catch {
        throw new ReturnError('INVALID', 'Enter a valid quantity.', req.lineNo);
      }
      // FR-TAX-3 / AC4: never more than was sold on this invoice, net of earlier credit notes.
      if (qty <= 0 || qty + before > whole)
        throw new ReturnError('RETURN_EXCEEDS_SOLD', 'More than was sold on this invoice.', req.lineNo);
      const part = (total: string, credited: string) => share(Number(total), Number(credited), qty, before, whole);
      return {
        original: o,
        qtyMilli: qty,
        unitId: o.unit_id,
        taxable: part(o.taxable_paise, o.c_taxable),
        cgst: part(o.cgst_paise, o.c_cgst),
        sgst: part(o.sgst_paise, o.c_sgst),
        igst: part(o.igst_paise, o.c_igst),
        cess: part(o.cess_paise, o.c_cess),
        cost: o.cost_paise === null ? null : part(o.cost_paise, o.c_cost),
        priceIncludesTax: true,
      };
    });
    // The note that leaves nothing on the invoice also takes the rest of its round-off.
    const fullyCredited = originals.every((o) => {
      const l = lines.find((x) => x.original.id === o.id);
      return Number(o.c_qty) + (l?.qtyMilli ?? 0) === Number(o.qty_milli);
    });
    const { rows: ro } = await sql<{ credited_round_off: string }>`
      select coalesce(sum(round_off_paise), 0) as credited_round_off from lbg.invoices
       where business_id = ${ctx.businessId} and original_invoice_id = ${invoiceId}
         and document_type = 'CREDIT_NOTE' and status = 'ISSUED'`.execute(trx);
    const roundOff = fullyCredited ? head.round_off_paise - Number(ro[0]?.credited_round_off ?? 0) : 0;
    const { allocated, credited } = await paidOn(trx, ctx, invoiceId);
    const noteTotal = lines.reduce((s, l) => s + l.taxable + l.cgst + l.sgst + l.igst + l.cess, 0) + roundOff;
    if (noteTotal <= 0) throw new ReturnError('INVALID', 'The credit note would be for nothing.');
    const outstanding = Number(head.total_paise) - allocated - credited;
    const release = Math.max(0, noteTotal - Math.max(outstanding, 0));
    checkSettlement(input, access.canRefund, head.customer_id, release);

    const note = await insertNote(trx, ctx, head, 'CREDIT_NOTE', reason, at, lines, roundOff);
    for (const l of [...lines].sort((a, b) => (a.original.variant_id < b.original.variant_id ? -1 : 1))) {
      if (l.unitId) {
        const unit = await lockUnit(trx, ctx, l.unitId);
        if (unit.status !== 'SOLD') throw new ReturnError('UNIT_NOT_SOLD', 'This unit is not recorded as sold.');
        await setUnitStatus(trx, ctx, unit, 'PENDING_INSPECTION');
      }
      await writeMovement(trx, ctx, {
        variantId: l.original.variant_id,
        unitId: l.unitId,
        type: 'SALE_RETURN',
        quantity: milliToQuantity(l.qtyMilli),
        bucket: 'INSPECTION',
        unitCostPaise: l.unitId ? l.cost : l.cost === null ? null : Math.round((l.cost * 1000) / l.qtyMilli),
        referenceType: 'credit_note',
        referenceId: note.id,
      });
    }
    if (head.customer_id) {
      await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                         reference_type, reference_id, created_by)
                values (${ctx.businessId}, ${head.customer_id}, 'CREDIT_NOTE', ${-note.totalPaise}, 'invoice',
                        ${note.id}, ${ctx.userId})`.execute(trx);
    }
    const released = await releaseAllocations(trx, ctx, invoiceId, release);
    const refunded =
      input.settlement === 'REFUND'
        ? await refundReleased(trx, ctx, head.customer_id, note.id, released, input, reason)
        : 0;
    await recordTenantEvent(trx, ctx, {
      action: 'credit_note.issue',
      targetType: 'invoice',
      targetId: note.id,
      metadata: {
        number: note.number,
        invoiceId,
        totalPaise: note.totalPaise,
        releasedPaise: release,
        refundedPaise: refunded,
      },
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return {
      noteId: note.id,
      number: note.number,
      totalPaise: note.totalPaise,
      releasedPaise: release,
      refundedPaise: refunded,
    };
  });
}

/** Debit note against an invoice (FR-TAX-3 AC4): extra taxable value at the original lines' rates. */
export async function issueDebitNote(
  db: Db,
  ctx: TenantContext,
  invoiceId: string,
  input: {
    readonly reason: string;
    readonly lines: readonly { readonly lineNo: number; readonly taxablePaise: number }[];
  },
  options: { readonly at?: Date; readonly requestId?: string } = {},
): Promise<{ noteId: string; number: string; totalPaise: number }> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new ReturnError('INVALID', 'Give a reason of at least 10 characters.');
  if (input.lines.length === 0) throw new ReturnError('INVALID', 'Choose at least one line.');
  const at = options.at ?? new Date();
  return withTenant(db, ctx, async (trx) => {
    const head = await lockInvoice(trx, ctx, invoiceId);
    if (!head.customer_id) throw new ReturnError('NEEDS_CUSTOMER', 'A debit note needs the customer who owes it.');
    await lockCustomer(trx, ctx, head.customer_id);
    const originals = await originalLines(trx, ctx, invoiceId);
    const picked = input.lines.map((req) => {
      const o = originals.find((x) => x.line_no === req.lineNo);
      if (!o) throw new ReturnError('INVALID', 'Unknown line.', req.lineNo);
      if (!Number.isSafeInteger(req.taxablePaise) || req.taxablePaise <= 0)
        throw new ReturnError('INVALID', 'Enter a positive amount.', req.lineNo);
      return { o, taxable: req.taxablePaise };
    });
    const chargeTax = head.document_type === 'TAX_INVOICE';
    const computed = computeSale({
      lines: picked.map((p) => ({
        qtyMilli: 1000,
        unitPricePaise: p.taxable,
        priceIncludesTax: false,
        rateBp: rateToBasisPoints(p.o.tax_rate_percent),
        cessBp: rateToBasisPoints(p.o.cess_percent),
      })),
      interState: head.place_of_supply_state !== head.party_snapshot?.seller?.stateCode,
      chargeTax,
      roundOff: false,
    });
    const lines = picked.map((p, i) => {
      const r = computed.lines[i];
      if (!r) throw new Error('debit note lost a line');
      return {
        original: p.o,
        qtyMilli: 1000,
        unitId: null,
        taxable: r.taxablePaise,
        cgst: r.cgstPaise,
        sgst: r.sgstPaise,
        igst: r.igstPaise,
        cess: r.cessPaise,
        cost: null,
        priceIncludesTax: false,
      };
    });
    const note = await insertNote(trx, ctx, head, 'DEBIT_NOTE', reason, at, lines, 0);
    await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                       reference_type, reference_id, created_by)
              values (${ctx.businessId}, ${head.customer_id}, 'DEBIT_NOTE', ${note.totalPaise}, 'invoice', ${note.id},
                      ${ctx.userId})`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'debit_note.issue',
      targetType: 'invoice',
      targetId: note.id,
      metadata: { number: note.number, invoiceId, totalPaise: note.totalPaise },
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return { noteId: note.id, number: note.number, totalPaise: note.totalPaise };
  });
}
