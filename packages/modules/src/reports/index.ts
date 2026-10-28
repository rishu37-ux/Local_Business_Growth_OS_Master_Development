// Core reports (increment 5.7: FR-RPT-1 Phase 5 subset, FR-RPT-2, FR-RPT-3,
// FR-LED-3, D-045). Every figure is a sum over stored documents, payments and
// stock records, so it reconciles with them. Periods are business dates
// (documents carry their business-local date; payment times are converted
// with the business timezone). Cancelled invoices count nowhere; credit notes
// are returns in the period they were issued.
import {
  ageingBucket,
  customPeriod,
  METRICS,
  periodRange,
  type DateRange,
  type MetricKey,
  type Period,
  type PeriodKind,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export class ReportError extends Error {
  readonly code = 'INVALID_PERIOD';

  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

const definitions = (keys: readonly MetricKey[]) =>
  Object.fromEntries(keys.map((k) => [k, METRICS[k]])) as Partial<
    Record<MetricKey, { label: string; definition: string }>
  >;

interface Calendar {
  readonly timezone: string;
  readonly weekStart: number;
  readonly fyStartMonth: number;
  readonly today: string;
}

async function calendarIn(trx: Trx, ctx: TenantContext): Promise<Calendar> {
  const { rows } = await sql<{ timezone: string; week_start: number | null; fy_start_month: number; today: string }>`
    select b.timezone, s.week_start, b.fy_start_month, (now() at time zone b.timezone)::date::text as today
      from lbg.businesses b left join lbg.business_settings s on s.business_id = b.id
     where b.id = ${ctx.businessId}`.execute(trx);
  const r = rows[0];
  if (!r) throw new Error('business not found');
  return { timezone: r.timezone, weekStart: r.week_start ?? 1, fyStartMonth: r.fy_start_month, today: r.today };
}

export type PeriodRequest =
  | { readonly kind: PeriodKind; readonly date?: string | undefined }
  | { readonly kind: 'custom'; readonly from: string; readonly to: string };

function resolvePeriod(req: PeriodRequest, cal: Calendar): Period {
  try {
    if (req.kind === 'custom') return customPeriod(req.from, req.to);
    return periodRange(req.kind, req.date ?? cal.today, cal);
  } catch (err) {
    if (err instanceof RangeError) throw new ReportError(err.message);
    throw err;
  }
}

/** Start and end instants of business dates `from`…`to` (for timestamps such as payment times). */
const instants = (range: DateRange, tz: string) => ({
  start: sql`(${range.from}::date::timestamp at time zone ${tz})`,
  end: sql`((${range.to}::date + 1)::timestamp at time zone ${tz})`,
});

// ---------------------------------------------------------------------------
// Sales summary
// ---------------------------------------------------------------------------

export interface SalesMetrics {
  readonly invoiceCount: number;
  readonly grossSalesPaise: number;
  readonly returnsPaise: number;
  readonly netSalesPaise: number;
  readonly taxableValuePaise: number;
  readonly taxCollectedPaise: number;
}

async function salesMetrics(trx: Trx, ctx: TenantContext, range: DateRange): Promise<SalesMetrics> {
  const { rows } = await sql<{ n: number; gross: string; returns: string; taxable: string; tax: string }>`
    select count(*) filter (where document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY'))::int as n,
           coalesce(sum(total_paise) filter (where document_type <> 'CREDIT_NOTE'), 0) as gross,
           coalesce(sum(total_paise) filter (where document_type = 'CREDIT_NOTE'), 0) as returns,
           coalesce(sum(case when document_type = 'CREDIT_NOTE' then -taxable_paise else taxable_paise end), 0) as taxable,
           coalesce(sum((cgst_paise + sgst_paise + igst_paise + cess_paise)
                        * case when document_type = 'CREDIT_NOTE' then -1 else 1 end), 0) as tax
      from lbg.invoices
     where business_id = ${ctx.businessId} and status = 'ISSUED'
       and invoice_date between ${range.from}::date and ${range.to}::date`.execute(trx);
  const r = rows[0];
  const gross = Number(r?.gross ?? 0);
  const returns = Number(r?.returns ?? 0);
  return {
    invoiceCount: r?.n ?? 0,
    grossSalesPaise: gross,
    returnsPaise: returns,
    netSalesPaise: gross - returns,
    taxableValuePaise: Number(r?.taxable ?? 0),
    taxCollectedPaise: Number(r?.tax ?? 0),
  };
}

export async function salesSummary(db: Db, ctx: TenantContext, req: PeriodRequest) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const period = resolvePeriod(req, cal);
    const current = await salesMetrics(trx, ctx, period);
    const previous = await salesMetrics(trx, ctx, period.previous);
    const { rows } = await sql<{ date: string; gross: string; returns: string; n: number }>`
      select invoice_date::text as date,
             coalesce(sum(total_paise) filter (where document_type <> 'CREDIT_NOTE'), 0) as gross,
             coalesce(sum(total_paise) filter (where document_type = 'CREDIT_NOTE'), 0) as returns,
             count(*) filter (where document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY'))::int as n
        from lbg.invoices
       where business_id = ${ctx.businessId} and status = 'ISSUED'
         and invoice_date between ${period.from}::date and ${period.to}::date
       group by invoice_date order by invoice_date`.execute(trx);
    return {
      period,
      current,
      previous,
      days: rows.map((r) => ({
        date: r.date,
        invoiceCount: r.n,
        grossSalesPaise: Number(r.gross),
        returnsPaise: Number(r.returns),
        netSalesPaise: Number(r.gross) - Number(r.returns),
      })),
      definitions: definitions(['grossSales', 'returns', 'netSales', 'taxableValue', 'taxCollected']),
    };
  });
}

