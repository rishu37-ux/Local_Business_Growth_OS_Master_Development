// Reports as tables for export (FR-RPT-4): the same rows the API returns,
// with column types, notes and metric definitions.
import { METRICS, type DateRange, type MetricKey } from '@lbgos/domain';
import type { ExportColumn, ExportTable } from './export.ts';
import type {
  expensesReport,
  marginSummary,
  operatingProfit,
  paymentMethodSummary,
  receivablesAgeing,
  returnsReport,
  salesByItem,
  salesSummary,
  stockValuation,
  taxSummary,
} from './index.ts';

type Result<F extends (...a: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export type ReportName =
  | 'sales-summary'
  | 'sales-by-item'
  | 'margin'
  | 'receivables'
  | 'payments'
  | 'returns'
  | 'tax'
  | 'stock-valuation'
  | 'expenses'
  | 'operating-profit';

/** Which formats each report offers (FR-RPT-4 AC1) and the permission needed to see it. */
export const REPORTS: Readonly<
  Record<ReportName, { readonly formats: readonly ('csv' | 'xlsx' | 'pdf')[]; readonly permission: string }>
> = {
  'sales-summary': { formats: ['csv', 'xlsx', 'pdf'], permission: 'reports.sales.view' },
  'sales-by-item': { formats: ['csv', 'xlsx'], permission: 'reports.sales.view' },
  margin: { formats: ['csv', 'xlsx'], permission: 'reports.financial.view' },
  receivables: { formats: ['csv', 'xlsx'], permission: 'reports.financial.view' },
  payments: { formats: ['csv', 'xlsx'], permission: 'reports.sales.view' },
  returns: { formats: ['csv', 'xlsx'], permission: 'reports.sales.view' },
  tax: { formats: ['csv', 'xlsx', 'pdf'], permission: 'reports.sales.view' },
  'stock-valuation': { formats: ['csv', 'xlsx'], permission: 'reports.financial.view' },
  expenses: { formats: ['csv', 'xlsx', 'pdf'], permission: 'reports.financial.view' },
  'operating-profit': { formats: ['csv', 'xlsx', 'pdf'], permission: 'reports.financial.view' },
};

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  RENT: 'Rent',
  SALARIES: 'Salaries',
  ELECTRICITY: 'Electricity',
  INTERNET_PHONE: 'Internet and phone',
  TRANSPORT: 'Transport',
  REPAIRS_MAINTENANCE: 'Repairs and maintenance',
  MARKETING: 'Marketing',
  SUPPLIES: 'Supplies',
  BANK_CHARGES: 'Bank charges',
  TAXES_FEES: 'Taxes and fees',
  OTHER: 'Other',
};
const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c;

const col = (key: string, label: string, kind: ExportColumn['kind'] = 'text'): ExportColumn => ({ key, label, kind });
const range = (p: DateRange) => (p.from === p.to ? p.from : `${p.from} to ${p.to}`);
const defs = (d: Partial<Record<MetricKey, { label: string; definition: string }>>) => Object.values(d);

