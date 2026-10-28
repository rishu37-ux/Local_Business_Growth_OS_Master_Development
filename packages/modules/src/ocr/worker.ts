// Worker-thread entry for OCR processing (FR-OCR-6 AC3). Untrusted bytes are
// re-checked, recognised by the configured adapter and parsed here, in a
// thread with its own memory limit and a wall-clock timeout enforced by the
// parent. Only plain data goes back to the parent.
import { parentPort, workerData } from 'node:worker_threads';
import { checkUpload, parseProductLabel, parseSupplierInvoice, type UploadLimits } from '@lbgos/domain';
import type { OcrAdapter } from './mock-adapter.ts';

interface Input {
  readonly bytes: Uint8Array;
  readonly scanType: 'PRODUCT_LABEL' | 'SUPPLIER_INVOICE';
  readonly adapterUrl: string;
  readonly structurerUrl: string | null;
  readonly limits: UploadLimits;
}

interface Structurer {
  structure(lines: readonly { text: string; confidence: number | null }[], scanType: string): Promise<unknown>;
}

async function run(input: Input) {
  const check = checkUpload(input.bytes, input.limits);
  if (!check.ok) return { ok: false as const, code: check.problem };
  const adapter = ((await import(input.adapterUrl)) as { default: OcrAdapter }).default;
  const result = await adapter.recognize(input.bytes, check.type);
  const extraction =
    input.scanType === 'PRODUCT_LABEL' ? parseProductLabel(result.lines) : parseSupplierInvoice(result.lines);
  let structured: unknown = undefined;
  let lines: string[] | null = null;
  if (input.structurerUrl) {
    lines = result.lines.map((l) => l.text);
    const structurer = ((await import(input.structurerUrl)) as { default: Structurer }).default;
    // OCR text is passed as data; the structurer's output is validated by the parent.
    structured = await structurer.structure(result.lines, input.scanType);
  }
  return { ok: true as const, provider: result.provider, extraction, structured, lines };
}

run(workerData as Input).then(
  (out) => parentPort?.postMessage(out),
  (err: unknown) => {
    // An engine's own failure code (e.g. PDF_NEEDS_TEXT_ENGINE) is kept; anything else is a provider error.
    const code = (err as { code?: unknown }).code;
    parentPort?.postMessage({
      ok: false,
      code: typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'PROVIDER_ERROR',
    });
  },
);
