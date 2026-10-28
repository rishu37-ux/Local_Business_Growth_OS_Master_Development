import { describe, expect, it } from 'vitest';
import { normalizeMobile, normalizeTags, placeOfSupply } from '../src/index.ts';

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

describe('customer tags (FR-CRM-1 AC1)', () => {
  it('trims, collapses spaces and drops case-insensitive duplicates', () => {
    expect(normalizeTags(['  VIP ', 'vip', 'Repair   customer', 'Bulk'])).toEqual(['VIP', 'Repair customer', 'Bulk']);
    expect(normalizeTags([])).toEqual([]);
  });

  it('refuses empty, long, separator-containing or more than 10 tags', () => {
    expect(normalizeTags([' '])).toBeNull();
    expect(normalizeTags(['x'.repeat(31)])).toBeNull();
    expect(normalizeTags(['a,b'])).toBeNull();
    expect(normalizeTags(['a;b'])).toBeNull();
    expect(normalizeTags(Array.from({ length: 11 }, (_, i) => `t${String(i)}`))).toBeNull();
    expect(normalizeTags([...Array.from({ length: 10 }, (_, i) => `t${String(i)}`), 'T0'])).toHaveLength(10);
  });
});
