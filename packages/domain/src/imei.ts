// IMEI validation (FR-INV-3 AC2): exactly 15 digits with a valid Luhn check
// digit. Mirrors lbg.is_valid_imei() in the database; both are tested against
// test/vectors/imei.json.

const IMEI_PATTERN = /^[0-9]{15}$/;

/** Luhn check digit for a string of digits (the digit to append). */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  // Walk from the right; the digit next to the (future) check digit is doubled.
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidImei(value: string): boolean {
  if (!IMEI_PATTERN.test(value)) return false;
  return luhnCheckDigit(value.slice(0, 14)) === Number(value[14]);
}
