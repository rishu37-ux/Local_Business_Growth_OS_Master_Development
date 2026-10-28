// API & Integrations Hub (increment 7.3: FR-HUB-1, -2, -4, -6, D-056).
// Viewing needs integrations.view; changes need integrations.manage, and
// anything touching a credential or an endpoint also a sign-in within 10
// minutes (FR-HUB-3 AC4). Responses never contain secret values.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CATEGORIES,
  createIntegration,
  disableIntegration,
  disableTemplate,
  enableIntegration,
  getIntegration,
  IntegrationError,
  integrationHealth,
  listIntegrations,
  listTemplates,
  providers,
  registerDltTemplate,
  revokeIntegration,
  setIntegrationSecret,
  syncTemplates,
  testIntegration,
  updateIntegration,
  type HubDeps,
  type IntegrationInput,
  type IntegrationPatch,
} from '@lbgos/modules/integrations';
import { SecretError } from '@lbgos/modules/secrets';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const httpsUrl = z.url({ protocol: /^https$/ }).max(300);
const config = {
  label: z.string().trim().min(1).max(80),
  baseUrl: httpsUrl.nullable().optional(),
  tokenUrl: httpsUrl.nullable().optional(),
  testPath: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.~%?=&-]*$/)
    .max(200)
    .nullable()
    .optional(),
  allowedPort: z.number().int().min(1).max(65535).nullable().optional(),
  scopes: z
    .array(z.string().regex(/^[A-Za-z0-9:._/-]{1,100}$/))
    .max(20)
    .optional(),
  modelId: z.string().trim().min(1).max(100).nullable().optional(),
  monthlyUnitLimit: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  maxRetries: z.number().int().min(0).max(3).optional(),
  // Non-secret provider settings (WhatsApp IDs, DLT entity and headers); checked per provider.
  config: z.record(z.string().max(40), z.unknown()).optional(),
};
const secret = z.string().min(1).max(4096);

const STATUS = {
  NOT_FOUND: 404,
  PROVIDER_UNKNOWN: 422,
  CATEGORY_NOT_SUPPORTED: 422,
  AUTH_NOT_SUPPORTED: 422,
  BASE_URL_REQUIRED: 422,
  ENDPOINT_NOT_ALLOWED: 422,
  SECRET_REQUIRED: 422,
  INVALID_STATE: 409,
  NOT_CONFIGURED: 409,
  QUOTA_EXCEEDED: 429,
  CONFIG_INVALID: 422,
  OPERATION_NOT_SUPPORTED: 422,
  TEMPLATE_INVALID: 422,
  SYNC_FAILED: 502,
} as const satisfies Record<IntegrationError['code'], number>;

