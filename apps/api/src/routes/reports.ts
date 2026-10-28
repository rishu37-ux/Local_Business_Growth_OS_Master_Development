// Reports and exports (increment 5.7: FR-RPT-1…4, FR-LED-3, D-045).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  auditExport,
  campaignResults,
  dashboard,
  exportReport,
  expensesReport,
  LIST_EXPORTS,
  listExport,
  ListExportError,
  marginSummary,
  operatingProfit,
  paymentMethodSummary,
  receivablesAgeing,
  repeatCustomers,
  REPORTS,
  ReportError,
  reportTable,
  returnsReport,
  salesByItem,
  salesSummary,
  salesTrend,
  shopName,
  stockValuation,
  taxSummary,
  toReportHtml,
  type ExportTable,
  type ListName,
  type PeriodRequest,
  type ReportName,
} from '@lbgos/modules/reports';
import { customerStatement, PaymentError } from '@lbgos/modules/sales';
import { PdfBusyError } from '../pdf.ts';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const periodFields = {
  period: z.enum(['day', 'week', 'month', 'year', 'fy', 'custom']).default('month'),
  date: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};
const periodQuery = z
  .strictObject(periodFields)
  .refine((q) => q.period !== 'custom' || (q.from !== undefined && q.to !== undefined), {
    message: 'from and to are required for a custom period',
  });
const groupBy = z.enum(['brand', 'model', 'variant']).default('model');
const trendQuery = z.strictObject({
  weeks: z.coerce.number().int().min(1).max(52).optional(),
  date: z.iso.date().optional(),
});

type PeriodQuery = z.infer<typeof periodQuery>;

const toPeriod = (q: PeriodQuery): PeriodRequest =>
  q.period === 'custom' ? { kind: 'custom', from: q.from ?? '', to: q.to ?? '' } : { kind: q.period, date: q.date };

