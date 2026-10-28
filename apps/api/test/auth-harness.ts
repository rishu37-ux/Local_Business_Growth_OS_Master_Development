// Test harness for auth flows: a real API (Better Auth + migrated database)
// driven through app.inject(). Synthetic accounts only.
import { createHmac } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createDb, type Db } from '@lbgos/db';
import { CapturingEmailSender, createAuthService } from '@lbgos/modules/auth';
import { CapturingMailer } from '@lbgos/modules/notifications';
import type { MessageProvider } from '@lbgos/modules/messaging';
import { chromiumPdfRenderer } from '../src/pdf.ts';
import { DEFAULT_ADAPTER_URL, MemoryStorage, processNextOcrJob, type OcrConfig } from '@lbgos/modules/ocr';
import { DEFAULT_UPLOAD_LIMITS } from '@lbgos/domain';
import { AUTHENTICATED } from '../src/auth-plugin.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { LogCapture, okReadiness } from './helpers.ts';

export const ORIGIN = 'http://localhost:3000';
export const SECRET = 'test-only-secret-0123456789abcdef0123456789';

export interface Harness {
  readonly app: FastifyInstance;
  /** Public origin of this harness (sent as Origin by the request helpers). */
  readonly origin: string;
  readonly emails: CapturingEmailSender;
  readonly mail: CapturingMailer;
  readonly logs: LogCapture;
  readonly authDb: Db;
  /** Tenant role pool (RLS applies), for probing database-level rules. */
  readonly appDb: Db;
  readonly admin: Db;
  readonly storage: MemoryStorage;
  readonly ocr: OcrConfig;
  /** Processes queued OCR jobs until the queue is empty; returns their outcomes. */
  runOcr(
    config?: Partial<OcrConfig['isolation']>,
  ): Promise<{ jobId: string; status: string; errorCode: string | null }[]>;
  close(): Promise<void>;
}

// Test files share one database, and with it the auth rate-limit counters, so
// each file starts at a random point of 10.0.0.0/8 instead of reusing the same
// addresses (a fixed start made sign-up limits collide across files).
let ipCounter = Math.floor(Math.random() * 0xffff00);
/** A fresh client IP per call, so per-IP rate limits never couple unrelated tests. */
export function freshIp(): string {
  ipCounter = (ipCounter + 1) % 0xffffff;
  return `10.${String(ipCounter >> 16)}.${String((ipCounter >> 8) & 0xff)}.${String(ipCounter & 0xff)}`;
}

export async function startHarness(
  options: { secureCookies?: boolean; baseURL?: string; webRoot?: string; messaging?: MessageProvider } = {},
): Promise<Harness> {
  const authDb = createDb('lbgos_auth', { max: 3 });
  const appDb = createDb('lbgos_app', { max: 3 });
  const platformDb = createDb('lbgos_platform', { max: 2 });
  // Owner role (BYPASSRLS): seeding and inspection only — never an application role.
  const admin: Db = new Kysely({
    dialect: new PostgresDialect({ pool: new pg.Pool({ user: 'lbgos_owner', max: 2 }) }),
  });
  const emails = new CapturingEmailSender();
  const mail = new CapturingMailer();
  const baseURL = options.baseURL ?? ORIGIN;
  const auth = createAuthService({
    baseURL,
    secret: SECRET,
    secureCookies: options.secureCookies ?? false,
    email: emails,
    db: authDb,
  });
  const logs = new LogCapture();
  const storage = new MemoryStorage();
  const ocr: OcrConfig = {
    storage,
    limits: DEFAULT_UPLOAD_LIMITS,
    isolation: { adapterUrl: DEFAULT_ADAPTER_URL, structurerUrl: null, timeoutMs: 15_000, maxMemoryMb: 128 },
    staleSeconds: 600,
  };
  // Real Chromium, started on the first PDF request only.
  const pdf = chromiumPdfRenderer();
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info', PUBLIC_BASE_URL: baseURL }),
    readiness: okReadiness,
    services: {
      appDb,
      platformDb,
      auth,
      mailer: mail,
      baseURL,
      ocr,
      pdf,
      ...(options.messaging ? { messaging: options.messaging } : {}),
    },
    logStream: logs,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
  });
  // Test-only routes used to probe the session hook.
  app.get('/test/protected', { config: { permission: AUTHENTICATED } }, () => ({ ok: true }));
  app.post('/test/protected', { config: { permission: AUTHENTICATED } }, () => ({ ok: true }));
  app.get('/test/:businessId/needs-permission', { config: { permission: 'catalogue.view' } }, () => ({ ok: true }));
  await app.ready();
  return {
    app,
    origin: new URL(baseURL).origin,
    emails,
    mail,
    logs,
    authDb,
    appDb,
    admin,
    storage,
    ocr,
    async runOcr(isolation = {}) {
      const cfg = { ...ocr, isolation: { ...ocr.isolation, ...isolation } };
      const out: { jobId: string; status: string; errorCode: string | null }[] = [];
      for (let r = await processNextOcrJob(appDb, cfg); r; r = await processNextOcrJob(appDb, cfg)) out.push(r);
      return out;
    },
    async close() {
      await app.close();
      await pdf.close();
      await Promise.all([authDb, appDb, platformDb, admin].map((db) => db.destroy()));
    },
  };
}

