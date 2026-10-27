// Runs OCR processing in a worker thread with a heap limit and a timeout
// (FR-OCR-6 AC3). A crash, an out-of-memory error or a timeout becomes a
// failure code; the API process keeps running.
import { Worker } from 'node:worker_threads';
import type { ProductLabelExtraction, SupplierInvoiceExtraction, UploadLimits } from '@lbgos/domain';

export interface IsolationOptions {
  readonly adapterUrl: string;
  readonly structurerUrl: string | null;
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
  readonly limits: UploadLimits;
}

export type IsolatedResult =
  | {
      readonly ok: true;
      readonly provider: string;
      readonly extraction: ProductLabelExtraction | SupplierInvoiceExtraction;
      readonly structured: unknown;
      /** OCR text lines, only when a structurer ran (for its verbatim check); never stored. */
      readonly lines: readonly string[] | null;
    }
  | { readonly ok: false; readonly code: string };

export const DEFAULT_ADAPTER_URL = new URL('./mock-adapter.ts', import.meta.url).href;

export function runIsolated(
  bytes: Uint8Array,
  scanType: 'PRODUCT_LABEL' | 'SUPPLIER_INVOICE',
  options: IsolationOptions,
): Promise<IsolatedResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: IsolatedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        bytes,
        scanType,
        adapterUrl: options.adapterUrl,
        structurerUrl: options.structurerUrl,
        limits: options.limits,
      },
      resourceLimits: { maxOldGenerationSizeMb: options.maxMemoryMb, maxYoungGenerationSizeMb: 16 },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'TIMEOUT' });
    }, options.timeoutMs);
    worker.once('message', (m: IsolatedResult) => {
      finish(m.ok ? m : { ok: false, code: /^[A-Z_]{1,40}$/.test(m.code) ? m.code : 'PROVIDER_ERROR' });
    });
    worker.once('error', (err: Error & { code?: string }) => {
      finish({ ok: false, code: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'OUT_OF_MEMORY' : 'WORKER_ERROR' });
    });
    worker.once('exit', () => {
      finish({ ok: false, code: 'WORKER_ERROR' });
    });
  });
}
