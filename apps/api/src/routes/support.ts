// Owner-granted support access (increment 10.1: FR-SUP-1, D-067). The owner
// grants (recent sign-in), sees grants and every support action, and revokes.
// Viewing and revoking stay possible in read-only mode: an owner must always
// be able to see and end support access.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { grantSupport, revokeSupport, SupportError, supportOverview } from '@lbgos/modules/support';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const grantParams = z.strictObject({ businessId: z.uuid(), grantId: z.uuid() });
const STATUS = { NOT_FOUND: 404, ALREADY_REVOKED: 409, DURATION_INVALID: 422 } as const satisfies Record<
  SupportError['code'],
  number
>;

export function registerSupportRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  const canManage = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.access?.permissions.has('support.grant') === true && !request.access.support) return true;
    void fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
    return false;
  };
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (err instanceof SupportError) return fail(request, reply, STATUS[err.code], err.code, err.message);
        throw err;
      }
    };
  const base = '/api/businesses/:businessId/support';

  app.get(
    base,
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    guarded(async (request, reply) => (canManage(request, reply) ? supportOverview(s.appDb, ctxOf(request)) : reply)),
  );

  app.post(
    `${base}/grants`,
    {
      config: { permission: 'support.grant', freshAuth: true },
      schema: {
        params: businessParams,
        body: z.strictObject({ purpose: z.string().trim().min(10).max(500), hours: z.int().min(1).max(72) }),
      },
    },
    guarded(async (request, reply) => {
      const body = request.body as { purpose: string; hours: number };
      const grant = await grantSupport(s.appDb, ctxOf(request), body, request.id);
      return reply.status(201).send({ grant });
    }),
  );

  app.post(
    `${base}/grants/:grantId/revoke`,
    { config: { permission: MEMBER }, schema: { params: grantParams } },
    guarded(async (request, reply) => {
      if (!canManage(request, reply)) return reply;
      const { grantId } = request.params as z.infer<typeof grantParams>;
      return { grant: await revokeSupport(s.appDb, ctxOf(request), grantId, request.id) };
    }),
  );
}
