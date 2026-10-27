// Stock report rules (FR-INV-7). Quantities are thousandths of a unit.
import { divRoundHalfUp } from './money.ts';

export const REORDER_FORMULA = 'max(0, average daily sales × lead-time days + reorder level − on hand − on order)';

export interface ReorderInput {
  /** Net units sold in the window (sales minus sale returns), thousandths. */
  readonly soldMilli: number;
  readonly windowDays: number;
  readonly leadTimeDays: number;
  /** Reorder level in whole units (null counts as 0). */
  readonly reorderLevel: number | null;
  readonly onHandMilli: number;
  readonly onOrderMilli: number;
}

export interface ReorderSuggestion {
  /** Average daily sales, thousandths (rounded half up). */
  readonly averageDailyMilli: number;
  /** Exact suggestion per the formula, thousandths. */
  readonly suggestedMilli: number;
  /** The suggestion rounded up to whole units, for ordering. */
  readonly suggestedUnits: number;
}

function check(value: number, what: string, min: number) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${what} must be an integer ≥ ${String(min)}`);
}

/** FR-INV-7 AC3. Returned as a suggestion only; callers must label it so. */
export function reorderSuggestion(input: ReorderInput): ReorderSuggestion {
  check(input.windowDays, 'windowDays', 1);
  check(input.leadTimeDays, 'leadTimeDays', 0);
  check(input.onOrderMilli, 'onOrderMilli', 0);
  check(input.onHandMilli, 'onHandMilli', Number.MIN_SAFE_INTEGER);
  const sold = BigInt(Math.max(0, input.soldMilli));
  // Multiply before dividing so the lead-time demand is exact; round once.
  const averageDailyMilli = Number(divRoundHalfUp(sold, BigInt(input.windowDays)));
  const leadDemand = Number(divRoundHalfUp(sold * BigInt(input.leadTimeDays), BigInt(input.windowDays)));
  const target = leadDemand + (input.reorderLevel ?? 0) * 1000;
  const suggestedMilli = Math.max(0, target - input.onHandMilli - input.onOrderMilli);
  return { averageDailyMilli, suggestedMilli, suggestedUnits: Math.ceil(suggestedMilli / 1000) };
}

export type MovementAge = 'ACTIVE' | 'SLOW' | 'DEAD';

/**
 * FR-INV-7 AC2: an item in stock with no sale for `deadDays` is dead stock,
 * for `slowDays` slow-moving. Items never sold are aged from their first receipt.
 */
export function classifyAge(daysSinceLastSaleOrReceipt: number, slowDays: number, deadDays: number): MovementAge {
  if (deadDays < slowDays) throw new RangeError('deadDays must be ≥ slowDays');
  if (daysSinceLastSaleOrReceipt >= deadDays) return 'DEAD';
  if (daysSinceLastSaleOrReceipt >= slowDays) return 'SLOW';
  return 'ACTIVE';
}
