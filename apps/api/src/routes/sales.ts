// Customers and document numbering (increment 5.2: FR-POS-4, FR-POS-5,
// FR-CRM-1 core, FR-TAX-2 AC2). Selling and invoices are added in 5.3.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createCustomer,
  CustomerError,
  findCustomerByMobile,
  getCustomer,
  searchCustomers,
  updateCustomer,
  type CustomerInput,
} from '@lbgos/modules/customers';
import { getNumbering, NumberingSettingsError, saveNumbering } from '@lbgos/modules/sales';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const customerFields = {
  name: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(6).max(20),
  email: z.email().max(200).nullable().optional(),
  address: optionalText(500),
  gstin: z.string().trim().max(15).nullable().optional(),
  stateCode: z
    .string()
    .regex(/^[0-9]{2}$/)
    .nullable()
    .optional(),
  notes: optionalText(2000),
};

export function sendSalesError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, body: Record<string, unknown>) =>
    reply.status(status).send({ error: { ...body, requestId: request.id } });
  if (err instanceof CustomerError) {
    if (err.code === 'NOT_FOUND') return send(404, { code: 'NOT_FOUND', message: 'Not found.' });
    if (err.code === 'DUPLICATE_MOBILE') {
      return send(409, { code: err.code, message: err.message, existingCustomerId: err.existingCustomerId });
    }
    return send(422, { code: err.code, message: err.message });
  }
  if (err instanceof NumberingSettingsError) return send(422, { code: err.code, message: err.message });
  return undefined;
}

export function registerSalesRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const handled = sendSalesError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };
  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });

  app.get(
    '/api/businesses/:businessId/customers',
    {
      config: { permission: 'customers.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({ q: z.string().max(80).optional(), mobile: z.string().max(20).optional() }),
      },
    },
    async (request) => {
      const q = request.query as { q?: string; mobile?: string };
      if (q.mobile) {
        const found = await findCustomerByMobile(s.appDb, ctxOf(request), q.mobile);
        return { customers: found ? [found] : [] };
      }
      return { customers: await searchCustomers(s.appDb, ctxOf(request), q.q ?? '') };
    },
  );

  app.post(
    '/api/businesses/:businessId/customers',
    {
      config: { permission: 'customers.manage' },
      schema: { params: businessParams, body: z.strictObject(customerFields) },
    },
    guarded(async (request, reply) => {
      const customer = await createCustomer(s.appDb, ctxOf(request), request.body as CustomerInput);
      return reply.status(201).send({ customer });
    }),
  );

  app.get(
    '/api/businesses/:businessId/customers/:id',
    { config: { permission: 'customers.view' }, schema: { params: idParams } },
    async (request, reply) => {
      const customer = await getCustomer(s.appDb, ctxOf(request), (request.params as { id: string }).id);
      return customer ? { customer } : notFound(request, reply);
    },
  );

  app.patch(
    '/api/businesses/:businessId/customers/:id',
    {
      config: { permission: 'customers.manage' },
      schema: { params: idParams, body: z.strictObject(customerFields).partial() },
    },
    guarded(async (request) => ({
      customer: await updateCustomer(
        s.appDb,
        ctxOf(request),
        (request.params as { id: string }).id,
        request.body as Partial<CustomerInput>,
      ),
    })),
  );

  app.get(
    '/api/businesses/:businessId/numbering',
    { config: { permission: 'business.settings.view' }, schema: { params: businessParams } },
    async (request) => getNumbering(s.appDb, ctxOf(request)),
  );

  app.put(
    '/api/businesses/:businessId/numbering',
    {
      config: { permission: 'tax.settings.manage', freshAuth: true },
      schema: {
        params: businessParams,
        body: z.strictObject({
          prefix: z.string().regex(/^[A-Z0-9/-]{0,6}$/, 'up to 6 of A–Z, 0–9, / or -'),
          numberFormat: z.string().min(7).max(40),
        }),
      },
    },
    guarded(async (request) =>
      saveNumbering(s.appDb, ctxOf(request), request.body as { prefix: string; numberFormat: string }, request.id),
    ),
  );
}
