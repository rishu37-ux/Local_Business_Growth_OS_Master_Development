import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyAge, reorderSuggestion } from '../src/index.ts';

describe('reorder suggestion (FR-INV-7 AC3)', () => {
  it('applies the formula exactly', () => {
    // 45 sold in 30 days = 1.5/day; lead 7 days → 10.5; + reorder level 5 = 15.5; − 6 on hand − 2 on order = 7.5
    expect(
      reorderSuggestion({
        soldMilli: 45_000,
        windowDays: 30,
        leadTimeDays: 7,
        reorderLevel: 5,
        onHandMilli: 6000,
        onOrderMilli: 2000,
      }),
    ).toEqual({ averageDailyMilli: 1500, suggestedMilli: 7500, suggestedUnits: 8 });
  });

  it('never suggests a negative quantity, and treats a missing reorder level as 0', () => {
    expect(
      reorderSuggestion({
        soldMilli: 3000,
        windowDays: 30,
        leadTimeDays: 7,
        reorderLevel: null,
        onHandMilli: 50_000,
        onOrderMilli: 0,
      }),
    ).toEqual({ averageDailyMilli: 100, suggestedMilli: 0, suggestedUnits: 0 });
    // Negative stock on hand increases the suggestion.
    expect(
      reorderSuggestion({
        soldMilli: 0,
        windowDays: 30,
        leadTimeDays: 7,
        reorderLevel: 2,
        onHandMilli: -1000,
        onOrderMilli: 0,
      }),
    ).toMatchObject({ suggestedMilli: 3000, suggestedUnits: 3 });
  });

  it('rounds lead-time demand once, half up (no compounding of the daily average)', () => {
    // 10 sold in 30 days: 0.333…/day; × 7 = 2.333… → 2333 (rounding the average first would give 2331).
    expect(
      reorderSuggestion({
        soldMilli: 10_000,
        windowDays: 30,
        leadTimeDays: 7,
        reorderLevel: 0,
        onHandMilli: 0,
        onOrderMilli: 0,
      }).suggestedMilli,
    ).toBe(2333);
  });

  it('is non-negative and monotone in sales (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e9 }),
        fc.integer({ min: 0, max: 1e9 }),
        fc.integer({ min: 1, max: 365 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: -1e6, max: 1e9 }),
        (a, b, window, lead, onHand) => {
          const s = (sold: number) =>
            reorderSuggestion({
              soldMilli: sold,
              windowDays: window,
              leadTimeDays: lead,
              reorderLevel: 3,
              onHandMilli: onHand,
              onOrderMilli: 0,
            }).suggestedMilli;
          return s(a) >= 0 && (a <= b ? s(a) <= s(b) : s(a) >= s(b));
        },
      ),
    );
  });

  it('validates inputs', () => {
    expect(() =>
      reorderSuggestion({
        soldMilli: 1,
        windowDays: 0,
        leadTimeDays: 7,
        reorderLevel: 0,
        onHandMilli: 0,
        onOrderMilli: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('slow-moving and dead stock (FR-INV-7 AC2)', () => {
  it('classifies by days since the last sale (or first receipt)', () => {
    expect(classifyAge(59, 60, 120)).toBe('ACTIVE');
    expect(classifyAge(60, 60, 120)).toBe('SLOW');
    expect(classifyAge(119, 60, 120)).toBe('SLOW');
    expect(classifyAge(120, 60, 120)).toBe('DEAD');
    expect(() => classifyAge(10, 60, 30)).toThrow(RangeError);
  });
});