/** `name=value` pairs from Set-Cookie headers. */
export function cookiesFrom(res: LightMyRequestResponse): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  for (const c of list) {
    const [pair] = c.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function setCookieHeaders(res: LightMyRequestResponse): string[] {
  const raw = res.headers['set-cookie'];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}

export const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

export async function post(
  h: Harness,
  url: string,
  payload: object,
  cookies: Record<string, string> = {},
  ip = freshIp(),
) {
  return h.app.inject({
    method: 'POST',
    url,
    payload,
    remoteAddress: ip,
    headers: { origin: h.origin, ...(Object.keys(cookies).length ? { cookie: cookieHeader(cookies) } : {}) },
  });
}

export async function get(h: Harness, url: string, cookies: Record<string, string> = {}, ip = freshIp()) {
  return h.app.inject({
    method: 'GET',
    url,
    remoteAddress: ip,
    headers: Object.keys(cookies).length ? { cookie: cookieHeader(cookies) } : {},
  });
}

/** Signs up and verifies the email; returns nothing (verification does not sign in). */
export async function createVerifiedUser(h: Harness, email: string, password: string, name = 'Synthetic User') {
  const res = await post(h, '/api/auth/sign-up/email', { email, password, name });
  if (res.statusCode !== 200) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  const mail = h.emails.last(email, 'verify-email');
  if (!mail) throw new Error('no verification email captured');
  const url = new URL(mail.url);
  const verify = await get(h, url.pathname + url.search);
  if (verify.statusCode >= 400) throw new Error(`verification failed: ${verify.statusCode} ${verify.body}`);
}

export async function signIn(h: Harness, email: string, password: string, ip = freshIp()) {
  const res = await post(h, '/api/auth/sign-in/email', { email, password }, {}, ip);
  return { res, cookies: cookiesFrom(res) };
}

export const SESSION_COOKIE = 'lbgos.session_token';

export async function userId(h: Harness, email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`select id from auth."user" where email = ${email}`.execute(h.admin);
  if (!rows[0]) throw new Error(`no user ${email}`);
  return rows[0].id;
}

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for driving the two-factor flow.
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export function secretFromTotpUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('no secret in TOTP URI');
  return secret;
}

/** Enrols TOTP for a signed-in user; returns the rotated session cookie (FR-AUTH-1 AC2). */
export async function enrolMfa(h: Harness, cookies: Record<string, string>, password: string) {
  const enable = await post(h, '/api/auth/two-factor/enable', { password }, cookies);
  if (enable.statusCode !== 200) throw new Error(`enable 2FA failed: ${enable.statusCode} ${enable.body}`);
  const { totpURI } = enable.json<{ totpURI: string }>();
  const secret = secretFromTotpUri(totpURI);
  const verify = await post(h, '/api/auth/two-factor/verify-totp', { code: totp(secret) }, cookies);
  if (verify.statusCode !== 200) throw new Error(`verify 2FA failed: ${verify.statusCode} ${verify.body}`);
  return { secret, session: { [SESSION_COOKIE]: cookiesFrom(verify)[SESSION_COOKIE] ?? '' } };
}

/** Verified, signed-in user; returns email, user ID and session cookies. */
export async function newUser(h: Harness, email: string, password: string) {
  await createVerifiedUser(h, email, password);
  const { res, cookies } = await signIn(h, email, password);
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode}`);
  return { email, id: await userId(h, email), cookies };
}

export async function put(h: Harness, url: string, payload: object, cookies: Record<string, string> = {}) {
  return h.app.inject({
    method: 'PUT',
    url,
    payload,
    remoteAddress: freshIp(),
    headers: { origin: h.origin, cookie: cookieHeader(cookies) },
  });
}
