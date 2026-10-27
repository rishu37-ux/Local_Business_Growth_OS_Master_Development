// Customers, document numbering (increment 5.2: FR-POS-4, FR-POS-5, FR-CRM-1
// core, FR-TAX-2 AC2), selling and invoices (increment 5.3: FR-POS-1…3,
// FR-INV-5 AC2–4, FR-LED-1).
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
import {
  createSaleDraft,
  discardSale,
  getInvoice,
  getNumbering,
  getPrintSettings,
  getSale,
  issueSale,
  listHeldSales,
  listInvoices,
  NumberingSettingsError,
  PAPER_SIZES,
  PrintSettingsError,
  renderDocumentHtml,
  requestDiscountApproval,
  SaleError,
  saveNumbering,
  savePrintSettings,
  updateSaleDraft,
  type IssueInput,
  type PaperSize,
  type SaleDraftInput,
  type SellerAccess,
} from '@lbgos/modules/sales';
import { PdfBusyError } from '../pdf.ts';
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

const paise = z.number().int().min(0).max(10_000_000_000_000);
const discount = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('PERCENT'), bp: z.number().int().min(0).max(10_000) }),
    z.strictObject({ kind: z.literal('AMOUNT'), paise }),
  ])
  .nullable()
  .optional();
const saleBody = z.strictObject({
  customerId: z.uuid().nullable().optional(),
  lines: z
    .array(
      z
        .strictObject({
          variantId: z.uuid().optional(),
          unitId: z.uuid().nullable().optional(),
          quantity: z
            .string()
            .regex(/^\d{1,9}(\.\d{1,3})?$/, 'a quantity with up to 3 decimals')
            .optional(),
          unitPricePaise: paise.optional(),
          discount,
        })
        .refine((l) => l.variantId !== undefined || l.unitId, { message: 'variantId or unitId is required' }),
    )
    .min(1)
    .max(100),
  invoiceDiscount: discount,
  notes: optionalText(1000),
});
const issueBody = z.strictObject({
  expectedTotalPaise: paise,
  payments: z
    .array(
      z.strictObject({
        method: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER']),
        amountPaise: paise.min(1),
        reference: z.string().trim().min(1).max(60).nullable().optional(),
        tenderedPaise: paise.nullable().optional(),
      }),
    )
    .max(10),
  useAdvancePaise: paise.optional(),
});

