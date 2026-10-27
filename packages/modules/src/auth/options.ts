// Better Auth configuration (D-019). Used both at runtime and by the schema
// generator (scripts/generate-auth-schema.ts), so the migration always matches
// the configured plugins.
import { createHash } from 'node:crypto';
import type { BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { sql } from 'kysely';
import type { Db } from '@lbgos/db';
import type { EmailSender } from './email.ts';
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  verifyPassword,
} from './passwords.ts';

export interface AuthSettings {
  /** Public origin of the app, e.g. https://app.example.in (cookies, links, origin checks). */
  readonly baseURL: string;
  /** ≥32 chars; signs cookies and encrypts TOTP secrets and backup codes. */
  readonly secret: string;
  /** Production: Secure + __Secure- cookies. */
  readonly secureCookies: boolean;
  readonly email: EmailSender;
  /** Pool connected as lbgos_auth (search_path = auth). */
  readonly db: Db;
}

export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60; // FR-AUTH-1 AC3
export const RESET_TOKEN_SECONDS = 30 * 60; // FR-AUTH-2 AC2
export const LOCKOUT = { maxFailures: 5, windowMinutes: 15 } as const; // FR-AUTH-4 AC1
export const CLIENT_IP_HEADER = 'x-lbgos-client-ip';

/** Failure tracking key: a hash of the normalised email, so raw addresses are not stored twice. */
/**
 * Idempotent: creates the lbg.users profile row for an identity if missing.
 * The auth role's search_path is `auth` only, hence the qualified types.
 */
export async function ensureProfile(db: Db, user: { id: string; email: string; name: string }): Promise<void> {
  await sql`select auth.create_user_profile(${user.id}::uuid, ${user.email}::public.citext, ${user.name})`.execute(db);
}

export function accountKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function emailFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('email' in body)) return undefined;
  const email = body.email;
  return typeof email === 'string' ? email : undefined;
}

function emailContext(body: unknown): { email?: string } {
  const email = emailFrom(body);
  return email === undefined ? {} : { email };
}

export function buildAuthOptions(s: AuthSettings): BetterAuthOptions {
  return {
    appName: 'Local Business Growth OS',
    baseURL: s.baseURL,
    basePath: '/api/auth',
    secret: s.secret,
    database: { db: s.db, type: 'postgres' },
    telemetry: { enabled: false },
    // Better Auth logs unstructured lines to stdout; keep only errors (our
    // structured logs and audit events record auth outcomes).
    logger: { level: 'error' },
    advanced: {
      // The API strips client-supplied forwarding headers and sets this one
      // from Fastify's proxy-aware request.ip, so rate limits key on a real IP.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      cookiePrefix: 'lbgos',
      useSecureCookies: s.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: s.secureCookies },
      database: { generateId: 'uuid' },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      password: { hash: hashPassword, verify: verifyPassword },
      resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await s.email.send({ to: user.email, kind: 'reset-password', url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await s.email.send({ to: user.email, kind: 'verify-email', url });
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Every identity gets a lbg.users profile row with the same ID (migration 0004).
          after: async (user) => {
            await ensureProfile(s.db, user);
          },
        },
      },
    },
    session: {
      expiresIn: SESSION_ABSOLUTE_SECONDS,
      // Absolute expiry: never extended. Idle timeouts are enforced by AuthService.getSession.
      disableSessionRefresh: true,
    },
    verification: { storeIdentifier: 'hashed' },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/two-factor/*': { window: 60, max: 10 },
      },
    },
    plugins: [
      twoFactor({
        issuer: 'Local Business Growth OS',
        // Backup codes can only be stored encrypted or plain in Better Auth 1.7
        // (not hashed); encrypted with the server secret (D-025).
        backupCodeOptions: { amount: 10, storeBackupCodes: 'encrypted' },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' || ctx.path === '/reset-password' || ctx.path === '/change-password') {
          const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown };
          const candidate = typeof body.newPassword === 'string' ? body.newPassword : body.password;
          const problem =
            typeof candidate === 'string' ? passwordProblem(candidate, emailContext(ctx.body)) : undefined;
          if (problem) throw new APIError('BAD_REQUEST', { message: problem, code: 'PASSWORD_REJECTED' });
        }
        if (ctx.path === '/change-password') {
          // FR-AUTH-1 AC6: a password change always signs out every other session.
          return { context: { body: { ...(ctx.body as object), revokeOtherSessions: true } } };
        }
        if (ctx.path === '/sign-in/email') {
          const email = emailFrom(ctx.body);
          if (!email) return;
          const { rows } = await sql<{ n: string }>`
            select count(*) as n from auth.sign_in_failures
             where account_key = ${accountKey(email)}
               and failed_at > now() - make_interval(mins => ${LOCKOUT.windowMinutes})`.execute(s.db);
          if (Number(rows[0]?.n ?? 0) >= LOCKOUT.maxFailures) {
            await sql`select auth.record_auth_event('auth.sign_in.locked', null,
                        jsonb_build_object('account_key', ${accountKey(email)}::text))`.execute(s.db);
            // Same response whether or not the account exists (FR-AUTH-4 AC1).
            throw new APIError('TOO_MANY_REQUESTS', {
              message: 'Too many attempts. Try again later.',
              code: 'TOO_MANY_ATTEMPTS',
            });
          }
        }
        return;
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const email = emailFrom(ctx.body);
        if (!email) return;
        const key = accountKey(email);
        const returned: unknown = ctx.context.returned;
        const isLockoutResponse =
          returned instanceof APIError &&
          (returned.body as { code?: unknown } | undefined)?.code === 'TOO_MANY_ATTEMPTS';
        if (returned instanceof APIError && !isLockoutResponse) {
          await sql`insert into auth.sign_in_failures (account_key) values (${key})`.execute(s.db);
        } else if (!(returned instanceof APIError)) {
          await sql`delete from auth.sign_in_failures where account_key = ${key}`.execute(s.db);
        }
      }),
    },
  };
}