// ---------------------------------------------------------------------------
// Sales by brand / model / variant, and margin
// ---------------------------------------------------------------------------

export type ItemGrouping = 'brand' | 'model' | 'variant';

export async function salesByItem(
  db: Db,
  ctx: TenantContext,
  req: PeriodRequest,
  options: { readonly groupBy: ItemGrouping; readonly withMargin: boolean },
) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const period = resolvePeriod(req, cal);
    const key =
      options.groupBy === 'brand'
        ? sql`coalesce(b.name, 'No brand')`
        : options.groupBy === 'model'
          ? sql`p.model_name`
          : sql`p.model_name || coalesce(' ' || nullif(concat_ws(' / ', v.ram, v.storage, v.colour), ''), '') || ' (' || v.sku || ')'`;
    const { rows } = await sql<{
      name: string;
      qty: string;
      net: string;
      taxable: string;
      cogs: string;
      missing_cost: number;
    }>`
      select ${key} as name,
             sum(case when i.document_type = 'CREDIT_NOTE' then -l.quantity
                      when i.document_type = 'DEBIT_NOTE' then 0 else l.quantity end)::numeric(14,3)::text as qty,
             sum(case when i.document_type = 'CREDIT_NOTE' then -l.line_total_paise else l.line_total_paise end) as net,
             sum(case when i.document_type = 'CREDIT_NOTE' then -l.taxable_paise else l.taxable_paise end) as taxable,
             sum(case when i.document_type = 'CREDIT_NOTE' then -coalesce(l.cost_paise, 0)
                      when i.document_type = 'DEBIT_NOTE' then 0 else coalesce(l.cost_paise, 0) end) as cogs,
             count(*) filter (where l.cost_paise is null and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY'))::int
               as missing_cost
        from lbg.invoice_lines l
        join lbg.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
        join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
        left join lbg.brands b on b.business_id = p.business_id and b.id = p.brand_id
       where l.business_id = ${ctx.businessId} and i.status = 'ISSUED'
         and i.invoice_date between ${period.from}::date and ${period.to}::date
       group by 1 order by 3 desc, 1`.execute(trx);
    return {
      period,
      groupBy: options.groupBy,
      rows: rows.map((r) => {
        const taxable = Number(r.taxable);
        const cogs = Number(r.cogs);
        return {
          name: r.name,
          quantity: r.qty,
          netSalesPaise: Number(r.net),
          taxableValuePaise: taxable,
          ...(options.withMargin
            ? {
                cogsPaise: cogs,
                grossMarginPaise: taxable - cogs,
                linesWithoutCost: r.missing_cost,
              }
            : {}),
        };
      }),
      definitions: definitions(
        options.withMargin ? ['netSales', 'taxableValue', 'cogs', 'grossMargin'] : ['netSales', 'taxableValue'],
      ),
    };
  });
}

