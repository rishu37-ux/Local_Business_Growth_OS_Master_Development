import { describe, expect, it } from 'vitest';
import { gateDecision, localMinute, nextAllowedTime, type GateFacts } from '../src/index.ts';

const base: GateFacts = { purpose: 'TRANSACTIONAL', consent: null, suppressed: false, erased: false, hasAddress: true };

describe('send-time gate (FR-CON-1 AC2, AC4)', () => {
  it('transactional is allowed by default; marketing needs a granted consent', () => {
    expect(gateDecision(base)).toEqual({ allowed: true });
    expect(gateDecision({ ...base, purpose: 'MARKETING' })).toEqual({ allowed: false, reason: 'NO_MARKETING_CONSENT' });
    expect(gateDecision({ ...base, purpose: 'MARKETING', consent: 'GRANTED' })).toEqual({ allowed: true });
  });

  it('withdrawal, suppression, erasure and a missing address block every purpose, in that precedence', () => {
    expect(gateDecision({ ...base, consent: 'WITHDRAWN' })).toEqual({ allowed: false, reason: 'CONSENT_WITHDRAWN' });
    expect(gateDecision({ ...base, purpose: 'MARKETING', consent: 'GRANTED', suppressed: true })).toEqual({
      allowed: false,
      reason: 'SUPPRESSED',
    });
    expect(gateDecision({ ...base, hasAddress: false, suppressed: true })).toEqual({
      allowed: false,
      reason: 'NO_ADDRESS',
    });
    expect(gateDecision({ ...base, erased: true, hasAddress: false })).toEqual({
      allowed: false,
      reason: 'CUSTOMER_ERASED',
    });
  });
});

describe('quiet hours (FR-REM-1 AC3)', () => {
  const ist = 'Asia/Kolkata';
  it('local minutes in the business time zone', () => {
    expect(localMinute(new Date('2026-10-28T03:30:00Z'), ist)).toBe(9 * 60); // 09:00 IST
    expect(localMinute(new Date('2026-10-28T18:29:00Z'), ist)).toBe(23 * 60 + 59);
  });

  it('inside the window the time is kept; before it, today 09:00; after it, tomorrow 09:00', () => {
    const inside = new Date('2026-10-28T06:00:00Z'); // 11:30 IST
    expect(nextAllowedTime(inside, ist)).toBe(inside);
    expect(nextAllowedTime(new Date('2026-10-28T01:00:00Z'), ist).toISOString()).toBe('2026-10-28T03:30:00.000Z');
    // 21:00 IST exactly is outside (the window ends at 21:00).
    expect(nextAllowedTime(new Date('2026-10-28T15:30:00Z'), ist).toISOString()).toBe('2026-10-29T03:30:00.000Z');
    expect(nextAllowedTime(new Date('2026-10-28T15:29:59Z'), ist).toISOString()).toBe('2026-10-28T15:29:59.000Z');
    expect(nextAllowedTime(new Date('2026-10-28T20:00:00Z'), ist).toISOString()).toBe('2026-10-29T03:30:00.000Z');
    expect(nextAllowedTime(new Date('2026-10-28T01:00:00Z'), ist, 600, 1200).toISOString()).toBe(
      '2026-10-28T04:30:00.000Z',
    );
    expect(() => nextAllowedTime(inside, ist, 900, 600)).toThrow(RangeError);
  });
});
