import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { financialYear, gstinCheckChar, gstinProblem } from '../src/index.ts';

describe('GSTIN (FR-ONB-2 AC4)', () => {
  // Widely published sample GSTINs; used only as format/checksum vectors.
  it.each(['27AAPFU0939F1ZV', '29AAGCB7383J1Z4'])('accepts %s', (g) => {
    expect(gstinProblem(g)).toBeUndefined();
  });

  it('rejects malformed values, bad check characters and state mismatches', () => {
    expect(gstinProblem('27AAPFU0939F1Z')).toBe('FORMAT');
    expect(gstinProblem('27aapfu0939f1zv')).toBe('FORMAT');
    expect(gstinProblem('27AAPFU0939F1ZW')).toBe('CHECKSUM');
    expect(gstinProblem('27AAPFU0939F1ZV', '09')).toBe('STATE_MISMATCH');
    expect(gstinProblem('27AAPFU0939F1ZV', '27')).toBeUndefined();
  });

  it('a correct check character is accepted and any other is rejected (property)', () => {
    const body = fc
      .tuple(
        fc.stringMatching(/^[0-9]{2}$/),
        fc.stringMatching(/^[A-Z]{5}$/),
        fc.stringMatching(/^[0-9]{4}$/),
        fc.stringMatching(/^[A-Z]$/),
        fc.stringMatching(/^[1-9A-Z]$/),
      )
      .map((parts) => parts.join('') + 'Z');
    fc.assert(
      fc.property(body, fc.stringMatching(/^[0-9A-Z]$/), (b, other) => {
        const check = gstinCheckChar(b);
        expect(gstinProblem(b + check)).toBeUndefined();
        if (other !== check) expect(gstinProblem(b + other)).toBe('CHECKSUM');
      }),
    );
  });
});

describe('financialYear (FR-RPT-3, D-012)', () => {
  const ist = 'Asia/Kolkata';
  it('uses the business timezone at the March/April boundary', () => {
    // 31 Mar 2027 23:30 IST = 18:00 UTC; 1 Apr 2027 00:30 IST = 31 Mar 19:00 UTC.
    expect(financialYear(new Date('2027-03-31T18:00:00Z'), ist, 4)).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T19:00:00Z'), ist, 4)).toBe('2027-28');
    expect(financialYear(new Date('2027-03-31T19:00:00Z'), 'UTC', 4)).toBe('2026-27');
  });

  it('handles other start months and century wrap', () => {
    expect(financialYear(new Date('2026-10-27T00:00:00Z'), ist, 1)).toBe('2026-26');
    expect(financialYear(new Date('2099-12-01T00:00:00Z'), 'UTC', 4)).toBe('2099-00');
    expect(() => financialYear(new Date(), ist, 13)).toThrow();
  });

  it('labels match the invoice-series format', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2098-12-31'), noInvalidDate: true }),
        fc.integer({ min: 1, max: 12 }),
        (d, m) => {
          expect(financialYear(d, ist, m)).toMatch(/^[0-9]{4}-[0-9]{2}$/);
        },
      ),
    );
  });
});
