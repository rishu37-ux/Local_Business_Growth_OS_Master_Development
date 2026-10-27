// Reports (increment 5.7: FR-RPT-1…4, FR-LED-3). Every figure shows its
// definition; sales are never labelled profit or cash. Sections appear only
// with the permission; the API checks again.
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { api, formatPaise, formatQty } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';

type Definition = { label: string; definition: string };
interface Metrics {
  invoiceCount: number;
  grossSalesPaise: number;
  returnsPaise: number;
  netSalesPaise: number;
  taxableValuePaise: number;
  taxCollectedPaise: number;
}
interface Summary {
  period: { from: string; to: string; previous: { from: string; to: string } };
  current: Metrics;
  previous: Metrics;
  definitions: Record<string, Definition>;
}
interface ByItem {
  rows: {
    name: string;
    quantity: string;
    netSalesPaise: number;
    taxableValuePaise: number;
    cogsPaise?: number;
    grossMarginPaise?: number;
  }[];
}
interface Margin {
  taxableValuePaise: number;
  cogsPaise: number;
  grossMarginPaise: number;
  grossMarginBp: number | null;
  linesWithoutCost: number;
  definitions: Record<string, Definition>;
}
interface Payments {
  rows: { method: string; receivedPaise: number; reversedPaise: number; refundedPaise: number; netPaise: number }[];
  totals: { netPaise: number };
  note: string;
  definitions: Record<string, Definition>;
}
interface Tax {
  rows: {
    label: string;
    supply: string;
    ratePercent: string;
    documents: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
  }[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
  note: string;
}
interface Ageing {
  asOf: string;
  customers: { customerId: string; name: string; buckets: Record<string, number>; totalPaise: number }[];
  totals: Record<string, number>;
  customerAdvancesPaise: number;
  definitions: Record<string, Definition>;
}
interface Valuation {
  asOf: string;
  rows: {
    sku: string;
    name: string;
    sellableQuantity: string;
    sellableValuePaise: number;
    otherQuantity: string;
    otherValuePaise: number;
    valuePaise: number;
  }[];
  totals: { sellableValuePaise: number; otherValuePaise: number; valuePaise: number };
  note: string;
}

const METHOD: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

function change(now: number, before: number): string {
  if (before === 0) return now === 0 ? 'No change' : 'No sales in the previous period';
  const pct = ((now - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% vs previous period`;
}

function Metric(props: { label: string; value: string; definition: string | undefined; hint?: string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-sm font-medium text-ink-600">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{props.value}</p>
      {props.hint ? <p className="mt-1 text-xs text-ink-600">{props.hint}</p> : null}
      {props.definition ? (
        <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-500">{props.definition}</p>
      ) : null}
    </div>
  );
}

function ExportLinks(props: { href: (format: string) => string; formats: readonly string[] }) {
  return (
    <p className="mb-3 flex flex-wrap gap-3 text-sm">
      <span className="text-ink-600">Export:</span>
      {props.formats.map((f) => (
        <a key={f} className="link" href={props.href(f)}>
          {f.toUpperCase()}
        </a>
      ))}
    </p>
  );
}

function Section(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={props.id}>
      <h2 id={props.id} className="section-title">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

interface ReportMap {
  'sales-summary': Summary;
  'sales-by-item': ByItem;
  margin: Margin;
  payments: Payments;
  tax: Tax;
  receivables: Ageing;
  'stock-valuation': Valuation;
}

function useReport<K extends keyof ReportMap>(base: string, name: K, query: string, enabled = true) {
  return useQuery({
    queryKey: ['report', base, name, query],
    queryFn: () => api<{ report: ReportMap[K] }>(`${base}/${name}${query ? `?${query}` : ''}`),
    enabled,
  });
}

export function ReportsPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const [period, setPeriod] = useState('month');
  const [date, setDate] = useState('');
  const valid = date === '' || /^\d{4}-\d{2}-\d{2}$/.test(date);
  const query = `period=${period}${date && valid ? `&date=${date}` : ''}`;
  const base = `/api/businesses/${businessId}/reports`;
  const can = business.can;
  const financial = can('reports.financial.view');
  const exportable = can('reports.export');

  const summary = useReport(base, 'sales-summary', query);
  const items = useReport(base, 'sales-by-item', `${query}&groupBy=model`);
  const margin = useReport(base, 'margin', query, financial);
  const payments = useReport(base, 'payments', query);
  const tax = useReport(base, 'tax', query);
  const ageing = useReport(base, 'receivables', '', financial);
  const stock = useReport(base, 'stock-valuation', '', financial);
  const exportHref =
    (name: string, extra = '') =>
    (f: string) =>
      `${base}/${name}/export?${query}${extra}&format=${f}`;

  const s = summary.data?.report;
  const d = s?.definitions ?? {};
  return (
    <Page
      eyebrow="Reports"
      title="Sales and accounts"
      description={
        s
          ? `${s.period.from} to ${s.period.to} · compared with ${s.period.previous.from} to ${s.period.previous.to}`
          : 'Loading…'
      }
    >
      <section aria-labelledby="period-heading">
        <h2 id="period-heading" className="section-title">
          Period
        </h2>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <NativeSelect
            label="Period"
            name="period"
            value={period}
            onChange={setPeriod}
            options={[
              ['day', 'Day'],
              ['week', 'Week'],
              ['month', 'Month'],
              ['fy', 'Financial year'],
              ['year', 'Calendar year'],
            ]}
          />
          <Field
            label="Date in the period (YYYY-MM-DD, empty = today)"
            name="date"
            value={date}
            onChange={setDate}
            isRequired={false}
          />
        </div>
        <p className="text-xs text-ink-600">
          Dates follow your shop&apos;s timezone and financial year. Cancelled invoices are not counted.
        </p>
      </section>

      <Alert message={summary.error ? errorText(summary.error) : null} />
      {s ? (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label={d.netSales?.label ?? 'Net sales'}
              value={formatPaise(s.current.netSalesPaise)}
              hint={change(s.current.netSalesPaise, s.previous.netSalesPaise)}
              definition={d.netSales?.definition}
            />
            <Metric
              label={d.grossSales?.label ?? 'Gross sales'}
              value={formatPaise(s.current.grossSalesPaise)}
              hint={`${String(s.current.invoiceCount)} invoices`}
              definition={d.grossSales?.definition}
            />
            <Metric
              label={d.returns?.label ?? 'Returns'}
              value={formatPaise(s.current.returnsPaise)}
              definition={d.returns?.definition}
            />
            <Metric
              label={d.taxCollected?.label ?? 'Tax collected'}
              value={formatPaise(s.current.taxCollectedPaise)}
              hint={`Taxable value ${formatPaise(s.current.taxableValuePaise)}`}
              definition={d.taxCollected?.definition}
            />
          </div>
          {exportable ? <ExportLinks href={exportHref('sales-summary')} formats={['csv', 'xlsx', 'pdf']} /> : null}
        </>
      ) : null}

      {financial && margin.data ? (
        <Section id="margin-heading" title="Gross margin">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label={margin.data.report.definitions.taxableValue?.label ?? 'Taxable value'}
              value={formatPaise(margin.data.report.taxableValuePaise)}
              definition={margin.data.report.definitions.taxableValue?.definition}
            />
            <Metric
              label={margin.data.report.definitions.cogs?.label ?? 'Cost of goods sold'}
              value={formatPaise(margin.data.report.cogsPaise)}
              definition={margin.data.report.definitions.cogs?.definition}
            />
            <Metric
              label={margin.data.report.definitions.grossMargin?.label ?? 'Gross margin'}
              value={formatPaise(margin.data.report.grossMarginPaise)}
              hint={
                margin.data.report.grossMarginBp === null
                  ? 'No sales'
                  : `${(margin.data.report.grossMarginBp / 100).toFixed(1)}% of taxable value`
              }
              definition={margin.data.report.definitions.grossMargin?.definition}
            />
          </div>
          {margin.data.report.linesWithoutCost > 0 ? (
            <p className="mt-3 text-sm text-amber-900">
              {margin.data.report.linesWithoutCost} sold line(s) had no recorded cost.
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section id="items-heading" title="Sales by model">
        {exportable ? (
          <ExportLinks href={exportHref('sales-by-item', '&groupBy=model')} formats={['csv', 'xlsx']} />
        ) : null}
        <Table
          caption="Sales by model"
          headers={['Model', 'Quantity', 'Net sales', 'Taxable value', ...(financial ? ['Cost', 'Gross margin'] : [])]}
        >
          {(items.data?.report.rows ?? []).map((r) => (
            <tr key={r.name}>
              <td className={cell}>{r.name}</td>
              <td className={cell}>{formatQty(r.quantity)}</td>
              <td className={cell}>{formatPaise(r.netSalesPaise)}</td>
              <td className={cell}>{formatPaise(r.taxableValuePaise)}</td>
              {financial ? <td className={cell}>{formatPaise(r.cogsPaise)}</td> : null}
              {financial ? <td className={cell}>{formatPaise(r.grossMarginPaise)}</td> : null}
            </tr>
          ))}
        </Table>
        {items.data?.report.rows.length === 0 ? <p className="text-sm text-ink-600">No sales in this period.</p> : null}
      </Section>

      <Section id="payments-heading" title={payments.data?.report.definitions.cashReceived?.label ?? 'Cash received'}>
        <p className="mb-3 text-sm text-ink-600">
          {payments.data?.report.definitions.cashReceived?.definition} {payments.data?.report.note}
        </p>
        {exportable ? <ExportLinks href={exportHref('payments')} formats={['csv', 'xlsx']} /> : null}
        <Table caption="Cash received by method" headers={['Method', 'Received', 'Reversed', 'Refunded', 'Net']}>
          {(payments.data?.report.rows ?? []).map((r) => (
            <tr key={r.method}>
              <td className={cell}>{METHOD[r.method] ?? r.method}</td>
              <td className={cell}>{formatPaise(r.receivedPaise)}</td>
              <td className={cell}>{formatPaise(r.reversedPaise)}</td>
              <td className={cell}>{formatPaise(r.refundedPaise)}</td>
              <td className={cell}>{formatPaise(r.netPaise)}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section id="tax-heading" title="Tax summary">
        <p className="mb-3 text-sm text-ink-600">{tax.data?.report.note}</p>
        {exportable ? <ExportLinks href={exportHref('tax')} formats={['csv', 'xlsx', 'pdf']} /> : null}
        <Table
          caption="Tax summary"
          headers={['Documents', 'Supply', 'Rate', 'Count', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Cess']}
        >
          {(tax.data?.report.rows ?? []).map((r) => (
            <tr key={`${r.label}-${r.supply}-${r.ratePercent}`}>
              <td className={cell}>{r.label}</td>
              <td className={cell}>{r.supply === 'INTER_STATE' ? 'Inter-state' : 'Intra-state'}</td>
              <td className={cell}>{formatQty(r.ratePercent)}%</td>
              <td className={cell}>{r.documents}</td>
              <td className={cell}>{formatPaise(r.taxablePaise)}</td>
              <td className={cell}>{formatPaise(r.cgstPaise)}</td>
              <td className={cell}>{formatPaise(r.sgstPaise)}</td>
              <td className={cell}>{formatPaise(r.igstPaise)}</td>
              <td className={cell}>{formatPaise(r.cessPaise)}</td>
            </tr>
          ))}
        </Table>
      </Section>

      {financial && ageing.data ? (
        <Section id="ageing-heading" title="Receivables ageing">
          <p className="mb-3 text-sm text-ink-600">
            As of {ageing.data.report.asOf}. {ageing.data.report.definitions.receivables?.definition} Customer advances
            held: {formatPaise(ageing.data.report.customerAdvancesPaise)}.
          </p>
          {exportable ? (
            <ExportLinks href={(f) => `${base}/receivables/export?format=${f}`} formats={['csv', 'xlsx']} />
          ) : null}
          <Table
            caption="Receivables ageing"
            headers={['Customer', '0–30 days', '31–60 days', '61–90 days', 'Over 90 days', 'Total due']}
          >
            {ageing.data.report.customers.map((c) => (
              <tr key={c.customerId}>
                <td className={cell}>{c.name}</td>
                {['0-30', '31-60', '61-90', '90+'].map((b) => (
                  <td key={b} className={cell}>
                    {formatPaise(c.buckets[b] ?? 0)}
                  </td>
                ))}
                <td className={cell}>{formatPaise(c.totalPaise)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}

      {financial && stock.data ? (
        <Section id="valuation-heading" title="Stock valuation">
          <p className="mb-3 text-sm text-ink-600">
            As of {stock.data.report.asOf}. Total {formatPaise(stock.data.report.totals.valuePaise)}.{' '}
            {stock.data.report.note}
          </p>
          {exportable ? (
            <ExportLinks href={(f) => `${base}/stock-valuation/export?format=${f}`} formats={['csv', 'xlsx']} />
          ) : null}
          <Table
            caption="Stock valuation"
            headers={['Item', 'SKU', 'Sellable', 'Sellable value', 'Other', 'Other value', 'Total']}
          >
            {stock.data.report.rows.map((r) => (
              <tr key={r.sku}>
                <td className={cell}>{r.name}</td>
                <td className={cell}>{r.sku}</td>
                <td className={cell}>{formatQty(r.sellableQuantity)}</td>
                <td className={cell}>{formatPaise(r.sellableValuePaise)}</td>
                <td className={cell}>{formatQty(r.otherQuantity)}</td>
                <td className={cell}>{formatPaise(r.otherValuePaise)}</td>
                <td className={cell}>{formatPaise(r.valuePaise)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}
    </Page>
  );
}