export function registerReportRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const has = (request: FastifyRequest, key: string) => request.access?.permissions.has(key) === true;
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (err instanceof ReportError) return fail(request, reply, 400, err.code, err.message);
        if (err instanceof PaymentError) {
          const nf = err.code === 'CUSTOMER_NOT_FOUND';
          return fail(request, reply, nf ? 404 : 400, nf ? 'NOT_FOUND' : err.code, nf ? 'Not found.' : err.message);
        }
        throw err;
      }
    };

  /** Runs a report by name (permission already checked). */
  const run = async (request: FastifyRequest, name: ReportName) => {
    const ctx = ctxOf(request);
    const q = request.query as PeriodQuery & { groupBy?: 'brand' | 'model' | 'variant'; weeks?: number };
    switch (name) {
      case 'sales-summary':
        return salesSummary(s.appDb, ctx, toPeriod(q));
      case 'sales-by-item':
        return salesByItem(s.appDb, ctx, toPeriod(q), {
          groupBy: q.groupBy ?? 'model',
          withMargin: has(request, 'reports.financial.view'),
        });
      case 'margin':
        return marginSummary(s.appDb, ctx, toPeriod(q));
      case 'receivables':
        return receivablesAgeing(s.appDb, ctx);
      case 'payments':
        return paymentMethodSummary(s.appDb, ctx, toPeriod(q));
      case 'returns':
        return returnsReport(s.appDb, ctx, toPeriod(q));
      case 'tax':
        return taxSummary(s.appDb, ctx, toPeriod(q));
      case 'stock-valuation':
        return stockValuation(s.appDb, ctx);
      case 'expenses':
        return expensesReport(s.appDb, ctx, toPeriod(q));
      case 'operating-profit':
        return operatingProfit(s.appDb, ctx, toPeriod(q));
      case 'sales-trend':
        return salesTrend(s.appDb, ctx, { weeks: q.weeks ?? 12, ...(q.date ? { date: q.date } : {}) });
      case 'repeat-customers':
        return repeatCustomers(s.appDb, ctx, toPeriod(q));
      case 'campaign-results':
        return campaignResults(s.appDb, ctx, toPeriod(q));
    }
  };

  // FR-LED-3 AC1: overview tiles from the report functions; each needs its report's permission.
  app.get(
    '/api/businesses/:businessId/dashboard',
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    async (request) => ({ dashboard: await dashboard(s.appDb, ctxOf(request), (key) => has(request, key)) }),
  );

  for (const [name, spec] of Object.entries(REPORTS) as [ReportName, (typeof REPORTS)[ReportName]][]) {
    const querystring =
      name === 'sales-by-item'
        ? z.strictObject({ ...periodFields, groupBy: groupBy.optional() })
        : name === 'receivables' || name === 'stock-valuation'
          ? z.strictObject({})
          : name === 'sales-trend'
            ? trendQuery
            : periodQuery;
    app.get(
      `/api/businesses/:businessId/reports/${name}`,
      { config: { permission: spec.permission }, schema: { params: businessParams, querystring } },
      guarded(async (request) => ({ report: await run(request, name) })),
    );
  }

  const sendFile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    table: ExportTable,
    format: 'csv' | 'xlsx' | 'pdf',
    basename: string,
  ) => {
    let body: Buffer;
    let type: string;
    if (format === 'pdf') {
      if (!s.pdf) return fail(request, reply, 503, 'PDF_UNAVAILABLE', 'PDF export is not available.');
      try {
        body = await s.pdf.render(toReportHtml(table), 'A4');
      } catch (err) {
        if (err instanceof PdfBusyError) return fail(request, reply, 503, 'PDF_BUSY', err.message);
        throw err;
      }
      type = 'application/pdf';
    } else {
      const out = exportReport(table, format);
      body = out.body;
      type = out.contentType;
    }
    return reply
      .type(type)
      .header('content-disposition', `attachment; filename="${basename.replace(/[^A-Za-z0-9-]/g, '-')}.${format}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);
  };

  app.get(
    '/api/businesses/:businessId/reports/:report/export',
    {
      config: { permission: 'reports.export' },
      schema: {
        params: z.strictObject({
          businessId: z.uuid(),
          report: z.enum(Object.keys(REPORTS) as [ReportName, ...ReportName[]]),
        }),
        querystring: z.strictObject({
          ...periodFields,
          groupBy: groupBy.optional(),
          weeks: z.coerce.number().int().min(1).max(52).optional(),
          format: z.enum(['csv', 'xlsx', 'pdf']),
        }),
      },
    },
    guarded(async (request, reply) => {
      const name = (request.params as { report: ReportName }).report;
      const q = request.query as PeriodQuery & { format: 'csv' | 'xlsx' | 'pdf' };
      const spec = REPORTS[name];
      // Exporting needs the report's own permission as well (ROLES_PERMISSIONS: reports.export).
      if (!has(request, spec.permission))
        return fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      if (!spec.formats.includes(q.format))
        return fail(
          request,
          reply,
          400,
          'FORMAT_UNAVAILABLE',
          `This report is not available as ${q.format.toUpperCase()}.`,
        );
      if (q.period === 'custom' && (!q.from || !q.to))
        return fail(request, reply, 400, 'INVALID_PERIOD', 'from and to are required for a custom period');
      const ctx = ctxOf(request);
      const result = await run(request, name);
      const table = reportTable(name, result, await shopName(s.appDb, ctx));
      const period = 'period' in result ? result.period : null;
      await auditExport(
        s.appDb,
        ctx,
        { report: name, format: q.format, ...(period ? { from: period.from, to: period.to } : {}) },
        request.id,
      );
      return sendFile(request, reply, table, q.format, `${name}-${period ? `${period.from}-${period.to}` : 'now'}`);
    }),
  );

  // List exports of the dashboard's sections (Phase 14, D-073): reports.export plus the section's own permission.
  app.get(
    '/api/businesses/:businessId/exports/:list',
    {
      config: { permission: 'reports.export' },
      schema: {
        params: z.strictObject({
          businessId: z.uuid(),
          list: z.enum(Object.keys(LIST_EXPORTS) as [ListName, ...ListName[]]),
        }),
        querystring: z.strictObject({
          format: z.enum(['csv', 'xlsx']),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
        }),
      },
    },
    async (request, reply) => {
      const name = (request.params as { list: ListName }).list;
      const q = request.query as { format: 'csv' | 'xlsx'; from?: string; to?: string };
      const spec = LIST_EXPORTS[name];
      if (!spec.anyOf.some((p) => has(request, p)))
        return fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      if ((q.from === undefined) !== (q.to === undefined) || (q.from && q.to && q.from > q.to))
        return fail(request, reply, 400, 'INVALID_PERIOD', 'Give both from and to, with from not after to.');
      const ctx = ctxOf(request);
      let table: ExportTable;
      try {
        table = await listExport(s.appDb, ctx, name, {
          from: spec.dated ? q.from : undefined,
          to: spec.dated ? q.to : undefined,
          canSeeCost: has(request, 'catalogue.cost.view'),
          canSeeBuyer: has(request, 'customers.view'),
        });
      } catch (err) {
        if (err instanceof ListExportError) return fail(request, reply, 413, err.code, err.message);
        throw err;
      }
      await auditExport(
        s.appDb,
        ctx,
        {
          report: `list:${name}`,
          format: q.format,
          ...(spec.dated && q.from && q.to ? { from: q.from, to: q.to } : {}),
        },
        request.id,
      );
      return sendFile(request, reply, table, q.format, `${name}${q.from && q.to ? `-${q.from}-${q.to}` : ''}`);
    },
  );

  // Customer statement export (FR-LED-1 AC3, FR-RPT-4 AC1: PDF for ledger statements).
  app.get(
    '/api/businesses/:businessId/customers/:id/statement/export',
    {
      config: { permission: 'reports.export' },
      schema: {
        params: z.strictObject({ businessId: z.uuid(), id: z.uuid() }),
        querystring: z.strictObject({ from: z.iso.date(), to: z.iso.date(), format: z.enum(['csv', 'pdf']) }),
      },
    },
    guarded(async (request, reply) => {
      if (!has(request, 'customer_ledger.view'))
        return fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      const ctx = ctxOf(request);
      const q = request.query as { from: string; to: string; format: 'csv' | 'pdf' };
      const id = (request.params as { id: string }).id;
      const st = await customerStatement(s.appDb, ctx, id, q.from, q.to);
      const table: ExportTable = {
        title: 'Customer statement',
        subtitle: `${q.from} to ${q.to} · ${await shopName(s.appDb, ctx)}`,
        columns: [
          { key: 'date', label: 'Date', kind: 'text' },
          { key: 'type', label: 'Entry', kind: 'text' },
          { key: 'document', label: 'Document', kind: 'text' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'balancePaise', label: 'Balance', kind: 'money' },
        ],
        rows: [
          { date: q.from, type: 'Opening balance', document: null, amountPaise: null, balancePaise: st.openingPaise },
          ...st.entries.map((e) => ({
            date: e.date,
            type: e.type.charAt(0) + e.type.slice(1).toLowerCase().replaceAll('_', ' '),
            document: e.document,
            amountPaise: e.amountPaise,
            balancePaise: e.balancePaise,
          })),
        ],
        totals: {
          date: q.to,
          type: 'Closing balance',
          document: null,
          amountPaise: null,
          balancePaise: st.closingPaise,
        },
        notes: ['Positive balance: the customer owes the shop. Negative balance: advance held for the customer.'],
      };
      await auditExport(
        s.appDb,
        ctx,
        { report: 'customer-statement', format: q.format, from: q.from, to: q.to },
        request.id,
      );
      return sendFile(request, reply, table, q.format, `statement-${q.from}-${q.to}`);
    }),
  );
}