/** Gross margin for the period (needs reports.financial.view, checked by the API). */
export async function marginSummary(db: Db, ctx: TenantContext, req: PeriodRequest) {
  const byModel = await salesByItem(db, ctx, req, { groupBy: 'model', withMargin: true });
  const taxable = byModel.rows.reduce((s, r) => s + r.taxableValuePaise, 0);
  const cogs = byModel.rows.reduce((s, r) => s + (r.cogsPaise ?? 0), 0);
  const margin = taxable - cogs;
  return {
    period: byModel.period,
    taxableValuePaise: taxable,
    cogsPaise: cogs,
    grossMarginPaise: margin,
    /** Basis points of taxable value; null when there were no sales. */
    grossMarginBp: taxable === 0 ? null : Math.round((margin * 10_000) / taxable),
    linesWithoutCost: byModel.rows.reduce((s, r) => s + (r.linesWithoutCost ?? 0), 0),
    definitions: definitions(['taxableValue', 'cogs', 'grossMargin']),
  };
}

// ---------------------------------------------------------------------------
// Receivables ageing
// ---------------------------------------------------------------------------

type Bucket = '0-30' | '31-60' | '61-90' | '90+';
const BUCKETS: readonly Bucket[] = ['0-30', '31-60', '61-90', '90+'];

/** Amounts owed now, by customer and by age of the document (FR-RPT-1). */
export async function receivablesAgeing(db: Db, ctx: TenantContext) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const { rows } = await sql<{
      customer_id: string;
      name: string;
      mobile: string | null;
      date: string;
      outstanding: string;
    }>`
      select i.customer_id, c.name, c.mobile_e164 as mobile, i.invoice_date::text as date,
             i.total_paise
               - coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                            where a.business_id = i.business_id and a.invoice_id = i.id), 0)
               - coalesce((select sum(n.total_paise) from lbg.invoices n
                            where n.business_id = i.business_id and n.original_invoice_id = i.id
                              and n.document_type = 'CREDIT_NOTE' and n.status = 'ISSUED'), 0) as outstanding
        from lbg.invoices i join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id
       where i.business_id = ${ctx.businessId} and i.status = 'ISSUED'
         and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY', 'DEBIT_NOTE')`.execute(trx);
    const byCustomer = new Map<
      string,
      {
        customerId: string;
        name: string;
        mobileE164: string | null;
        buckets: Record<Bucket, number>;
        totalPaise: number;
      }
    >();
    const totals: Record<Bucket, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const r of rows) {
      const amount = Number(r.outstanding);
      if (amount <= 0) continue;
      const bucket = ageingBucket(r.date, cal.today);
      const c = byCustomer.get(r.customer_id) ?? {
        customerId: r.customer_id,
        name: r.name,
        mobileE164: r.mobile,
        buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
        totalPaise: 0,
      };
      c.buckets[bucket] += amount;
      c.totalPaise += amount;
      totals[bucket] += amount;
      byCustomer.set(r.customer_id, c);
    }
    const { rows: adv } = await sql<{ advance: string }>`
      select coalesce(sum(p.amount_paise
               - coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                            where a.business_id = p.business_id and a.payment_id = p.id), 0)
               - coalesce((select sum(r.amount_paise) from lbg.payment_refunds r
                            where r.business_id = p.business_id and r.payment_id = p.id), 0)), 0) as advance
        from lbg.payments p
       where p.business_id = ${ctx.businessId} and p.customer_id is not null and p.reverses_payment_id is null
         and not exists (select 1 from lbg.payments x where x.business_id = p.business_id and x.reverses_payment_id = p.id)`.execute(
      trx,
    );
    return {
      asOf: cal.today,
      buckets: BUCKETS,
      customers: [...byCustomer.values()].sort((a, b) => b.totalPaise - a.totalPaise || a.name.localeCompare(b.name)),
      totals: { ...totals, totalPaise: BUCKETS.reduce((s, b) => s + totals[b], 0) },
      customerAdvancesPaise: Number(adv[0]?.advance ?? 0),
      definitions: definitions(['receivables', 'customerAdvances']),
    };
  });
}

// ---------------------------------------------------------------------------
// Cash received by payment method
// ---------------------------------------------------------------------------

