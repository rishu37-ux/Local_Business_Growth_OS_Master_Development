// Erase a customer's personal data and the owner's full data export
// (increment 6.6: FR-PRV-1 AC2, FR-PRV-2, D-052). Both are owner-only and need
// a recent sign-in; the export is also available in read-only mode.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eraseCustomer, exportBusinessData, PrivacyError } from '@lbgos/modules/privacy';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const STATUS = { NOT_FOUND: 404, ALREADY_ERASED: 409, EXPORT_TOO_LARGE: 413 } as const satisfies Record<
  PrivacyError['code'],
  number
>;

export function registerPrivacyRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  const ownerOnly = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.access?.isOwner === true) return true;
    void fail(request, reply, 403, 'OWNER_ONLY', 'Only the owner can do this.');
    return false;
  };
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (!(err instanceof PrivacyError)) throw err;
        const nf = err.code === 'NOT_FOUND';
        return fail(request, reply, STATUS[err.code], err.code, nf ? 'Not found.' : err.message);
      }
    };

  app.post(
    '/api/businesses/:businessId/customers/:id/erase',
    {
      // customers.manage keeps it out of read-only mode; the owner check and re-authentication follow.
      config: { permission: 'customers.manage', freshAuth: true },
      schema: {
        params: z.strictObject({ businessId: z.uuid(), id: z.uuid() }),
        body: z.strictObject({ reason: z.string().trim().min(10).max(500) }),
      },
    },
    guarded(async (request, reply) => {
      if (!ownerOnly(request, reply)) return reply;
      const result = await eraseCustomer(
        s.appDb,
        ctxOf(request),
        (request.params as { id: string }).id,
        (request.body as { reason: string }).reason,
        request.id,
      );
      return { erasure: result };
    }),
  );

  app.get(
    '/api/businesses/:businessId/export/business-data',
    { config: { permission: MEMBER, freshAuth: true }, schema: { params: z.strictObject({ businessId: z.uuid() }) } },
    guarded(async (request, reply) => {
      if (!ownerOnly(request, reply)) return reply;
      const out = await exportBusinessData(s.appDb, ctxOf(request), request.id);
      return reply
        .type('application/zip')
        .header('content-disposition', 'attachment; filename="business-data.zip"')
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(out.zip);
    }),
  );
}
