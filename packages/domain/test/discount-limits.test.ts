import { describe, expect, it } from 'vitest';
import { discountWithinLimit } from '../src/index.ts';

describe('discount limits (FR-POS-2 AC1)', () => {
  const billing = { limits: { maxPercent: 2, maxPaise: 50_000 } };

  it('applies both the percentage and the amount cap', () => {
    // 2 % of ₹10,000 = ₹200: exactly at the cap is allowed, one paisa over is not.
    expect(discountWithinLimit(billing, 20_000, 1_000_000)).toBe(true);
    expect(discountWithinLimit(billing, 20_001, 1_000_000)).toBe(false);
    // 2 % of ₹50,000 = ₹1,000, but the amount cap is ₹500.
    expect(discountWithinLimit(billing, 50_000, 5_000_000)).toBe(true);
    expect(discountWithinLimit(billing, 50_001, 5_000_000)).toBe(false);
  });

  it('one cap alone, fractional percentages, unlimited grants', () => {
    expect(discountWithinLimit({ limits: { maxPercent: 2.5 } }, 250, 10_000)).toBe(true);
    expect(discountWithinLimit({ limits: { maxPercent: 2.5 } }, 251, 10_000)).toBe(false);
    expect(discountWithinLimit({ limits: { maxPaise: 100 } }, 100, 100)).toBe(true);
    expect(discountWithinLimit({ limits: undefined }, 99_999_999, 100_000_000)).toBe(true);
  });

  it('without pos.discount only a zero discount is allowed', () => {
    expect(discountWithinLimit(undefined, 0, 1000)).toBe(true);
    expect(discountWithinLimit(undefined, 1, 1000)).toBe(false);
    expect(discountWithinLimit(billing, 0, 0)).toBe(true);
  });

  it('rejects invalid amounts', () => {
    expect(() => discountWithinLimit(billing, -1, 100)).toThrow(RangeError);
    expect(() => discountWithinLimit(billing, 1, 1.5)).toThrow(RangeError);
  });
});