export async function paymentMethodSummary(db: Db, ctx: TenantContext, req: PeriodRequest) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const period = resolvePeriod(req, cal);
    const { start, end } = instants(period, cal.timezone);
    const { rows } = await sql<{ method: string; received: string; reversed: string; refunded: string }>`
      with m as (
        select method,
               case when reverses_payment_id is null then amount_paise else 0 end as received,
               case when reverses_payment_id is not null then amount_paise else 0 end as reversed,
               0::bigint as refunded
          from lbg.payments
         where business_id = ${ctx.businessId} and received_at >= ${start} and received_at < ${end}
        union all
        select method, 0, 0, amount_paise from lbg.payment_refunds
         where business_id = ${ctx.businessId} and refunded_at >= ${start} and refunded_at < ${end}
      )
      select method, sum(received) as received, sum(reversed) as reversed, sum(refunded) as refunded
        from m group by method order by method`.execute(trx);
    const out = rows.map((r) => {
      const received = Number(r.received);
      const reversed = Number(r.reversed);
      const refunded = Number(r.refunded);
      return {
        method: r.method,
        receivedPaise: received,
        reversedPaise: reversed,
        refundedPaise: refunded,
        netPaise: received - reversed - refunded,
      };
    });
    const sum = (k: 'receivedPaise' | 'reversedPaise' | 'refundedPaise' | 'netPaise') =>
      out.reduce((s, r) => s + r[k], 0);
    return {
      period,
      rows: out,
      totals: {
        receivedPaise: sum('receivedPaise'),
        reversedPaise: sum('reversedPaise'),
        refundedPaise: sum('refundedPaise'),
        netPaise: sum('netPaise'),
      },
      note: 'Payments as recorded at the counter; settlement of UPI and card payments is not verified.',
      definitions: definitions(['cashReceived']),
    };
  });
}

// ---------------------------------------------------------------------------
// Returns and tax summary
// ---------------------------------------------------------------------------

export async function returnsReport(db: Db, ctx: TenantContext, req: PeriodRequest) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const period = resolvePeriod(req, cal);
    const { rows } = await sql<{
      id: string;
      number: string;
      date: string;
      original_number: string | null;
      customer: string | null;
      total: string;
      reason: string | null;
    }>`
      select n.id, n.invoice_number as number, n.invoice_date::text as date, o.invoice_number as original_number,
             c.name as customer, n.total_paise as total, n.notes as reason
        from lbg.invoices n
        join lbg.invoices o on o.business_id = n.business_id and o.id = n.original_invoice_id
        left join lbg.customers c on c.business_id = n.business_id and c.id = n.customer_id
       where n.business_id = ${ctx.businessId} and n.document_type = 'CREDIT_NOTE' and n.status = 'ISSUED'
         and n.invoice_date between ${period.from}::date and ${period.to}::date
       order by n.invoice_date, n.invoice_number`.execute(trx);
    const out = rows.map((r) => ({
      id: r.id,
      number: r.number,
      date: r.date,
      originalInvoiceNumber: r.original_number,
      customerName: r.customer,
      totalPaise: Number(r.total),
      reason: r.reason,
    }));
    return {
      period,
      rows: out,
      totalPaise: out.reduce((s, r) => s + r.totalPaise, 0),
      definitions: definitions(['returns']),
    };
  });
}

const DOC_LABEL: Readonly<Record<string, string>> = {
  TAX_INVOICE: 'Tax invoices',
  BILL_OF_SUPPLY: 'Bills of supply',
  CREDIT_NOTE: 'Credit notes',
  DEBIT_NOTE: 'Debit notes',
};

