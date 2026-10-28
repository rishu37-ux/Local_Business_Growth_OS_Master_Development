import { describe, expect, it } from 'vitest';
import {
  channelConfigProblem,
  matchTemplate,
  templateBodyValid,
  whatsappPurpose,
  type ChannelTemplate,
} from '../src/index.ts';

const t = (
  id: string,
  channel: 'WHATSAPP' | 'SMS',
  purpose: 'MARKETING' | 'TRANSACTIONAL',
  body: string,
  status = 'APPROVED',
): ChannelTemplate => ({
  id,
  channel,
  purpose,
  body,
  status,
});

const templates = [
  t('wa-pending', 'WHATSAPP', 'MARKETING', 'Diwali: {{1}} off at {{2}}!', 'PENDING'),
  t('wa-offer', 'WHATSAPP', 'MARKETING', 'Diwali: {{1}} off at {{2}}!'),
  t('wa-swap', 'WHATSAPP', 'TRANSACTIONAL', 'Invoice {{2}} for {{1}} is ready.'),
  t('wa-fixed', 'WHATSAPP', 'TRANSACTIONAL', 'Your repair is ready (1+1=2?).'),
  t('sms-promo', 'SMS', 'MARKETING', 'Sale: {#var#} off on {#var#}. -Shop'),
  t('sms-txn', 'SMS', 'TRANSACTIONAL', 'Dear {#var#}, invoice {#var#} paid. -Shop'),
];

describe('template matching (FR-MSG-1 AC1, FR-MSG-2 AC1)', () => {
  it('matches an approved template of the right channel and purpose and extracts the parameters', () => {
    expect(
      matchTemplate(' Diwali: 10% off at Model X! ', templates, { channel: 'WHATSAPP', purpose: 'MARKETING' }),
    ).toEqual({
      template: templates[1],
      params: ['10%', 'Model X'],
    });
    // Parameters follow the placeholder numbers, not their position in the text.
    expect(
      matchTemplate('Invoice INV-7 for Asha is ready.', templates, { channel: 'WHATSAPP', purpose: 'TRANSACTIONAL' })
        ?.params,
    ).toEqual(['Asha', 'INV-7']);
    expect(
      matchTemplate('Your repair is ready (1+1=2?).', templates, { channel: 'WHATSAPP', purpose: 'TRANSACTIONAL' })
        ?.template.id,
    ).toBe('wa-fixed');
    expect(
      matchTemplate('Sale: 10% off on covers. -Shop', templates, { channel: 'SMS', purpose: 'MARKETING' })?.params,
    ).toEqual(['10%', 'covers']);
  });

  it('never mixes marketing and transactional, channels, or unapproved templates; rejects extra or invalid text', () => {
    expect(
      matchTemplate('Diwali: 10% off at Model X!', templates, { channel: 'WHATSAPP', purpose: 'TRANSACTIONAL' }),
    ).toBeNull();
    expect(
      matchTemplate('Sale: 10% off on covers. -Shop', templates, { channel: 'SMS', purpose: 'TRANSACTIONAL' }),
    ).toBeNull();
    expect(
      matchTemplate('Diwali: 10% off at Model X!', templates, { channel: 'SMS', purpose: 'MARKETING' }),
    ).toBeNull();
    expect(
      matchTemplate('Diwali: 10% off at Model X! Hurry', templates, { channel: 'WHATSAPP', purpose: 'MARKETING' }),
    ).toBeNull();
    expect(
      matchTemplate('Diwali:  off at Model X!', templates, { channel: 'WHATSAPP', purpose: 'MARKETING' }),
    ).toBeNull();
    // A WhatsApp parameter has no new lines; a DLT variable is at most 30 characters.
    expect(
      matchTemplate('Diwali: 10%\noff at X!', templates, { channel: 'WHATSAPP', purpose: 'MARKETING' }),
    ).toBeNull();
    expect(
      matchTemplate(`Sale: ${'x'.repeat(31)} off on covers. -Shop`, templates, {
        channel: 'SMS',
        purpose: 'MARKETING',
      }),
    ).toBeNull();
    // Only the pending copy would match: nothing is sent.
    expect(
      matchTemplate('Diwali: 5% off at Y!', [templates[0] as ChannelTemplate], {
        channel: 'WHATSAPP',
        purpose: 'MARKETING',
      }),
    ).toBeNull();
  });

  it('checks template bodies and WhatsApp categories', () => {
    expect(templateBodyValid({ channel: 'WHATSAPP', body: 'Hi {{1}}, {{2}}' })).toBe(true);
    expect(templateBodyValid({ channel: 'WHATSAPP', body: 'Hi {{2}}' })).toBe(false);
    expect(templateBodyValid({ channel: 'WHATSAPP', body: 'Hi {{1}} {{1}}' })).toBe(false);
    expect(templateBodyValid({ channel: 'SMS', body: '  ' })).toBe(false);
    expect(templateBodyValid({ channel: 'SMS', body: 'Hi {#var#}' })).toBe(true);
    expect(
      matchTemplate('Hi A', [t('bad', 'WHATSAPP', 'MARKETING', 'Hi {{2}}')], {
        channel: 'WHATSAPP',
        purpose: 'MARKETING',
      }),
    ).toBeNull();
    expect([whatsappPurpose('MARKETING'), whatsappPurpose('utility'), whatsappPurpose('AUTHENTICATION')]).toEqual([
      'MARKETING',
      'TRANSACTIONAL',
      'TRANSACTIONAL',
    ]);
  });
});