export function registerIntegrationRoutes(app: FastifyInstance, s: AppServices): void {
  const deps: HubDeps = {
    appDb: s.appDb,
    secrets: s.secrets ?? null,
    allowMocks: s.integrations?.allowMocks ?? false,
    outbound: s.integrations?.outbound,
    retryBaseMs: s.integrations?.retryBaseMs,
  };
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const send = (status: number, code: string, message: string, detail?: string) =>
          reply.status(status).send({ error: { code, message, ...(detail ? { detail } : {}), requestId: request.id } });
        if (err instanceof IntegrationError) {
          const nf = err.code === 'NOT_FOUND';
          return send(STATUS[err.code], err.code, nf ? 'Not found.' : err.message, err.detail);
        }
        if (err instanceof SecretError) {
          return send(err.code === 'STORE_NOT_CONFIGURED' ? 503 : 409, err.code, err.message);
        }
        throw err;
      }
    };
  const base = '/api/businesses/:businessId/integrations';

  app.get(
    `${base}/providers`,
    { config: { permission: 'integrations.view' }, schema: { params: businessParams } },
    () => ({ providers: providers(deps.allowMocks), categories: CATEGORIES, storeConfigured: deps.secrets !== null }),
  );

  app.get(
    base,
    { config: { permission: 'integrations.view' }, schema: { params: businessParams } },
    async (request) => ({ integrations: await listIntegrations(s.appDb, ctxOf(request)) }),
  );

  app.get(
    `${base}/:id`,
    { config: { permission: 'integrations.view' }, schema: { params: idParams } },
    guarded(async (request) => {
      const ctx = ctxOf(request);
      return {
        integration: await getIntegration(s.appDb, ctx, idOf(request), request.id),
        health: await integrationHealth(s.appDb, ctx, idOf(request)),
      };
    }),
  );

  app.post(
    base,
    {
      config: { permission: 'integrations.manage', freshAuth: true },
      schema: {
        params: businessParams,
        body: z.strictObject({
          ...config,
          category: z.enum(CATEGORIES),
          provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
          authMethod: z.enum(['NONE', 'API_KEY', 'BEARER', 'OAUTH2_CLIENT_CREDENTIALS']),
          secret: secret.optional(),
        }),
      },
    },
    guarded(async (request, reply) =>
      reply.status(201).send({
        integration: await createIntegration(deps, ctxOf(request), request.body as IntegrationInput, request.id),
      }),
    ),
  );

  app.patch(
    `${base}/:id`,
    {
      config: { permission: 'integrations.manage', freshAuth: true },
      schema: { params: idParams, body: z.strictObject(config).partial() },
    },
    guarded(async (request) => ({
      integration: await updateIntegration(
        deps,
        ctxOf(request),
        idOf(request),
        request.body as IntegrationPatch,
        request.id,
      ),
    })),
  );

  app.put(
    `${base}/:id/secret`,
    {
      config: { permission: 'integrations.manage', freshAuth: true },
      schema: { params: idParams, body: z.strictObject({ secret }) },
    },
    guarded(async (request) => ({
      integration: await setIntegrationSecret(
        deps,
        ctxOf(request),
        idOf(request),
        (request.body as { secret: string }).secret,
        request.id,
      ),
    })),
  );

  app.post(
    `${base}/:id/test`,
    { config: { permission: 'integrations.manage' }, schema: { params: idParams } },
    guarded(async (request) => ({ test: await testIntegration(deps, ctxOf(request), idOf(request), request.id) })),
  );

  app.post(
    `${base}/:id/disable`,
    { config: { permission: 'integrations.manage' }, schema: { params: idParams } },
    guarded(async (request) => ({
      integration: await disableIntegration(s.appDb, ctxOf(request), idOf(request), request.id),
    })),
  );

  app.post(
    `${base}/:id/enable`,
    { config: { permission: 'integrations.manage' }, schema: { params: idParams } },
    guarded(async (request) => ({
      integration: await enableIntegration(s.appDb, ctxOf(request), idOf(request), request.id),
    })),
  );

  app.post(
    `${base}/:id/revoke`,
    { config: { permission: 'integrations.manage', freshAuth: true }, schema: { params: idParams } },
    guarded(async (request) => ({
      integration: await revokeIntegration(s.appDb, ctxOf(request), idOf(request), request.id),
    })),
  );

  // Provider templates (7.6): WhatsApp templates are read from Meta; SMS templates are entered as registered on DLT.
  app.get(
    `${base}/:id/templates`,
    { config: { permission: 'integrations.view' }, schema: { params: idParams } },
    guarded(async (request) => ({ templates: await listTemplates(s.appDb, ctxOf(request), idOf(request)) })),
  );
  app.post(
    `${base}/:id/templates/sync`,
    { config: { permission: 'integrations.manage' }, schema: { params: idParams } },
    guarded(async (request) => ({
      templates: await syncTemplates(deps, ctxOf(request), idOf(request), request.id),
    })),
  );
  app.post(
    `${base}/:id/templates`,
    {
      config: { permission: 'integrations.manage' },
      schema: {
        params: idParams,
        body: z.strictObject({
          name: z.string().trim().min(1).max(100),
          purpose: z.enum(['MARKETING', 'TRANSACTIONAL']),
          body: z.string().trim().min(1).max(1024),
          dltTemplateId: z.string().regex(/^\d{10,25}$/),
        }),
      },
    },
    guarded(async (request, reply) =>
      reply.status(201).send({
        template: await registerDltTemplate(
          s.appDb,
          ctxOf(request),
          idOf(request),
          request.body as { name: string; purpose: 'MARKETING' | 'TRANSACTIONAL'; body: string; dltTemplateId: string },
          request.id,
        ),
      }),
    ),
  );
  app.post(
    `${base}/:id/templates/:templateId/disable`,
    {
      config: { permission: 'integrations.manage' },
      schema: { params: z.strictObject({ businessId: z.uuid(), id: z.uuid(), templateId: z.uuid() }) },
    },
    guarded(async (request) => ({
      template: await disableTemplate(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.params as { templateId: string }).templateId,
      ),
    })),
  );
}