/** Tax by document type and rate, credit notes negative (for the accountant; not a GST filing). */
export async function taxSummary(db: Db, ctx: TenantContext, req: PeriodRequest) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const period = resolvePeriod(req, cal);
    const { rows } = await sql<{
      document_type: string;
      rate: string;
      inter_state: boolean;
      count: number;
      taxable: string;
      cgst: string;
      sgst: string;
      igst: string;
      cess: string;
    }>`
      select i.document_type, l.tax_rate_percent::text as rate, i.igst_paise > 0 as inter_state,
             count(distinct i.id)::int as count, sum(l.taxable_paise) as taxable, sum(l.cgst_paise) as cgst,
             sum(l.sgst_paise) as sgst, sum(l.igst_paise) as igst, sum(l.cess_paise) as cess
        from lbg.invoice_lines l join lbg.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
       where l.business_id = ${ctx.businessId} and i.status = 'ISSUED'
         and i.invoice_date between ${period.from}::date and ${period.to}::date
       group by 1, 2, 3 order by 1, 2, 3`.execute(trx);
    const out = rows.map((r) => {
      const sign = r.document_type === 'CREDIT_NOTE' ? -1 : 1;
      const v = (x: string) => sign * Number(x);
      return {
        documentType: r.document_type,
        label: DOC_LABEL[r.document_type] ?? r.document_type,
        ratePercent: r.rate,
        supply: r.inter_state ? ('INTER_STATE' as const) : ('INTRA_STATE' as const),
        documents: r.count,
        taxablePaise: v(r.taxable),
        cgstPaise: v(r.cgst),
        sgstPaise: v(r.sgst),
        igstPaise: v(r.igst),
        cessPaise: v(r.cess),
      };
    });
    const sum = (k: 'taxablePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'cessPaise') =>
      out.reduce((s, r) => s + r[k], 0);
    return {
      period,
      rows: out,
      totals: {
        taxablePaise: sum('taxablePaise'),
        cgstPaise: sum('cgstPaise'),
        sgstPaise: sum('sgstPaise'),
        igstPaise: sum('igstPaise'),
        cessPaise: sum('cessPaise'),
      },
      note: 'Summary for your accountant. This is not a GST return or filing; check it against your records before filing.',
      definitions: definitions(['taxableValue', 'taxCollected']),
    };
  });
}

// ---------------------------------------------------------------------------
// Stock valuation
// ---------------------------------------------------------------------------

/** Stock on hand at cost, now, by item and bucket (needs reports.financial.view). */
export async function stockValuation(db: Db, ctx: TenantContext) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const { rows } = await sql<{
      sku: string;
      name: string;
      serialized: boolean;
      sellable_qty: string;
      other_qty: string;
      sellable_value: string;
      other_value: string;
      missing_cost: boolean;
    }>`
      with lv as (
        select variant_id,
               sum(quantity) filter (where bucket = 'AVAILABLE') as sellable,
               sum(quantity) filter (where bucket <> 'AVAILABLE') as other
          from lbg.stock_levels where business_id = ${ctx.businessId} group by variant_id
      )
      select v.sku, p.model_name || coalesce(' ' || nullif(concat_ws(' / ', v.ram, v.storage, v.colour), ''), '') as name,
             p.is_serialized as serialized,
             greatest(coalesce(lv.sellable, 0), 0)::numeric(14,3)::text as sellable_qty,
             greatest(coalesce(lv.other, 0), 0)::numeric(14,3)::text as other_qty,
             case when p.is_serialized then
                    (select coalesce(sum(u.unit_cost_paise), 0) from lbg.serialized_units u
                      where u.business_id = v.business_id and u.variant_id = v.id and u.status in ('IN_STOCK', 'RESERVED'))
                  else round(greatest(coalesce(lv.sellable, 0), 0) * coalesce(v.avg_cost_paise, 0)) end::text as sellable_value,
             case when p.is_serialized then
                    (select coalesce(sum(u.unit_cost_paise), 0) from lbg.serialized_units u
                      where u.business_id = v.business_id and u.variant_id = v.id
                        and u.status in ('PENDING_INSPECTION', 'DAMAGED', 'IN_REPAIR'))
                  else round(greatest(coalesce(lv.other, 0), 0) * coalesce(v.avg_cost_paise, 0)) end::text as other_value,
             (not p.is_serialized and v.avg_cost_paise is null and coalesce(lv.sellable, 0) + coalesce(lv.other, 0) > 0)
               as missing_cost
        from lbg.product_variants v
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
        left join lv on lv.variant_id = v.id
       where v.business_id = ${ctx.businessId}
         and (coalesce(lv.sellable, 0) <> 0 or coalesce(lv.other, 0) <> 0)
       order by 2, 1`.execute(trx);
    const out = rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      serialized: r.serialized,
      sellableQuantity: r.sellable_qty,
      otherQuantity: r.other_qty,
      sellableValuePaise: Number(r.sellable_value),
      otherValuePaise: Number(r.other_value),
      valuePaise: Number(r.sellable_value) + Number(r.other_value),
      costMissing: r.missing_cost,
    }));
    return {
      asOf: cal.today,
      rows: out,
      totals: {
        sellableValuePaise: out.reduce((s, r) => s + r.sellableValuePaise, 0),
        otherValuePaise: out.reduce((s, r) => s + r.otherValuePaise, 0),
        valuePaise: out.reduce((s, r) => s + r.valuePaise, 0),
      },
      note: 'Sellable = available stock. Other = awaiting inspection, damaged or in repair (counted, not sellable).',
      definitions: definitions(['stockValuation']),
    };
  });
}