const SALE_STATUS = {
  NOT_FOUND: 404,
  NOT_DRAFT: 409,
  INVALID_LINE: 422,
  CUSTOMER_NOT_FOUND: 422,
  DISCOUNT_EXCEEDS_VALUE: 422,
  NOT_READY: 422,
  TOTAL_CHANGED: 409,
  PAYMENT_INVALID: 422,
  BALANCE_NEEDS_CUSTOMER: 422,
  OVERPAYMENT_NEEDS_CUSTOMER: 422,
  INSUFFICIENT_ADVANCE: 422,
  INSUFFICIENT_STOCK: 409,
  UNIT_NOT_AVAILABLE: 409,
  APPROVAL_NOT_NEEDED: 409,
  SERIES_EXHAUSTED: 409,
} as const satisfies Record<SaleError['code'], number>;

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
  if (err instanceof PrintSettingsError) return send(422, { code: err.code, message: err.message });
  if (err instanceof SaleError) {
    if (err.code === 'NOT_FOUND') return send(404, { code: 'NOT_FOUND', message: 'Not found.' });
    return send(SALE_STATUS[err.code], {
      code: err.code,
      message: err.message,
      ...(err.lineIndex === undefined ? {} : { lineIndex: err.lineIndex }),
      ...(err.problems ? { problems: err.problems } : {}),
    });
  }
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
  const sellerAccess = (request: FastifyRequest): SellerAccess => ({
    discount: request.access?.permissions.get('pos.discount'),
    priceOverride: request.access?.permissions.has('pos.price_override') === true,
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
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

  // Draft sales (carts). Held carts are drafts; they do not reserve stock.
  app.get(
    '/api/businesses/:businessId/sales',
    { config: { permission: 'pos.sell' }, schema: { params: businessParams } },
    async (request) => ({ sales: await listHeldSales(s.appDb, ctxOf(request)) }),
  );

  app.post(
    '/api/businesses/:businessId/sales',
    { config: { permission: 'pos.sell' }, schema: { params: businessParams, body: saleBody } },
    guarded(async (request, reply) => {
      const sale = await createSaleDraft(
        s.appDb,
        ctxOf(request),
        sellerAccess(request),
        request.body as SaleDraftInput,
      );
      return reply.status(201).send({ sale });
    }),
  );

  app.get(
    '/api/businesses/:businessId/sales/:id',
    { config: { permission: 'pos.sell' }, schema: { params: idParams } },
    guarded(async (request) => ({
      sale: await getSale(s.appDb, ctxOf(request), sellerAccess(request), idOf(request)),
    })),
  );

  app.put(
    '/api/businesses/:businessId/sales/:id',
    { config: { permission: 'pos.sell' }, schema: { params: idParams, body: saleBody } },
    guarded(async (request) => ({
      sale: await updateSaleDraft(
        s.appDb,
        ctxOf(request),
        sellerAccess(request),
        idOf(request),
        request.body as SaleDraftInput,
      ),
    })),
  );

  app.post(
    '/api/businesses/:businessId/sales/:id/discount-approval',
    {
      config: { permission: 'pos.sell' },
      schema: { params: idParams, body: z.strictObject({ reason: z.string().trim().min(10).max(500) }) },
    },
    guarded(async (request, reply) => {
      const created = await requestDiscountApproval(
        s.appDb,
        ctxOf(request),
        sellerAccess(request),
        idOf(request),
        (request.body as { reason: string }).reason,
      );
      return reply.status(201).send({ approvalRequest: created });
    }),
  );

  app.post(
    '/api/businesses/:businessId/sales/:id/issue',
    { config: { permission: 'pos.sell' }, schema: { params: idParams, body: issueBody } },
    guarded(async (request, reply) => {
      const issued = await issueSale(
        s.appDb,
        ctxOf(request),
        sellerAccess(request),
        idOf(request),
        request.body as IssueInput,
        { requestId: request.id },
      );
      return reply.status(201).send({ invoice: issued });
    }),
  );

  app.post(
    '/api/businesses/:businessId/sales/:id/discard',
    { config: { permission: 'pos.sell' }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      await discardSale(s.appDb, ctxOf(request), idOf(request));
      return reply.status(204).send();
    }),
  );

  // Issued documents. Seeing invoices is part of selling and of the customer ledger.
  app.get(
    '/api/businesses/:businessId/invoices',
    {
      config: { permission: 'customers.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          customerId: z.uuid().optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
        }),
      },
    },
    async (request) => {
      const q = request.query as { customerId?: string; from?: string; to?: string };
      return {
        invoices: await listInvoices(s.appDb, ctxOf(request), {
          customerId: q.customerId,
          ...(q.from ? { from: q.from } : {}),
          ...(q.to ? { to: q.to } : {}),
        }),
      };
    },
  );

  app.get(
    '/api/businesses/:businessId/invoices/:id',
    { config: { permission: 'customers.view' }, schema: { params: idParams } },
    async (request, reply) => {
      const invoice = await getInvoice(s.appDb, ctxOf(request), idOf(request), {
        canSeeCost: request.access?.permissions.has('catalogue.cost.view') === true,
      });
      return invoice ? { invoice } : notFound(request, reply);
    },
  );

  // Printed documents (FR-PRN-1, ADR-12). The print page has its own CSP: no
  // scripts at all, only its inline stylesheet.
  const PRINT_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  const paperQuery = z.strictObject({ size: z.enum(PAPER_SIZES).optional() });
  const printable = async (request: FastifyRequest) => {
    const ctx = ctxOf(request);
    const invoice = await getInvoice(s.appDb, ctx, idOf(request), { canSeeCost: false });
    const size = (request.query as { size?: PaperSize }).size ?? (await getPrintSettings(s.appDb, ctx)).printSize;
    return { invoice, size };
  };

  app.get(
    '/api/businesses/:businessId/print-settings',
    { config: { permission: 'business.settings.view' }, schema: { params: businessParams } },
    async (request) => ({ settings: await getPrintSettings(s.appDb, ctxOf(request)) }),
  );

  app.put(
    '/api/businesses/:businessId/print-settings',
    {
      config: { permission: 'business.settings.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          printSize: z.enum(PAPER_SIZES),
          address: optionalText(500),
          phone: z.string().trim().max(20).nullable().optional(),
          email: z.email().max(200).nullable().optional(),
          terms: optionalText(1000),
        }),
      },
    },
    guarded(async (request) => ({
      settings: await savePrintSettings(
        s.appDb,
        ctxOf(request),
        request.body as Parameters<typeof savePrintSettings>[2],
        request.id,
      ),
    })),
  );

  app.get(
    '/api/businesses/:businessId/invoices/:id/print',
    { config: { permission: 'customers.view' }, schema: { params: idParams, querystring: paperQuery } },
    async (request, reply) => {
      const { invoice, size } = await printable(request);
      if (!invoice) return notFound(request, reply);
      const base = `/api/businesses/${ctxOf(request).businessId}/invoices/${invoice.id}`;
      const html = renderDocumentHtml(invoice, {
        size,
        toolbar: { pdfHref: `${base}/pdf?size=${size}`, sizeHref: (p) => `${base}/print?size=${p}` },
      });
      return reply.header('content-security-policy', PRINT_CSP).type('text/html; charset=utf-8').send(html);
    },
  );

  app.get(
    '/api/businesses/:businessId/invoices/:id/pdf',
    { config: { permission: 'customers.view' }, schema: { params: idParams, querystring: paperQuery } },
    async (request, reply) => {
      if (!s.pdf) {
        return reply.status(503).send({
          error: { code: 'PDF_UNAVAILABLE', message: 'PDF download is not available.', requestId: request.id },
        });
      }
      const { invoice, size } = await printable(request);
      if (!invoice) return notFound(request, reply);
      let pdf: Buffer;
      try {
        pdf = await s.pdf.render(renderDocumentHtml(invoice, { size }), size);
      } catch (err) {
        if (err instanceof PdfBusyError) {
          return reply
            .status(503)
            .header('retry-after', '5')
            .send({ error: { code: 'PDF_BUSY', message: err.message, requestId: request.id } });
        }
        throw err;
      }
      const filename = `${(invoice.number ?? 'document').replace(/[^A-Za-z0-9-]/g, '-')}-${size}.pdf`;
      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .send(pdf);
    },
  );
}
