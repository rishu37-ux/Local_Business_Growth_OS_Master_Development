// Suppliers and purchases (increment 4.2: FR-INV-3, FR-INV-5, FR-INV-8).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isIndianStateCode } from '@lbgos/domain';
import { z } from 'zod';
import {
  createPurchaseDraft,
  createSupplier,
  discardPurchase,
  getPurchase,
  getSupplier,
  listPurchases,
  listSuppliers,
  postPurchase,
  PurchasingError,
  reversePurchase,
  supplierLedger,
  updatePurchaseDraft,
  updateSupplier,
  type PurchaseDraftInput,
  type PurchaseStatus,
  type SupplierInput,
} from '@lbgos/modules/purchasing';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const supplierFields = {
  name: z.string().trim().min(1).max(120),
  gstin: z.string().trim().max(15).nullable().optional(),
  mobileE164: z
    .string()
    .regex(/^\+[1-9][0-9]{7,14}$/, 'international format, e.g. +919800000000')
    .nullable()
    .optional(),
  email: z.email().max(200).nullable().optional(),
  address: optionalText(500),
  stateCode: z.string().refine(isIndianStateCode, 'Choose a state or union territory of India.').nullable().optional(),
  paymentTerms: optionalText(200),
  notes: optionalText(2000),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
};
const supplierBody = z.strictObject(supplierFields);
const supplierPatch = z.strictObject(supplierFields).partial();

export const purchaseBody = z.strictObject({
  supplierId: z.uuid(),
  supplierInvoiceNo: z.string().trim().min(1).max(40),
  supplierInvoiceDate: z.iso.date(),
  supplierTotalPaise: z.number().int().min(0).max(10_000_000_000_000).nullable().optional(),
  notes: optionalText(2000),
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'a quantity with up to 3 decimals'),
        unitCostPaise: z.number().int().min(0).max(10_000_000_000_000),
        taxRateId: z.uuid().nullable().optional(),
        units: z
          .array(
            z.strictObject({
              imei1: z.string().trim().max(20).nullable().optional(),
              imei2: z.string().trim().max(20).nullable().optional(),
              serialNumber: z.string().trim().max(60).nullable().optional(),
            }),
          )
          .max(1000)
          .optional(),
      }),
    )
    .max(500),
});

const reason = z.string().trim().min(10).max(500);

function sendPurchasingError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (!(err instanceof PurchasingError)) return undefined;
  const status = {
    NOT_FOUND: 404,
    GSTIN_INVALID: 422,
    INVALID_LINE: 422,
    NOT_DRAFT: 409,
    NOT_POSTED: 409,
    BLOCKING_PROBLEMS: 422,
    DUPLICATE_SUPPLIER_INVOICE: 409,
    IMEI_TAKEN: 409,
    REVERSAL_BLOCKED: 409,
    INSUFFICIENT_STOCK: 409,
  }[err.code];
  return reply.status(status).send({
    error: {
      code: err.code,
      message: err.code === 'NOT_FOUND' ? 'Not found.' : err.message,
      requestId: request.id,
      ...(err.field ? { field: err.field } : {}),
      ...(err.problems.length > 0 ? { problems: err.problems } : {}),
    },
  });
}

export function registerPurchasingRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const handled = sendPurchasingError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };

  app.get(
    '/api/businesses/:businessId/suppliers',
    {
      config: { permission: 'suppliers.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({ includeArchived: z.enum(['true', 'false']).optional() }),
      },
    },
    async (request) => ({
      suppliers: await listSuppliers(
        s.appDb,
        ctxOf(request),
        (request.query as { includeArchived?: string }).includeArchived === 'true',
      ),
    }),
  );

  app.post(
    '/api/businesses/:businessId/suppliers',
    { config: { permission: 'suppliers.manage' }, schema: { params: businessParams, body: supplierBody } },
    guarded(async (request, reply) => {
      const id = await createSupplier(s.appDb, ctxOf(request), request.body as SupplierInput);
      return reply.status(201).send({ id });
    }),
  );

  app.get(
    '/api/businesses/:businessId/suppliers/:id',
    { config: { permission: 'suppliers.view' }, schema: { params: idParams } },
    async (request, reply) => {
      const supplier = await getSupplier(s.appDb, ctxOf(request), idOf(request));
      return supplier ? { supplier } : notFound(request, reply);
    },
  );

  app.patch(
    '/api/businesses/:businessId/suppliers/:id',
    { config: { permission: 'suppliers.manage' }, schema: { params: idParams, body: supplierPatch } },
    guarded(async (request, reply) => {
      await updateSupplier(s.appDb, ctxOf(request), idOf(request), request.body as Partial<SupplierInput>);
      return reply.status(204).send();
    }),
  );

  app.get(
    '/api/businesses/:businessId/suppliers/:id/ledger',
    { config: { permission: 'purchases.view' }, schema: { params: idParams } },
    async (request, reply) => {
      const ledger = await supplierLedger(s.appDb, ctxOf(request), idOf(request));
      return ledger ?? notFound(request, reply);
    },
  );

  app.get(
    '/api/businesses/:businessId/purchases',
    {
      config: { permission: 'purchases.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          status: z.enum(['DRAFT', 'POSTED', 'REVERSED', 'DISCARDED']).optional(),
          supplierId: z.uuid().optional(),
        }),
      },
    },
    async (request) => {
      const q = request.query as { status?: PurchaseStatus; supplierId?: string };
      return { purchases: await listPurchases(s.appDb, ctxOf(request), q) };
    },
  );

  app.post(
    '/api/businesses/:businessId/purchases',
    { config: { permission: 'purchases.create' }, schema: { params: businessParams, body: purchaseBody } },
    guarded(async (request, reply) => {
      const id = await createPurchaseDraft(s.appDb, ctxOf(request), request.body as PurchaseDraftInput);
      return reply.status(201).send({ id });
    }),
  );

  app.get(
    '/api/businesses/:businessId/purchases/:id',
    { config: { permission: 'purchases.view' }, schema: { params: idParams } },
    async (request, reply) => {
      const purchase = await getPurchase(
        s.appDb,
        ctxOf(request),
        idOf(request),
        request.access?.permissions.has('inventory.view') === true,
      );
      return purchase ? { purchase } : notFound(request, reply);
    },
  );

  app.put(
    '/api/businesses/:businessId/purchases/:id',
    { config: { permission: 'purchases.create' }, schema: { params: idParams, body: purchaseBody } },
    guarded(async (request, reply) => {
      await updatePurchaseDraft(s.appDb, ctxOf(request), idOf(request), request.body as PurchaseDraftInput);
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/businesses/:businessId/purchases/:id/discard',
    { config: { permission: 'purchases.create' }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      await discardPurchase(s.appDb, ctxOf(request), idOf(request));
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/businesses/:businessId/purchases/:id/post',
    {
      config: { permission: 'purchases.post' },
      schema: { params: idParams, body: z.strictObject({ overrideReason: reason.optional() }) },
    },
    guarded(async (request) => {
      const body = request.body as { overrideReason?: string };
      return {
        purchase: await postPurchase(s.appDb, ctxOf(request), idOf(request), {
          overrideReason: body.overrideReason,
          requestId: request.id,
        }),
      };
    }),
  );

  app.post(
    '/api/businesses/:businessId/purchases/:id/reverse',
    { config: { permission: 'purchases.post' }, schema: { params: idParams, body: z.strictObject({ reason }) } },
    guarded(async (request, reply) => {
      await reversePurchase(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.body as { reason: string }).reason,
        request.id,
      );
      return reply.status(204).send();
    }),
  );
}
