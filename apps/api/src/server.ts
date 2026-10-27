// Process entry point: validate config, open role pools, serve, shut down cleanly.
import { sql } from 'kysely';
import { createDb, type Db, type PoolOptions } from '@lbgos/db';
import { createAuthService, DevConsoleEmailSender } from '@lbgos/modules/auth';
import { DevConsoleMailer } from '@lbgos/modules/notifications';
import { chromiumPdfRenderer } from './pdf.ts';
import { DEFAULT_ADAPTER_URL, LocalFileStorage, processNextOcrJob, type OcrConfig } from '@lbgos/modules/ocr';
import { DEFAULT_UPLOAD_LIMITS } from '@lbgos/domain';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';

function fail(message: string): never {
  // Plain stderr: the logger is not configured yet, and messages hold no secret values.
  console.error(message);
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  fail(err instanceof ConfigError ? err.message : 'invalid configuration');
}

const secret = config.SESSION_SECRET ?? fail('SESSION_SECRET is required (at least 32 characters)');
if (config.NODE_ENV === 'production') {
  // No transactional email provider is configured yet (ADR-19, open question Q6).
  fail('production start refused: no email provider is configured for verification and reset emails');
}

const pool = (url: string | undefined): PoolOptions => (url ? { connectionString: url } : {});
const appDb = createDb('lbgos_app', pool(config.DATABASE_URL_APP));
const platformDb = createDb('lbgos_platform', pool(config.DATABASE_URL_PLATFORM));
const authDb = createDb('lbgos_auth', pool(config.DATABASE_URL_AUTH));
const pools: Db[] = [appDb, platformDb, authDb];

const auth = createAuthService({
  baseURL: config.PUBLIC_BASE_URL,
  secret,
  secureCookies: config.PUBLIC_BASE_URL.startsWith('https://'),
  email: new DevConsoleEmailSender(),
  db: authDb,
});

// Scans: private local storage and the mock OCR adapter until a provider is chosen (Q4).
const ocr: OcrConfig = {
  storage: new LocalFileStorage(path.resolve(config.UPLOAD_DIR)),
  limits: DEFAULT_UPLOAD_LIMITS,
  isolation: {
    adapterUrl: DEFAULT_ADAPTER_URL,
    structurerUrl: null,
    timeoutMs: config.OCR_TIMEOUT_MS,
    maxMemoryMb: config.OCR_MAX_MEMORY_MB,
  },
  staleSeconds: Math.ceil(config.OCR_TIMEOUT_MS / 1000) * 4,
};

// PDFs of printed documents (ADR-12): headless Chromium, started on first use.
const pdf = chromiumPdfRenderer();

// Serve the built web app when present (pnpm -F @lbgos/web build).
const webRoot = path.resolve(import.meta.dirname, '../../web/dist');

const app = buildApp({
  config,
  ...(existsSync(path.join(webRoot, 'index.html')) ? { webRoot } : {}),
  services: { appDb, platformDb, auth, mailer: new DevConsoleMailer(), baseURL: config.PUBLIC_BASE_URL, ocr, pdf },
  readiness: {
    database: async () => {
      await sql`select 1`.execute(appDb);
    },
  },
});

// One OCR job at a time per process (ADR-08 job rules; D-036). Each job runs
// in its own worker thread with memory and time limits.
let ocrBusy = false;
const ocrTimer = setInterval(() => {
  if (ocrBusy) return;
  ocrBusy = true;
  processNextOcrJob(appDb, ocr)
    .then((r) => {
      if (r) app.log.info({ jobId: r.jobId, status: r.status, errorCode: r.errorCode }, 'ocr job processed');
    })
    .catch((err: unknown) => {
      app.log.error({ err }, 'ocr runner failed');
    })
    .finally(() => {
      ocrBusy = false;
    });
}, 1000);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  clearInterval(ocrTimer);
  await app.close();
  await pdf.close();
  await Promise.all(pools.map((db) => db.destroy()));
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
