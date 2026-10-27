// Connects the auth module to the API: turns a session cookie into a Principal
// with the authorization-relevant facts the request hook needs.
import { sql } from 'kysely';
import type { Db } from '@lbgos/db';
import type { AuthService } from '@lbgos/modules/auth';
import { loadBusinessAccess, type BusinessAccess } from '@lbgos/modules/tenancy';

export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  readonly twoFactorEnabled: boolean;
  /** Platform admin or business owner (D-011). */
  readonly mfaRequired: boolean;
  readonly platformAdmin: boolean;
}

export interface AuthGate {
  /** Better Auth's Fetch handler for /api/auth/*. */
  handler(request: Request): Promise<Response>;
  resolve(headers: Headers): Promise<Principal | null>;
  /** The user's access in one business, or null if not an active member. */
  businessAccess(businessId: string, userId: string): Promise<BusinessAccess | null>;
}

/** FR-AUTH-1 AC3 idle timeouts. */
export const IDLE_SECONDS = { platformAdmin: 30 * 60, businessUser: 12 * 60 * 60 } as const;

export function createAuthGate(deps: {
  readonly auth: AuthService;
  readonly appDb: Db;
  readonly platformDb: Db;
}): AuthGate {
  const isPlatformAdmin = async (userId: string) => {
    const { rows } = await sql<{ ok: boolean }>`
      select exists (select 1 from lbg.platform_admins where user_id = ${userId}) as ok`.execute(deps.platformDb);
    return rows[0]?.ok === true;
  };

  return {
    handler: (request) => deps.auth.handler(request),

    async resolve(headers) {
      let platformAdmin = false;
      const session = await deps.auth.getSession(headers, async (userId) => {
        platformAdmin = await isPlatformAdmin(userId);
        return platformAdmin ? IDLE_SECONDS.platformAdmin : IDLE_SECONDS.businessUser;
      });
      if (!session) return null;
      const { rows } = await sql<{ required: boolean }>`
        select lbg.user_requires_mfa(${session.userId}::uuid) as required`.execute(deps.appDb);
      return {
        userId: session.userId,
        email: session.email,
        name: session.name,
        sessionId: session.sessionId,
        twoFactorEnabled: session.twoFactorEnabled,
        mfaRequired: rows[0]?.required === true,
        platformAdmin,
      };
    },

    businessAccess: (businessId, userId) => loadBusinessAccess(deps.appDb, businessId, userId),
  };
}
