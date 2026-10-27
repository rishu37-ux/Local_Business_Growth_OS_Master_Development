// Purchase line and document arithmetic (FR-INV-8 AC2, D-013, D-017, D-033).
// Supplier invoices state tax-exclusive unit costs; tax is computed per line
// and split CGST/SGST (intra-state) or IGST (inter-state). Subject to
// tax-professional review, like every tax rule here.
import { divRoundHalfUp, exclusiveTax, lineValue, splitIntraState } from './money.ts';

export interface PurchaseLineInput {
  readonly qtyMilli: number;
  /** Tax-exclusive cost per unit, in paise. */
  readonly unitCostPaise: number;
  /** GST rate in basis points (0 when the line has no rate). */
  readonly rateBp: number;
  /** Cess rate in basis points. */
  readonly cessBp: number;
}

export interface PurchaseLineAmounts {
  readonly taxable: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly cess: number;
  readonly tax: number;
  readonly total: number;
}

export function purchaseLineAmounts(line: PurchaseLineInput, interState: boolean): PurchaseLineAmounts {
  const taxable = lineValue(line.qtyMilli, line.unitCostPaise);
  const gst = exclusiveTax(taxable, line.rateBp);
  const cess = exclusiveTax(taxable, line.cessBp);
  const { cgst, sgst } = interState ? { cgst: 0, sgst: 0 } : splitIntraState(gst);
  const igst = interState ? gst : 0;
  const tax = gst + cess;
  return { taxable, cgst, sgst, igst, cess, tax, total: taxable + tax };
}

export interface PurchaseTotals extends PurchaseLineAmounts {
  readonly lines: readonly PurchaseLineAmounts[];
}

/** Document totals are the sums of the line amounts, so they always reconcile. */
export function purchaseTotals(lines: readonly PurchaseLineInput[], interState: boolean): PurchaseTotals {
  const amounts = lines.map((l) => purchaseLineAmounts(l, interState));
  const sum = (k: keyof PurchaseLineAmounts) => amounts.reduce((acc, a) => acc + a[k], 0);
  return {
    lines: amounts,
    taxable: sum('taxable'),
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    cess: sum('cess'),
    tax: sum('tax'),
    total: sum('total'),
  };
}

/** Splits `amount` into `parts` integers that sum to it (floor each, remainder to the last). */
export function splitAmount(amount: number, parts: number): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('amount must be a non-negative integer');
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError('parts must be a positive integer');
  const each = Math.floor(amount / parts);
  const out = Array.from({ length: parts }, () => each);
  out[parts - 1] = amount - each * (parts - 1);
  return out;
}

/**
 * The amount of a line that becomes inventory cost (D-033). A regular GST
 * registrant can claim input tax credit, so cost is the taxable value; for
 * composition and unregistered businesses the tax is part of the cost.
 */
export function lineCost(amounts: PurchaseLineAmounts, taxIsCost: boolean): number {
  return taxIsCost ? amounts.total : amounts.taxable;
}

/** Per-unit cost for weighted average (D-017): round_half_up(cost × 1000 / qtyMilli). */
export function unitCostFromLine(costPaise: number, qtyMilli: number): number {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) throw new RangeError('quantity must be positive');
  return Number(divRoundHalfUp(BigInt(costPaise) * 1000n, BigInt(qtyMilli)));
}
