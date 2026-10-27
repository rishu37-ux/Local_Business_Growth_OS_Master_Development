import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  divRoundHalfUp,
  effectiveVersion,
  exclusiveTax,
  lineValue,
  milliToQuantity,
  periodsOverlap,
  quantityToMilli,
  rateToBasisPoints,
  splitIntraState,
  weightedAverageCost,
} from '../src/index.ts';

describe('integer money arithmetic (NFR-8, D-013)', () => {
  it('rounds half up', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 2n)).toBe(2n);
    expect(divRoundHalfUp(7n, 3n)).toBe(2n);
    expect(divRoundHalfUp(149n, 100n)).toBe(1n);
    expect(divRoundHalfUp(150n, 100n)).toBe(2n);
  });

  it('parses rates and quantities exactly, rejecting malformed text', () => {
    expect(rateToBasisPoints('18.00')).toBe(1800);
    expect(rateToBasisPoints('0.25')).toBe(25);
    expect(rateToBasisPoints('5')).toBe(500);
    expect(rateToBasisPoints('100.00')).toBe(10_000);
    for (const bad of ['', '-1', '18.123', '1e2', '101', 'abc']) expect(() => rateToBasisPoints(bad)).toThrow();
    expect(quantityToMilli('1.5')).toBe(1500);
    expect(quantityToMilli('2')).toBe(2000);
    expect(quantityToMilli('0.125')).toBe(125);
    expect(milliToQuantity(1500)).toBe('1.500');
    expect(milliToQuantity(-1000)).toBe('-1.000');
    for (const bad of ['-1', '1.2345', '1,5', ' ']) expect(() => quantityToMilli(bad)).toThrow();
  });

  it('computes line values and exclusive tax with half-up rounding', () => {
    expect(lineValue(3000, 12_345)).toBe(37_035);
    expect(lineValue(1500, 333)).toBe(500); // 499.5 → 500
    expect(exclusiveTax(10_000, 1800)).toBe(1800);
    expect(exclusiveTax(999, 1800)).toBe(180); // 179.82 → 180
    expect(exclusiveTax(25, 1800)).toBe(5); // 4.5 → 5
    expect(exclusiveTax(12_345, 0)).toBe(0);
  });

  it('splits odd paise with CGST = floor(tax/2)', () => {
    expect(splitIntraState(181)).toEqual({ cgst: 90, sgst: 91 });
    expect(splitIntraState(180)).toEqual({ cgst: 90, sgst: 90 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), (t) => {
        const { cgst, sgst } = splitIntraState(t);
        return cgst + sgst === t && sgst - cgst >= 0 && sgst - cgst <= 1;
      }),
    );
  });

  it('rejects values that would lose precision', () => {
    expect(() => lineValue(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => exclusiveTax(-1, 1800)).toThrow(RangeError);
    expect(() => lineValue(1.5, 100)).toThrow(RangeError);
  });

  it('weighted average cost (D-017)', () => {
    expect(weightedAverageCost({ onHandMilli: 0, currentAvgPaise: null, addedMilli: 5000, addedUnitPaise: 1000 })).toBe(
      1000,
    );
    // 10 @ ₹10 + 5 @ ₹13 = ₹165 / 15 = ₹11
    expect(
      weightedAverageCost({ onHandMilli: 10_000, currentAvgPaise: 1000, addedMilli: 5000, addedUnitPaise: 1300 }),
    ).toBe(1100);
    // 1 @ 100 + 2 @ 101 = 302 / 3 = 100.67 → 101
    expect(
      weightedAverageCost({ onHandMilli: 1000, currentAvgPaise: 100, addedMilli: 2000, addedUnitPaise: 101 }),
    ).toBe(101);
    // Negative stock on hand counts as zero.
    expect(
      weightedAverageCost({ onHandMilli: -2000, currentAvgPaise: 500, addedMilli: 1000, addedUnitPaise: 800 }),
    ).toBe(800);
  });

  it('the average always lies between the old average and the incoming cost (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 0, max: 1e7 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 0, max: 1e7 }),
        (onHand, avg, added, cost) => {
          const r = weightedAverageCost({
            onHandMilli: onHand,
            currentAvgPaise: avg,
            addedMilli: added,
            addedUnitPaise: cost,
          });
          return r >= Math.min(avg, cost) && r <= Math.max(avg, cost);
        },
      ),
    );
  });
});

describe('tax-rate versions (FR-TAX-2 AC1)', () => {
  const versions = [
    { id: 'a', name: 'GST 18', effectiveFrom: '2025-04-01', effectiveTo: '2026-09-21' },
    { id: 'b', name: 'GST 18', effectiveFrom: '2026-09-22', effectiveTo: null },
    { id: 'c', name: 'GST 5', effectiveFrom: '2025-04-01', effectiveTo: null },
  ];

  it('picks the version in force on the date, by name, inclusive bounds', () => {
    expect(effectiveVersion(versions, 'GST 18', '2026-09-21')?.id).toBe('a');
    expect(effectiveVersion(versions, 'gst 18', '2026-09-22')?.id).toBe('b');
    expect(effectiveVersion(versions, 'GST 18', '2025-03-31')).toBeUndefined();
    expect(effectiveVersion(versions, 'GST 5', '2030-01-01')?.id).toBe('c');
    expect(() => effectiveVersion(versions, 'GST 5', '01/01/2030')).toThrow();
  });

  it('detects overlapping periods', () => {
    const v = (from: string, to: string | null) => ({ id: 'x', name: 'n', effectiveFrom: from, effectiveTo: to });
    expect(periodsOverlap(v('2025-01-01', '2025-12-31'), v('2025-12-31', null))).toBe(true);
    expect(periodsOverlap(v('2025-01-01', '2025-12-30'), v('2025-12-31', null))).toBe(false);
    expect(periodsOverlap(v('2025-01-01', null), v('2030-01-01', '2030-01-02'))).toBe(true);
  });
});

describe('money edge paths', () => {
  it('accepts numeric inputs and handles empty or unknown stock in averages', () => {
    expect(rateToBasisPoints(18)).toBe(1800);
    expect(quantityToMilli(2)).toBe(2000);
    // Stock on hand but no recorded average: the incoming cost becomes the average.
    expect(
      weightedAverageCost({ onHandMilli: 5000, currentAvgPaise: null, addedMilli: 1000, addedUnitPaise: 700 }),
    ).toBe(700);
    // Nothing on hand and nothing added keeps the (absent) average at 0.
    expect(weightedAverageCost({ onHandMilli: 0, currentAvgPaise: null, addedMilli: 0, addedUnitPaise: 700 })).toBe(0);
    expect(() => divRoundHalfUp(-1n, 2n)).toThrow(RangeError);
  });
});
