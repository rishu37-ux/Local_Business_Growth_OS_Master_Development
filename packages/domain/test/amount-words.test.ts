import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { amountInWords, GST_STATES, stateLabel } from '../src/index.ts';

describe('amount in words (FR-PRN-1 AC2)', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(5)).toBe('Rupees Zero and Five Paise Only');
    expect(amountInWords(1_600_000)).toBe('Rupees Sixteen Thousand Only');
    expect(amountInWords(33_300)).toBe('Rupees Three Hundred Thirty-Three Only');
    expect(amountInWords(1_234_567_890)).toBe(
      'Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight and Ninety Paise Only',
    );
    expect(amountInWords(10_000_000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(1_100_000_000_000)).toBe('Rupees One Thousand One Hundred Crore Only');
    expect(amountInWords(1_901)).toBe('Rupees Nineteen and One Paise Only');
    expect(amountInWords(7_000_000)).toBe('Rupees Seventy Thousand Only');
  });

  it('rejects negative and fractional amounts', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(1.5)).toThrow(RangeError);
  });

  it('always ends with "Only" and never contains empty words (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e13 }), (n) => {
        const w = amountInWords(n);
        return w.startsWith('Rupees ') && w.endsWith(' Only') && !/\s{2}|-\s|\s-|undefined/.test(w);
      }),
    );
  });

  it('names states by GST code', () => {
    expect(stateLabel('27')).toBe('Maharashtra (27)');
    expect(stateLabel('99')).toBe('99');
    expect(Object.keys(GST_STATES)).toHaveLength(37);
  });
});
