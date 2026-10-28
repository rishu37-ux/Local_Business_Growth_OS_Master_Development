// Platform billing invoices (increment 10.2: FR-SUB-1 AC3, D-068). The
// platform admin issues, records manual payments and voids; the owner sees
// the business's invoices, also in read-only mode (an expired subscription
// must still show what is owed).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BillingError,
  businessBillingInvoices,
  issueBillingInvoice,
  listBillingInvoices,
  recordManualPayment,
  voidBillingInvoice,
} from '@lbgos/modules/billing';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const invoiceParams = z.strictObject({ invoiceId: z.uuid() });
const STATUS = {
  NOT_FOUND: 404,
  NO_SUBSCRIPTION: 409,
  NOT_ISSUED: 409,
  PERIOD_INVALID: 422,
  PERIOD_BILLED: 409,
} as const satisfies Record<BillingError['code'], number>;

export function registerBillingRoutes(app: FastifyInstance, s: AppServices): void {
  const actor = (request: FastifyRequest) => request.principal?.userId ?? '';
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (err instanceof BillingError) return fail(request, reply, STATUS[err.code], err.code, err.message);
        throw err;
      }
    };
  const manage = { permission: 'platform.businesses.manage' } as const;

  app.get(
    '/api/platform/billing-invoices',
    { config: manage, schema: { querystring: z.strictObject({ businessId: z.uuid().optional() }) } },
    async (request) => ({
      invoices: await listBillingInvoices(s.platformDb, (request.query as { businessId?: string }).businessId),
    }),
  );

  app.post(
    '/api/platform/billing-invoices',
    {
      config: manage,
      schema: {
        body: z.strictObject({ businessId: z.uuid(), periodStart: z.iso.date(), periodEnd: z.iso.date() }),
      },
    },
    guarded(async (request, reply) => {
      const invoice = await issueBillingInvoice(
        s.platformDb,
        actor(request),
        request.body as { businessId: string; periodStart: string; periodEnd: string },
      );
      return reply.status(201).send({ invoice });
    }),
  );

  app.post(
    '/api/platform/billing-invoices/:invoiceId/payment',
    {
      config: manage,
      schema: {
        params: invoiceParams,
        body: z.strictObject({ paidOn: z.iso.date(), reference: z.string().trim().min(3).max(100) }),
      },
    },
    guarded(async (request) => ({
      invoice: await recordManualPayment(
        s.platformDb,
        actor(request),
        (request.params as { invoiceId: string }).invoiceId,
        request.body as { paidOn: string; reference: string },
      ),
    })),
  );

  app.post(
    '/api/platform/billing-invoices/:invoiceId/void',
    {
      config: manage,
      schema: { params: invoiceParams, body: z.strictObject({ reason: z.string().trim().min(10).max(500) }) },
    },
    guarded(async (request) => ({
      invoice: await voidBillingInvoice(
        s.platformDb,
        actor(request),
        (request.params as { invoiceId: string }).invoiceId,
        (request.body as { reason: string }).reason,
      ),
    })),
  );

  app.get(
    '/api/businesses/:businessId/billing-invoices',
    { config: { permission: MEMBER }, schema: { params: z.strictObject({ businessId: z.uuid() }) } },
    async (request, reply) => {
      if (request.access?.permissions.has('subscription.manage') !== true)
        return fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      return {
        invoices: await businessBillingInvoices(s.appDb, {
          businessId: (request.params as { businessId: string }).businessId,
          userId: actor(request),
        }),
      };
    },
  );
}
