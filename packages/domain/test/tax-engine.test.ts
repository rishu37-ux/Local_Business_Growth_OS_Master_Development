import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  apportion,
  computeSale,
  discountAmount,
  TaxEngineError,
  type SaleInput,
  type SaleLineInput,
} from '../src/index.ts';

const line = (over: Partial<SaleLineInput> = {}): SaleLineInput => ({
  qtyMilli: 1000,
  unitPricePaise: 11_800,
  priceIncludesTax: true,
  rateBp: 1800,
  cessBp: 0,
  ...over,
});
const sale = (lines: SaleLineInput[], over: Partial<SaleInput> = {}): SaleInput => ({
  lines,
  interState: false,
  chargeTax: true,
  roundOff: false,
  ...over,
});

describe('tax engine — worked examples (FR-TAX-1 AC1–3, D-013)', () => {
  it('inclusive price: ₹118 at 18 % → taxable ₹100, CGST ₹9, SGST ₹9', () => {
    const r = computeSale(sale([line()]));
    expect(r.lines[0]).toEqual({
      grossPaise: 11_800,
      lineDiscountPaise: 0,
      invoiceDiscountPaise: 0,
      taxablePaise: 10_000,
      cgstPaise: 900,
      sgstPaise: 900,
      igstPaise: 0,
      cessPaise: 0,
      totalPaise: 11_800,
    });
    expect(r.totalPaise).toBe(11_800);
  });

  it('exclusive price: ₹100 + 18 % → ₹118', () => {
    const r = computeSale(sale([line({ unitPricePaise: 10_000, priceIncludesTax: false })]));
    expect(r).toMatchObject({ taxablePaise: 10_000, cgstPaise: 900, sgstPaise: 900, totalPaise: 11_800 });
  });

  it('inter-state supply uses IGST only', () => {
    const r = computeSale(sale([line()], { interState: true }));
    expect(r).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1800, totalPaise: 11_800 });
  });

  it('odd-paisa GST: CGST takes floor(tax / 2), SGST the remainder', () => {
    // ₹10.05 exclusive at 18 %: tax round(180.9) = 181 → 90 + 91.
    const r = computeSale(sale([line({ unitPricePaise: 1005, priceIncludesTax: false })]));
    expect(r.lines[0]).toMatchObject({ taxablePaise: 1005, cgstPaise: 90, sgstPaise: 91 });
  });

  it('inclusive rounding: taxable = round_half_up(gross × 100 / (100 + rate)); tax is the rest', () => {
    // 999 × 100 / 118 = 846.61 → 847; tax 152 → 76 + 76.
    const r = computeSale(sale([line({ unitPricePaise: 999 })]));
    expect(r.lines[0]).toMatchObject({ taxablePaise: 847, cgstPaise: 76, sgstPaise: 76, totalPaise: 999 });
  });

  it('zero-rated, nil-rated or exempt lines (rate 0) carry no tax', () => {
    const r = computeSale(sale([line({ rateBp: 0, unitPricePaise: 5000 })]));
    expect(r).toMatchObject({ taxablePaise: 5000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 5000 });
  });

  it('cess: exclusive adds it separately; inclusive takes it out of the price with GST first', () => {
    const ex = computeSale(
      sale([line({ unitPricePaise: 10_000, priceIncludesTax: false, rateBp: 2800, cessBp: 1200 })]),
    );
    expect(ex.lines[0]).toMatchObject({
      taxablePaise: 10_000,
      cgstPaise: 1400,
      sgstPaise: 1400,
      cessPaise: 1200,
      totalPaise: 14_000,
    });
    const inc = computeSale(sale([line({ unitPricePaise: 14_000, rateBp: 2800, cessBp: 1200 })]));
    expect(inc.lines[0]).toMatchObject({
      taxablePaise: 10_000,
      cgstPaise: 1400,
      sgstPaise: 1400,
      cessPaise: 1200,
      totalPaise: 14_000,
    });
    // Inclusive with an odd split: 1,001 / 1.40 = 715; tax 286 → GST round(715 × 0.28) = 200, cess 86.
    const odd = computeSale(sale([line({ unitPricePaise: 1001, rateBp: 2800, cessBp: 1200 })]));
    expect(odd.lines[0]).toMatchObject({
      taxablePaise: 715,
      cgstPaise: 100,
      sgstPaise: 100,
      cessPaise: 86,
      totalPaise: 1001,
    });
  });

  it('line discounts (percent and amount) apply before tax', () => {
    const r = computeSale(
      sale([
        line({ unitPricePaise: 11_800, discount: { kind: 'AMOUNT', paise: 1180 } }),
        line({ unitPricePaise: 10_000, priceIncludesTax: false, discount: { kind: 'PERCENT', bp: 1000 } }),
      ]),
    );
    expect(r.lines[0]).toMatchObject({ lineDiscountPaise: 1180, taxablePaise: 9000, totalPaise: 10_620 });
    expect(r.lines[1]).toMatchObject({ lineDiscountPaise: 1000, taxablePaise: 9000, totalPaise: 10_620 });
    expect(r.discountPaise).toBe(2180);
  });

  it('invoice discount is apportioned in proportion to line value; remainder paise go to the last line', () => {
    // ₹1.00 off lines worth 1 : 1 : 1 (₹10 each) → 33, 33, 34 paise.
    const r = computeSale(
      sale(
        [1, 2, 3].map(() => line({ unitPricePaise: 1000, rateBp: 0 })),
        { invoiceDiscount: { kind: 'AMOUNT', paise: 100 } },
      ),
    );
    expect(r.lines.map((l) => l.invoiceDiscountPaise)).toEqual([33, 33, 34]);
    expect(r).toMatchObject({ discountPaise: 100, totalPaise: 2900 });
    // Percent: 10 % of ₹300 = ₹30, split 2 : 1.
    const p = computeSale(
      sale([line({ unitPricePaise: 20_000, rateBp: 0 }), line({ unitPricePaise: 10_000, rateBp: 0 })], {
        invoiceDiscount: { kind: 'PERCENT', bp: 1000 },
      }),
    );
    expect(p.lines.map((l) => l.invoiceDiscountPaise)).toEqual([2000, 1000]);
  });

  it('round-off to the nearest rupee is a separate amount and part of the total', () => {
    const up = computeSale(sale([line({ unitPricePaise: 10_050, rateBp: 0 })], { roundOff: true }));
    expect(up).toMatchObject({ roundOffPaise: 50, totalPaise: 10_100 });
    const down = computeSale(sale([line({ unitPricePaise: 10_049, rateBp: 0 })], { roundOff: true }));
    expect(down).toMatchObject({ roundOffPaise: -49, totalPaise: 10_000 });
    expect(computeSale(sale([line({ unitPricePaise: 10_000, rateBp: 0 })], { roundOff: true })).roundOffPaise).toBe(0);
  });

  it('multi-rate invoices sum line by line', () => {
    const r = computeSale(
      sale([
        line({ unitPricePaise: 11_800 }),
        line({ unitPricePaise: 10_500, rateBp: 500 }),
        line({ unitPricePaise: 1000, rateBp: 0 }),
      ]),
    );
    expect(r).toMatchObject({
      taxablePaise: 10_000 + 10_000 + 1000,
      cgstPaise: 900 + 250,
      sgstPaise: 900 + 250,
      totalPaise: 23_300,
    });
  });

  it('quantities: 3 × ₹118 and 1.5 × ₹200 (exempt)', () => {
    const r = computeSale(
      sale([line({ qtyMilli: 3000 }), line({ qtyMilli: 1500, unitPricePaise: 20_000, rateBp: 0 })]),
    );
    expect(r.lines.map((l) => l.totalPaise)).toEqual([35_400, 30_000]);
  });

  it('Bill of Supply (unregistered/composition): no tax lines, net amount is the total (AC4)', () => {
    const r = computeSale(
      sale([line(), line({ priceIncludesTax: false, unitPricePaise: 10_000 })], { chargeTax: false }),
    );
    expect(r).toMatchObject({
      taxablePaise: 21_800,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      cessPaise: 0,
      totalPaise: 21_800,
    });
  });

  it('an invoice with 120 lines reconciles exactly', () => {
    const lines = Array.from({ length: 120 }, (_, i) =>
      line({
        unitPricePaise: 997 + i * 13,
        rateBp: [0, 500, 1200, 1800, 2800][i % 5] ?? 0,
        priceIncludesTax: i % 2 === 0,
      }),
    );
    const r = computeSale(sale(lines, { invoiceDiscount: { kind: 'AMOUNT', paise: 1234 }, roundOff: true }));
    expect(r.lines).toHaveLength(120);
    expect(r.totalPaise).toBe(r.lines.reduce((s, l) => s + l.totalPaise, 0) + r.roundOffPaise);
    expect(r.lines.reduce((s, l) => s + l.invoiceDiscountPaise, 0)).toBe(1234);
  });
});

