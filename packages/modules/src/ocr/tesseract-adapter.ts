// Real OCR with Tesseract 5 (increment 12.1, D-071): the open-source engine
// runs as a separate local program, so photos never leave the shop's server.
// It is started from inside the isolated OCR worker with its own time limit;
// the image goes in on stdin and word-level TSV comes back on stdout. Words
// are grouped into lines; a line's confidence is the mean of its words'.
// Photos only: PDFs need a text engine (they go to manual entry).
import { execFile } from 'node:child_process';
import type { OcrLine, SniffedType } from '@lbgos/domain';
import type { OcrAdapter, OcrResult } from './mock-adapter.ts';

const TIMEOUT_MS = 20_000;
const MAX_LINES = 500;
const MAX_LINE = 500;

export class OcrEngineError extends Error {
  readonly code: 'PDF_NEEDS_TEXT_ENGINE' | 'OCR_ENGINE_MISSING' | 'OCR_ENGINE_FAILED' | 'OCR_ENGINE_TIMEOUT';

  constructor(code: OcrEngineError['code']) {
    super(code);
    this.name = 'OcrEngineError';
    this.code = code;
  }
}

/** Parses Tesseract's TSV (level 5 = word) into lines with a 0–1 confidence. */
export function linesFromTsv(tsv: string): OcrLine[] {
  const groups = new Map<string, { words: string[]; conf: number[] }>();
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = (c[11] ?? '').trim();
    const conf = Number(c[10]);
    if (text === '') continue;
    const key = `${c[1] ?? ''}.${c[2] ?? ''}.${c[3] ?? ''}.${c[4] ?? ''}`;
    const g = groups.get(key) ?? { words: [], conf: [] };
    g.words.push(text);
    if (Number.isFinite(conf) && conf >= 0) g.conf.push(conf);
    groups.set(key, g);
  }
  const out: OcrLine[] = [];
  for (const g of groups.values()) {
    if (out.length >= MAX_LINES) break;
    const confidence = g.conf.length
      ? Math.round((g.conf.reduce((a, b) => a + b, 0) / g.conf.length) * 10) / 1000
      : null;
    out.push({ text: g.words.join(' ').slice(0, MAX_LINE), confidence });
  }
  return out;
}

function run(bytes: Uint8Array): Promise<string> {
  const bin = process.env.OCR_TESSERACT_BIN ?? 'tesseract';
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      ['stdin', 'stdout', '-l', 'eng', '--psm', '3', 'tsv'],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      },
      (err, stdout) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        reject(
          new OcrEngineError(
            e.code === 'ENOENT' ? 'OCR_ENGINE_MISSING' : e.killed ? 'OCR_ENGINE_TIMEOUT' : 'OCR_ENGINE_FAILED',
          ),
        );
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(Buffer.from(bytes));
  });
}

const adapter: OcrAdapter = {
  name: 'tesseract',
  async recognize(bytes: Uint8Array, type: SniffedType): Promise<OcrResult> {
    if (type === 'application/pdf') throw new OcrEngineError('PDF_NEEDS_TEXT_ENGINE');
    return { provider: 'tesseract', lines: linesFromTsv(await run(bytes)) };
  },
};

export default adapter;
