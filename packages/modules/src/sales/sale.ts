// Draft sales and issuing (increment 5.3: FR-POS-1…3, FR-INV-5 AC2–4,
// FR-LED-1, FR-TAX-1 AC4, D-040). A draft invoice is the cart. Issuing runs
// in one transaction: numbering, line snapshots, stock movements, unit
// status, payments, allocations, ledger and audit — any failure writes nothing.
import { allocate, discountWithinLimit, milliToQuantity, NumberingError, type Discount } from '@lbgos/domain';
import { sql } from 'kysely';
import { allocatePayment, withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { createApprovalRequest, type ApprovalAction, type DeciderPermissions } from '../approvals/index.ts';
import { recordTenantEvent } from '../audit/index.ts';
import { setUnitStatus, writeMovement } from '../inventory/index.ts';
import { nextDocumentNumber } from './numbering.ts';
import { customerFundsIn, isCardLike } from './payments.ts';
import {
  discountColumns,
  normaliseLines,
  priceSale,
  saleProblems,
  SaleError,
  toDiscount,
  type DiscountApproval,
  type PricedSale,
  type SaleDraftInput,
  type SaleProblem,
  type SellerAccess,
  type StoredLine,
} from './pricing.ts';

export const DISCOUNT_ACTION = 'sales.discount';

interface DraftRow {
  id: string;
  status: string;
  customer_id: string | null;
  invoice_discount_kind: string | null;
  invoice_discount_value: string | null;
  notes: string | null;
  discount_approved_by: string | null;
  approved_discount_paise: string | null;
  approved_content_sha256: string | null;
  created_by: string | null;
  created_at: Date;
}

interface Draft {
  readonly id: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly invoiceDiscount: Discount | null;
  readonly notes: string | null;
  readonly approval: DiscountApproval;
  readonly lines: StoredLine[];
}

async function loadDraft(trx: Trx, ctx: TenantContext, id: string, lock: boolean): Promise<Draft> {
  const row = (
    await sql<DraftRow>`
      select id, status, customer_id, invoice_discount_kind, invoice_discount_value, notes, discount_approved_by,
             approved_discount_paise, approved_content_sha256, created_by, created_at
        from lbg.invoices
       where business_id = ${ctx.businessId} and id = ${id}
         and document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY')
       ${lock ? sql`for update` : sql``}`.execute(trx)
  ).rows[0];
  if (!row) throw new SaleError('NOT_FOUND', 'sale not found');
  const { rows } = await sql<{
    variant_id: string;
    unit_id: string | null;
    qty_milli: string;
    unit_price_paise: string;
    line_discount_kind: string | null;
    line_discount_value: string | null;
  }>`select variant_id, unit_id, (quantity * 1000)::bigint as qty_milli, unit_price_paise, line_discount_kind,
            line_discount_value
       from lbg.invoice_lines where business_id = ${ctx.businessId} and invoice_id = ${id} order by line_no`.execute(
    trx,
  );
  return {
    id: row.id,
    status: row.status,
    customerId: row.customer_id,
    invoiceDiscount: toDiscount(row.invoice_discount_kind, row.invoice_discount_value),
    notes: row.notes,
    approval: {
      approvedBy: row.discount_approved_by,
      approvedDiscountPaise: row.approved_discount_paise === null ? null : Number(row.approved_discount_paise),
      approvedContentSha256: row.approved_content_sha256,
    },
    lines: rows.map((r) => ({
      variantId: r.variant_id,
      unitId: r.unit_id,
      qtyMilli: Number(r.qty_milli),
      unitPricePaise: Number(r.unit_price_paise),
      discount: toDiscount(r.line_discount_kind, r.line_discount_value),
    })),
  };
}

/** Replaces the lines and header amounts of a draft with `priced`. */
async function writePriced(
  trx: Trx,
  ctx: TenantContext,
  id: string,
  priced: PricedSale,
  costs: readonly (number | null)[] | null,
): Promise<void> {
  await sql`delete from lbg.invoice_lines where business_id = ${ctx.businessId} and invoice_id = ${id}`.execute(trx);
  const taxed = priced.documentType === 'TAX_INVOICE';
  for (const [i, l] of priced.lines.entries()) {
    const a = l.amounts;
    const d = discountColumns(l.discount);
    const rate = taxed ? l.facts.taxRate : null;
    await sql`
      insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, unit_id, description, hsn_code,
                                     quantity, unit_price_paise, discount_paise, tax_rate_percent, taxable_paise,
                                     cgst_paise, sgst_paise, igst_paise, cess_paise, line_total_paise, cost_paise,
                                     tax_rate_id, price_includes_tax, cess_percent, gross_paise, line_discount_kind,
                                     line_discount_value, invoice_discount_paise)
      values (${ctx.businessId}, ${id}, ${i + 1}, ${l.variantId}, ${l.unitId}, ${l.facts.description},
              ${l.facts.hsnCode}, ${milliToQuantity(l.qtyMilli)}::numeric, ${l.unitPricePaise}, ${a.lineDiscountPaise},
              ${rate?.ratePercent ?? '0'}::numeric, ${a.taxablePaise}, ${a.cgstPaise}, ${a.sgstPaise}, ${a.igstPaise},
              ${a.cessPaise}, ${a.totalPaise}, ${costs?.[i] ?? null}, ${rate?.id ?? null}, ${l.facts.priceIncludesTax},
              ${rate?.cessPercent ?? '0'}::numeric, ${a.grossPaise}, ${d.kind}, ${d.value}, ${a.invoiceDiscountPaise})`.execute(
      trx,
    );
  }
  const r = priced.result;
  const inv = discountColumns(priced.invoiceDiscount);
  await sql`
    update lbg.invoices
       set document_type = ${priced.documentType}, invoice_date = ${priced.invoiceDate}::date,
           customer_id = ${priced.customer?.id ?? null}, place_of_supply_state = ${priced.placeOfSupply},
           invoice_discount_kind = ${inv.kind}, invoice_discount_value = ${inv.value},
           gross_paise = ${r.grossPaise}, discount_paise = ${r.discountPaise}, taxable_paise = ${r.taxablePaise},
           cgst_paise = ${r.cgstPaise}, sgst_paise = ${r.sgstPaise}, igst_paise = ${r.igstPaise},
           cess_paise = ${r.cessPaise}, round_off_paise = ${r.roundOffPaise}, total_paise = ${r.totalPaise}
     where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
}

export interface SaleView {
  readonly id: string;
  readonly status: string;
  readonly documentType: string;
  readonly invoiceDate: string;
  readonly customer: { readonly id: string; readonly name: string; readonly mobileE164: string | null } | null;
  readonly placeOfSupply: string;
  readonly interState: boolean;
  readonly lines: readonly {
    readonly variantId: string;
    readonly unitId: string | null;
    readonly description: string;
    readonly hsnCode: string | null;
    readonly quantity: string;
    readonly unitPricePaise: number;
    readonly discount: Discount | null;
    readonly priceIncludesTax: boolean;
    readonly taxRatePercent: string | null;
    readonly amounts: PricedSale['result']['lines'][number];
  }[];
  readonly invoiceDiscount: Discount | null;
  readonly totals: Omit<PricedSale['result'], 'lines'>;
  readonly contentSha256: string;
  readonly discountApproved: boolean;
  readonly problems: readonly SaleProblem[];
  readonly notes: string | null;
}

function view(draft: Draft, priced: PricedSale, problems: SaleProblem[]): SaleView {
  const r = priced.result;
  const totals = {
    grossPaise: r.grossPaise,
    discountPaise: r.discountPaise,
    taxablePaise: r.taxablePaise,
    cgstPaise: r.cgstPaise,
    sgstPaise: r.sgstPaise,
    igstPaise: r.igstPaise,
    cessPaise: r.cessPaise,
    roundOffPaise: r.roundOffPaise,
    totalPaise: r.totalPaise,
  };
  return {
    id: draft.id,
    status: draft.status,
    documentType: priced.documentType,
    invoiceDate: priced.invoiceDate,
    customer: priced.customer
      ? { id: priced.customer.id, name: priced.customer.name, mobileE164: priced.customer.mobileE164 }
      : null,
    placeOfSupply: priced.placeOfSupply,
    interState: priced.interState,
    lines: priced.lines.map((l) => ({
      variantId: l.variantId,
      unitId: l.unitId,
      description: l.facts.description,
      hsnCode: l.facts.hsnCode,
      quantity: milliToQuantity(l.qtyMilli),
      unitPricePaise: l.unitPricePaise,
      discount: l.discount,
      priceIncludesTax: l.facts.priceIncludesTax,
      taxRatePercent: priced.documentType === 'TAX_INVOICE' ? (l.facts.taxRate?.ratePercent ?? null) : null,
      amounts: l.amounts,
    })),
    invoiceDiscount: priced.invoiceDiscount,
    totals,
    contentSha256: priced.contentSha256,
    discountApproved: !problems.some((p) => p.code === 'DISCOUNT_NEEDS_APPROVAL') && priced.result.discountPaise > 0,
    problems,
    notes: draft.notes,
  };
}

async function saveDraftIn(
  trx: Trx,
  ctx: TenantContext,
  access: SellerAccess,
  id: string,
  input: SaleDraftInput,
  at: Date,
): Promise<SaleView> {
  const draft = await loadDraft(trx, ctx, id, true);
  if (draft.status !== 'DRAFT') throw new SaleError('NOT_DRAFT', 'This sale has already been completed.');
  const lines = await normaliseLines(trx, ctx, input.lines);
  const customerId = input.customerId ?? null;
  const invoiceDiscount = input.invoiceDiscount ?? null;
  const priced = await priceSale(trx, ctx, { customerId, lines, invoiceDiscount, at });
  await writePriced(trx, ctx, id, priced, null);
  // An approval covers only the content it was given for (FR-POS-2 AC2).
  let approval = draft.approval;
  if (approval.approvedContentSha256 !== priced.contentSha256 && approval.approvedBy !== null) {
    await sql`update lbg.invoices set discount_approval_id = null, discount_approved_by = null,
                approved_discount_paise = null, approved_content_sha256 = null
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    approval = { approvedBy: null, approvedDiscountPaise: null, approvedContentSha256: null };
  }
  await sql`update lbg.invoices set notes = ${input.notes ?? null} where business_id = ${ctx.businessId} and id = ${id}`.execute(
    trx,
  );
  const saved = { ...draft, customerId, invoiceDiscount, lines, notes: input.notes ?? null, approval };
  return view(saved, priced, saleProblems(priced, access, approval));
}

