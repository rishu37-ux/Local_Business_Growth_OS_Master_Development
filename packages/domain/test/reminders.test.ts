import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  REMINDER_TYPES,
  renderTemplate,
  templatePlaceholders,
  templateProblems,
} from '../src/index.ts';

describe('reminder templates (FR-REM-1 AC2)', () => {
  it('default templates are valid for their type', () => {
    for (const t of REMINDER_TYPES) expect(templateProblems(t, DEFAULT_TEMPLATES[t])).toEqual([]);
  });

  it('refuses unknown placeholders, ones the type cannot fill, stray braces and empty text', () => {
    expect(templateProblems('BIRTHDAY', 'Hi {name}, {discount}% off!')).toEqual(['Unknown placeholder {discount}.']);
    expect(templateProblems('BIRTHDAY', 'Hi {name}, your {model}')).toEqual([
      '{model} is not available for this reminder.',
    ]);
    expect(templateProblems('PAYMENT_DUE', 'Pay {amount_due} {')).toEqual(['Unmatched { or }.']);
    expect(templateProblems('PAYMENT_DUE', 'Pay } now')).toEqual(['Unmatched { or }.']);
    expect(templateProblems('PAYMENT_DUE', '  ')).toEqual(['The text is empty.']);
    expect(templateProblems('PAYMENT_DUE', 'Pay {}')).toEqual(['Unknown placeholder {}.']);
  });

  it('fills recorded values; a missing value reports the placeholder instead of sending a gap', () => {
    expect(templatePlaceholders('{name} {shop} {name}')).toEqual(['name', 'shop']);
    expect(renderTemplate('Hi {name} from {shop}, {name}!', { name: 'Asha', shop: 'Star Mobiles' })).toEqual({
      ok: true,
      text: 'Hi Asha from Star Mobiles, Asha!',
    });
    expect(renderTemplate('IMEI {imei_last4} ends {warranty_end}', { imei_last4: null, warranty_end: ' ' })).toEqual({
      ok: false,
      missing: ['imei_last4', 'warranty_end'],
    });
    expect(renderTemplate('No placeholders.', {})).toEqual({ ok: true, text: 'No placeholders.' });
  });
});
