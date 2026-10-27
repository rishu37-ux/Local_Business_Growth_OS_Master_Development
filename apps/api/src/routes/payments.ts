// Customer payments, advances, refunds, reversals and statements (increment
// 5.4: FR-LED-1, FR-LED-2, D-014, D-041); cancellation, credit and debit notes
// (increment 5.5: FR-TAX-3, FR-POS-3 AC5, D-016, D-042).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applyAdvance,
  cancelInvoice,
  issueCreditNote,
  issueDebitNote,
  ReturnError,
  type CancelInput,
  type CreditNoteInput,
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

const RETURN_STATUS = {
  NOT_FOUND: 404,
  NOT_ISSUED: 409,
  NOT_AN_INVOICE: 422,
  OUTSIDE_WINDOW: 409,
  HAS_NOTES: 409,
  INVALID: 422,
  RETURN_EXCEEDS_SOLD: 422,
  REFUND_REQUIRED: 422,
  REFUND_FORBIDDEN: 403,
  NEEDS_CUSTOMER: 422,
  UNIT_NOT_SOLD: 409,
} as const satisfies Record<ReturnError['code'], number>;

const settlement = {
  settlement: z.enum(['ADVANCE', 'REFUND']),
  refundMethod: method.optional(),
  refundReference: reference,
};

function sendPaymentError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ReturnError) {
    const notFound = err.code === 'NOT_FOUND';
    return reply.status(RETURN_STATUS[err.code]).send({
      error: {
        code: err.code,
        message: notFound ? 'Not found.' : err.message,
        requestId: request.id,
        ...(err.lineNo === undefined ? {} : { lineNo: err.lineNo }),
      },
    });
  }
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

  const canRefund = (request: FastifyRequest) => request.access?.permissions.has('refunds.approve') === true;

  app.post(
    '/api/businesses/:businessId/invoices/:id/cancel',
    {
      config: { permission: 'invoices.cancel' },
      schema: {
        params: idParams,
        body: z.strictObject({ reason, goods: z.enum(['NOT_TAKEN', 'RETURNED']), ...settlement }),
      },
    },
    guarded(async (request) => ({
      cancellation: await cancelInvoice(
        s.appDb,
        ctxOf(request),
        { canRefund: canRefund(request) },
        idOf(request),
        request.body as CancelInput,
        { requestId: request.id },
      ),
    })),
  );

  app.post(
    '/api/businesses/:businessId/invoices/:id/credit-notes',
    {
      config: { permission: 'credit_notes.create' },
      schema: {
        params: idParams,
        body: z.strictObject({
          reason,
          lines: z
            .array(
              z.strictObject({
                lineNo: z.number().int().min(1),
                quantity: z
                  .string()
                  .regex(/^\d{1,9}(\.\d{1,3})?$/)
                  .optional(),
              }),
            )
            .min(1)
            .max(100),
          ...settlement,
        }),
      },
    },
    guarded(async (request, reply) => {
      const note = await issueCreditNote(
        s.appDb,
        ctxOf(request),
        { canRefund: canRefund(request) },
        idOf(request),
        request.body as CreditNoteInput,
        { requestId: request.id },
      );
      return reply.status(201).send({ creditNote: note });
    }),
  );

  app.post(
    '/api/businesses/:businessId/invoices/:id/debit-notes',
    {
      config: { permission: 'credit_notes.create' },
      schema: {
        params: idParams,
        body: z.strictObject({
          reason,
          lines: z
            .array(z.strictObject({ lineNo: z.number().int().min(1), taxablePaise: paise.min(1) }))
            .min(1)
            .max(100),
        }),
      },
    },
    guarded(async (request, reply) => {
      const note = await issueDebitNote(
        s.appDb,
        ctxOf(request),
        idOf(request),
        request.body as { reason: string; lines: { lineNo: number; taxablePaise: number }[] },
        { requestId: request.id },
      );
      return reply.status(201).send({ debitNote: note });
    }),
  );
}
