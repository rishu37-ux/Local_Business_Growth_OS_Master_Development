// Pricing a draft sale (FR-POS-1 AC2, FR-POS-2, FR-TAX-1, D-038, D-040). The
// draft stores what the cashier entered (items, units, prices, discounts);
// everything else — tax rate in force, place of supply, document type,
// amounts — is derived here from current facts, both when the draft is saved
// and again when it is issued.
import { createHash } from 'node:crypto';
import {
  computeSale,
  discountWithinLimit,
  milliToQuantity,
  placeOfSupply,
  quantityToMilli,
  rateToBasisPoints,
  TaxEngineError,
  type Discount,
  type EffectiveGrant,
  type SaleResult,
} from '@lbgos/domain';
import { sql } from 'kysely';
import type { TenantContext, Trx } from '@lbgos/db';
import { canonicalJson } from '../approvals/index.ts';
import type { DocumentType } from './numbering.ts';

export interface SaleLineSpec {
  /** Optional when `unitId` is given (the unit's variant is used). */
  readonly variantId?: string | undefined;
  /** Serialized items: the specific unit sold (FR-POS-1 AC2). */
  readonly unitId?: string | null | undefined;
  /** Decimal text, up to 3 decimals; serialized lines are always 1. */
  readonly quantity?: string | undefined;
  /** Price per unit as entered; defaults to the catalogue selling price. */
  readonly unitPricePaise?: number | undefined;
  readonly discount?: Discount | null | undefined;
}

export interface SaleDraftInput {
  readonly customerId?: string | null | undefined;
  readonly lines: readonly SaleLineSpec[];
  readonly invoiceDiscount?: Discount | null | undefined;
  readonly notes?: string | null | undefined;
}

/** What the person selling may do (from their effective permissions). */
export interface SellerAccess {
  /** The pos.discount grant; undefined when not held. */
  readonly discount: EffectiveGrant | undefined;
  readonly priceOverride: boolean;
}

export type SaleProblemCode =
  | 'UNIT_REQUIRED'
  | 'UNIT_NOT_AVAILABLE'
  | 'ITEM_ARCHIVED'
  | 'NO_TAX_RATE'
  | 'BELOW_MIN_PRICE'
  | 'DISCOUNT_NEEDS_APPROVAL'
  | 'INSUFFICIENT_STOCK';

export interface SaleProblem {
  readonly code: SaleProblemCode;
  readonly lineIndex?: number;
  readonly message: string;
}

export class SaleError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'NOT_DRAFT'
    | 'INVALID_LINE'
    | 'CUSTOMER_NOT_FOUND'
    | 'DISCOUNT_EXCEEDS_VALUE'
    | 'NOT_READY'
    | 'TOTAL_CHANGED'
    | 'PAYMENT_INVALID'
    | 'BALANCE_NEEDS_CUSTOMER'
    | 'OVERPAYMENT_NEEDS_CUSTOMER'
    | 'INSUFFICIENT_ADVANCE'
    | 'INSUFFICIENT_STOCK'
    | 'UNIT_NOT_AVAILABLE'
    | 'APPROVAL_NOT_NEEDED'
    | 'SERIES_EXHAUSTED';
  readonly lineIndex: number | undefined;
  readonly problems: readonly SaleProblem[] | undefined;

  constructor(code: SaleError['code'], message: string, extra: { lineIndex?: number; problems?: SaleProblem[] } = {}) {
    super(message);
    this.name = 'SaleError';
    this.code = code;
    this.lineIndex = extra.lineIndex;
    this.problems = extra.problems;
  }
}

/** A draft line as stored (the cashier's input). */
export interface StoredLine {
  readonly variantId: string;
  readonly unitId: string | null;
  readonly qtyMilli: number;
  readonly unitPricePaise: number;
  readonly discount: Discount | null;
}

interface LineFacts {
  readonly variantId: string;
  readonly serialized: boolean;
  readonly archived: boolean;
  readonly description: string;
  readonly hsnCode: string | null;
  readonly priceIncludesTax: boolean;
  readonly minPricePaise: number | null;
  readonly avgCostPaise: number | null;
  /** The tax-rate version in force on the invoice date (null: none set or none in force). */
  readonly taxRate: { readonly id: string; readonly ratePercent: string; readonly cessPercent: string } | null;
  readonly unit: { readonly status: string; readonly costPaise: number } | null;
  readonly availableMilli: number;
}

