// AI assistants (increments 8.1–8.3: FR-AGT-1…6, D-061). Using an assistant
// needs agents.use; each tool needs its own permission, checked against the
// signed-in user's permissions in this business. Runs are visible to their
// user, and to holders of audit.view.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentError,
  AGENTS,
  cancelRun,
  getRun,
  listRuns,
  resumeRun,
  startRun,
  TOOLS,
  type AgentDeps,
  type AgentKey,
} from '@lbgos/modules/agents';
import { activeIntegration } from '@lbgos/modules/integrations';
import { MEMBER } from '../auth-plugin.ts';
import { hubDepsOf } from '../hub.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });

const STATUS = {
  NOT_FOUND: 404,
  UNKNOWN_AGENT: 422,
  INVALID_STATE: 409,
  NOT_CONFIGURED: 409,
  FORBIDDEN: 403,
} as const satisfies Record<AgentError['code'], number>;

export function registerAgentRoutes(app: FastifyInstance, s: AppServices): void {
  const deps: AgentDeps = { ...hubDepsOf(s), storage: s.ocr };
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  // Set or Map (grants with limits): the keys are the permission names either way.
  const permissionsOf = (request: FastifyRequest): ReadonlySet<string> =>
    new Set(request.access?.permissions.keys() ?? []);
  const seesAll = (request: FastifyRequest) => permissionsOf(request).has('audit.view');
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (!(err instanceof AgentError)) throw err;
        const nf = err.code === 'NOT_FOUND';
        return reply.status(STATUS[err.code]).send({
          error: { code: err.code, message: nf ? 'Not found.' : err.message, requestId: request.id },
        });
      }
    };
  const base = '/api/businesses/:businessId/agents';
  /** Reading runs needs agents.use or audit.view but stays possible in read-only mode (D-009). */
  const canRead = (request: FastifyRequest, reply: FastifyReply) => {
    const p = permissionsOf(request);
    if (p.has('agents.use') || p.has('audit.view')) return true;
    void reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.', requestId: request.id },
    });
    return false;
  };

  app.get(base, { config: { permission: 'agents.use' }, schema: { params: businessParams } }, async (request) => {
    const p = permissionsOf(request);
    return {
      agents: AGENTS.map((a) => ({
        ...a,
        tools: a.tools.map((name) => {
          const t = TOOLS.get(name);
          return {
            name,
            description: t?.description ?? '',
            permission: t?.permission ?? '',
            consequential: t?.consequential ?? false,
            allowed: t ? p.has(t.permission) : false,
          };
        }),
      })),
      configured: (await activeIntegration(s.appDb, ctxOf(request), 'LLM')) !== null,
    };
  });

  app.get(
    `${base}/runs`,
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    async (request, reply) =>
      canRead(request, reply) ? { runs: await listRuns(s.appDb, ctxOf(request), seesAll(request)) } : reply,
  );

  app.get(
    `${base}/runs/:id`,
    { config: { permission: MEMBER }, schema: { params: idParams } },
    guarded(async (request, reply) =>
      canRead(request, reply) ? { run: await getRun(s.appDb, ctxOf(request), idOf(request), seesAll(request)) } : reply,
    ),
  );

  app.post(
    `${base}/runs`,
    {
      config: { permission: 'agents.use' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          agent: z.enum(['INVENTORY', 'FINANCE', 'CRM', 'MARKETING', 'GROWTH']),
          question: z.string().trim().min(1).max(1000),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
        }),
      },
    },
    guarded(async (request, reply) => {
      const b = request.body as { agent: AgentKey; question: string; idempotencyKey: string };
      const run = await startRun(deps, ctxOf(request), permissionsOf(request), b);
      return reply.status(201).send({ run });
    }),
  );

  app.post(
    `${base}/runs/:id/resume`,
    { config: { permission: 'agents.use' }, schema: { params: idParams } },
    guarded(async (request) => ({ run: await resumeRun(deps, ctxOf(request), permissionsOf(request), idOf(request)) })),
  );

  app.post(
    `${base}/runs/:id/cancel`,
    { config: { permission: 'agents.use' }, schema: { params: idParams } },
    guarded(async (request) => ({ run: await cancelRun(s.appDb, ctxOf(request), idOf(request)) })),
  );
}
