import { describe, expect, it } from 'vitest';
import { normalizeMobile, placeOfSupply } from '../src/index.ts';

describe('mobile numbers (FR-CRM-1 AC1)', () => {
  it.each([
    ['98765 43210', '+919876543210'],
    ['098765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalises %s', (input, out) => {
    expect(normalizeMobile(input)).toBe(out);
  });

  it.each(['12345', '5876543210', '+91 12345 67890', '+910000', 'abc', '+0123456789'])('rejects %s', (input) => {
    expect(normalizeMobile(input)).toBeNull();
  });
});

describe('place of supply (FR-POS-5 AC2)', () => {
  it('GSTIN state, then customer state, then the shop state', () => {
    expect(placeOfSupply({ gstin: '29AAGCB7383J1Z4', stateCode: '27' }, '27')).toBe('29');
    expect(placeOfSupply({ stateCode: '09' }, '27')).toBe('09');
    expect(placeOfSupply({}, '27')).toBe('27');
    expect(placeOfSupply(null, '27')).toBe('27');
  });
});
