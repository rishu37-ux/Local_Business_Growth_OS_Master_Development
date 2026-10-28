// Fastify application factory (backlog F-05, increment 3.4). Builds the HTTP
// app without listening, so tests use app.inject().
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createAuthGate } from './auth-gate.ts';
import { isBusinessPermission, isPlatformPermission } from '@lbgos/domain';
import { AUTHENTICATED, MEMBER, registerAuth } from './auth-plugin.ts';
import type { Config } from './config.ts';
import { registerCatalogueRoutes } from './routes/catalogue.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { registerMessagingRoutes } from './routes/messaging.ts';
import { registerOnboardingRoutes } from './routes/onboarding.ts';
import { registerPaymentRoutes } from './routes/payments.ts';
import { registerPurchasingRoutes } from './routes/purchasing.ts';
import { registerReminderRoutes } from './routes/reminders.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerSalesRoutes } from './routes/sales.ts';
import { registerScanRoutes } from './routes/scans.ts';
import { registerPlatformRoutes } from './routes/platform.ts';
import { registerTenancyRoutes } from './routes/tenancy.ts';
import type { AppServices } from './services.ts';
import { registerWeb } from './static.ts';
import { errorBody, INTERNAL, mapDatabaseError } from './errors.ts';
import { zodValidatorCompiler } from './validation.ts';

// Every route must say who may call it (increment 3.4 AC6, FR-RBAC-1 AC2).
// Enforcement of `permission` against the session arrives with RBAC (3.6);
// the declaration requirement is enforced from the start.
declare module 'fastify' {
  interface FastifyContextConfig {
    /** Permission key from ROLES_PERMISSIONS.md required to call this route. */
    permission?: string;
    /** Explicitly public (no session needed), e.g. health checks. */
    public?: boolean;
  }
}

export interface Readiness {
  /** Resolves when the database answers; rejects otherwise. */
  database(): Promise<void>;
}

export interface AppDeps {
  readonly config: Config;
  readonly readiness: Readiness;
  /** Databases and auth. Without them every non-public route answers 401 and no business routes exist. */
  readonly services?: AppServices;
  /** Built web app (apps/web/dist) to serve at /; omitted in API-only tests. */
  readonly webRoot?: string;
  /** Test hook: where log lines go (default stdout). */
  readonly logStream?: Writable;
}

// Paths censored in every log line (NFR-10, FR-HUB-3 AC3). Wildcards cover one
// level of nesting; code must not log raw secrets or personal data in the
// first place, so this is the safety net, not the policy.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'secret',
  'token',
  'apiKey',
  'otp',
  '*.password',
  '*.newPassword',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.otp',
];

/** SHA-256 of the stylesheet React Aria Components 1.22 injects (D-031). */
export const REACT_ARIA_STYLE_HASH = "'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='";

// Accept an upstream request ID only if it looks like one; otherwise mint our
// own, so attacker-controlled text never becomes a log correlation key.
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function buildApp(deps: AppDeps): FastifyInstance {
  const logger: FastifyServerOptions['logger'] = {
    level: deps.config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    ...(deps.logStream ? { stream: deps.logStream } : {}),
  };

  const app = Fastify({
    logger,
    // Trust exactly N proxy hops (edge + platform router), never arbitrary
    // X-Forwarded-For chains; Fastify's types take this as a function.
    trustProxy: (_address: string, hop: number) => hop < deps.config.TRUST_PROXY_HOPS,
    bodyLimit: 1_048_576, // 1 MiB; uploads use a separate path with their own limits (FR-OCR-6)
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.setValidatorCompiler(zodValidatorCompiler);

  app.addHook('onRoute', (route) => {
    const where = `route ${String(route.method)} ${route.url}`;
    const config = route.config as { permission?: unknown; public?: unknown } | undefined;
    if (config?.public === true) return;
    const permission = config?.permission;
    if (typeof permission !== 'string') throw new Error(`${where} must declare config.permission or config.public`);
    // FR-RBAC-1 AC2: only catalogue permissions, each on the right kind of URL.
    if (permission === AUTHENTICATED) return;
    if (permission === MEMBER) {
      if (!route.url.includes(':businessId')) throw new Error(`${where} uses ${MEMBER} without :businessId`);
      return;
    }
    if (isBusinessPermission(permission)) {
      if (!route.url.includes(':businessId'))
        throw new Error(`${where} uses business permission ${permission} without :businessId`);
      return;
    }
    if (isPlatformPermission(permission)) {
      if (!route.url.startsWith('/api/platform/'))
        throw new Error(`${where} uses platform permission ${permission} outside /api/platform/`);
      return;
    }
    throw new Error(`${where} declares unknown permission ${permission}`);
  });

  // NFR-17 security headers. The SPA is served from the same origin (ADR-05),
  // so the CSP needs no inline scripts or third-party origins.
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React Aria Components injects one fixed <style> (touch-action for
        // pressable elements). It is allowed by its exact hash, not by
        // 'unsafe-inline'; the browser test fails if the hash ever stops matching.
        styleSrc: ["'self'", REACT_ARIA_STYLE_HASH],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, request, reply) => {
    const validation = (err as { validation?: unknown }).validation;
    if (Array.isArray(validation)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: 'The request is invalid.', requestId: request.id, issues: validation },
      });
    }
    const mapped = mapDatabaseError(err);
    if (mapped) {
      if (mapped.status === 403) request.log.warn({ err }, 'security: database denied access (RLS/privilege)');
      else request.log.info({ err }, 'request rejected by database rule');
      return reply.status(mapped.status).send(errorBody(mapped, request.id));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: 'BAD_REQUEST', message: 'The request could not be processed.', requestId: request.id },
      });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody(INTERNAL, request.id));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } }),
  );

  const services = deps.services;
  registerAuth(app, services ? createAuthGate(services) : undefined, new URL(deps.config.PUBLIC_BASE_URL).origin);
  if (services) {
    registerTenancyRoutes(app, services);
    registerMemberRoutes(app, services);
    registerOnboardingRoutes(app, services);
    registerPlatformRoutes(app, services);
    registerCatalogueRoutes(app, services);
    registerPurchasingRoutes(app, services);
    registerInventoryRoutes(app, services);
    registerScanRoutes(app, services);
    registerSalesRoutes(app, services);
    registerPaymentRoutes(app, services);
    registerReportRoutes(app, services);
    registerMessagingRoutes(app, services);
    registerReminderRoutes(app, services);
  }

  app.get('/healthz', { config: { public: true } }, () => ({ status: 'ok' }));

  if (deps.webRoot) registerWeb(app, deps.webRoot);

  app.get('/readyz', { config: { public: true } }, async (request, reply) => {
    try {
      await deps.readiness.database();
      return { status: 'ready' };
    } catch (err) {
      request.log.error({ err }, 'readiness check failed: database');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