export interface PricedLine extends StoredLine {
  readonly facts: LineFacts;
  readonly amounts: SaleResult['lines'][number];
}

export interface PricedSale {
  readonly documentType: Extract<DocumentType, 'TAX_INVOICE' | 'BILL_OF_SUPPLY'>;
  readonly invoiceDate: string;
  readonly placeOfSupply: string;
  readonly interState: boolean;
  readonly customer: CustomerFacts | null;
  readonly lines: readonly PricedLine[];
  readonly invoiceDiscount: Discount | null;
  readonly result: SaleResult;
  /** SHA-256 of the cashier's input; a discount approval covers exactly this content. */
  readonly contentSha256: string;
  readonly seller: SellerFacts;
}

export interface CustomerFacts {
  readonly id: string;
  readonly name: string;
  readonly mobileE164: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly address: string | null;
  readonly erased: boolean;
}

export interface SellerFacts {
  readonly legalName: string;
  readonly displayName: string | null;
  readonly registrationType: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
  readonly gstin: string | null;
  readonly stateCode: string;
  readonly timezone: string;
  readonly roundOff: boolean;
  readonly allowNegativeStock: boolean;
  /** Printed on documents (D-044). */
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly terms: string | null;
}

export function toDiscount(kind: string | null, value: string | number | null): Discount | null {
  if (kind === null || value === null) return null;
  return kind === 'PERCENT' ? { kind: 'PERCENT', bp: Number(value) } : { kind: 'AMOUNT', paise: Number(value) };
}

export const discountColumns = (d: Discount | null | undefined) =>
  d ? { kind: d.kind, value: d.kind === 'PERCENT' ? d.bp : d.paise } : { kind: null, value: null };

export function contentHash(customerId: string | null, lines: readonly StoredLine[], invoiceDiscount: Discount | null) {
  return createHash('sha256').update(canonicalJson({ customerId, lines, invoiceDiscount })).digest('hex');
}

/** Business date (yyyy-mm-dd) of `at` in `timeZone`. */
export function businessDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export async function sellerFacts(trx: Trx, ctx: TenantContext): Promise<SellerFacts> {
  const { rows } = await sql<{
    legal_name: string;
    display_name: string | null;
    registration_type: SellerFacts['registrationType'] | null;
    gstin: string | null;
    state_code: string | null;
    timezone: string;
    round_off: boolean | null;
    allow_negative_stock: boolean | null;
    business_address: string | null;
    business_phone: string | null;
    business_email: string | null;
    invoice_terms: string | null;
  }>`
    select b.legal_name, b.display_name, t.registration_type, t.gstin, coalesce(t.state_code, b.state_code) as state_code,
           b.timezone, s.round_off, s.allow_negative_stock, s.business_address, s.business_phone,
           s.business_email::text as business_email, s.invoice_terms
      from lbg.businesses b
      left join lbg.tax_profiles t on t.business_id = b.id
      left join lbg.business_settings s on s.business_id = b.id
     where b.id = ${ctx.businessId}`.execute(trx);
  const r = rows[0];
  if (!r?.state_code) throw new Error('business state is not set');
  return {
    legalName: r.legal_name,
    displayName: r.display_name,
    registrationType: r.registration_type ?? 'UNREGISTERED',
    gstin: r.gstin,
    stateCode: r.state_code,
    timezone: r.timezone,
    roundOff: r.round_off ?? true,
    allowNegativeStock: r.allow_negative_stock ?? false,
    address: r.business_address,
    phone: r.business_phone,
    email: r.business_email,
    terms: r.invoice_terms,
  };
}

