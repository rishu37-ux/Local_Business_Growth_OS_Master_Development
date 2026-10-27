// GSTIN structure and check character (FR-ONB-2 AC4). This validates format and
// checksum only; it does not prove the GSTIN is registered or active (that needs
// the GST portal, which is not integrated).

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 2-digit state code, 10-char PAN (5 letters, 4 digits, 1 letter), entity
// number, 'Z' by default, check character.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Check character for the first 14 characters of a GSTIN (mod-36, weights 1/2). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const value = ALPHABET.indexOf(first14.charAt(i));
    if (value < 0) throw new Error('invalid GSTIN character');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

export type GstinProblem = 'FORMAT' | 'CHECKSUM' | 'STATE_MISMATCH';

/** Returns undefined when the GSTIN is well-formed, has a valid check character and matches the state. */
export function gstinProblem(gstin: string, stateCode?: string): GstinProblem | undefined {
  if (!GSTIN_PATTERN.test(gstin)) return 'FORMAT';
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'CHECKSUM';
  if (stateCode !== undefined && gstin.slice(0, 2) !== stateCode) return 'STATE_MISMATCH';
  return undefined;
}
