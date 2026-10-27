// Discount limits (FR-POS-2 AC1, ROLES_PERMISSIONS §2): a pos.discount grant
// may cap the total discount on one invoice as a percentage of its value
// before discounts and as an amount. Both caps apply when both are set.
import type { EffectiveGrant } from './permissions.ts';

/**
 * Whether `discountPaise` on an invoice worth `grossPaise` before discounts is
 * within `grant` (undefined: pos.discount not held, so no discount at all).
 * A grant without limits is unlimited.
 */
export function discountWithinLimit(
  grant: EffectiveGrant | undefined,
  discountPaise: number,
  grossPaise: number,
): boolean {
  if (
    !Number.isSafeInteger(discountPaise) ||
    discountPaise < 0 ||
    !Number.isSafeInteger(grossPaise) ||
    grossPaise < 0
  ) {
    throw new RangeError('amounts must be non-negative integers');
  }
  if (discountPaise === 0) return true;
  if (!grant) return false;
  const limits = grant.limits;
  if (!limits) return true;
  if (limits.maxPaise !== undefined && discountPaise > limits.maxPaise) return false;
  if (limits.maxPercent !== undefined) {
    // discount / gross ≤ maxPercent / 100, compared exactly in basis points.
    const bp = BigInt(Math.round(limits.maxPercent * 100));
    if (BigInt(discountPaise) * 10_000n > bp * BigInt(grossPaise)) return false;
  }
  return true;
}