export async function customerFacts(trx: Trx, ctx: TenantContext, id: string): Promise<CustomerFacts | null> {
  const { rows } = await sql<{
    id: string;
    name: string;
    mobile_e164: string | null;
    gstin: string | null;
    state_code: string | null;
    address: string | null;
    erased_at: Date | null;
  }>`select id, name, mobile_e164, gstin, state_code, address, erased_at from lbg.customers
      where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    mobileE164: r.mobile_e164,
    gstin: r.gstin,
    stateCode: r.state_code,
    address: r.address,
    erased: r.erased_at !== null,
  };
}

/** Validates and normalises the cashier's input into stored lines (structural errors throw). */
export async function normaliseLines(
  trx: Trx,
  ctx: TenantContext,
  specs: readonly SaleLineSpec[],
): Promise<StoredLine[]> {
  if (specs.length === 0) throw new SaleError('INVALID_LINE', 'Add at least one item.');
  if (specs.length > 100) throw new SaleError('INVALID_LINE', 'A sale can have at most 100 lines.');
  const seenUnits = new Set<string>();
  const out: StoredLine[] = [];
  for (const [i, spec] of specs.entries()) {
    let variantId = spec.variantId;
    const unitId = spec.unitId ?? null;
    if (unitId) {
      if (seenUnits.has(unitId))
        throw new SaleError('INVALID_LINE', 'The same unit is on the sale twice.', { lineIndex: i });
      seenUnits.add(unitId);
      const { rows } = await sql<{ variant_id: string }>`select variant_id from lbg.serialized_units
                                  where business_id = ${ctx.businessId} and id = ${unitId}`.execute(trx);
      const unitVariant = rows[0]?.variant_id;
      if (!unitVariant) throw new SaleError('INVALID_LINE', 'Unit not found.', { lineIndex: i });
      if (variantId && variantId !== unitVariant)
        throw new SaleError('INVALID_LINE', 'The unit belongs to another item.', { lineIndex: i });
      variantId = unitVariant;
    }
    if (!variantId) throw new SaleError('INVALID_LINE', 'Choose an item.', { lineIndex: i });
    const { rows } = await sql<{ is_serialized: boolean; selling_price_paise: string }>`
      select p.is_serialized, v.selling_price_paise from lbg.product_variants v
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where v.business_id = ${ctx.businessId} and v.id = ${variantId}`.execute(trx);
    const v = rows[0];
    if (!v) throw new SaleError('INVALID_LINE', 'Item not found.', { lineIndex: i });
    if (unitId && !v.is_serialized)
      throw new SaleError('INVALID_LINE', 'This item is not serial-tracked.', { lineIndex: i });
    let qtyMilli: number;
    try {
      qtyMilli = quantityToMilli(spec.quantity ?? '1');
    } catch {
      throw new SaleError('INVALID_LINE', 'Enter a valid quantity.', { lineIndex: i });
    }
    if (qtyMilli <= 0) throw new SaleError('INVALID_LINE', 'Enter a valid quantity.', { lineIndex: i });
    if (v.is_serialized && qtyMilli !== 1000)
      throw new SaleError('INVALID_LINE', 'Serial-tracked items are sold one unit per line.', { lineIndex: i });
    out.push({
      variantId,
      unitId,
      qtyMilli,
      unitPricePaise: spec.unitPricePaise ?? Number(v.selling_price_paise),
      discount: spec.discount ?? null,
    });
  }
  return out;
}

async function lineFacts(trx: Trx, ctx: TenantContext, line: StoredLine, invoiceDate: string): Promise<LineFacts> {
  const { rows } = await sql<{
    is_serialized: boolean;
    product_status: string;
    variant_status: string;
    model_name: string;
    ram: string | null;
    storage: string | null;
    colour: string | null;
    hsn_code: string | null;
    price_includes_tax: boolean;
    min_selling_price_paise: string | null;
    avg_cost_paise: string | null;
    has_rate: boolean;
    rate_id: string | null;
    rate_percent: string | null;
    cess_percent: string | null;
    available: string | null;
  }>`
    select p.is_serialized, p.status as product_status, v.status as variant_status, p.model_name, v.ram, v.storage,
           v.colour, v.hsn_code, v.price_includes_tax, v.min_selling_price_paise, v.avg_cost_paise,
           v.tax_rate_id is not null as has_rate, r.id as rate_id, r.rate_percent::text as rate_percent,
           r.cess_percent::text as cess_percent,
           (select (quantity * 1000)::bigint::text from lbg.stock_levels l
             where l.business_id = v.business_id and l.variant_id = v.id and l.bucket = 'AVAILABLE') as available
      from lbg.product_variants v
      join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
      left join lbg.tax_rates r on r.business_id = v.business_id
                               and r.id = lbg.effective_tax_rate(v.tax_rate_id, ${invoiceDate}::date)
     where v.business_id = ${ctx.businessId} and v.id = ${line.variantId}`.execute(trx);
  const r = rows[0];
  if (!r) throw new SaleError('INVALID_LINE', 'Item not found.');
  let unit: LineFacts['unit'] = null;
  let identity = '';
  if (line.unitId) {
    const u = (
      await sql<{ status: string; unit_cost_paise: string; serial_number: string | null; imeis: string | null }>`
        select u.status, u.unit_cost_paise, u.serial_number,
               (select string_agg(i.imei, ' / ' order by i.slot) from lbg.serialized_unit_imeis i
                 where i.business_id = u.business_id and i.unit_id = u.id) as imeis
          from lbg.serialized_units u
         where u.business_id = ${ctx.businessId} and u.id = ${line.unitId}`.execute(trx)
    ).rows[0];
    if (!u) throw new SaleError('INVALID_LINE', 'Unit not found.');
    unit = { status: u.status, costPaise: Number(u.unit_cost_paise) };
    identity = u.imeis ? ` IMEI ${u.imeis}` : u.serial_number ? ` S/N ${u.serial_number}` : '';
  }
  const attrs = [r.ram, r.storage, r.colour].filter((x): x is string => !!x).join(' ');
  return {
    variantId: line.variantId,
    serialized: r.is_serialized,
    archived: r.product_status !== 'ACTIVE' || r.variant_status !== 'ACTIVE',
    description: `${r.model_name}${attrs ? ` ${attrs}` : ''}${identity}`.slice(0, 300),
    hsnCode: r.hsn_code,
    priceIncludesTax: r.price_includes_tax,
    minPricePaise: r.min_selling_price_paise === null ? null : Number(r.min_selling_price_paise),
    avgCostPaise: r.avg_cost_paise === null ? null : Number(r.avg_cost_paise),
    taxRate:
      r.rate_id && r.rate_percent !== null && r.cess_percent !== null
        ? { id: r.rate_id, ratePercent: r.rate_percent, cessPercent: r.cess_percent }
        : null,
    unit,
    availableMilli: r.available === null ? 0 : Number(r.available),
  };
}

/** Prices `lines` with current facts (tax rate in force, place of supply, document type). */
export async function priceSale(
  trx: Trx,
  ctx: TenantContext,
  input: {
    readonly customerId: string | null;
    readonly lines: readonly StoredLine[];
    readonly invoiceDiscount: Discount | null;
    readonly at: Date;
  },
): Promise<PricedSale> {
  const seller = await sellerFacts(trx, ctx);
  const invoiceDate = businessDate(input.at, seller.timezone);
  const customer = input.customerId ? await customerFacts(trx, ctx, input.customerId) : null;
  if (input.customerId && (!customer || customer.erased))
    throw new SaleError('CUSTOMER_NOT_FOUND', 'Customer not found.');
  const pos = placeOfSupply(customer, seller.stateCode);
  const interState = pos !== seller.stateCode;
  const chargeTax = seller.registrationType === 'REGULAR';
  const facts: LineFacts[] = [];
  for (const line of input.lines) facts.push(await lineFacts(trx, ctx, line, invoiceDate));
  let result: SaleResult;
  try {
    result = computeSale({
      lines: input.lines.map((line, i) => {
        const rate = facts[i]?.taxRate;
        return {
          qtyMilli: line.qtyMilli,
          unitPricePaise: line.unitPricePaise,
          priceIncludesTax: facts[i]?.priceIncludesTax ?? true,
          rateBp: chargeTax && rate ? rateToBasisPoints(rate.ratePercent) : 0,
          cessBp: chargeTax && rate ? rateToBasisPoints(rate.cessPercent) : 0,
          discount: line.discount ?? undefined,
        };
      }),
      invoiceDiscount: input.invoiceDiscount ?? undefined,
      interState,
      chargeTax,
      roundOff: seller.roundOff,
    });
  } catch (err) {
    if (err instanceof TaxEngineError) {
      const code = err.code === 'DISCOUNT_EXCEEDS_VALUE' ? 'DISCOUNT_EXCEEDS_VALUE' : 'INVALID_LINE';
      throw new SaleError(code, err.message, err.lineIndex === undefined ? {} : { lineIndex: err.lineIndex });
    }
    throw err;
  }
  const lines = input.lines.map((line, i): PricedLine => {
    const f = facts[i];
    const amounts = result.lines[i];
    if (!f || !amounts) throw new Error('pricing lost a line');
    return { ...line, facts: f, amounts };
  });
  return {
    documentType: chargeTax ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY',
    invoiceDate,
    placeOfSupply: pos,
    interState,
    customer,
    lines,
    invoiceDiscount: input.invoiceDiscount,
    result,
    contentSha256: contentHash(input.customerId, input.lines, input.invoiceDiscount),
    seller,
  };
}

/** Value of a line after all discounts, compared with its minimum price (FR-POS-2 AC3). */
export function belowMinPrice(line: PricedLine): boolean {
  const min = line.facts.minPricePaise;
  if (min === null) return false;
  const net = line.amounts.grossPaise - line.amounts.lineDiscountPaise - line.amounts.invoiceDiscountPaise;
  return BigInt(net) * 1000n < BigInt(min) * BigInt(line.qtyMilli);
}

export interface DiscountApproval {
  readonly approvedBy: string | null;
  readonly approvedDiscountPaise: number | null;
  readonly approvedContentSha256: string | null;
}

export function discountApproved(priced: PricedSale, approval: DiscountApproval): boolean {
  return (
    approval.approvedBy !== null &&
    approval.approvedContentSha256 === priced.contentSha256 &&
    approval.approvedDiscountPaise !== null &&
    priced.result.discountPaise <= approval.approvedDiscountPaise
  );
}

/** Everything that stops this sale from being issued by this seller now. */
export function saleProblems(priced: PricedSale, access: SellerAccess, approval: DiscountApproval): SaleProblem[] {
  const problems: SaleProblem[] = [];
  const demand = new Map<string, number>();
  for (const [i, line] of priced.lines.entries()) {
    const f = line.facts;
    if (f.archived) problems.push({ code: 'ITEM_ARCHIVED', lineIndex: i, message: 'This item is archived.' });
    if (f.serialized && !line.unitId)
      problems.push({ code: 'UNIT_REQUIRED', lineIndex: i, message: 'Scan or choose the unit being sold.' });
    if (f.unit && f.unit.status !== 'IN_STOCK')
      problems.push({ code: 'UNIT_NOT_AVAILABLE', lineIndex: i, message: 'This unit is not in stock.' });
    if (priced.documentType === 'TAX_INVOICE' && !f.taxRate)
      problems.push({ code: 'NO_TAX_RATE', lineIndex: i, message: 'This item has no tax rate in force today.' });
    if (!access.priceOverride && belowMinPrice(line))
      problems.push({
        code: 'BELOW_MIN_PRICE',
        lineIndex: i,
        message: 'The price after discount is below the minimum selling price.',
      });
    if (!f.serialized) demand.set(line.variantId, (demand.get(line.variantId) ?? 0) + line.qtyMilli);
  }
  if (!priced.seller.allowNegativeStock) {
    for (const [i, line] of priced.lines.entries()) {
      const wanted = demand.get(line.variantId);
      if (wanted !== undefined && wanted > line.facts.availableMilli) {
        problems.push({
          code: 'INSUFFICIENT_STOCK',
          lineIndex: i,
          message: `Only ${milliToQuantity(line.facts.availableMilli)} in stock.`,
        });
        demand.delete(line.variantId); // report once per item
      }
    }
  }
  const { discountPaise, grossPaise } = priced.result;
  if (!discountWithinLimit(access.discount, discountPaise, grossPaise) && !discountApproved(priced, approval)) {
    problems.push({
      code: 'DISCOUNT_NEEDS_APPROVAL',
      message: 'The discount is above your limit and needs approval.',
    });
  }
  return problems;
}
