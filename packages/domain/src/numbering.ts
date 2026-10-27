// Invoice number formats (FR-POS-4 AC3, D-012). Tokens: {PREFIX}, {FY}
// (e.g. "26-27"), {FYLONG} (e.g. "2026-27") and {SEQ:n} (zero-padded to n
// digits, 1 ≤ n ≤ 8). Rendered numbers are at most 16 characters of
// A–Z, a–z, 0–9, "/" and "-"; a format that could break that is refused when
// it is configured, not when an invoice is issued.

export const MAX_NUMBER_LENGTH = 16;
export const DEFAULT_FORMAT = '{PREFIX}{FY}/{SEQ:4}';

const TOKEN = /\{(PREFIX|FY|FYLONG|SEQ:([1-8]))\}/g;
const ALLOWED = /^[A-Za-z0-9/-]*$/;

export type FormatProblem = 'NO_SEQUENCE' | 'MULTIPLE_SEQUENCES' | 'BAD_CHARACTERS' | 'UNKNOWN_TOKEN' | 'TOO_LONG';

function seqDigits(format: string): number[] {
  return [...format.matchAll(TOKEN)].filter((m) => m[1]?.startsWith('SEQ')).map((m) => Number(m[2]));
}

/** `fy` is "2026-27" (validated by callers); {FY} renders as "26-27". */
function render(format: string, values: { prefix: string; fy: string; seq: string }): string {
  return format.replace(TOKEN, (_m, token: string) => {
    if (token === 'PREFIX') return values.prefix;
    if (token === 'FY') return values.fy.slice(2);
    if (token === 'FYLONG') return values.fy;
    return values.seq;
  });
}

/** null when the format is acceptable for this prefix. */
export function formatProblem(format: string, prefix: string): FormatProblem | null {
  const digits = seqDigits(format);
  if (digits.length === 0) return 'NO_SEQUENCE';
  if (digits.length > 1) return 'MULTIPLE_SEQUENCES';
  const literal = format.replace(TOKEN, '');
  if (/[{}]/.test(literal)) return 'UNKNOWN_TOKEN';
  if (!ALLOWED.test(literal) || !ALLOWED.test(prefix)) return 'BAD_CHARACTERS';
  // Longest possible rendering: the largest sequence that fits its digits.
  const longest = render(format, { prefix, fy: '2026-27', seq: '9'.repeat(Math.max(...digits)) });
  if (longest.length > MAX_NUMBER_LENGTH) return 'TOO_LONG';
  return null;
}

export class NumberingError extends Error {
  readonly code: 'SERIES_EXHAUSTED' | FormatProblem;

  constructor(code: NumberingError['code'], message: string) {
    super(message);
    this.name = 'NumberingError';
    this.code = code;
  }
}

/** The number for sequence value `seq` in financial year `fy` ("2026-27"). */
export function renderInvoiceNumber(format: string, prefix: string, fy: string, seq: number): string {
  const problem = formatProblem(format, prefix);
  if (problem) throw new NumberingError(problem, `invalid number format: ${problem}`);
  if (!/^\d{4}-\d{2}$/.test(fy)) throw new RangeError('invalid financial year');
  const digits = Math.max(...seqDigits(format));
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError('sequence must be a positive integer');
  if (String(seq).length > digits) {
    throw new NumberingError('SERIES_EXHAUSTED', `the series has no ${String(digits)}-digit numbers left`);
  }
  return render(format, { prefix, fy, seq: String(seq).padStart(digits, '0') });
}
