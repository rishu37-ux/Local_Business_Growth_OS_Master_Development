// Fastify application factory (backlog F-05, increment 3.4). Builds the HTTP
// app without listening, so tests use app.inject().
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.ts';
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
    const config = route.config as { permission?: unknown; public?: unknown } | undefined;
    const declared = config?.public === true || typeof config?.permission === 'string';
    if (!declared) {
      throw new Error(`route ${String(route.method)} ${route.url} must declare config.permission or config.public`);
    }
  });

  // NFR-17 security headers. The SPA is served from the same origin (ADR-05),
  // so the CSP needs no inline scripts or third-party origins.
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
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

  app.get('/healthz', { config: { public: true } }, () => ({ status: 'ok' }));

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