export async function createSaleDraft(
  db: Db,
  ctx: TenantContext,
  access: SellerAccess,
  input: SaleDraftInput,
  at: Date = new Date(),
): Promise<SaleView> {
  return withTenant(db, ctx, async (trx) => {
    // Provisional header; saveDraftIn derives the real values.
    const { rows } = await sql<{ id: string }>`
      insert into lbg.invoices (business_id, document_type, financial_year, invoice_date, place_of_supply_state,
                                created_by)
      select ${ctx.businessId}, 'BILL_OF_SUPPLY', '2000-01', current_date, coalesce(b.state_code, '00'), ${ctx.userId}
        from lbg.businesses b where b.id = ${ctx.businessId}
      returning id`.execute(trx);
    const id = rows[0]?.id;
    if (!id) throw new Error('draft insert returned nothing');
    return saveDraftIn(trx, ctx, access, id, input, at);
  });
}

export async function updateSaleDraft(
  db: Db,
  ctx: TenantContext,
  access: SellerAccess,
  id: string,
  input: SaleDraftInput,
  at: Date = new Date(),
): Promise<SaleView> {
  return withTenant(db, ctx, (trx) => saveDraftIn(trx, ctx, access, id, input, at));
}

export async function getSale(
  db: Db,
  ctx: TenantContext,
  access: SellerAccess,
  id: string,
  at: Date = new Date(),
): Promise<SaleView> {
  return withTenant(db, ctx, async (trx) => {
    const draft = await loadDraft(trx, ctx, id, false);
    if (draft.status !== 'DRAFT') throw new SaleError('NOT_DRAFT', 'This sale has already been completed.');
    const priced = await priceSale(trx, ctx, { ...draft, at });
    return view(draft, priced, saleProblems(priced, access, draft.approval));
  });
}

