// Versioned tax rates (FR-TAX-2 AC1). Mirrors lbg.effective_tax_rate() and the
// overlap rule of the lbg.tax_rates guard trigger. Dates are ISO yyyy-mm-dd
// strings in the business timezone, which compare correctly as text.

export interface TaxRateVersion {
  readonly id: string;
  readonly name: string;
  /** Inclusive start date. */
  readonly effectiveFrom: string;
  /** Inclusive end date; null means open-ended. */
  readonly effectiveTo: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(date: string): string {
  if (!ISO_DATE.test(date)) throw new RangeError(`invalid date: ${date}`);
  return date;
}

const covers = (v: TaxRateVersion, on: string) =>
  v.effectiveFrom <= on && (v.effectiveTo === null || v.effectiveTo >= on);

/** The version of rate `name` in force on `on`, or undefined if none is. */
export function effectiveVersion<T extends TaxRateVersion>(
  versions: readonly T[],
  name: string,
  on: string,
): T | undefined {
  check(on);
  const key = name.toLowerCase();
  return versions.find((v) => v.name.toLowerCase() === key && covers(v, on));
}

/** Whether two versions' periods share at least one day (inclusive bounds). */
export function periodsOverlap(a: TaxRateVersion, b: TaxRateVersion): boolean {
  check(a.effectiveFrom);
  check(b.effectiveFrom);
  const aEnd = a.effectiveTo ?? '9999-12-31';
  const bEnd = b.effectiveTo ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}