export function reportTable(name: 'sales-summary', r: Result<typeof salesSummary>, shop: string): ExportTable;
export function reportTable(name: 'sales-by-item', r: Result<typeof salesByItem>, shop: string): ExportTable;
export function reportTable(name: 'margin', r: Result<typeof marginSummary>, shop: string): ExportTable;
export function reportTable(name: 'receivables', r: Result<typeof receivablesAgeing>, shop: string): ExportTable;
export function reportTable(name: 'payments', r: Result<typeof paymentMethodSummary>, shop: string): ExportTable;
export function reportTable(name: 'returns', r: Result<typeof returnsReport>, shop: string): ExportTable;
export function reportTable(name: 'tax', r: Result<typeof taxSummary>, shop: string): ExportTable;
export function reportTable(name: 'stock-valuation', r: Result<typeof stockValuation>, shop: string): ExportTable;
export function reportTable(name: 'expenses', r: Result<typeof expensesReport>, shop: string): ExportTable;
export function reportTable(name: 'operating-profit', r: Result<typeof operatingProfit>, shop: string): ExportTable;
export function reportTable(name: ReportName, r: unknown, shop: string): ExportTable;
export function reportTable(name: ReportName, result: unknown, shop: string): ExportTable {
  switch (name) {
    case 'sales-summary': {
      const r = result as Result<typeof salesSummary>;
      return {
        title: 'Sales summary',
        subtitle: `${range(r.period)} (previous: ${range(r.period.previous)}) · ${shop}`,
        columns: [
          col('date', 'Date'),
          col('invoiceCount', 'Invoices', 'int'),
          col('grossSalesPaise', METRICS.grossSales.label, 'money'),
          col('returnsPaise', METRICS.returns.label, 'money'),
          col('netSalesPaise', METRICS.netSales.label, 'money'),
        ],
        rows: r.days.map((d) => ({ ...d })),
        totals: {
          date: 'Total',
          invoiceCount: r.current.invoiceCount,
          grossSalesPaise: r.current.grossSalesPaise,
          returnsPaise: r.current.returnsPaise,
          netSalesPaise: r.current.netSalesPaise,
        },
        notes: [
          `Taxable value ₹${(r.current.taxableValuePaise / 100).toFixed(2)}; tax collected ₹${(r.current.taxCollectedPaise / 100).toFixed(2)}.`,
          `Previous period: net sales ₹${(r.previous.netSalesPaise / 100).toFixed(2)} from ${String(r.previous.invoiceCount)} invoices.`,
        ],
        definitions: defs(r.definitions),
      };
    }
    case 'sales-by-item': {
      const r = result as Result<typeof salesByItem>;
      const margin = r.rows.some((x) => 'cogsPaise' in x);
      return {
        title: `Sales by ${r.groupBy}`,
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [
          col('name', r.groupBy === 'brand' ? 'Brand' : r.groupBy === 'model' ? 'Model' : 'Variant'),
          col('quantity', 'Quantity', 'qty'),
          col('netSalesPaise', METRICS.netSales.label, 'money'),
          col('taxableValuePaise', METRICS.taxableValue.label, 'money'),
          ...(margin
            ? [
                col('cogsPaise', METRICS.cogs.label, 'money'),
                col('grossMarginPaise', METRICS.grossMargin.label, 'money'),
              ]
            : []),
        ],
        rows: r.rows.map((x) => ({ ...x })),
        definitions: defs(r.definitions),
      };
    }
    case 'margin': {
      const r = result as Result<typeof marginSummary>;
      return {
        title: 'Gross margin',
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [col('metric', 'Metric'), col('amount', 'Amount', 'money')],
        rows: [
          { metric: METRICS.taxableValue.label, amount: r.taxableValuePaise },
          { metric: METRICS.cogs.label, amount: r.cogsPaise },
          { metric: METRICS.grossMargin.label, amount: r.grossMarginPaise },
        ],
        notes: [
          r.grossMarginBp === null
            ? 'No sales in the period.'
            : `Gross margin ${(r.grossMarginBp / 100).toFixed(2)}% of taxable value.`,
          ...(r.linesWithoutCost > 0
            ? [`${String(r.linesWithoutCost)} sold line(s) had no recorded cost and count as cost 0.`]
            : []),
        ],
        definitions: defs(r.definitions),
      };
    }
    case 'expenses': {
      const r = result as Result<typeof expensesReport>;
      return {
        title: 'Expenses',
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [col('category', 'Category'), col('count', 'Entries', 'int'), col('amountPaise', 'Amount', 'money')],
        rows: r.byCategory.map((c) => ({ ...c, category: categoryLabel(c.category) })),
        totals: { category: 'Total', count: r.byCategory.reduce((t, c) => t + c.count, 0), amountPaise: r.totalPaise },
        notes: [
          'Corrected entries are shown net of their reversals.',
          ...(r.enabled ? [] : ['Expenses are not enabled for this shop.']),
        ],
        definitions: defs(r.definitions),
      };
    }
    case 'operating-profit': {
      const r = result as Result<typeof operatingProfit>;
      return {
        title: 'Operating profit (estimate)',
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [col('metric', 'Metric'), col('amount', 'Amount', 'money')],
        rows: [
          { metric: METRICS.taxableValue.label, amount: r.taxableValuePaise },
          { metric: METRICS.cogs.label, amount: r.cogsPaise },
          { metric: METRICS.grossMargin.label, amount: r.grossMarginPaise },
          { metric: METRICS.expenses.label, amount: r.expensesPaise },
          { metric: METRICS.operatingProfit.label, amount: r.operatingProfitPaise },
        ],
        notes: [
          ...r.notes,
          ...(r.linesWithoutCost > 0
            ? [`${String(r.linesWithoutCost)} sold line(s) had no recorded cost and count as cost 0.`]
            : []),
        ],
        definitions: defs(r.definitions),
      };
    }
    case 'receivables': {
      const r = result as Result<typeof receivablesAgeing>;
      return {
        title: 'Receivables ageing',
        subtitle: `As of ${r.asOf} · ${shop}`,
        columns: [
          col('name', 'Customer'),
          col('mobile', 'Mobile'),
          col('b0', '0–30 days', 'money'),
          col('b31', '31–60 days', 'money'),
          col('b61', '61–90 days', 'money'),
          col('b90', 'Over 90 days', 'money'),
          col('total', 'Total due', 'money'),
        ],
        rows: r.customers.map((c) => ({
          name: c.name,
          mobile: c.mobileE164,
          b0: c.buckets['0-30'],
          b31: c.buckets['31-60'],
          b61: c.buckets['61-90'],
          b90: c.buckets['90+'],
          total: c.totalPaise,
        })),
        totals: {
          name: 'Total',
          mobile: null,
          b0: r.totals['0-30'],
          b31: r.totals['31-60'],
          b61: r.totals['61-90'],
          b90: r.totals['90+'],
          total: r.totals.totalPaise,
        },
        notes: [`Customer advances held: ₹${(r.customerAdvancesPaise / 100).toFixed(2)} (not netted above).`],
        definitions: defs(r.definitions),
      };
    }
    case 'payments': {
      const r = result as Result<typeof paymentMethodSummary>;
      return {
        title: 'Cash received by method',
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [
          col('method', 'Method'),
          col('receivedPaise', 'Received', 'money'),
          col('reversedPaise', 'Reversed', 'money'),
          col('refundedPaise', 'Refunded', 'money'),
          col('netPaise', 'Net', 'money'),
        ],
        rows: r.rows.map((x) => ({ ...x })),
        totals: { method: 'Total', ...r.totals },
        notes: [r.note],
        definitions: defs(r.definitions),
      };
    }
    case 'returns': {
      const r = result as Result<typeof returnsReport>;
      return {
        title: 'Returns (credit notes)',
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [
          col('date', 'Date'),
          col('number', 'Credit note'),
          col('originalInvoiceNumber', 'Against invoice'),
          col('customerName', 'Customer'),
          col('reason', 'Reason'),
          col('totalPaise', 'Amount', 'money'),
        ],
        rows: r.rows.map((x) => ({ ...x })),
        totals: { date: 'Total', totalPaise: r.totalPaise },
        definitions: defs(r.definitions),
      };
    }
    case 'tax': {
      const r = result as Result<typeof taxSummary>;
      return {
        title: 'Tax summary',
        subtitle: `${range(r.period)} · ${shop}`,
        columns: [
          col('label', 'Documents'),
          col('supply', 'Supply'),
          col('ratePercent', 'Rate %'),
          col('documents', 'Count', 'int'),
          col('taxablePaise', 'Taxable value', 'money'),
          col('cgstPaise', 'CGST', 'money'),
          col('sgstPaise', 'SGST', 'money'),
          col('igstPaise', 'IGST', 'money'),
          col('cessPaise', 'Cess', 'money'),
        ],
        rows: r.rows.map((x) => ({ ...x, supply: x.supply === 'INTER_STATE' ? 'Inter-state' : 'Intra-state' })),
        totals: { label: 'Total', ...r.totals },
        notes: [r.note],
        definitions: defs(r.definitions),
      };
    }
    case 'stock-valuation': {
      const r = result as Result<typeof stockValuation>;
      return {
        title: 'Stock valuation',
        subtitle: `As of ${r.asOf} · ${shop}`,
        columns: [
          col('name', 'Item'),
          col('sku', 'SKU'),
          col('sellableQuantity', 'Sellable qty', 'qty'),
          col('sellableValuePaise', 'Sellable value', 'money'),
          col('otherQuantity', 'Other qty', 'qty'),
          col('otherValuePaise', 'Other value', 'money'),
          col('valuePaise', 'Total value', 'money'),
        ],
        rows: r.rows.map((x) => ({
          name: x.name,
          sku: x.sku,
          sellableQuantity: x.sellableQuantity,
          sellableValuePaise: x.sellableValuePaise,
          otherQuantity: x.otherQuantity,
          otherValuePaise: x.otherValuePaise,
          valuePaise: x.valuePaise,
        })),
        totals: { name: 'Total', ...r.totals },
        notes: [r.note],
        definitions: defs(r.definitions),
      };
    }
  }
}
