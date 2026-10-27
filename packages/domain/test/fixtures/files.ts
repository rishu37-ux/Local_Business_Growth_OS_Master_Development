// Synthetic upload fixtures for tests (no real documents). PNGs are valid,
// decodable images; the mock OCR adapter reads the text "printed" on them from
// a tEXt chunk with the keyword `lbgos-ocr` (a test convention, not OCR).
import { crc32, deflateSync } from 'node:zlib';

export interface FixtureLine {
  readonly text: string;
  readonly confidence: number | null;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A grey PNG of the given size; with `lines`, carries fixture OCR text. */
export function png(width: number, height: number, lines?: readonly FixtureLine[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const small = width * height <= 1_000_000;
  // Pixel data only for small images; large ones exist to test the size limit.
  const raw = small ? Buffer.alloc((width + 1) * height, 0xc0) : Buffer.alloc(0);
  if (small) for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(lines
      ? [
          chunk(
            'tEXt',
            Buffer.concat([Buffer.from('lbgos-ocr\0', 'latin1'), Buffer.from(JSON.stringify(lines), 'utf8')]),
          ),
        ]
      : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(parts);
}

/** JPEG header with an SOF0 frame of the given size (enough for sniffing). */
export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** A minimal uncompressed PDF with `pages` pages; text lines go on page 1 as literal strings. */
export function pdf(pages: number, lines: readonly string[] = []): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = lines.map((l, i) => `BT /F1 10 Tf 40 ${String(800 - i * 14)} Td (${esc(l)}) Tj ET`).join('\n');
  const kids = Array.from({ length: pages }, (_, i) => `${String(4 + i)} 0 R`).join(' ');
  const objs = [
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`,
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${String(pages)} >> endobj`,
    `3 0 obj << /Length ${String(content.length)} >> stream\n${content}\nendstream endobj`,
    ...Array.from(
      { length: pages },
      (_, i) =>
        `${String(4 + i)} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]${i === 0 ? ' /Contents 3 0 R' : ''} >> endobj`,
    ),
  ];
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

export const HEIC = Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypheic', 'latin1'), 0, 0, 0, 0]);
