// Consent policy and quiet hours for messages (FR-CON-1, FR-REM-1 AC3, D-048).

export const MESSAGE_CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export const MESSAGE_PURPOSES = ['TRANSACTIONAL', 'MARKETING'] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

export type BlockReason =
  'CUSTOMER_ERASED' | 'SUPPRESSED' | 'CONSENT_WITHDRAWN' | 'NO_MARKETING_CONSENT' | 'NO_ADDRESS';

export interface GateFacts {
  readonly purpose: MessagePurpose;
  /** Latest consent record for this customer, channel and purpose; null when none. */
  readonly consent: 'GRANTED' | 'WITHDRAWN' | null;
  /** The address is on the suppression list for this channel. */
  readonly suppressed: boolean;
  readonly erased: boolean;
  readonly hasAddress: boolean;
}

/**
 * The send-time gate (FR-CON-1 AC2, AC4): suppression and withdrawal block
 * every purpose; marketing additionally needs a GRANTED consent. Transactional
 * messages are allowed by default.
 */
export function gateDecision(
  f: GateFacts,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: BlockReason } {
  if (f.erased) return { allowed: false, reason: 'CUSTOMER_ERASED' };
  if (!f.hasAddress) return { allowed: false, reason: 'NO_ADDRESS' };
  if (f.suppressed) return { allowed: false, reason: 'SUPPRESSED' };
  if (f.consent === 'WITHDRAWN') return { allowed: false, reason: 'CONSENT_WITHDRAWN' };
  if (f.purpose === 'MARKETING' && f.consent !== 'GRANTED') return { allowed: false, reason: 'NO_MARKETING_CONSENT' };
  return { allowed: true };
}

/** Minutes after local midnight of `at` in `timeZone`. */
export function localMinute(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return n('hour') * 60 + n('minute');
}

/**
 * The earliest time at or after `at` inside the daily window
 * [startMinute, endMinute) in `timeZone` (default 09:00–21:00). Assumes no
 * daylight-saving change before the next window (true for Indian time).
 */
export function nextAllowedTime(at: Date, timeZone: string, startMinute = 540, endMinute = 1260): Date {
  if (!(startMinute >= 0 && startMinute < endMinute && endMinute <= 1440)) throw new RangeError('invalid quiet hours');
  const m = localMinute(at, timeZone);
  if (m >= startMinute && m < endMinute) return at;
  const wait = m < startMinute ? startMinute - m : 1440 - m + startMinute;
  const next = new Date(at.getTime() + wait * 60_000);
  next.setUTCSeconds(0, 0);
  return next;
}
