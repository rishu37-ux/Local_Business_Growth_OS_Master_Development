import { describe, expect, it } from 'vitest';
import { displayDate, factsFor, groundingCheck, type GroundingFacts } from '../src/index.ts';

const facts: GroundingFacts = factsFor(
  [
    { pricePaise: 1_500_000, specs: ['8GB', '128 GB', 'Blue'] },
    { pricePaise: 49_900, specs: [null] },
  ],
  { kind: 'PERCENT', value: 1000, validFrom: '2026-11-01', validTo: '2026-11-30' },
);

describe('grounding post-check (FR-AIC-2 AC2)', () => {
  it('facts include prices, offer prices, the percentage, the dates and numeric specs', () => {
    expect(facts.pricesPaise).toEqual(expect.arrayContaining([1_500_000, 1_350_000, 49_900, 44_910, 44_900]));
    expect(facts.percents).toEqual([10]);
    expect(facts.dates).toEqual(['2026-11-01', '2026-11-30']);
    expect(facts.specs).toEqual(['8GB', '128 GB']);
  });

  it('grounded text passes in many notations', () => {
    for (const t of [
      'Model X 8GB/128GB at ₹15,000 — now ₹13,500 with 10% off till 30 Nov 2026!',
      'Rs. 15000 only. Offer ends 30/11/2026. 128 gb storage.',
      'INR 449 for the cable (10 percent off), from 1st November to November 30.',
      'Only 13500/- till 2026-11-30.',
      'Was ₹499, now ₹449.10.',
    ]) {
      expect(groundingCheck(t, facts)).toEqual([]);
    }
  });

  it('flags invented prices, percentages, dates and specs', () => {
    expect(
      groundingCheck(
        'Only ₹999 and 50% off till 31 Dec 2099! Huge 12GB RAM, 108MP camera, 6.7" screen. Also Rs 15,000.',
        facts,
      ),
    ).toEqual([
      { kind: 'DATE', text: '31 Dec 2099' },
      { kind: 'PRICE', text: '₹999' },
      { kind: 'PERCENT', text: '50%' },
      { kind: 'SPEC', text: '12GB' },
      { kind: 'SPEC', text: '108MP' },
      { kind: 'SPEC', text: '6.7"' },
    ]);
    expect(groundingCheck('Sale on 15/08/2026 and Dec 25, Jan 1st 2027, 2026-12-31', facts).map((f) => f.text)).toEqual(
      ['2026-12-31', '15/08/2026', 'Dec 25', 'Jan 1st 2027'],
    );
    // A day and month without a year match the offer date of any year; a wrong year does not.
    expect(groundingCheck('Ends 30 Nov', facts)).toEqual([]);
    expect(groundingCheck('Ends 30 Nov 2027', facts)).toEqual([{ kind: 'DATE', text: '30 Nov 2027' }]);
    expect(groundingCheck('₹999 ₹999', facts)).toEqual([{ kind: 'PRICE', text: '₹999' }]); // listed once
  });

  it('amount offers and no offer', () => {
    const amount = factsFor([{ pricePaise: 100_000, specs: [] }], {
      kind: 'AMOUNT',
      value: 10_000,
      validFrom: '2026-01-01',
      validTo: '2026-01-31',
    });
    expect(groundingCheck('₹1,000 now ₹900 — ₹100 off!', amount)).toEqual([]);
    expect(groundingCheck('Flat 5% off', factsFor([{ pricePaise: 100, specs: [] }], null))).toEqual([
      { kind: 'PERCENT', text: '5%' },
    ]);
    expect(displayDate('2026-11-30')).toBe('30 Nov 2026');
  });
});