export interface HeldSale {
  readonly id: string;
  readonly customerName: string | null;
  readonly lineCount: number;
  readonly totalPaise: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** Held carts (FR-POS-1 AC4): drafts of this business, newest first. */
export async function listHeldSales(db: Db, ctx: TenantContext): Promise<HeldSale[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      customer_name: string | null;
      line_count: number;
      total_paise: string;
      created_by: string | null;
      created_at: Date;
    }>`
      select i.id, c.name as customer_name,
             (select count(*)::int from lbg.invoice_lines l where l.business_id = i.business_id and l.invoice_id = i.id) as line_count,
             i.total_paise, i.created_by, i.created_at
        from lbg.invoices i left join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id
       where i.business_id = ${ctx.businessId} and i.status = 'DRAFT'
         and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY')
       order by i.created_at desc limit 100`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      customerName: r.customer_name,
      lineCount: r.line_count,
      totalPaise: Number(r.total_paise),
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
    }));
  });
}

export async function discardSale(db: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const draft = await loadDraft(trx, ctx, id, true);
    if (draft.status !== 'DRAFT') throw new SaleError('NOT_DRAFT', 'This sale has already been completed.');
    await sql`update lbg.invoices set status = 'DISCARDED' where business_id = ${ctx.businessId} and id = ${id}`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, { action: 'sale.discard', targetType: 'invoice', targetId: id });
  });
}

