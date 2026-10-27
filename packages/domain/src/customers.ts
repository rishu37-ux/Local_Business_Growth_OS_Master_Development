// Customer helpers (FR-POS-5, FR-CRM-1): mobile normalisation and place of supply.

/**
 * Normalises a phone number to E.164. Indian numbers may be typed as 10 digits
 * (starting 6–9), with a leading 0, or with 91 / +91; other countries need a
 * leading +. Returns null if the result is not a plausible E.164 number.
 */
export function normalizeMobile(input: string): string | null {
  const compact = input.replace(/[\s().-]/g, '');
  let e164: string;
  if (compact.startsWith('+')) e164 = compact;
  else if (/^[6-9]\d{9}$/.test(compact)) e164 = `+91${compact}`;
  else if (/^0[6-9]\d{9}$/.test(compact)) e164 = `+91${compact.slice(1)}`;
  else if (/^91[6-9]\d{9}$/.test(compact)) e164 = `+${compact}`;
  else return null;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  // An Indian number must have exactly 10 digits after +91, starting 6–9.
  if (e164.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(e164)) return null;
  return e164;
}

/**
 * Place of supply (FR-POS-5 AC2, FR-TAX-1 AC2): the state of a B2B customer's
 * GSTIN, else the customer's state, else the shop's state (over-the-counter
 * sale, D-013).
 */
export function placeOfSupply(
  customer: { readonly gstin?: string | null; readonly stateCode?: string | null } | null,
  businessState: string,
): string {
  const fromGstin = customer?.gstin ? customer.gstin.slice(0, 2) : null;
  return fromGstin ?? customer?.stateCode ?? businessState;
}