// ---------------------------------------------------------------------------
// Expenses and the operating-profit estimate (increment 6.4: FR-EXP-1, FR-RPT-1, D-050)
// ---------------------------------------------------------------------------

/** Expenses by category for the period; reversals net out against the original's date. */
export async function expensesReport(db: Db, ctx: TenantContext, req: PeriodRequest) {
  return withTenant(db, ctx, async (trx) => {
    const cal = await calendarIn(trx, ctx);
    const period = resolvePeriod(req, cal);
    const { rows } = await sql<{ category: string; amount: string; n: number }>`
      select category, sum(amount_paise) as amount,
             count(*) filter (where reverses_expense_id is null
                                and not exists (select 1 from lbg.expenses r where r.business_id = e.business_id
                                                  and r.reverses_expense_id = e.id))::int as n
        from lbg.expenses e
       where business_id = ${ctx.businessId} and expense_date between ${period.from}::date and ${period.to}::date
       group by category
       order by sum(amount_paise) desc, category`.execute(trx);
    const { rows: s } = await sql<{ enabled: boolean | null }>`
      select expenses_enabled as enabled from lbg.business_settings where business_id = ${ctx.businessId}`.execute(trx);
    const byCategory = rows
      .map((r) => ({ category: r.category, amountPaise: Number(r.amount), count: r.n }))
      .filter((r) => r.amountPaise !== 0);
    return {
      period,
      enabled: s[0]?.enabled ?? false,
      byCategory,
      totalPaise: byCategory.reduce((t, r) => t + r.amountPaise, 0),
      definitions: definitions(['expenses']),
    };
  });
}

/** Gross margin minus expenses — an estimate, labelled as such (FR-RPT-1, SRS §7). */
export async function operatingProfit(db: Db, ctx: TenantContext, req: PeriodRequest) {
  const margin = await marginSummary(db, ctx, req);
  const expenses = await expensesReport(db, ctx, req);
  return {
    period: margin.period,
    label: 'estimate' as const,
    taxableValuePaise: margin.taxableValuePaise,
    cogsPaise: margin.cogsPaise,
    grossMarginPaise: margin.grossMarginPaise,
    expensesPaise: expenses.totalPaise,
    operatingProfitPaise: margin.grossMarginPaise - expenses.totalPaise,
    expensesEnabled: expenses.enabled,
    linesWithoutCost: margin.linesWithoutCost,
    notes: [
      'An estimate from what is recorded here: it leaves out anything not entered (for example owner drawings, depreciation, loan interest) and is not a tax computation.',
      ...(expenses.enabled
        ? []
        : ['Expenses are switched off for this shop; only entries recorded while they were on are deducted.']),
    ],
    definitions: definitions(['taxableValue', 'cogs', 'grossMargin', 'expenses', 'operatingProfit']),
  };
}

export {
  exportReport,
  toCsv,
  toReportHtml,
  toXlsx,
  zip,
  type ExportCell,
  type ExportColumn,
  type ExportFormat,
  type ExportTable,
} from './export.ts';
export { REPORTS, reportTable, type ReportName } from './tables.ts';
export { dashboard, type Dashboard, type Tile } from './dashboard.ts';

/** Shop name for report headings. */
export async function shopName(db: Db, ctx: TenantContext): Promise<string> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ name: string }>`
      select coalesce(display_name, legal_name) as name from lbg.businesses where id = ${ctx.businessId}`.execute(trx);
    return rows[0]?.name ?? '';
  });
}

/** FR-RPT-4 AC2: every export is audited (report, format, period; no report contents). */
export async function auditExport(
  db: Db,
  ctx: TenantContext,
  meta: { readonly report: string; readonly format: string; readonly from?: string; readonly to?: string },
  requestId?: string,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await recordTenantEvent(trx, ctx, {
      action: 'report.export',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { ...meta },
      ...(requestId ? { requestId } : {}),
    });
  });
}
