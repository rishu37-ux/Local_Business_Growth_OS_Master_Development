// Customer payments, advances, refunds, reversals and statements (increment
// 5.4: FR-LED-1, FR-LED-2, D-014, D-041).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applyAdvance,
  customerAccount,
  customerStatement,
  PaymentError,
  recordPayment,
  refundAdvance,
  reversePayment,
  type PaymentInput,
  type PaymentMethod,
} from '@lbgos/modules/sales';
import type { AppServices } from '../services.ts';

const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const paise = z.number().int().min(0).max(10_000_000_000_000);
const method = z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER']);
const reference = z.string().trim().min(1).max(60).nullable().optional();
const reason = z.string().trim().min(10).max(500);
const invoiceIds = z.array(z.uuid()).min(1).max(50).optional();

const STATUS = {
  NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  PAYMENT_INVALID: 422,
  UNKNOWN_INVOICE: 422,
  INSUFFICIENT_ADVANCE: 422,
  ALREADY_REVERSED: 409,
  NOT_REVERSIBLE: 409,
  REFUNDED: 409,
  INVALID_PERIOD: 400,
} as const satisfies Record<PaymentError['code'], number>;

function sendPaymentError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (!(err instanceof PaymentError)) return undefined;
  const notFound = err.code === 'NOT_FOUND' || err.code === 'CUSTOMER_NOT_FOUND';
  return reply.status(STATUS[err.code]).send({
    error: {
      code: notFound ? 'NOT_FOUND' : err.code,
      message: notFound ? 'Not found.' : err.message,
      requestId: request.id,
    },
  });
}

export function registerPaymentRoutes(app: FastifyInstance, s: AppServices): void {
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
        const handled = sendPaymentError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };
  const base = '/api/businesses/:businessId/customers/:id';

  app.get(
    `${base}/account`,
    { config: { permission: 'customer_ledger.view' }, schema: { params: idParams } },
    guarded(async (request) => ({ account: await customerAccount(s.appDb, ctxOf(request), idOf(request)) })),
  );

  app.get(
    `${base}/statement`,
    {
      config: { permission: 'customer_ledger.view' },
      schema: { params: idParams, querystring: z.strictObject({ from: z.iso.date(), to: z.iso.date() }) },
    },
    guarded(async (request) => {
      const q = request.query as { from: string; to: string };
      return { statement: await customerStatement(s.appDb, ctxOf(request), idOf(request), q.from, q.to) };
    }),
  );

  app.post(
    `${base}/payments`,
    {
      config: { permission: 'payments.record' },
      schema: {
        params: idParams,
        body: z.strictObject({
          method,
          amountPaise: paise.min(1),
          reference,
          tenderedPaise: paise.nullable().optional(),
          invoiceIds,
          notes: z.string().trim().min(1).max(500).nullable().optional(),
        }),
      },
    },
    guarded(async (request, reply) => {
      const payment = await recordPayment(
        s.appDb,
        ctxOf(request),
        idOf(request),
        request.body as PaymentInput,
        request.id,
      );
      return reply.status(201).send({ payment });
    }),
  );

  app.post(
    `${base}/apply-advance`,
    { config: { permission: 'payments.record' }, schema: { params: idParams, body: z.strictObject({ invoiceIds }) } },
    guarded(async (request) =>
      applyAdvance(s.appDb, ctxOf(request), idOf(request), request.body as { invoiceIds?: string[] }, request.id),
    ),
  );

  app.post(
    `${base}/refunds`,
    {
      config: { permission: 'refunds.approve' },
      schema: { params: idParams, body: z.strictObject({ amountPaise: paise.min(1), method, reference, reason }) },
    },
    guarded(async (request, reply) => {
      const body = request.body as { amountPaise: number; method: PaymentMethod; reference?: string; reason: string };
      return reply
        .status(201)
        .send({ refund: await refundAdvance(s.appDb, ctxOf(request), idOf(request), body, request.id) });
    }),
  );

  app.post(
    '/api/businesses/:businessId/payments/:id/reverse',
    { config: { permission: 'refunds.approve' }, schema: { params: idParams, body: z.strictObject({ reason }) } },
    guarded(async (request, reply) => {
      const reversal = await reversePayment(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.body as { reason: string }).reason,
        request.id,
      );
      return reply.status(201).send({ reversal });
    }),
  );
}
