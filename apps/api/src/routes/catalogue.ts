// Catalogue and tax rates (increment 4.1: FR-INV-1, FR-INV-2, FR-TAX-2).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CatalogueError,
  closeTaxRate,
  createNamed,
  createProduct,
  createTaxRate,
  createVariant,
  deleteNamed,
  deleteProduct,
  deleteVariant,
  getProduct,
  listNamed,
  listProducts,
  listTaxRates,
  updateNamed,
  updateProduct,
  updateVariant,
  type ProductInput,
  type VariantInput,
} from '@lbgos/modules/catalogue';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });

const paise = z.number().int().min(0).max(10_000_000_000_000);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const status = z.enum(['ACTIVE', 'ARCHIVED']);

const variantFields = {
  sku: z.string().regex(/^[A-Za-z0-9._/-]{1,40}$/, 'letters, digits and . _ / - only (max 40)'),
  barcode: z
    .string()
    .regex(/^[\x21-\x7e]{1,48}$/, 'printable characters without spaces (max 48)')
    .nullable()
    .optional(),
  ram: optionalText(20),
  storage: optionalText(20),
  colour: optionalText(40),
  uom: z.string().trim().min(1).max(10).optional(),
  sellingPricePaise: paise,
  minSellingPricePaise: paise.nullable().optional(),
  purchasePricePaise: paise.nullable().optional(),
  priceIncludesTax: z.boolean().optional(),
  taxRateId: z.uuid().nullable().optional(),
  hsnCode: z
    .string()
    .regex(/^[0-9]{4,8}$/, '4 to 8 digits')
    .nullable()
    .optional(),
  reorderLevel: z.number().int().min(0).max(1_000_000).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(240).nullable().optional(),
  warrantyProvider: optionalText(120),
  defaultSupplierId: z.uuid().nullable().optional(),
  status: status.optional(),
};
const variantBody = z.strictObject(variantFields);
const variantPatch = z.strictObject(variantFields).partial();

const productFields = {
  categoryId: z.uuid().nullable().optional(),
  brandId: z.uuid().nullable().optional(),
  modelName: z.string().trim().min(1).max(120),
  modelNumber: optionalText(60),
  description: optionalText(2000),
  isSerialized: z.boolean(),
  status: status.optional(),
};
const productBody = z.strictObject({ ...productFields, variants: z.array(variantBody).max(50).optional() });
const productPatch = z.strictObject(productFields).partial();

const namedBody = z.strictObject({ name: z.string().trim().min(1).max(80) });
const namedPatch = z.strictObject({ name: z.string().trim().min(1).max(80).optional(), status: status.optional() });

const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'a percentage with up to 2 decimals')
  .refine((v) => Number(v) <= 100, 'at most 100');
const taxRateBody = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    ratePercent: percent,
    cessPercent: percent.optional(),
    effectiveFrom: z.iso.date(),
    effectiveTo: z.iso.date().nullable().optional(),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: 'must not be before effectiveFrom',
    path: ['effectiveTo'],
  });

function sendCatalogueError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (!(err instanceof CatalogueError)) return undefined;
  const status = {
    NOT_FOUND: 404,
    IN_USE: 409,
    DUPLICATE: 409,
    INVALID_REFERENCE: 422,
    COST_FORBIDDEN: 403,
    INVALID_INPUT: 422,
  }[err.code];
  const message = err.code === 'NOT_FOUND' ? 'Not found.' : err.message;
  return reply.status(status).send({
    error: { code: err.code, message, requestId: request.id, ...(err.field ? { field: err.field } : {}) },
  });
}