describe('tax engine — validation', () => {
  it('rejects empty invoices, bad numbers and discounts larger than the value', () => {
    expect(() => computeSale(sale([]))).toThrow(TaxEngineError);
    expect(() => computeSale(sale([line({ qtyMilli: 0 })]))).toThrow(/quantity/);
    expect(() => computeSale(sale([line({ qtyMilli: 1.5 })]))).toThrow(TaxEngineError);
    expect(() => computeSale(sale([line({ rateBp: 10_001 })]))).toThrow(/tax rate/);
    expect(() => computeSale(sale([line({ cessBp: -1 })]))).toThrow(/cess/);
    expect(() => computeSale(sale([line({ unitPricePaise: -5 })]))).toThrow(/price/);
    try {
      computeSale(sale([line(), line({ discount: { kind: 'AMOUNT', paise: 99_999 } })]));
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'DISCOUNT_EXCEEDS_VALUE', lineIndex: 1 });
    }
    expect(() => computeSale(sale([line()], { invoiceDiscount: { kind: 'AMOUNT', paise: 11_801 } }))).toThrow(
      TaxEngineError,
    );
    expect(() => discountAmount(100, { kind: 'PERCENT', bp: 10_001 })).toThrow(/percent/);
    expect(() => discountAmount(100, { kind: 'AMOUNT', paise: 1.5 })).toThrow(/amount/);
  });

  it('100 % discounts and zero-value lines are allowed', () => {
    const r = computeSale(sale([line({ discount: { kind: 'PERCENT', bp: 10_000 } }), line({ unitPricePaise: 0 })]));
    expect(r.totalPaise).toBe(0);
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(5, [0, 0, 5])).toEqual([0, 0, 5]);
    // A remainder skips a line that has no room left.
    expect(apportion(2, [2, 1, 0])).toEqual([1, 1, 0]);
  });
});

