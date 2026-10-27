import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineCost, purchaseLineAmounts, purchaseTotals, splitAmount, unitCostFromLine } from '../src/index.ts';

describe('purchase arithmetic (FR-INV-8 AC2, D-013, D-033)', () => {
  it('intra-state lines split GST into CGST/SGST; inter-state lines use IGST', () => {
    const line = { qtyMilli: 2000, unitCostPaise: 1_000_001, rateBp: 1800, cessBp: 0 };
    expect(purchaseLineAmounts(line, false)).toEqual({
      taxable: 2_000_002,
      cgst: 180_000,
      sgst: 180_000,
      igst: 0,
      cess: 0,
      tax: 360_000,
      total: 2_360_002,
    });
    expect(purchaseLineAmounts(line, true)).toMatchObject({ cgst: 0, sgst: 0, igst: 360_000, total: 2_360_002 });
  });

  it('odd-paisa GST gives CGST the floor and SGST the remainder; cess is separate', () => {
    const a = purchaseLineAmounts({ qtyMilli: 1000, unitCostPaise: 1005, rateBp: 1800, cessBp: 100 }, false);
    expect(a).toMatchObject({ taxable: 1005, cgst: 90, sgst: 91, cess: 10, tax: 191, total: 1196 });
  });

  it('document totals always equal the sums of lines and taxable + tax (property)', () => {
    const line = fc.record({
      qtyMilli: fc.integer({ min: 1, max: 1_000_000 }),
      unitCostPaise: fc.integer({ min: 0, max: 50_000_000 }),
      rateBp: fc.integer({ min: 0, max: 10_000 }),
      cessBp: fc.integer({ min: 0, max: 5000 }),
    });
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 120 }), fc.boolean(), (lines, inter) => {
        const t = purchaseTotals(lines, inter);
        return (
          t.total === t.taxable + t.tax &&
          t.tax === t.cgst + t.sgst + t.igst + t.cess &&
          t.total === t.lines.reduce((s, l) => s + l.total, 0) &&
          (inter ? t.cgst + t.sgst === 0 : t.igst === 0)
        );
      }),
    );
  });

  it('splits amounts exactly across units', () => {
    expect(splitAmount(1000, 3)).toEqual([333, 333, 334]);
    expect(splitAmount(0, 2)).toEqual([0, 0]);
    expect(() => splitAmount(10, 0)).toThrow();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 1, max: 1000 }), (amount, n) => {
        const parts = splitAmount(amount, n);
        return parts.length === n && parts.reduce((s, p) => s + p, 0) === amount && parts.every((p) => p >= 0);
      }),
    );
  });

  it('inventory cost excludes creditable tax only for regular registrants (D-033)', () => {
    const a = purchaseLineAmounts({ qtyMilli: 3000, unitCostPaise: 1000, rateBp: 1800, cessBp: 0 }, false);
    expect(lineCost(a, false)).toBe(3000);
    expect(lineCost(a, true)).toBe(3540);
    expect(unitCostFromLine(3540, 3000)).toBe(1180);
    expect(unitCostFromLine(1000, 3000)).toBe(333);
    expect(() => unitCostFromLine(100, 0)).toThrow();
  });
});
