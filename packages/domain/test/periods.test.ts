import { describe, expect, it } from 'vitest';
import { addDays, ageingBucket, customPeriod, daysBetween, periodRange } from '../src/index.ts';

const IN = { weekStart: 1, fyStartMonth: 4 };

describe('report periods (FR-RPT-1 AC1, FR-RPT-3)', () => {
  it('day, month and calendar year with the previous period', () => {
    expect(periodRange('day', '2027-04-01', IN)).toEqual({
      kind: 'day',
      from: '2027-04-01',
      to: '2027-04-01',
      previous: { from: '2027-03-31', to: '2027-03-31' },
    });
    expect(periodRange('month', '2024-03-15', IN)).toMatchObject({
      from: '2024-03-01',
      to: '2024-03-31',
      previous: { from: '2024-02-01', to: '2024-02-29' },
    });
    expect(periodRange('year', '2026-10-27', IN)).toMatchObject({
      from: '2026-01-01',
      to: '2026-12-31',
      previous: { from: '2025-01-01', to: '2025-12-31' },
    });
  });

  it('financial year: 31 March and 1 April fall in different years', () => {
    expect(periodRange('fy', '2027-03-31', IN)).toMatchObject({
      from: '2026-04-01',
      to: '2027-03-31',
      previous: { from: '2025-04-01', to: '2026-03-31' },
    });
    expect(periodRange('fy', '2027-04-01', IN)).toMatchObject({ from: '2027-04-01', to: '2028-03-31' });
    expect(periodRange('fy', '2026-06-30', { weekStart: 1, fyStartMonth: 1 })).toMatchObject({
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });

  it('weeks start on the configured day (default Monday)', () => {
    // 27 Oct 2026 is a Tuesday.
    expect(periodRange('week', '2026-10-27', IN)).toMatchObject({
      from: '2026-10-26',
      to: '2026-11-01',
      previous: { from: '2026-10-19', to: '2026-10-25' },
    });
    expect(periodRange('week', '2026-10-27', { weekStart: 7, fyStartMonth: 4 })).toMatchObject({
      from: '2026-10-25',
      to: '2026-10-31',
    });
    expect(periodRange('week', '2026-10-26', IN).from).toBe('2026-10-26'); // a Monday starts its own week
    expect(periodRange('week', '2026-11-01', IN).from).toBe('2026-10-26'); // a Sunday ends it
  });

  it('custom ranges compare with the same length before', () => {
    expect(customPeriod('2026-10-11', '2026-10-20')).toEqual({
      kind: 'custom',
      from: '2026-10-11',
      to: '2026-10-20',
      previous: { from: '2026-10-01', to: '2026-10-10' },
    });
    expect(() => customPeriod('2026-10-20', '2026-10-11')).toThrow(RangeError);
    expect(() => customPeriod('2000-01-01', '2026-01-01')).toThrow(RangeError);
  });

  it('date helpers and validation', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
    expect(() => periodRange('day', '2026-02-30', IN)).toThrow(RangeError);
    expect(() => periodRange('day', '26-1-1', IN)).toThrow(RangeError);
    expect(() => periodRange('week', '2026-01-01', { weekStart: 0, fyStartMonth: 4 })).toThrow(RangeError);
    expect(() => periodRange('fy', '2026-01-01', { weekStart: 1, fyStartMonth: 13 })).toThrow(RangeError);
  });

  it('receivables ageing buckets', () => {
    expect(ageingBucket('2026-10-27', '2026-10-27')).toBe('0-30');
    expect(ageingBucket('2026-09-27', '2026-10-27')).toBe('0-30'); // 30 days
    expect(ageingBucket('2026-09-26', '2026-10-27')).toBe('31-60');
    expect(ageingBucket('2026-08-28', '2026-10-27')).toBe('31-60'); // 60
    expect(ageingBucket('2026-08-27', '2026-10-27')).toBe('61-90');
    expect(ageingBucket('2026-07-29', '2026-10-27')).toBe('61-90'); // 90
    expect(ageingBucket('2026-07-28', '2026-10-27')).toBe('90+');
    expect(ageingBucket('2026-10-28', '2026-10-27')).toBe('0-30'); // future-dated never negative
  });
});