describe('tax engine — properties (FR-TAX-1 AC3)', () => {
  const discount = fc.option(
    fc.oneof(
      fc.record({ kind: fc.constant('PERCENT' as const), bp: fc.integer({ min: 0, max: 10_000 }) }),
      fc.record({ kind: fc.constant('AMOUNT' as const), paise: fc.integer({ min: 0, max: 500 }) }),
    ),
    { nil: undefined },
  );
  const saleLine = fc.record({
    qtyMilli: fc.integer({ min: 1000, max: 20_000 }),
    unitPricePaise: fc.integer({ min: 500, max: 20_000_000 }),
    priceIncludesTax: fc.boolean(),
    rateBp: fc.constantFrom(0, 25, 300, 500, 1200, 1800, 2800),
    cessBp: fc.constantFrom(0, 0, 100, 1200),
    discount,
  });
  const input = fc.record({
    lines: fc.array(saleLine, { minLength: 1, maxLength: 40 }),
    interState: fc.boolean(),
    chargeTax: fc.boolean(),
    roundOff: fc.boolean(),
    invoiceDiscount: fc.option(
      fc.record({ kind: fc.constant('PERCENT' as const), bp: fc.integer({ min: 0, max: 5000 }) }),
      {
        nil: undefined,
      },
    ),
  });

  it('Σ lines = totals; each line reconciles; inclusive lines keep their net amount; never negative', () => {
    fc.assert(
      fc.property(input, (inp) => {
        const r = computeSale(inp);
        const sum = (k: 'taxablePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'cessPaise' | 'totalPaise') =>
          r.lines.reduce((s, l) => s + l[k], 0);
        const linesOk = r.lines.every((l, i) => {
          const src = inp.lines[i];
          const net = l.grossPaise - l.lineDiscountPaise - l.invoiceDiscountPaise;
          return (
            l.totalPaise === l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise &&
            Math.abs(l.cgstPaise - l.sgstPaise) <= 1 &&
            l.sgstPaise >= l.cgstPaise &&
            (!inp.interState || l.cgstPaise + l.sgstPaise === 0) &&
            (inp.interState || l.igstPaise === 0) &&
            (!(src?.priceIncludesTax ?? false) || !inp.chargeTax || l.totalPaise === net) &&
            (inp.chargeTax || (l.totalPaise === net && l.taxablePaise === net)) &&
            net >= 0 &&
            [l.taxablePaise, l.cgstPaise, l.sgstPaise, l.igstPaise, l.cessPaise].every((x) => x >= 0)
          );
        });
        return (
          linesOk &&
          r.taxablePaise === sum('taxablePaise') &&
          r.cgstPaise === sum('cgstPaise') &&
          r.sgstPaise === sum('sgstPaise') &&
          r.igstPaise === sum('igstPaise') &&
          r.cessPaise === sum('cessPaise') &&
          r.totalPaise === sum('totalPaise') + r.roundOffPaise &&
          r.roundOffPaise >= -49 &&
          r.roundOffPaise <= 50 &&
          (!inp.roundOff || r.totalPaise % 100 === 0)
        );
      }),
      { numRuns: 400 },
    );
  });

  it('apportion: shares sum to the amount and never exceed a weight', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1e9 }), { minLength: 1, maxLength: 50 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (w, f) => {
          const total = w.reduce((s, x) => s + x, 0);
          const amount = Math.floor(total * f);
          const shares = apportion(amount, w);
          return shares.reduce((s, x) => s + x, 0) === amount && shares.every((s, i) => s >= 0 && s <= (w[i] ?? 0));
        },
      ),
    );
  });
});