describe('channel configuration (FR-MSG-2 AC1)', () => {
  it('WhatsApp needs numeric phone number and account IDs', () => {
    expect(channelConfigProblem('whatsapp_cloud', { phoneNumberId: '1234567890', wabaId: '9876543210' })).toBeNull();
    expect(channelConfigProblem('whatsapp_cloud', null)).toMatch(/required/);
    expect(channelConfigProblem('whatsapp_cloud', { phoneNumberId: 'abc', wabaId: '9876543210' })).toMatch(
      /phone number ID/,
    );
    expect(channelConfigProblem('whatsapp_cloud', { phoneNumberId: '1234567890', wabaId: 'x' })).toMatch(/Account ID/);
    expect(channelConfigProblem('whatsapp_cloud', { phoneNumberId: '1234567890', wabaId: '9876543210', x: 1 })).toMatch(
      /Unknown/,
    );
  });

  it('SMS needs the DLT entity ID and registered headers of the right form', () => {
    const ok = { dltEntityId: '1201234567890123456', headers: { TRANSACTIONAL: 'SHOPIN', MARKETING: '123456' } };
    expect(channelConfigProblem('sms_dlt_json', ok)).toBeNull();
    expect(channelConfigProblem('sms_dlt_json', 'x')).toMatch(/required/);
    expect(channelConfigProblem('sms_dlt_json', { ...ok, dltEntityId: '12' })).toMatch(/entity ID/);
    expect(channelConfigProblem('sms_dlt_json', { ...ok, headers: {} })).toMatch(/At least one/);
    expect(channelConfigProblem('sms_dlt_json', { ...ok, headers: { TRANSACTIONAL: 'shop12' } })).toMatch(/6 capital/);
    expect(channelConfigProblem('sms_dlt_json', { ...ok, headers: { MARKETING: 'SHOPIN' } })).toMatch(/6 digits/);
    expect(channelConfigProblem('sms_dlt_json', { ...ok, headers: { OTP: 'SHOPIN' } })).toMatch(
      /TRANSACTIONAL or MARKETING/,
    );
    expect(channelConfigProblem('sms_dlt_json', { ...ok, extra: true })).toMatch(/Unknown/);
  });

  it('other providers take no configuration', () => {
    expect(channelConfigProblem('mock', {})).toBeNull();
    expect(channelConfigProblem('mock', { a: 1 })).toMatch(/no configuration/);
  });
});
