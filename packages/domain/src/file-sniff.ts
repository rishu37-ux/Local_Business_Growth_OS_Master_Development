// Upload type detection by magic bytes and size/page/dimension limits
// (FR-OCR-6 AC1). Reads headers only; never decodes image data, so a
// decompression bomb is rejected by its declared dimensions before anything
// expands it.

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export interface UploadLimits {
  readonly maxBytes: number;
  readonly maxPdfPages: number;
  readonly maxImageSide: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = { maxBytes: 10 * 1024 * 1024, maxPdfPages: 10, maxImageSide: 8000 };

export type FileProblem =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'HEIC_UNSUPPORTED'
  | 'MALFORMED'
  | 'TOO_MANY_PAGES'
  | 'DIMENSIONS_TOO_LARGE';

export type FileCheck =
  | {
      readonly ok: true;
      readonly type: SniffedType;
      readonly width?: number;
      readonly height?: number;
      readonly pages?: number;
    }
  | { readonly ok: false; readonly problem: FileProblem };

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));
const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) * 2 ** 24 + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);

export function sniffType(b: Uint8Array): SniffedType | 'HEIC' | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(b, 4, 4) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(b, 8, 4))) return 'HEIC';
  return null;
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X' && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Page count of a PDF from its page tree: the largest /Count, or the number of
 * /Type /Page objects. Object streams can hide both; then the count is unknown
 * and the file is refused rather than guessed (MALFORMED).
 */
export function pdfPageCount(b: Uint8Array): number | null {
  const text = new TextDecoder('latin1').decode(b);
  if (!text.includes('%%EOF')) return null;
  let count = 0;
  for (const m of text.matchAll(
    /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d{1,6})|\/Count\s+(\d{1,6})[^>]*?\/Type\s*\/Pages\b/g,
  )) {
    count = Math.max(count, Number(m[1] ?? m[2]));
  }
  if (count > 0) return count;
  const pages = [...text.matchAll(/\/Type\s*\/Page(?![a-zA-Z])/g)].length;
  return pages > 0 ? pages : null;
}

export function checkUpload(b: Uint8Array, limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): FileCheck {
  if (b.length === 0) return { ok: false, problem: 'EMPTY' };
  if (b.length > limits.maxBytes) return { ok: false, problem: 'TOO_LARGE' };
  const type = sniffType(b);
  if (type === 'HEIC') return { ok: false, problem: 'HEIC_UNSUPPORTED' };
  if (type === null) return { ok: false, problem: 'UNSUPPORTED_TYPE' };
  if (type === 'application/pdf') {
    const pages = pdfPageCount(b);
    if (pages === null) return { ok: false, problem: 'MALFORMED' };
    if (pages > limits.maxPdfPages) return { ok: false, problem: 'TOO_MANY_PAGES' };
    return { ok: true, type, pages };
  }
  const size = type === 'image/png' ? pngSize(b) : type === 'image/jpeg' ? jpegSize(b) : webpSize(b);
  if (!size || size.width === 0 || size.height === 0) return { ok: false, problem: 'MALFORMED' };
  if (size.width > limits.maxImageSide || size.height > limits.maxImageSide) {
    return { ok: false, problem: 'DIMENSIONS_TOO_LARGE' };
  }
  return { ok: true, type, width: size.width, height: size.height };
}
