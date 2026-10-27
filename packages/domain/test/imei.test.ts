import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidImei, luhnCheckDigit } from '../src/index.ts';
import vectors from './vectors/imei.json' with { type: 'json' };

describe('isValidImei', () => {
  it.each(vectors.valid)('accepts %s', (imei) => {
    expect(isValidImei(imei)).toBe(true);
  });

  it.each(vectors.invalid)('rejects %j', (imei) => {
    expect(isValidImei(imei)).toBe(false);
  });

  it('accepts exactly one check digit for any 14-digit body', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{14}$/), (body) => {
        const digits = Array.from({ length: 10 }, (_, d) => String(d));
        const accepted = digits.filter((d) => isValidImei(body + d));
        expect(accepted).toEqual([String(luhnCheckDigit(body))]);
      }),
    );
  });

  it('detects any single-digit substitution', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9]{14}$/),
        fc.integer({ min: 0, max: 14 }),
        fc.integer({ min: 1, max: 9 }),
        (body, pos, delta) => {
          const imei = body + String(luhnCheckDigit(body));
          const changed = imei.slice(0, pos) + String((Number(imei[pos]) + delta) % 10) + imei.slice(pos + 1);
          expect(isValidImei(changed)).toBe(false);
        },
      ),
    );
  });
});
