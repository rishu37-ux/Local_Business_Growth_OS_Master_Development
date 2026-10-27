// Development/test OCR adapter. It does NOT recognise text in images: it reads
// synthetic fixture text from a PNG tEXt chunk with the keyword `lbgos-ocr`
// (JSON array of {text, confidence}) and literal strings from uncompressed PDF
// content streams (confidence unknown). JPEG/WebP give no text. A real
// provider adapter implements the same interface (INTEGRATIONS_STATUS.md).
// It runs inside the isolated OCR worker and has no network access.
import type { OcrLine, SniffedType } from '@lbgos/domain';

export interface OcrResult {
  readonly provider: string;
  readonly lines: readonly OcrLine[];
}

export interface OcrAdapter {
  readonly name: string;
  recognize(bytes: Uint8Array, type: SniffedType): Promise<OcrResult>;
}

const MAX_LINES = 500;
const MAX_LINE = 500;

function cleanLines(value: unknown): OcrLine[] {
  if (!Array.isArray(value)) return [];
  const out: OcrLine[] = [];
  for (const item of value.slice(0, MAX_LINES)) {
    if (typeof item !== 'object' || item === null) continue;
    const { text, confidence } = item as { text?: unknown; confidence?: unknown };
    if (typeof text !== 'string') continue;
    const c = typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : null;
    out.push({ text: text.slice(0, MAX_LINE), confidence: c });
  }
  return out;
}

function pngFixtureText(b: Uint8Array): OcrLine[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const data = b.subarray(i + 8, i + 8 + len);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && new TextDecoder('latin1').decode(data.subarray(0, nul)) === 'lbgos-ocr') {
        try {
          return cleanLines(JSON.parse(new TextDecoder().decode(data.subarray(nul + 1))));
        } catch {
          return [];
        }
      }
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return [];
}

function pdfLiteralText(b: Uint8Array): OcrLine[] {
  const text = new TextDecoder('latin1').decode(b);
  const out: OcrLine[] = [];
  for (const m of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    const s = (m[1] ?? '').replace(/\\([\\()])/g, '$1');
    out.push({ text: s.slice(0, MAX_LINE), confidence: null });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

export const mockOcrAdapter: OcrAdapter = {
  name: 'mock',
  recognize(bytes, type) {
    const lines =
      type === 'image/png' ? pngFixtureText(bytes) : type === 'application/pdf' ? pdfLiteralText(bytes) : [];
    return Promise.resolve({ provider: 'mock', lines });
  },
};

export default mockOcrAdapter;
