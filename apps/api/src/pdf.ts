// PDF rendering by headless Chromium from the print HTML (ADR-12, FR-PRN-1
// AC3). The page runs with JavaScript disabled and every network request
// blocked: only the HTML handed in is rendered. Renders are limited in number
// and time so a burst of downloads cannot exhaust the server.
import { chromium, type Browser } from 'playwright';

export type PdfPaper = 'A4' | 'A5' | '80MM' | '58MM';

export interface PdfRenderer {
  render(html: string, paper: PdfPaper): Promise<Buffer>;
  close(): Promise<void>;
}

export class PdfBusyError extends Error {
  constructor() {
    super('PDF rendering is busy; try again.');
    this.name = 'PdfBusyError';
  }
}

const THERMAL_WIDTH: Partial<Record<PdfPaper, string>> = { '80MM': '80mm', '58MM': '58mm' };

export function chromiumPdfRenderer(
  options: { maxConcurrent?: number; maxQueued?: number; timeoutMs?: number } = {},
): PdfRenderer {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 20;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let browser: Promise<Browser> | null = null;
  let running = 0;
  const waiting: (() => void)[] = [];

  const acquire = async () => {
    if (running < maxConcurrent) {
      running++;
      return;
    }
    if (waiting.length >= maxQueued) throw new PdfBusyError();
    await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  return {
    async render(html, paper) {
      await acquire();
      try {
        browser ??= chromium.launch();
        const context = await (await browser).newContext({ javaScriptEnabled: false, offline: true });
        try {
          await context.route('**/*', (route) => route.abort());
          const page = await context.newPage();
          page.setDefaultTimeout(timeoutMs);
          await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
          const width = THERMAL_WIDTH[paper];
          if (width) {
            // Roll paper: one page as long as the receipt.
            const box = await page.locator('main').boundingBox();
            const heightPx = Math.ceil((box?.height ?? 600) + 24);
            return await page.pdf({
              width,
              height: `${String(heightPx)}px`,
              printBackground: true,
              margin: { top: '2mm', bottom: '2mm', left: '2mm', right: '2mm' },
            });
          }
          return await page.pdf({ preferCSSPageSize: true, printBackground: true });
        } finally {
          await context.close();
        }
      } finally {
        release();
      }
    },
    async close() {
      if (browser) await (await browser).close();
      browser = null;
    },
  };
}