// ---------------------------------------------------------------------------
// Over-limit discounts (FR-POS-2 AC2)
// ---------------------------------------------------------------------------

export interface DiscountApprovalPayload {
  readonly invoiceId: string;
  readonly contentSha256: string;
  readonly discountPaise: number;
  readonly grossPaise: number;
  readonly totalPaise: number;
}

export async function requestDiscountApproval(
  db: Db,
  ctx: TenantContext,
  access: SellerAccess,
  id: string,
  reason: string,
  at: Date = new Date(),
): Promise<{ id: string; payloadSha256: string }> {
  return withTenant(db, ctx, async (trx) => {
    const draft = await loadDraft(trx, ctx, id, true);
    if (draft.status !== 'DRAFT') throw new SaleError('NOT_DRAFT', 'This sale has already been completed.');
    const priced = await priceSale(trx, ctx, { ...draft, at });
    const { discountPaise, grossPaise, totalPaise } = priced.result;
    if (discountWithinLimit(access.discount, discountPaise, grossPaise)) {
      throw new SaleError('APPROVAL_NOT_NEEDED', 'This discount is within your limit.');
    }
    const payload: DiscountApprovalPayload = {
      invoiceId: id,
      contentSha256: priced.contentSha256,
      discountPaise,
      grossPaise,
      totalPaise,
    };
    return createApprovalRequest(trx, ctx, {
      actionType: DISCOUNT_ACTION,
      payload,
      requiredPermission: 'pos.discount',
      reason,
    });
  });
}

function isPayload(p: unknown): p is DiscountApprovalPayload {
  const x = p as Partial<DiscountApprovalPayload> | null;
  return (
    typeof x?.invoiceId === 'string' &&
    typeof x.contentSha256 === 'string' &&
    typeof x.discountPaise === 'number' &&
    typeof x.grossPaise === 'number'
  );
}

/**
 * Approval action: the approver's own discount limit must cover the discount;
 * on execution the draft records the approver, the approved amount and the
 * content it covers. A draft changed since the request fails the execution.
 */
