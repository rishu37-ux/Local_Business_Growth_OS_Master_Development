// Sale tax engine (FR-TAX-1, D-013). Pure and deterministic: integer paise,
// rates in basis points, quantities in thousandths. Every total is a sum of
// line amounts, so totals always reconcile with lines.
//
// Rules (D-013, subject to tax-professional review):
// - Line value = quantity × unit price, as entered (tax-inclusive or not).
// - A line discount (percent or amount) applies first. An invoice discount is
//   then apportioned to lines in proportion to their value after line
//   discounts; any remaining paise go to the last lines that can take them.
// - Inclusive prices: taxable = round_half_up(net × 10000 / (10000 + GST + cess));
//   the tax is the rest of the net amount, GST first and cess taking the remainder.
// - Exclusive prices: GST and cess are each round_half_up(taxable × rate).
// - Intra-state: CGST = floor(GST / 2), SGST = the rest. Inter-state: IGST.
// - A Bill of Supply (unregistered or composition business) charges no tax:
//   the net amount is the line total.
// - Optional round-off of the invoice total to the nearest rupee (half up).
import { divRoundHalfUp, lineValue, splitIntraState } from './money.ts';

export type Discount =
  { readonly kind: 'PERCENT'; readonly bp: number } | { readonly kind: 'AMOUNT'; readonly paise: number };

export interface SaleLineInput {
  readonly qtyMilli: number;
  /** Price per unit as entered, in paise. */
  readonly unitPricePaise: number;
  readonly priceIncludesTax: boolean;
  /** GST rate in basis points; 0 for nil-rated, exempt or zero-rated lines. */
  readonly rateBp: number;
  readonly cessBp: number;
  readonly discount?: Discount | undefined;
}

export interface SaleInput {
  readonly lines: readonly SaleLineInput[];
  readonly invoiceDiscount?: Discount | undefined;
  readonly interState: boolean;
  /** false for a Bill of Supply: no tax is charged. */
  readonly chargeTax: boolean;
  readonly roundOff: boolean;
}

export interface SaleLineResult {
  readonly grossPaise: number;
  readonly lineDiscountPaise: number;
  readonly invoiceDiscountPaise: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly totalPaise: number;
}

export interface SaleResult {
  readonly lines: readonly SaleLineResult[];
  readonly grossPaise: number;
  /** Line discounts plus the invoice discount. */
  readonly discountPaise: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly roundOffPaise: number;
  readonly totalPaise: number;
}

export class TaxEngineError extends Error {
  readonly code: 'NO_LINES' | 'DISCOUNT_EXCEEDS_VALUE' | 'INVALID_INPUT';
  readonly lineIndex: number | undefined;

  constructor(code: TaxEngineError['code'], message: string, lineIndex?: number) {
    super(message);
    this.name = 'TaxEngineError';
    this.code = code;
    this.lineIndex = lineIndex;
  }
}

function checkInt(value: number, max: number, what: string, lineIndex?: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TaxEngineError('INVALID_INPUT', `${what} is out of range`, lineIndex);
  }
}

/** The discount in paise on `base`; percent discounts round half up. */
export function discountAmount(base: number, discount: Discount | undefined, lineIndex?: number): number {
  if (!discount) return 0;
  if (discount.kind === 'PERCENT') {
    checkInt(discount.bp, 10_000, 'discount percent', lineIndex);
    return Number(divRoundHalfUp(BigInt(base) * BigInt(discount.bp), 10_000n));
  }
  checkInt(discount.paise, Number.MAX_SAFE_INTEGER, 'discount amount', lineIndex);
  if (discount.paise > base) {
    throw new TaxEngineError(
      'DISCOUNT_EXCEEDS_VALUE',
      'The discount is larger than the value it applies to.',
      lineIndex,
    );
  }
  return discount.paise;
}

/**
 * Splits `amount` over items in proportion to their `value`, flooring each
 * share; the paise left over go to the last items that still have room
 * (share < value). Requires amount ≤ Σ values. One backward pass is enough:
 * fewer paise are left over than there are items with a fractional share,
 * and each of those has at least one paisa of room.
 */