export function registerCatalogueRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const canSeeCost = (request: FastifyRequest) => request.access?.permissions.has('catalogue.cost.view') === true;
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const handled = sendCatalogueError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };

  for (const table of ['categories', 'brands'] as const) {
    const base = `/api/businesses/:businessId/${table}`;
    app.get(
      base,
      { config: { permission: 'catalogue.view' }, schema: { params: businessParams } },
      async (request) => ({
        [table]: await listNamed(s.appDb, ctxOf(request), table),
      }),
    );
    app.post(
      base,
      { config: { permission: 'catalogue.manage' }, schema: { params: businessParams, body: namedBody } },
      guarded(async (request, reply) => {
        const id = await createNamed(s.appDb, ctxOf(request), table, (request.body as { name: string }).name);
        return reply.status(201).send({ id });
      }),
    );
    app.patch(
      `${base}/:id`,
      { config: { permission: 'catalogue.manage' }, schema: { params: idParams, body: namedPatch } },
      guarded(async (request, reply) => {
        await updateNamed(s.appDb, ctxOf(request), table, idOf(request), request.body as z.infer<typeof namedPatch>);
        return reply.status(204).send();
      }),
    );
    app.delete(
      `${base}/:id`,
      { config: { permission: 'catalogue.manage' }, schema: { params: idParams } },
      guarded(async (request, reply) => {
        await deleteNamed(s.appDb, ctxOf(request), table, idOf(request));
        return reply.status(204).send();
      }),
    );
  }

  app.get(
    '/api/businesses/:businessId/products',
    {
      config: { permission: 'catalogue.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          includeArchived: z.enum(['true', 'false']).optional(),
          q: z.string().max(80).optional(),
        }),
      },
    },
    async (request) => {
      const query = request.query as { includeArchived?: string; q?: string };
      return {
        products: await listProducts(s.appDb, ctxOf(request), {
          includeArchived: query.includeArchived === 'true',
          ...(query.q ? { search: query.q } : {}),
        }),
      };
    },
  );

  app.post(
    '/api/businesses/:businessId/products',
    { config: { permission: 'catalogue.manage' }, schema: { params: businessParams, body: productBody } },
    guarded(async (request, reply) => {
      const body = request.body as ProductInput & { variants?: VariantInput[] };
      return reply.status(201).send(await createProduct(s.appDb, ctxOf(request), body, canSeeCost(request)));
    }),
  );

  app.get(
    '/api/businesses/:businessId/products/:id',
    { config: { permission: 'catalogue.view' }, schema: { params: idParams } },
    async (request, reply) => {
      const product = await getProduct(s.appDb, ctxOf(request), idOf(request), canSeeCost(request));
      if (!product)
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
      return { product };
    },
  );

  app.patch(
    '/api/businesses/:businessId/products/:id',
    { config: { permission: 'catalogue.manage' }, schema: { params: idParams, body: productPatch } },
    guarded(async (request, reply) => {
      await updateProduct(s.appDb, ctxOf(request), idOf(request), request.body as Partial<ProductInput>);
      return reply.status(204).send();
    }),
  );

  app.delete(
    '/api/businesses/:businessId/products/:id',
    { config: { permission: 'catalogue.manage' }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      await deleteProduct(s.appDb, ctxOf(request), idOf(request));
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/businesses/:businessId/products/:id/variants',
    { config: { permission: 'catalogue.manage' }, schema: { params: idParams, body: variantBody } },
    guarded(async (request, reply) => {
      const id = await createVariant(
        s.appDb,
        ctxOf(request),
        idOf(request),
        request.body as VariantInput,
        canSeeCost(request),
      );
      return reply.status(201).send({ id });
    }),
  );

  app.patch(
    '/api/businesses/:businessId/variants/:id',
    { config: { permission: 'catalogue.manage' }, schema: { params: idParams, body: variantPatch } },
    guarded(async (request, reply) => {
      await updateVariant(
        s.appDb,
        ctxOf(request),
        idOf(request),
        request.body as Partial<VariantInput>,
        canSeeCost(request),
      );
      return reply.status(204).send();
    }),
  );

  app.delete(
    '/api/businesses/:businessId/variants/:id',
    { config: { permission: 'catalogue.manage' }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      await deleteVariant(s.appDb, ctxOf(request), idOf(request));
      return reply.status(204).send();
    }),
  );

  app.get(
    '/api/businesses/:businessId/tax-rates',
    { config: { permission: 'catalogue.view' }, schema: { params: businessParams } },
    async (request) => ({ taxRates: await listTaxRates(s.appDb, ctxOf(request)) }),
  );

  app.post(
    '/api/businesses/:businessId/tax-rates',
    {
      config: { permission: 'tax.settings.manage', freshAuth: true },
      schema: { params: businessParams, body: taxRateBody },
    },
    guarded(async (request, reply) => {
      const id = await createTaxRate(s.appDb, ctxOf(request), request.body as z.infer<typeof taxRateBody>, request.id);
      return reply.status(201).send({ id });
    }),
  );

  app.post(
    '/api/businesses/:businessId/tax-rates/:id/close',
    {
      config: { permission: 'tax.settings.manage', freshAuth: true },
      schema: { params: idParams, body: z.strictObject({ effectiveTo: z.iso.date() }) },
    },
    guarded(async (request, reply) => {
      await closeTaxRate(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.body as { effectiveTo: string }).effectiveTo,
        request.id,
      );
      return reply.status(204).send();
    }),
  );
}