export const discountApprovalAction: ApprovalAction = {
  authorize(permissions: DeciderPermissions, payload: unknown) {
    if (!isPayload(payload)) return 'This request is malformed.';
    const grant =
      'get' in permissions
        ? permissions.get('pos.discount')
        : permissions.has('pos.discount')
          ? { limits: undefined }
          : undefined;
    return discountWithinLimit(grant, payload.discountPaise, payload.grossPaise)
      ? null
      : 'Your discount limit does not cover this discount.';
  },
  async execute(trx, ctx, payload, requestId) {
    if (!isPayload(payload)) throw Object.assign(new Error('malformed payload'), { code: 'MALFORMED' });
    const draft = await loadDraft(trx, ctx, payload.invoiceId, true).catch(() => null);
    if (draft?.status !== 'DRAFT') throw Object.assign(new Error('not a draft'), { code: 'SALE_NOT_DRAFT' });
    const priced = await priceSale(trx, ctx, { ...draft, at: new Date() });
    if (priced.contentSha256 !== payload.contentSha256 || priced.result.discountPaise > payload.discountPaise) {
      throw Object.assign(new Error('sale changed'), { code: 'SALE_CHANGED' });
    }
    await sql`update lbg.invoices set discount_approval_id = ${requestId}, discount_approved_by = ${ctx.userId},
                approved_discount_paise = ${payload.discountPaise}, approved_content_sha256 = ${payload.contentSha256}
               where business_id = ${ctx.businessId} and id = ${payload.invoiceId}`.execute(trx);
    return { invoiceId: payload.invoiceId, approvedDiscountPaise: payload.discountPaise };
  },
};

// ---------------------------------------------------------------------------
// Issuing (checkout)
// ---------------------------------------------------------------------------

export type CheckoutMethod = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';

export interface CheckoutPayment {
  readonly method: CheckoutMethod;
  readonly amountPaise: number;
  /** UPI reference or card last 4 digits; never a full card number (FR-POS-3 AC4). */
  readonly reference?: string | null | undefined;
  /** Cash handed over; the change is returned (FR-POS-3 AC3). */
  readonly tenderedPaise?: number | null | undefined;
}

export interface IssueInput {
  /** The total the cashier confirmed; issuing is refused if the recomputed total differs. */
  readonly expectedTotalPaise: number;
  readonly payments: readonly CheckoutPayment[];
  /** Amount of the customer's advance to use (FR-POS-3 AC1 "customer advance"). */
  readonly useAdvancePaise?: number | undefined;
}

export interface IssuedSale {
  readonly invoiceId: string;
  readonly documentType: string;
  readonly number: string;
  readonly invoiceDate: string;
  readonly totalPaise: number;
  readonly paidPaise: number;
  readonly advanceUsedPaise: number;
  readonly balanceDuePaise: number;
  /** Paid beyond the total, held as customer advance. */
  readonly advanceAddedPaise: number;
  readonly changePaise: number;
}

function checkPayments(payments: readonly CheckoutPayment[]): number {
  let change = 0;
  for (const p of payments) {
    if (!Number.isSafeInteger(p.amountPaise) || p.amountPaise <= 0)
      throw new SaleError('PAYMENT_INVALID', 'Each payment must be a positive amount.');
    if (isCardLike(p.reference)) {
      throw new SaleError('PAYMENT_INVALID', 'Do not enter full card numbers; record only the last 4 digits.');
    }
    if (p.tenderedPaise !== undefined && p.tenderedPaise !== null) {
      if (p.method !== 'CASH') throw new SaleError('PAYMENT_INVALID', 'Only cash payments have a tendered amount.');
      if (p.tenderedPaise < p.amountPaise)
        throw new SaleError('PAYMENT_INVALID', 'The cash tendered is less than the amount.');
      change += p.tenderedPaise - p.amountPaise;
    }
  }
  return change;
}

const pgCode = (err: unknown) => (err as { code?: unknown }).code;

