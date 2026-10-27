// Integer money arithmetic (NFR-8, D-013, D-017). Amounts are paise, rates are
// basis points (18.00 % = 1800), quantities are thousandths of a unit
// (numeric(12,3) in the database). Intermediate products use BigInt so no
// step can lose precision; results must fit in a safe integer.

function toSafe(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${what} out of range`);
  }
  return Number(value);
}

function nonNegativeInt(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative integer`);
  return BigInt(value);
}

/** round_half_up(n / d) for n ≥ 0, d > 0. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new RangeError('divRoundHalfUp expects n >= 0 and d > 0');
  return (n * 2n + d) / (d * 2n);
}

/** Parses a percentage such as "18", "18.00" or "0.25" into basis points. */
export function rateToBasisPoints(rate: string | number): number {
  const text = typeof rate === 'number' ? String(rate) : rate.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new RangeError(`invalid rate: ${text}`);
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (bp > 10_000) throw new RangeError('rate above 100 %');
  return bp;
}

/** Parses a quantity such as "2", "1.5" or "0.125" into thousandths. */
export function quantityToMilli(qty: string | number): number {
  const text = typeof qty === 'number' ? String(qty) : qty.trim();
  const match = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) throw new RangeError(`invalid quantity: ${text}`);
  return Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
}

/** Formats thousandths back to the database's numeric text ("1.5" → "1.500"). */
export function milliToQuantity(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  return `${sign}${String(Math.trunc(abs / 1000))}.${String(abs % 1000).padStart(3, '0')}`;
}

/** Value of `qtyMilli` thousandths at `unitPaise` each, rounded half up to a paisa. */
export function lineValue(qtyMilli: number, unitPaise: number): number {
  return toSafe(
    divRoundHalfUp(nonNegativeInt(qtyMilli, 'quantity') * nonNegativeInt(unitPaise, 'unit price'), 1000n),
    'line value',
  );
}

/** Tax on a tax-exclusive taxable value (D-013): round_half_up(taxable × rate). */
export function exclusiveTax(taxablePaise: number, rateBp: number): number {
  return toSafe(
    divRoundHalfUp(nonNegativeInt(taxablePaise, 'taxable value') * nonNegativeInt(rateBp, 'rate'), 10_000n),
    'tax',
  );
}

/** Intra-state split (D-013): CGST takes floor(tax / 2), SGST the remainder. */
export function splitIntraState(taxPaise: number): { cgst: number; sgst: number } {
  nonNegativeInt(taxPaise, 'tax');
  const cgst = Math.floor(taxPaise / 2);
  return { cgst, sgst: taxPaise - cgst };
}

/**
 * Moving weighted average cost per unit (D-017), rounded half up to a paisa.
 * Stock already on hand below zero (negative stock allowed) counts as zero, so
 * the new average is the incoming cost.
 */
export function weightedAverageCost(input: {
  readonly onHandMilli: number;
  readonly currentAvgPaise: number | null;
  readonly addedMilli: number;
  readonly addedUnitPaise: number;
}): number {
  const added = nonNegativeInt(input.addedMilli, 'added quantity');
  const addedCost = nonNegativeInt(input.addedUnitPaise, 'added cost');
  const onHand = input.onHandMilli > 0 && input.currentAvgPaise !== null ? BigInt(input.onHandMilli) : 0n;
  const current = onHand > 0n ? nonNegativeInt(input.currentAvgPaise ?? 0, 'average cost') : 0n;
  const total = onHand + added;
  if (total === 0n) return toSafe(current, 'average cost');
  return toSafe(divRoundHalfUp(onHand * current + added * addedCost, total), 'average cost');
}
