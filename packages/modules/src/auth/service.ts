// The auth module's public service (D-019). Wraps Better Auth so the rest of
// the system depends only on this interface.
import { betterAuth } from 'better-auth';
import { sql } from 'kysely';
import { buildAuthOptions, ensureProfile, type AuthSettings } from './options.ts';

export interface AuthSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly expiresAt: Date;
}

export interface AuthService {
  /** Fetch-API handler for everything under /api/auth/*. */
  handler(request: Request): Promise<Response>;
  /**
   * Resolves the session cookie in `headers`. Returns null if there is none,
   * it expired, or it has been idle longer than `idleSecondsFor(userId)`
   * seconds (the session is then revoked).
   */
  getSession(headers: Headers, idleSecondsFor: (userId: string) => Promise<number>): Promise<AuthSession | null>;
  /** Signs a user out everywhere (deactivation, MFA reset, role changes). */
  revokeAllSessions(userId: string): Promise<number>;
  /** Removes a user's MFA enrolment and signs them out (FR-AUTH-5 AC1). */
  resetMfa(userId: string): Promise<void>;
}

/** Activity writes are throttled to one per minute per session. */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

export function createAuthService(settings: AuthSettings): AuthService {
  const auth = betterAuth(buildAuthOptions(settings));
  const db = settings.db;

  return {
    handler: (request) => auth.handler(request),

    async getSession(headers, idleSecondsFor) {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      const sessionId = result.session.id;
      const idleSeconds = await idleSecondsFor(result.user.id);
      const { rows } = await sql<{ last_seen_at: Date }>`
        select last_seen_at from auth.session_activity where session_id = ${sessionId}`.execute(db);
      const lastSeen = rows[0]?.last_seen_at;
      const now = Date.now();
      if (lastSeen && now - lastSeen.getTime() > idleSeconds * 1000) {
        await sql`delete from auth."session" where id = ${sessionId}`.execute(db);
        return null;
      }
      if (!lastSeen) {
        // First use of this session. Better Auth's user insert and its
        // after-create hook are not one transaction, so a profile row can be
        // missing if that hook failed; repair it here (idempotent).
        await ensureProfile(db, result.user);
      }
      if (!lastSeen || now - lastSeen.getTime() > ACTIVITY_WRITE_INTERVAL_MS) {
        await sql`insert into auth.session_activity (session_id, last_seen_at) values (${sessionId}, now())
                  on conflict (session_id) do update set last_seen_at = excluded.last_seen_at`.execute(db);
      }
      const user = result.user as typeof result.user & { twoFactorEnabled?: boolean | null };
      return {
        sessionId,
        userId: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled === true,
        expiresAt: new Date(result.session.expiresAt),
      };
    },

    async revokeAllSessions(userId) {
      const result = await sql`delete from auth."session" where "userId" = ${userId}`.execute(db);
      return Number(result.numAffectedRows ?? 0);
    },

    async resetMfa(userId) {
      await db.transaction().execute(async (trx) => {
        await sql`delete from auth."twoFactor" where "userId" = ${userId}`.execute(trx);
        await sql`update auth."user" set "twoFactorEnabled" = false where id = ${userId}`.execute(trx);
        await sql`delete from auth."session" where "userId" = ${userId}`.execute(trx);
      });
    },
  };
}
