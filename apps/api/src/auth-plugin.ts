// Session enforcement for every non-public route, plus the bridge that serves
// Better Auth's endpoints under /api/auth/* (increment 3.5).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '@lbgos/db';
import { isBusinessPermission, isPlatformPermission, permittedInMode } from '@lbgos/domain';
import { CLIENT_IP_HEADER } from '@lbgos/modules/auth';
import type { BusinessAccess } from '@lbgos/modules/tenancy';
import type { AuthGate, Principal } from './auth-gate.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook on every non-public route. */
    principal?: Principal;
    /** Set on business-scoped routes after the permission check. */
    access?: BusinessAccess;
  }
  interface FastifyContextConfig {
    /** Route stays reachable for a user who must enrol MFA but has not yet (D-011). */
    allowWithoutMfa?: boolean;
  }
}

/** Pseudo-permission: any signed-in user (e.g. "who am I"). */
export const AUTHENTICATED = 'authenticated';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Client-supplied forwarding headers are never passed to Better Auth; it sees
// only the proxy-aware IP computed by Fastify (rate-limit keys, session IP).
const STRIPPED_HEADERS = new Set([
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'forwarded',
  CLIENT_IP_HEADER,
]);

function toFetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || STRIPPED_HEADERS.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/**
 * Better Auth returns the session token in sign-in/sign-up JSON bodies. The
 * browser only needs the HttpOnly cookie; a token readable by scripts would
 * defeat HttpOnly if an XSS bug ever existed, so it is removed here.
 */
function withoutToken(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && 'token' in parsed) {
      return JSON.stringify({ ...parsed, token: null });
    }
  } catch {
    // Not JSON after all: pass through unchanged.
  }
  return json;
}

function deny(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, requestId: request.id } });
}

export function registerAuth(app: FastifyInstance, gate: AuthGate | undefined, publicOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config;
    // Unmatched URLs go straight to the 404 handler; nothing exists to protect.
    if (request.is404 || config.public === true) return;

    // CSRF defence for cookie-authenticated, state-changing requests (threat T4):
    // the browser's Origin must be our own. SameSite=Lax cookies are the first layer.
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== publicOrigin) {
      return deny(reply, request, 403, 'ORIGIN_REJECTED', 'Cross-origin request rejected.');
    }

    const principal = gate ? await gate.resolve(toFetchHeaders(request)) : null;
    if (!principal) return deny(reply, request, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (principal.mfaRequired && !principal.twoFactorEnabled && config.allowWithoutMfa !== true) {
      return deny(reply, request, 403, 'MFA_ENROLMENT_REQUIRED', 'Set up two-step verification to continue.');
    }
    request.principal = principal;

    const permission = config.permission;
    if (permission === AUTHENTICATED) return;

    if (permission !== undefined && isPlatformPermission(permission)) {
      // Platform admins hold every platform permission; MFA was enforced above.
      if (!principal.platformAdmin)
        return deny(reply, request, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      return;
    }

    if (permission !== undefined && isBusinessPermission(permission) && gate) {
      const businessId = (request.params as { businessId?: unknown }).businessId;
      // Non-members get 404, so business IDs cannot be probed.
      const access =
        typeof businessId === 'string' && isUuid(businessId)
          ? await gate.businessAccess(businessId, principal.userId)
          : null;
      if (!access) return deny(reply, request, 404, 'NOT_FOUND', 'Not found.');
      if (!permittedInMode(permission, access.mode)) {
        const code = access.mode === 'READ_ONLY' ? 'TENANT_READ_ONLY' : 'BUSINESS_NOT_AVAILABLE';
        return deny(reply, request, 403, code, 'This action is not available for this business right now.');
      }
      if (!access.permissions.has(permission)) {
        return deny(reply, request, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      }
      request.access = access;
      return;
    }

    // Unknown permission keys cannot be registered (app.ts), so this is unreachable: fail closed anyway.
    return deny(reply, request, 403, 'FORBIDDEN', 'You do not have access to this resource.');
  });

  if (!gate) return;

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { public: true },
    handler: async (request, reply) => {
      const headers = toFetchHeaders(request);
      headers.set(CLIENT_IP_HEADER, request.ip);
      headers.delete('content-length');
      const hasBody = request.method !== 'GET' && request.body !== undefined && request.body !== null;
      const response = await gate.handler(
        new Request(new URL(request.url, publicOrigin), {
          method: request.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      void reply.status(response.status);
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie' && name !== 'content-length' && name !== 'content-encoding') {
          void reply.header(name, value);
        }
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) void reply.header('set-cookie', cookies);
      const text = await response.text();
      return reply.send(response.headers.get('content-type')?.includes('application/json') ? withoutToken(text) : text);
    },
  });

  app.get('/api/me', { config: { permission: AUTHENTICATED, allowWithoutMfa: true } }, (request) => {
    const p = request.principal;
    return p
      ? {
          userId: p.userId,
          email: p.email,
          name: p.name,
          twoFactorEnabled: p.twoFactorEnabled,
          mfaRequired: p.mfaRequired,
          platformAdmin: p.platformAdmin,
        }
      : null;
  });
}
