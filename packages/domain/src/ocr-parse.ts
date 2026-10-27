// Deterministic field extraction from OCR text (FR-OCR-2, FR-OCR-3, FR-OCR-4
// AC2, FR-OCR-5). OCR text is untrusted data: it is only matched against
// fixed patterns. Nothing in it is ever executed, followed or used to choose
// an action, and a value that is not in the text stays null.
import { gstinProblem } from './gstin.ts';
import { isValidImei } from './imei.ts';
import { lineValue, quantityToMilli } from './money.ts';

export interface OcrLine {
  readonly text: string;
  /** Provider confidence 0–1, or null when the provider gives none. */
  readonly confidence: number | null;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export type FieldProblem =
  'IMEI_INVALID' | 'IMEI_MALFORMED' | 'DUPLICATE_IN_SCAN' | 'GSTIN_INVALID' | 'INVALID_DATE' | 'AMOUNT_MISMATCH';

export interface ExtractedField {
  readonly key: string;
  readonly value: string | null;
  readonly confidence: number | null;
  readonly level: ConfidenceLevel;
  /** The OCR line the value came from (evidence). */
  readonly source: string | null;
  /** Below the high-confidence threshold, or a heuristic guess: the user must confirm it. */
  readonly needsConfirmation: boolean;
  readonly problems: readonly FieldProblem[];
}

export const HIGH_CONFIDENCE = 0.9;
export const MEDIUM_CONFIDENCE = 0.7;

export function confidenceLevel(c: number | null): ConfidenceLevel {
  if (c === null || !Number.isFinite(c)) return 'unknown';
  if (c >= HIGH_CONFIDENCE) return 'high';
  if (c >= MEDIUM_CONFIDENCE) return 'medium';
  return 'low';
}

function field(
  key: string,
  value: string | null,
  line: OcrLine | null,
  options: { guess?: boolean; problems?: FieldProblem[] } = {},
): ExtractedField {
  const confidence = line?.confidence ?? null;
  const level = value === null ? 'unknown' : confidenceLevel(confidence);
  return {
    key,
    value,
    confidence: value === null ? null : confidence,
    level,
    source: value === null ? null : (line?.text ?? null),
    needsConfirmation:
      value !== null && (level !== 'high' || options.guess === true || (options.problems?.length ?? 0) > 0),
    problems: options.problems ?? [],
  };
}

/** First line matching `re`; returns the capture group `group` (trimmed). */
function find(lines: readonly OcrLine[], re: RegExp, group = 1): { value: string; line: OcrLine } | null {
  for (const line of lines) {
    const m = re.exec(line.text);
    const v = m?.[group]?.trim();
    if (v) return { value: v, line };
  }
  return null;
}

function named(key: string, lines: readonly OcrLine[], re: RegExp): ExtractedField {
  const hit = find(lines, re);
  return field(key, hit?.value ?? null, hit?.line ?? null);
}

/** "1,23,456.78" → 12345678 paise; anything else → null. */
export function parseMoneyToPaise(text: string): number | null {
  const t = text.replace(/,/g, '');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (Indian order) or yyyy-mm-dd → ISO date, or null if not a real date. */
export function parseInvoiceDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [y, mo, d] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : dmy
      ? [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])]
      : [0, 0, 0];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${String(y)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function eanValid(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = Array.from({ length: 13 }, (_, i) => Number(code.charAt(i)));
  const sum = digits.slice(0, 12).reduce((s, d, i) => s + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

const IMEI_LABELLED = /IMEI\s*[12]?\s*(?:No\.?)?\s*[:#-]?\s*([0-9][0-9 ]{8,22}[0-9])/gi;
const DIGIT_RUN_15 = /(?<!\d)(\d{15})(?!\d)/g;
const HAS_15_DIGITS = /(?<!\d)\d{15}(?!\d)/;

/** IMEIs in a set of lines: labelled values (any length, flagged if malformed) and bare 15-digit runs. */
function imeiFields(lines: readonly OcrLine[], prefix: string): ExtractedField[] {
  const found: { value: string; line: OcrLine; malformed: boolean }[] = [];
  for (const line of lines) {
    const labelled = new Set<string>();
    for (const m of line.text.matchAll(IMEI_LABELLED)) {
      const digits = (m[1] ?? '').replace(/ /g, '');
      labelled.add(digits);
      found.push({ value: digits, line, malformed: digits.length !== 15 });
    }
    for (const m of line.text.matchAll(DIGIT_RUN_15)) {
      const digits = m[1] ?? '';
      if (!labelled.has(digits)) found.push({ value: digits, line, malformed: false });
    }
  }
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.value, (counts.get(f.value) ?? 0) + 1);
  return found.map((f, i) => {
    const problems: FieldProblem[] = [];
    if (f.malformed) problems.push('IMEI_MALFORMED');
    else if (!isValidImei(f.value)) problems.push('IMEI_INVALID');
    if ((counts.get(f.value) ?? 0) > 1) problems.push('DUPLICATE_IN_SCAN');
    return field(`${prefix}${String(i + 1)}`, f.value, f.line, { problems });
  });
}

export interface ProductLabelExtraction {
  readonly scanType: 'PRODUCT_LABEL';
  readonly fields: readonly ExtractedField[];
  readonly imeis: readonly ExtractedField[];
}

export function parseProductLabel(lines: readonly OcrLine[]): ProductLabelExtraction {
  const ramStorage = find(lines, /(\d{1,2})\s*GB\s*(?:RAM)?\s*\+\s*(\d{2,4})\s*(GB|TB)/i);
  const ram = ramStorage
    ? field('ram', `${ramStorage.value} GB`, ramStorage.line)
    : named('ram', lines, /(?:RAM|Memory)\s*[:-]?\s*(\d{1,2}\s*GB)\b/i);
  const storageHit = ramStorage
    ? (() => {
        const m = /\+\s*(\d{2,4})\s*(GB|TB)/i.exec(ramStorage.line.text);
        return m ? field('storage', `${m[1] ?? ''} ${(m[2] ?? '').toUpperCase()}`, ramStorage.line) : null;
      })()
    : null;
  const storage = storageHit ?? named('storage', lines, /(?:ROM|Storage)\s*[:-]?\s*(\d{2,4}\s*(?:GB|TB))\b/i);
  const barcodeHit = (() => {
    for (const line of lines) {
      for (const m of line.text.matchAll(/(?<!\d)(\d{13})(?!\d)/g)) {
        if (eanValid(m[1] ?? '')) return { value: m[1] ?? '', line };
      }
    }
    return null;
  })();
  return {
    scanType: 'PRODUCT_LABEL',
    fields: [
      named('brand', lines, /Brand\s*[:-]\s*([A-Za-z][A-Za-z0-9 &.-]{0,39})$/i),
      named('modelName', lines, /Model\s*(?:Name)?\s*[:-]\s*([A-Za-z0-9][A-Za-z0-9 ()+.-]{0,59})$/i),
      named('modelNumber', lines, /Model\s*(?:No\.?|Number)\s*[:-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{1,39})\b/i),
      ram,
      storage,
      named('colour', lines, /Colou?r\s*[:-]\s*([A-Za-z][A-Za-z ]{1,29})$/i),
      field('barcode', barcodeHit?.value ?? null, barcodeHit?.line ?? null),
      named('serialNumber', lines, /(?:S\/N|Serial\s*(?:No\.?|Number)?)\s*[:#-]?\s*([A-Z0-9]{6,30})\b/i),
    ],
    imeis: imeiFields(lines, 'imei.'),
  };
}

export interface InvoiceLineExtraction {
  readonly key: string;
  readonly description: ExtractedField;
  readonly quantity: ExtractedField;
  readonly unitPricePaise: ExtractedField;
  readonly amountPaise: ExtractedField;
  /** quantity × unit price recomputed by code (FR-OCR-3 AC3). */
  readonly computedAmountPaise: number | null;
  readonly imeis: readonly ExtractedField[];
}

export interface SupplierInvoiceExtraction {
  readonly scanType: 'SUPPLIER_INVOICE';
  readonly fields: readonly ExtractedField[];
  readonly lines: readonly InvoiceLineExtraction[];
  /** Σ printed line amounts, recomputed by code. */
  readonly computedLinesTotalPaise: number;
}

const LINE_ITEM =
  /^(.*?[A-Za-z].*?)\s+(\d{1,6}(?:\.\d{1,3})?)\s+(?:x\s+)?(?:₹|Rs\.?\s*)?(\d[\d,]*\.\d{2})\s+(?:₹|Rs\.?\s*)?(\d[\d,]*\.\d{2})$/i;
const NOT_AN_ITEM = /^(?:sub\s*-?\s*total|total|grand|cgst|sgst|igst|cess|tax|round|amount|balance|invoice)/i;

function money(value: string): number | null {
  return parseMoneyToPaise(value);
}

export function parseSupplierInvoice(lines: readonly OcrLine[]): SupplierInvoiceExtraction {
  const items: { line: OcrLine; m: RegExpExecArray; imeiLines: OcrLine[] }[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    const m = NOT_AN_ITEM.test(text) ? null : LINE_ITEM.exec(text);
    if (m) {
      items.push({ line, m, imeiLines: [] });
      continue;
    }
    // IMEIs listed under an item belong to that item.
    const last = items[items.length - 1];
    if (last && (/IMEI/i.test(text) || HAS_15_DIGITS.test(text))) last.imeiLines.push(line);
  }
  const outLines = items.map((it, i): InvoiceLineExtraction => {
    const key = `line.${String(i + 1)}`;
    const qty = it.m[2] ?? '';
    const unit = money(it.m[3] ?? '');
    const amount = money(it.m[4] ?? '');
    let computed: number | null;
    try {
      computed = unit === null ? null : lineValue(quantityToMilli(qty), unit);
    } catch {
      computed = null;
    }
    const mismatch = computed !== null && amount !== null && computed !== amount;
    return {
      key,
      description: field(`${key}.description`, it.m[1]?.trim() ?? null, it.line),
      quantity: field(`${key}.quantity`, qty, it.line),
      unitPricePaise: field(`${key}.unitPricePaise`, unit === null ? null : String(unit), it.line),
      amountPaise: field(`${key}.amountPaise`, amount === null ? null : String(amount), it.line, {
        problems: mismatch ? ['AMOUNT_MISMATCH'] : [],
      }),
      computedAmountPaise: computed,
      imeis: imeiFields(it.imeiLines, `${key}.imei.`),
    };
  });
  // IMEIs repeated across different lines are duplicates within the scan too.
  const all = outLines.flatMap((l) => l.imeis);
  const seen = new Map<string, number>();
  for (const f of all) if (f.value) seen.set(f.value, (seen.get(f.value) ?? 0) + 1);
  const withDupes = outLines.map((l) => ({
    ...l,
    imeis: l.imeis.map((f) =>
      f.value && (seen.get(f.value) ?? 0) > 1 && !f.problems.includes('DUPLICATE_IN_SCAN')
        ? { ...f, needsConfirmation: true, problems: [...f.problems, 'DUPLICATE_IN_SCAN' as const] }
        : f,
    ),
  }));

  const gstinHit = find(lines, /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/);
  const gstin = gstinHit
    ? field('gstin', gstinHit.value, gstinHit.line, { problems: gstinProblem(gstinHit.value) ? ['GSTIN_INVALID'] : [] })
    : field('gstin', null, null);
  const dateHit = find(lines, /(?:Invoice\s*)?Date\s*[:-]?\s*(\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4})/i);
  const isoDate = dateHit ? parseInvoiceDate(dateHit.value) : null;
  const totalHit =
    find(lines, /Grand\s*Total\s*[:-]?\s*(?:₹|Rs\.?\s*)?(\d[\d,]*\.\d{2})/i) ??
    find(lines, /^(?!.*sub).*?\bTotal(?:\s*Amount)?\s*[:-]?\s*(?:₹|Rs\.?\s*)?(\d[\d,]*\.\d{2})\s*$/i);
  const total = totalHit ? money(totalHit.value) : null;
  const computedLinesTotalPaise = outLines.reduce((s, l) => s + (l.computedAmountPaise ?? 0), 0);
  const firstNamed = lines.find((l) => /[A-Za-z]{3}/.test(l.text) && !/invoice|gstin|date|bill|tax/i.test(l.text));

  return {
    scanType: 'SUPPLIER_INVOICE',
    fields: [
      // A heuristic (first text line): always shown for confirmation.
      field('supplierName', firstNamed?.text.trim().slice(0, 120) ?? null, firstNamed ?? null, { guess: true }),
      gstin,
      named('invoiceNo', lines, /Invoice\s*(?:No\.?|Number|#)\s*[:-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{0,39})/i),
      dateHit
        ? field('invoiceDate', isoDate ?? dateHit.value, dateHit.line, { problems: isoDate ? [] : ['INVALID_DATE'] })
        : field('invoiceDate', null, null),
      field('totalPaise', total === null ? null : String(total), totalHit?.line ?? null),
    ],
    lines: withDupes,
    computedLinesTotalPaise,
  };
}
