// Issued documents (read side). Line costs are shown only to holders of
// catalogue.cost.view (ROLES_PERMISSIONS §3).
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';

export interface InvoiceSummary {
  readonly id: string;
  readonly documentType: string;
  readonly number: string | null;
  readonly invoiceDate: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly totalPaise: number;
  readonly allocatedPaise: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  readonly financialYear: string;
  readonly placeOfSupply: string;
  readonly partySnapshot: unknown;
  readonly grossPaise: number;
  readonly discountPaise: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly roundOffPaise: number;
  readonly discountApprovedBy: string | null;
  readonly issuedAt: string | null;
  readonly issuedBy: string | null;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly variantId: string;
    readonly unitId: string | null;
    readonly description: string;
    readonly hsnCode: string | null;
    readonly quantity: string;
    readonly unitPricePaise: number;
    readonly grossPaise: number;
    readonly discountPaise: number;
    readonly invoiceDiscountPaise: number;
    readonly taxRatePercent: string;
    readonly cessPercent: string;
    readonly taxablePaise: number;
    readonly cgstPaise: number;
    readonly sgstPaise: number;
    readonly igstPaise: number;
    readonly cessPaise: number;
    readonly totalPaise: number;
    readonly costPaise?: number | null;
  }[];
  readonly payments: readonly {
    readonly paymentId: string;
    readonly method: string;
    readonly reference: string | null;
    readonly allocatedPaise: number;
  }[];
}

interface SummaryRow {
  id: string;
  document_type: string;
  invoice_number: string | null;
  invoice_date: string;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  total_paise: string;
  allocated: string;
}

const SUMMARY = sql`
  select i.id, i.document_type, i.invoice_number, i.invoice_date::text as invoice_date, i.status, i.customer_id,
         c.name as customer_name, i.total_paise,
         coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                    where a.business_id = i.business_id and a.invoice_id = i.id), 0) as allocated
    from lbg.invoices i left join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id`;

const toSummary = (r: SummaryRow): InvoiceSummary => ({
  id: r.id,
  documentType: r.document_type,
  number: r.invoice_number,
  invoiceDate: r.invoice_date,
  status: r.status,
  customerId: r.customer_id,
  customerName: r.customer_name,
  totalPaise: Number(r.total_paise),
  allocatedPaise: Number(r.allocated),
});

export async function listInvoices(
  db: Db,
  ctx: TenantContext,
  filter: { readonly customerId?: string | undefined; readonly from?: string; readonly to?: string } = {},
): Promise<InvoiceSummary[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<SummaryRow>`${SUMMARY}
      where i.business_id = ${ctx.businessId} and i.status in ('ISSUED', 'CANCELLED')
        ${filter.customerId ? sql`and i.customer_id = ${filter.customerId}` : sql``}
        ${filter.from ? sql`and i.invoice_date >= ${filter.from}::date` : sql``}
        ${filter.to ? sql`and i.invoice_date <= ${filter.to}::date` : sql``}
      order by i.issued_at desc limit 200`.execute(trx);
    return rows.map(toSummary);
  });
}

export async function getInvoice(
  db: Db,
  ctx: TenantContext,
  id: string,
  options: { readonly canSeeCost: boolean },
): Promise<InvoiceDetail | null> {
  return withTenant(db, ctx, async (trx) => {
    const head = (
      await sql<
        SummaryRow & {
          financial_year: string;
          place_of_supply_state: string;
          party_snapshot: unknown;
          gross_paise: string;
          discount_paise: string;
          taxable_paise: string;
          cgst_paise: string;
          sgst_paise: string;
          igst_paise: string;
          cess_paise: string;
          round_off_paise: number;
          discount_approved_by: string | null;
          issued_at: Date | null;
          issued_by: string | null;
        }
      >`
        select s.*, i.financial_year, i.place_of_supply_state, i.party_snapshot, i.gross_paise, i.discount_paise,
               i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.cess_paise, i.round_off_paise,
               i.discount_approved_by, i.issued_at, i.issued_by
          from (${SUMMARY} where i.business_id = ${ctx.businessId} and i.id = ${id}
                  and i.status in ('ISSUED', 'CANCELLED')) s
          join lbg.invoices i on i.business_id = ${ctx.businessId} and i.id = s.id`.execute(trx)
    ).rows[0];
    if (!head) return null;
    const { rows: lines } = await sql<{
      line_no: number;
      variant_id: string;
      unit_id: string | null;
      description: string;
      hsn_code: string | null;
      quantity: string;
      unit_price_paise: string;
      gross_paise: string;
      discount_paise: string;
      invoice_discount_paise: string;
      tax_rate_percent: string;
      cess_percent: string;
      taxable_paise: string;
      cgst_paise: string;
      sgst_paise: string;
      igst_paise: string;
      cess_paise: string;
      line_total_paise: string;
      cost_paise: string | null;
    }>`select line_no, variant_id, unit_id, description, hsn_code, quantity::text as quantity, unit_price_paise,
              gross_paise, discount_paise, invoice_discount_paise, tax_rate_percent::text as tax_rate_percent,
              cess_percent::text as cess_percent, taxable_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
              line_total_paise, cost_paise
         from lbg.invoice_lines where business_id = ${ctx.businessId} and invoice_id = ${id} order by line_no`.execute(
      trx,
    );
    const { rows: payments } = await sql<{
      payment_id: string;
      method: string;
      reference: string | null;
      allocated: string;
    }>`select p.id as payment_id, p.method, p.reference, sum(a.amount_paise) as allocated
         from lbg.payment_allocations a join lbg.payments p on p.business_id = a.business_id and p.id = a.payment_id
        where a.business_id = ${ctx.businessId} and a.invoice_id = ${id}
        group by p.id, p.method, p.reference, p.received_at order by p.received_at, p.id`.execute(trx);
    return {
      ...toSummary(head),
      financialYear: head.financial_year,
      placeOfSupply: head.place_of_supply_state,
      partySnapshot: head.party_snapshot,
      grossPaise: Number(head.gross_paise),
      discountPaise: Number(head.discount_paise),
      taxablePaise: Number(head.taxable_paise),
      cgstPaise: Number(head.cgst_paise),
      sgstPaise: Number(head.sgst_paise),
      igstPaise: Number(head.igst_paise),
      cessPaise: Number(head.cess_paise),
      roundOffPaise: head.round_off_paise,
      discountApprovedBy: head.discount_approved_by,
      issuedAt: head.issued_at?.toISOString() ?? null,
      issuedBy: head.issued_by,
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        variantId: l.variant_id,
        unitId: l.unit_id,
        description: l.description,
        hsnCode: l.hsn_code,
        quantity: l.quantity,
        unitPricePaise: Number(l.unit_price_paise),
        grossPaise: Number(l.gross_paise),
        discountPaise: Number(l.discount_paise),
        invoiceDiscountPaise: Number(l.invoice_discount_paise),
        taxRatePercent: l.tax_rate_percent,
        cessPercent: l.cess_percent,
        taxablePaise: Number(l.taxable_paise),
        cgstPaise: Number(l.cgst_paise),
        sgstPaise: Number(l.sgst_paise),
        igstPaise: Number(l.igst_paise),
        cessPaise: Number(l.cess_paise),
        totalPaise: Number(l.line_total_paise),
        ...(options.canSeeCost ? { costPaise: l.cost_paise === null ? null : Number(l.cost_paise) } : {}),
      })),
      payments: payments.map((p) => ({
        paymentId: p.payment_id,
        method: p.method,
        reference: p.reference,
        allocatedPaise: Number(p.allocated),
      })),
    };
  });
}
