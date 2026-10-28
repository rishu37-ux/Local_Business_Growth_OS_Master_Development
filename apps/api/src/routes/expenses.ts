// Expenses (increment 6.4: FR-EXP-1, D-050). Off until the owner enables the
// module; entries are append-only and corrected by reversal.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  EXPENSE_CATEGORIES,
  ExpenseError,
  expenseSettings,
  getExpense,
  listExpenses,
  recordExpense,
  reverseExpense,
  setExpensesEnabled,
  type ExpenseInput,
} from '@lbgos/modules/expenses';
import { getUploadFile, OcrError, storeUpload } from '@lbgos/modules/ocr';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });

const STATUS = {
  MODULE_DISABLED: 409,
  NOT_FOUND: 404,
  DATE_INVALID: 422,
  ATTACHMENT_INVALID: 422,
  ALREADY_REVERSED: 409,
  NOT_REVERSIBLE: 409,
} as const satisfies Record<ExpenseError['code'], number>;

export function registerExpenseRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  /** Reading expenses needs expenses.manage but stays possible in read-only mode (D-009: data stays accessible). */
  const canRead = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.access?.permissions.has('expenses.manage') === true) return true;
    void fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
    return false;
  };
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (err instanceof ExpenseError) {
          const nf = err.code === 'NOT_FOUND';
          return fail(request, reply, STATUS[err.code], err.code, nf ? 'Not found.' : err.message);
        }
        if (err instanceof OcrError) return fail(request, reply, 422, err.code, err.message);
        throw err;
      }
    };
  const base = '/api/businesses/:businessId/expenses';

  app.get(
    `${base}/settings`,
    { config: { permission: 'business.settings.view' }, schema: { params: businessParams } },
    async (request) => ({ settings: await expenseSettings(s.appDb, ctxOf(request)) }),
  );

  app.put(
    `${base}/settings`,
    {
      config: { permission: 'business.settings.manage' },
      schema: { params: businessParams, body: z.strictObject({ enabled: z.boolean() }) },
    },
    async (request) => ({
      settings: await setExpensesEnabled(
        s.appDb,
        ctxOf(request),
        (request.body as { enabled: boolean }).enabled,
        request.id,
      ),
    }),
  );

  app.get(
    base,
    {
      config: { permission: MEMBER },
      schema: { params: businessParams, querystring: z.strictObject({ from: z.iso.date(), to: z.iso.date() }) },
    },
    async (request, reply) => {
      if (!canRead(request, reply)) return reply;
      return { expenses: await listExpenses(s.appDb, ctxOf(request), request.query as { from: string; to: string }) };
    },
  );

  app.post(
    base,
    {
      config: { permission: 'expenses.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          date: z.iso.date(),
          category: z.enum(EXPENSE_CATEGORIES),
          amountPaise: z.number().int().min(1).max(10_000_000_000_000),
          method: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER']),
          reference: z
            .string()
            .trim()
            .min(1)
            .max(60)
            .refine((v) => !/[0-9]{13,19}/.test(v), 'Do not enter card numbers.')
            .nullable()
            .optional(),
          notes: z.string().trim().min(1).max(500).nullable().optional(),
          uploadId: z.uuid().nullable().optional(),
        }),
      },
    },
    guarded(async (request, reply) =>
      reply
        .status(201)
        .send({ expense: await recordExpense(s.appDb, ctxOf(request), request.body as ExpenseInput, request.id) }),
    ),
  );

  app.post(
    `${base}/:id/reverse`,
    {
      config: { permission: 'expenses.manage' },
      schema: { params: idParams, body: z.strictObject({ reason: z.string().trim().min(10).max(500) }) },
    },
    guarded(async (request, reply) =>
      reply.status(201).send({
        reversal: await reverseExpense(
          s.appDb,
          ctxOf(request),
          idOf(request),
          (request.body as { reason: string }).reason,
          request.id,
        ),
      }),
    ),
  );

  // Receipts: same file checks and private storage as scans (needs upload storage configured).
  const ocr = s.ocr;
  if (!ocr) return;
  app.post(
    `${base}/attachments`,
    {
      config: { permission: 'expenses.manage' },
      bodyLimit: ocr.limits.maxBytes + 1024,
      schema: {
        params: businessParams,
        querystring: z.strictObject({ name: z.string().max(200).optional() }),
        body: z.instanceof(Buffer),
      },
    },
    guarded(async (request, reply) => {
      const ctx = ctxOf(request);
      if (!(await expenseSettings(s.appDb, ctx)).enabled) {
        return fail(request, reply, 409, 'MODULE_DISABLED', 'Expenses are not enabled for this shop.');
      }
      const uploadId = await storeUpload(
        s.appDb,
        ocr,
        ctx,
        {
          bytes: request.body as Buffer,
          originalName: (request.query as { name?: string }).name,
          purpose: 'expense',
        },
        request.id,
      );
      return reply.status(201).send({ uploadId });
    }),
  );

  app.get(
    `${base}/:id/attachment`,
    { config: { permission: MEMBER }, schema: { params: idParams } },
    async (request, reply) => {
      if (!canRead(request, reply)) return reply;
      const ctx = ctxOf(request);
      const e = await getExpense(s.appDb, ctx, idOf(request));
      const file = e?.uploadId ? await getUploadFile(s.appDb, ocr, ctx, e.uploadId) : null;
      if (!file) return fail(request, reply, 404, 'NOT_FOUND', 'Not found.');
      const inline = file.contentType.startsWith('image/');
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', inline ? 'inline' : 'attachment; filename="receipt.pdf"')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(file.bytes));
    },
  );
}