function withShares<T extends { readonly value: number }>(
  amount: number,
  items: readonly T[],
): (T & { share: number })[] {
  const total = items.reduce((s, x) => s + x.value, 0);
  const out = items.map((x) => ({
    ...x,
    share: total === 0 ? 0 : Number((BigInt(amount) * BigInt(x.value)) / BigInt(total)),
  }));
  let left = amount - out.reduce((s, x) => s + x.share, 0);
  for (const x of [...out].reverse()) {
    if (left === 0) break;
    const add = Math.min(x.value - x.share, left);
    x.share += add;
    left -= add;
  }
  return out;
}

/** Proportional split of `amount` over `weights` (see withShares). */
export function apportion(amount: number, weights: readonly number[]): number[] {
  return withShares(
    amount,
    weights.map((value) => ({ value })),
  ).map((x) => x.share);
}

function taxLine(
  net: number,
  line: SaleLineInput,
  input: SaleInput,
): Omit<SaleLineResult, 'grossPaise' | 'lineDiscountPaise' | 'invoiceDiscountPaise'> {
  if (!input.chargeTax) {
    return { taxablePaise: net, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0, totalPaise: net };
  }
  let taxable: number;
  let gst: number;
  let cess: number;
  if (line.priceIncludesTax) {
    const divisor = 10_000n + BigInt(line.rateBp) + BigInt(line.cessBp);
    taxable = Number(divRoundHalfUp(BigInt(net) * 10_000n, divisor));
    const tax = net - taxable;
    if (line.cessBp === 0) {
      gst = tax;
      cess = 0;
    } else {
      gst = Math.min(tax, Number(divRoundHalfUp(BigInt(taxable) * BigInt(line.rateBp), 10_000n)));
      cess = tax - gst;
    }
  } else {
    taxable = net;
    gst = Number(divRoundHalfUp(BigInt(taxable) * BigInt(line.rateBp), 10_000n));
    cess = Number(divRoundHalfUp(BigInt(taxable) * BigInt(line.cessBp), 10_000n));
  }
  const { cgst, sgst } = input.interState ? { cgst: 0, sgst: 0 } : splitIntraState(gst);
  const igst = input.interState ? gst : 0;
  return {
    taxablePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    cessPaise: cess,
    totalPaise: taxable + gst + cess,
  };
}

export function computeSale(input: SaleInput): SaleResult {
  if (input.lines.length === 0) throw new TaxEngineError('NO_LINES', 'An invoice needs at least one line.');
  const prepared = input.lines.map((line, i) => {
    checkInt(line.qtyMilli, 1_000_000_000_000, 'quantity', i);
    if (line.qtyMilli === 0) throw new TaxEngineError('INVALID_INPUT', 'quantity must be positive', i);
    checkInt(line.unitPricePaise, 10_000_000_000_000, 'price', i);
    checkInt(line.rateBp, 10_000, 'tax rate', i);
    checkInt(line.cessBp, 10_000, 'cess rate', i);
    const gross = lineValue(line.qtyMilli, line.unitPricePaise);
    const lineDiscount = discountAmount(gross, line.discount, i);
    return { line, gross, lineDiscount, value: gross - lineDiscount };
  });
  const invoiceDiscount = discountAmount(
    prepared.reduce((s, p) => s + p.value, 0),
    input.invoiceDiscount,
  );
  const lines = withShares(invoiceDiscount, prepared).map((p): SaleLineResult => ({
    grossPaise: p.gross,
    lineDiscountPaise: p.lineDiscount,
    invoiceDiscountPaise: p.share,
    ...taxLine(p.value - p.share, p.line, input),
  }));
  const sum = (k: keyof SaleLineResult) => lines.reduce((s, l) => s + l[k], 0);
  const beforeRound = sum('totalPaise');
  const roundOff = input.roundOff ? Number(divRoundHalfUp(BigInt(beforeRound), 100n)) * 100 - beforeRound : 0;
  return {
    lines,
    grossPaise: sum('grossPaise'),
    discountPaise: sum('lineDiscountPaise') + invoiceDiscount,
    taxablePaise: sum('taxablePaise'),
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    cessPaise: sum('cessPaise'),
    roundOffPaise: roundOff,
    totalPaise: beforeRound + roundOff,
  };
}