export async function issueSale(
  db: Db,
  ctx: TenantContext,
  access: SellerAccess,
  id: string,
  input: IssueInput,
  options: { readonly at?: Date; readonly requestId?: string } = {},
): Promise<IssuedSale> {
  const at = options.at ?? new Date();
  const changePaise = checkPayments(input.payments);
  try {
    return await withTenant(db, ctx, async (trx) => {
      const draft = await loadDraft(trx, ctx, id, true);
      if (draft.status !== 'DRAFT') throw new SaleError('NOT_DRAFT', 'This sale has already been completed.');
      if (draft.lines.length === 0) throw new SaleError('INVALID_LINE', 'Add at least one item.');
      if (draft.customerId) {
        // Serialises checkouts and payments of one customer (advance use, D-014).
        await sql`select id from lbg.customers where business_id = ${ctx.businessId} and id = ${draft.customerId}
                   for update`.execute(trx);
      }
      // Units are locked in a fixed order so concurrent carts cannot deadlock;
      // a second sale of the same unit waits here and then sees it SOLD.
      const unitIds = draft.lines.flatMap((l) => (l.unitId ? [l.unitId] : [])).sort();
      if (unitIds.length > 0) {
        await sql`select id from lbg.serialized_units where business_id = ${ctx.businessId}
                   and id = any(${unitIds}::uuid[]) order by id for update`.execute(trx);
      }
      const priced = await priceSale(trx, ctx, { ...draft, at });
      const problems = saleProblems(priced, access, draft.approval);
      if (problems.length > 0) {
        const unit = problems.find((p) => p.code === 'UNIT_NOT_AVAILABLE');
        if (unit) throw new SaleError('UNIT_NOT_AVAILABLE', unit.message, { problems });
        throw new SaleError('NOT_READY', 'This sale cannot be completed yet.', { problems });
      }
      const total = priced.result.totalPaise;
      if (total !== input.expectedTotalPaise) {
        throw new SaleError('TOTAL_CHANGED', 'The total has changed. Check the sale and confirm the new total.');
      }

      const paid = input.payments.reduce((s, p) => s + p.amountPaise, 0);
      const useAdvance = input.useAdvancePaise ?? 0;
      const customer = priced.customer;
      if (!Number.isSafeInteger(useAdvance) || useAdvance < 0)
        throw new SaleError('PAYMENT_INVALID', 'Invalid advance amount.');
      if (useAdvance > 0 && !customer)
        throw new SaleError('INSUFFICIENT_ADVANCE', 'Choose the customer whose advance is used.');
      if (useAdvance > total) throw new SaleError('PAYMENT_INVALID', 'The advance used is more than the total.');
      if (useAdvance > 0 && paid + useAdvance > total)
        throw new SaleError('PAYMENT_INVALID', 'Use less advance: the payments already cover the total.');
      const balance = total - useAdvance - paid;
      // D-014: a balance due, or money kept as advance, needs a customer with a mobile number.
      if (balance > 0 && !customer?.mobileE164)
        throw new SaleError('BALANCE_NEEDS_CUSTOMER', 'A part-paid sale needs a customer with a mobile number.');
      if (balance < 0 && !customer?.mobileE164)
        throw new SaleError(
          'OVERPAYMENT_NEEDS_CUSTOMER',
          'The payments are more than the total. Reduce them, or choose a customer to hold the rest as advance.',
        );
      const funds = customer && useAdvance > 0 ? await customerFundsIn(trx, ctx, customer.id) : [];
      if (funds.reduce((s, f) => s + f.unallocatedPaise, 0) < useAdvance)
        throw new SaleError('INSUFFICIENT_ADVANCE', 'The customer does not have that much advance.');

      // COGS snapshot (D-017): unit cost for serialized items, average cost otherwise.
      const costs = priced.lines.map((l) =>
        l.facts.unit
          ? l.facts.unit.costPaise
          : l.facts.avgCostPaise === null
            ? null
            : Number((BigInt(l.facts.avgCostPaise) * BigInt(l.qtyMilli) + 500n) / 1000n),
      );
      await writePriced(trx, ctx, id, priced, costs);

      // Stock-level rows are locked by the movement trigger; a fixed order avoids deadlocks.
      const byVariant = [...priced.lines.entries()].sort(([, a], [, b]) =>
        a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
      );
      for (const [i, l] of byVariant) {
        const movement = {
          variantId: l.variantId,
          type: 'SALE' as const,
          referenceType: 'invoice',
          referenceId: id,
        };
        if (l.unitId && l.facts.unit) {
          await writeMovement(trx, ctx, {
            ...movement,
            unitId: l.unitId,
            quantity: '-1',
            unitCostPaise: l.facts.unit.costPaise,
          });
          await setUnitStatus(
            trx,
            ctx,
            { id: l.unitId, variantId: l.variantId, status: 'IN_STOCK', unitCostPaise: l.facts.unit.costPaise },
            'SOLD',
          );
        } else {
          await writeMovement(trx, ctx, {
            ...movement,
            quantity: `-${milliToQuantity(l.qtyMilli)}`,
            unitCostPaise: l.facts.avgCostPaise ?? costs[i] ?? null,
          });
        }
      }

      const number = await nextDocumentNumber(trx, ctx, priced.documentType, at);
      const snapshot = {
        seller: {
          legalName: priced.seller.legalName,
          displayName: priced.seller.displayName,
          registrationType: priced.seller.registrationType,
          gstin: priced.seller.gstin,
          stateCode: priced.seller.stateCode,
        },
        buyer: customer
          ? {
              name: customer.name,
              mobileE164: customer.mobileE164,
              gstin: customer.gstin,
              stateCode: customer.stateCode,
              address: customer.address,
            }
          : null,
      };
      await sql`
        update lbg.invoices
           set status = 'ISSUED', series_id = ${number.seriesId}, financial_year = ${number.financialYear},
               invoice_number = ${number.number}, issued_at = ${at}, issued_by = ${ctx.userId},
               party_snapshot = ${JSON.stringify(snapshot)}::jsonb
         where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);

      // Payments as entered (FR-POS-3 AC6: recorded, not verified settlement).
      const newPayments: { id: string; unallocatedPaise: number }[] = [];
      for (const p of input.payments) {
        const { rows } = await sql<{ id: string }>`
          insert into lbg.payments (business_id, customer_id, method, amount_paise, reference, received_at,
                                    recorded_by, cash_tendered_paise)
          values (${ctx.businessId}, ${customer?.id ?? null}, ${p.method}, ${p.amountPaise}, ${p.reference ?? null},
                  ${at}, ${ctx.userId}, ${p.tenderedPaise ?? null})
          returning id`.execute(trx);
        const paymentId = rows[0]?.id;
        if (!paymentId) throw new Error('payment insert returned nothing');
        newPayments.push({ id: paymentId, unallocatedPaise: p.amountPaise });
      }
      const allocations = [
        ...allocate(funds, [{ id, date: priced.invoiceDate, number: number.number, outstandingPaise: useAdvance }]),
        ...allocate(newPayments, [
          { id, date: priced.invoiceDate, number: number.number, outstandingPaise: total - useAdvance },
        ]),
      ];
      for (const a of allocations) await allocatePayment(trx, ctx, a.paymentId, a.invoiceId, a.amountPaise);

      // Customer ledger (FR-LED-1). A zero-total invoice has no ledger effect.
      if (customer && total > 0) {
        await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                           reference_type, reference_id, created_by, created_at)
                  values (${ctx.businessId}, ${customer.id}, 'INVOICE', ${total}, 'invoice', ${id}, ${ctx.userId},
                          ${at})`.execute(trx);
      }
      if (customer) {
        for (const p of newPayments) {
          await sql`insert into lbg.customer_ledger_entries (business_id, customer_id, entry_type, amount_paise,
                                                             reference_type, reference_id, created_by, created_at)
                    values (${ctx.businessId}, ${customer.id}, 'PAYMENT', ${-p.unallocatedPaise}, 'payment', ${p.id},
                            ${ctx.userId}, ${at})`.execute(trx);
        }
      }
      await recordTenantEvent(trx, ctx, {
        action: 'sale.issue',
        targetType: 'invoice',
        targetId: id,
        metadata: {
          number: number.number,
          documentType: priced.documentType,
          totalPaise: total,
          discountPaise: priced.result.discountPaise,
          discountApprovedBy: draft.approval.approvedBy,
        },
        ...(options.requestId ? { requestId: options.requestId } : {}),
      });
      return {
        invoiceId: id,
        documentType: priced.documentType,
        number: number.number,
        invoiceDate: priced.invoiceDate,
        totalPaise: total,
        paidPaise: paid,
        advanceUsedPaise: useAdvance,
        balanceDuePaise: Math.max(balance, 0),
        advanceAddedPaise: Math.max(-balance, 0),
        changePaise,
      };
    });
  } catch (err) {
    if (pgCode(err) === 'LB015') throw new SaleError('INSUFFICIENT_STOCK', 'There is not enough stock for this sale.');
    if (err instanceof NumberingError && err.code === 'SERIES_EXHAUSTED') {
      throw new SaleError('SERIES_EXHAUSTED', 'The invoice number series is full. Change the number format.');
    }
    throw err;
  }
}
