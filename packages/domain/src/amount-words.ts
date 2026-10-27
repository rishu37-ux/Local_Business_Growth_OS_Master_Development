// Amounts in words for printed invoices (FR-PRN-1 AC2), in the Indian
// numbering system (thousand, lakh, crore): 1,23,45,678.90 →
// "Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred
// Seventy-Eight and Ninety Paise Only".

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 === 0 ? t : `${t}-${ONES[n % 10] ?? ''}`;
}

/** Words for a whole number ≥ 1 (Indian grouping); crores may themselves be large. */
function indianWords(n: number): string {
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor(n / 100_000) % 100;
  const thousand = Math.floor(n / 1000) % 100;
  const hundred = Math.floor(n / 100) % 10;
  const rest = n % 100;
  if (crore > 0) parts.push(`${indianWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (hundred > 0) parts.push(`${ONES[hundred] ?? ''} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

export function amountInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError('amount must be a non-negative integer');
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const r = rupees === 0 ? 'Zero' : indianWords(rupees);
  return p === 0 ? `Rupees ${r} Only` : `Rupees ${r} and ${belowHundred(p)} Paise Only`;
}
