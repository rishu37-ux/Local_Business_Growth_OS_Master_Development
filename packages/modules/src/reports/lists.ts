// List exports for the sections of the dashboard (Phase 14, D-073): the rows
// of a screen as an ExportTable, so CSV and XLSX use the report writers (with
// the formula guard of D-045). Each list has the permission that shows its
// screen; cost columns need catalogue.cost.view and online buyers are masked
// without customers.view, as on screen. Read inside the tenant context only.
import { GST_STATES } from '@lbgos/domain';
import { sql, type RawBuilder } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import type { ExportCell, ExportColumn, ExportTable } from './export.ts';

export const LIST_EXPORTS = {
  products: { title: 'Catalogue', anyOf: ['catalogue.view'], dated: false },
  stock: { title: 'Stock levels', anyOf: ['inventory.view'], dated: false },
  imeis: { title: 'Phones by IMEI', anyOf: ['inventory.view'], dated: false },
  suppliers: { title: 'Suppliers', anyOf: ['suppliers.view'], dated: false },
  purchases: { title: 'Purchases', anyOf: ['purchases.view'], dated: true },
  invoices: { title: 'Invoices', anyOf: ['customers.view'], dated: true },
  payments: { title: 'Payments received', anyOf: ['customer_ledger.view'], dated: true },
  expenses: { title: 'Expenses', anyOf: ['expenses.manage', 'reports.financial.view'], dated: true },
  'online-orders': { title: 'Online orders', anyOf: ['pos.sell', 'inventory.view'], dated: true },
} as const satisfies Record<string, { title: string; anyOf: readonly string[]; dated: boolean }>;
export type ListName = keyof typeof LIST_EXPORTS;

/** Above this the owner's full data export is the way (14.2). */
export const MAX_LIST_ROWS = 50_000;

export class ListExportError extends Error {
  readonly code = 'EXPORT_TOO_LARGE';

  constructor() {
    super(`More than ${String(MAX_LIST_ROWS)} rows: narrow the dates or use the full data download.`);
    this.name = 'ListExportError';
  }
}

export interface ListOptions {
  /** Business dates, inclusive; only for the dated lists. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly canSeeCost: boolean;
  readonly canSeeBuyer: boolean;
}

type Row = Record<string, ExportCell>;
const col = (key: string, label: string, kind: ExportColumn['kind'] = 'text'): ExportColumn => ({ key, label, kind });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const yes = (b: boolean) => (b ? 'Yes' : 'No');
const stateName = (code: string | null) => (code ? (GST_STATES[code] ?? code) : null);
/** `and <column>::date between from and to` when a range is given. */
const range = (column: RawBuilder<unknown>, o: ListOptions) =>
  o.from && o.to ? sql`and ${column} between ${o.from}::date and ${o.to}::date` : sql``;

async function build(db: Db, ctx: TenantContext, name: ListName, o: ListOptions) {
  return withTenant(db, ctx, async (trx) => {
    const b = ctx.businessId;
    const tz = sql`(select timezone from lbg.businesses where id = ${b})`;
    switch (name) {
      case 'products': {
        const { rows } = await sql<Record<string, unknown>>`
          select p.model_name, br.name as brand, c.name as category, p.model_number, v.ram, v.storage, v.colour,
                 v.sku, v.barcode, v.hsn_code, v.selling_price_paise, v.min_selling_price_paise, t.name as tax_rate,
                 p.is_serialized, v.warranty_months, v.reorder_level, v.status, v.avg_cost_paise,
                 v.purchase_price_paise
            from lbg.product_variants v
            join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
            left join lbg.brands br on br.business_id = p.business_id and br.id = p.brand_id
            left join lbg.categories c on c.business_id = p.business_id and c.id = p.category_id
            left join lbg.tax_rates t on t.business_id = v.business_id and t.id = v.tax_rate_id
           where v.business_id = ${b} order by p.model_name, v.sku limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('product', 'Product'),
            col('brand', 'Brand'),
            col('category', 'Category'),
            col('modelNumber', 'Model number'),
            col('ram', 'RAM'),
            col('storage', 'Storage'),
            col('colour', 'Colour'),
            col('sku', 'SKU'),
            col('barcode', 'Barcode'),
            col('hsn', 'HSN code'),
            col('price', 'Selling price', 'money'),
            col('minPrice', 'Minimum price', 'money'),
            col('taxRate', 'Tax rate'),
            col('serialized', 'Has IMEI/serial'),
            col('warranty', 'Warranty (months)', 'int'),
            col('reorder', 'Reorder level', 'int'),
            col('status', 'Status'),
            ...(o.canSeeCost
              ? [col('avgCost', 'Average cost', 'money'), col('lastCost', 'Last purchase price', 'money')]
              : []),
          ],
          rows: rows.map((r): Row => ({
            product: r.model_name as string,
            brand: r.brand as string | null,
            category: r.category as string | null,
            modelNumber: r.model_number as string | null,
            ram: r.ram as string | null,
            storage: r.storage as string | null,
            colour: r.colour as string | null,
            sku: r.sku as string,
            barcode: r.barcode as string | null,
            hsn: r.hsn_code as string | null,
            price: num(r.selling_price_paise),
            minPrice: num(r.min_selling_price_paise),
            taxRate: r.tax_rate as string | null,
            serialized: yes(r.is_serialized as boolean),
            warranty: num(r.warranty_months),
            reorder: num(r.reorder_level),
            status: r.status as string,
            ...(o.canSeeCost ? { avgCost: num(r.avg_cost_paise), lastCost: num(r.purchase_price_paise) } : {}),
          })),
        };
      }
      case 'stock': {
        const { rows } = await sql<Record<string, unknown>>`
          select p.model_name, concat_ws(' / ', v.ram, v.storage, v.colour) as variant, v.sku, v.reorder_level,
                 coalesce(sum(s.quantity) filter (where s.bucket = 'AVAILABLE'), 0)::text as available,
                 coalesce(sum(s.quantity) filter (where s.bucket = 'INSPECTION'), 0)::text as inspection,
                 coalesce(sum(s.quantity) filter (where s.bucket = 'DAMAGED'), 0)::text as damaged,
                 coalesce(sum(s.quantity) filter (where s.bucket = 'REPAIR'), 0)::text as repair,
                 round(coalesce(sum(s.quantity) filter (where s.bucket = 'AVAILABLE'), 0) * coalesce(v.avg_cost_paise, 0))::bigint as value
            from lbg.product_variants v
            join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
            left join lbg.stock_levels s on s.business_id = v.business_id and s.variant_id = v.id
           where v.business_id = ${b}
           group by p.model_name, v.ram, v.storage, v.colour, v.sku, v.reorder_level, v.avg_cost_paise
           order by p.model_name, v.sku limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('product', 'Product'),
            col('variant', 'Variant'),
            col('sku', 'SKU'),
            col('available', 'Available', 'qty'),
            col('inspection', 'Awaiting inspection', 'qty'),
            col('damaged', 'Damaged', 'qty'),
            col('repair', 'In repair', 'qty'),
            col('reorder', 'Reorder level', 'int'),
            ...(o.canSeeCost ? [col('value', 'Value at cost', 'money')] : []),
          ],
          rows: rows.map((r): Row => ({
            product: r.model_name as string,
            variant: (r.variant as string) || null,
            sku: r.sku as string,
            available: (r.available as string).replace(/\.?0+$/, '') || '0',
            inspection: (r.inspection as string).replace(/\.?0+$/, '') || '0',
            damaged: (r.damaged as string).replace(/\.?0+$/, '') || '0',
            repair: (r.repair as string).replace(/\.?0+$/, '') || '0',
            reorder: num(r.reorder_level),
            ...(o.canSeeCost ? { value: num(r.value) } : {}),
          })),
        };
      }
      case 'imeis': {
        const { rows } = await sql<Record<string, unknown>>`
          select (select i.imei from lbg.serialized_unit_imeis i where i.business_id = u.business_id and i.unit_id = u.id and i.slot = 1) as imei1,
                 (select i.imei from lbg.serialized_unit_imeis i where i.business_id = u.business_id and i.unit_id = u.id and i.slot = 2) as imei2,
                 u.serial_number, p.model_name, v.sku, u.status, (u.created_at at time zone ${tz})::date::text as received,
                 pu.supplier_invoice_no, su.name as supplier, u.unit_cost_paise
            from lbg.serialized_units u
            join lbg.product_variants v on v.business_id = u.business_id and v.id = u.variant_id
            join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
            left join lbg.purchases pu on pu.business_id = u.business_id and pu.id = u.purchase_id
            left join lbg.suppliers su on su.business_id = pu.business_id and su.id = pu.supplier_id
           where u.business_id = ${b} order by u.created_at desc, u.id limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('imei1', 'IMEI 1'),
            col('imei2', 'IMEI 2'),
            col('serial', 'Serial number'),
            col('product', 'Product'),
            col('sku', 'SKU'),
            col('status', 'Status'),
            col('received', 'Received on'),
            col('supplier', 'Supplier'),
            col('supplierInvoice', 'Supplier invoice'),
            ...(o.canSeeCost ? [col('cost', 'Cost', 'money')] : []),
          ],
          rows: rows.map((r): Row => ({
            imei1: r.imei1 as string | null,
            imei2: r.imei2 as string | null,
            serial: r.serial_number as string | null,
            product: r.model_name as string,
            sku: r.sku as string,
            status: r.status as string,
            received: r.received as string,
            supplier: r.supplier as string | null,
            supplierInvoice: r.supplier_invoice_no as string | null,
            ...(o.canSeeCost ? { cost: num(r.unit_cost_paise) } : {}),
          })),
        };
      }
      case 'suppliers': {
        const { rows } = await sql<Record<string, unknown>>`
          select name, gstin, state_code, mobile_e164, email::text as email, address, payment_terms, status
            from lbg.suppliers where business_id = ${b} order by name limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('name', 'Supplier'),
            col('gstin', 'GSTIN'),
            col('state', 'State'),
            col('mobile', 'Mobile'),
            col('email', 'Email'),
            col('address', 'Address'),
            col('terms', 'Payment terms'),
            col('status', 'Status'),
          ],
          rows: rows.map((r): Row => ({
            name: r.name as string,
            gstin: r.gstin as string | null,
            state: stateName(r.state_code as string | null),
            mobile: r.mobile_e164 as string | null,
            email: r.email as string | null,
            address: r.address as string | null,
            terms: r.payment_terms as string | null,
            status: r.status as string,
          })),
        };
      }
      case 'purchases': {
        const { rows } = await sql<Record<string, unknown>>`
          select p.supplier_invoice_date::text as date, s.name as supplier, p.supplier_invoice_no, p.status,
                 p.taxable_paise, p.cgst_paise, p.sgst_paise, p.igst_paise, p.cess_paise, p.total_paise,
                 (p.posted_at at time zone ${tz})::date::text as posted
            from lbg.purchases p left join lbg.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
           where p.business_id = ${b} ${range(sql`coalesce(p.supplier_invoice_date, (p.created_at at time zone ${tz})::date)`, o)}
           order by p.supplier_invoice_date desc nulls last, p.created_at desc limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('date', 'Bill date'),
            col('supplier', 'Supplier'),
            col('number', 'Supplier invoice'),
            col('status', 'Status'),
            col('taxable', 'Taxable value', 'money'),
            col('cgst', 'CGST', 'money'),
            col('sgst', 'SGST', 'money'),
            col('igst', 'IGST', 'money'),
            col('cess', 'Cess', 'money'),
            col('total', 'Total', 'money'),
            col('posted', 'Posted on'),
          ],
          rows: rows.map((r): Row => ({
            date: r.date as string | null,
            supplier: r.supplier as string | null,
            number: r.supplier_invoice_no as string | null,
            status: r.status as string,
            taxable: num(r.taxable_paise),
            cgst: num(r.cgst_paise),
            sgst: num(r.sgst_paise),
            igst: num(r.igst_paise),
            cess: num(r.cess_paise),
            total: num(r.total_paise),
            posted: r.posted as string | null,
          })),
        };
      }
      case 'invoices': {
        const { rows } = await sql<Record<string, unknown>>`
          select i.invoice_number, i.invoice_date::text as date, i.document_type, i.status,
                 coalesce(i.party_snapshot ->> 'name', c.name) as customer, c.mobile_e164,
                 i.place_of_supply_state, i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.cess_paise,
                 i.total_paise,
                 coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                            where a.business_id = i.business_id and a.invoice_id = i.id), 0) as paid
            from lbg.invoices i left join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id
           where i.business_id = ${b} and i.status in ('ISSUED', 'CANCELLED') ${range(sql`i.invoice_date`, o)}
           order by i.invoice_date desc, i.invoice_number desc limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        const DOC: Record<string, string> = {
          TAX_INVOICE: 'Tax invoice',
          BILL_OF_SUPPLY: 'Bill of supply',
          CREDIT_NOTE: 'Credit note',
          DEBIT_NOTE: 'Debit note',
        };
        return {
          columns: [
            col('number', 'Number'),
            col('date', 'Date'),
            col('type', 'Document'),
            col('status', 'Status'),
            col('customer', 'Customer'),
            col('mobile', 'Mobile'),
            col('pos', 'Place of supply'),
            col('taxable', 'Taxable value', 'money'),
            col('cgst', 'CGST', 'money'),
            col('sgst', 'SGST', 'money'),
            col('igst', 'IGST', 'money'),
            col('cess', 'Cess', 'money'),
            col('total', 'Total', 'money'),
            col('paid', 'Paid', 'money'),
          ],
          rows: rows.map((r): Row => ({
            number: r.invoice_number as string,
            date: r.date as string,
            type: DOC[r.document_type as string] ?? (r.document_type as string),
            status: r.status as string,
            customer: r.customer as string | null,
            mobile: r.mobile_e164 as string | null,
            pos: stateName(r.place_of_supply_state as string | null),
            taxable: num(r.taxable_paise),
            cgst: num(r.cgst_paise),
            sgst: num(r.sgst_paise),
            igst: num(r.igst_paise),
            cess: num(r.cess_paise),
            total: num(r.total_paise),
            paid: num(r.paid),
          })),
        };
      }
      case 'payments': {
        const { rows } = await sql<Record<string, unknown>>`
          select (p.received_at at time zone ${tz})::date::text as date, c.name as customer, p.method, p.amount_paise,
                 p.reference, p.reverses_payment_id is not null as reversal
            from lbg.payments p left join lbg.customers c on c.business_id = p.business_id and c.id = p.customer_id
           where p.business_id = ${b} ${range(sql`(p.received_at at time zone ${tz})::date`, o)}
           order by p.received_at desc, p.id limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('date', 'Date'),
            col('customer', 'Customer'),
            col('method', 'Method'),
            col('amount', 'Amount', 'money'),
            col('reference', 'Reference'),
            col('reversal', 'Reversal'),
          ],
          rows: rows.map((r): Row => ({
            date: r.date as string,
            customer: r.customer as string | null,
            method: r.method as string,
            amount: num(r.amount_paise),
            reference: r.reference as string | null,
            reversal: yes(r.reversal as boolean),
          })),
        };
      }
      case 'expenses': {
        const { rows } = await sql<Record<string, unknown>>`
          select expense_date::text as date, category, amount_paise, method, reference, notes,
                 reverses_expense_id is not null as reversal
            from lbg.expenses where business_id = ${b} ${range(sql`expense_date`, o)}
           order by expense_date desc, created_at desc limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('date', 'Date'),
            col('category', 'Category'),
            col('amount', 'Amount', 'money'),
            col('method', 'Method'),
            col('reference', 'Reference'),
            col('notes', 'Notes'),
            col('reversal', 'Reversal'),
          ],
          rows: rows.map((r): Row => ({
            date: r.date as string,
            category: r.category as string,
            amount: num(r.amount_paise),
            method: r.method as string | null,
            reference: r.reference as string | null,
            notes: r.notes as string | null,
            reversal: yes(r.reversal as boolean),
          })),
        };
      }
      case 'online-orders': {
        const { rows } = await sql<Record<string, unknown>>`
          select (o.placed_at at time zone ${tz})::text as placed, c.name as channel, o.external_order_id,
                 o.platform_status, o.status, o.customer_name, o.customer_mobile, o.buyer_email, o.buyer_gstin,
                 o.ship_to, o.payment_method, o.payment_status, o.fulfilled_by, o.tracking_id, o.total_paise,
                 o.marketplace_fees_paise, i.invoice_number, i.status as invoice_status,
                 (select string_agg(l.quantity || ' × ' || coalesce(l.title, l.external_sku), '; ' order by l.id)
                    from lbg.channel_order_lines l where l.business_id = o.business_id and l.order_id = o.id) as items
            from lbg.channel_orders o
            join lbg.sales_channels c on c.business_id = o.business_id and c.id = o.channel_id
            left join lbg.invoices i on i.business_id = o.business_id and i.id = o.sale_id
           where o.business_id = ${b} ${range(sql`(o.placed_at at time zone ${tz})::date`, o)}
           order by o.placed_at desc, o.id limit ${MAX_LIST_ROWS + 1}`.execute(trx);
        return {
          columns: [
            col('placed', 'Received'),
            col('channel', 'Channel'),
            col('orderId', 'Platform order ID'),
            col('platformStatus', 'Status on the platform'),
            col('state', 'Our status'),
            col('buyer', 'Buyer'),
            col('mobile', 'Mobile'),
            col('email', 'Email'),
            col('gstin', 'GSTIN'),
            col('address', 'Delivery address'),
            col('city', 'City'),
            col('stateName', 'State'),
            col('pincode', 'PIN code'),
            col('payment', 'Payment'),
            col('paymentStatus', 'Payment status'),
            col('fulfilledBy', 'Shipped by'),
            col('tracking', 'Tracking ID'),
            col('items', 'Items'),
            col('total', 'Order total', 'money'),
            col('fees', 'Marketplace fees', 'money'),
            col('invoice', 'Invoice'),
          ],
          rows: rows.map((r): Row => {
            const ship = r.ship_to as Record<string, string | null> | null;
            const name = r.customer_name as string | null;
            const mobile = r.customer_mobile as string | null;
            const billed = r.invoice_status === 'ISSUED' || r.invoice_status === 'CANCELLED';
            const street = ship ? [ship.line1, ship.line2, ship.landmark].filter(Boolean).join(', ') : '';
            return {
              placed: (r.placed as string).slice(0, 16),
              channel: r.channel as string,
              orderId: r.external_order_id as string,
              platformStatus: r.platform_status as string | null,
              state: r.status === 'CANCELLED' ? 'Cancelled' : billed ? 'Billed' : 'Open',
              // Masked as on screen without customers.view (D-072).
              buyer: o.canSeeBuyer ? name : name ? `${name.slice(0, 1)}…` : null,
              mobile: o.canSeeBuyer ? mobile : mobile ? `••••••${mobile.slice(-4)}` : null,
              email: o.canSeeBuyer ? (r.buyer_email as string | null) : null,
              gstin: o.canSeeBuyer ? (r.buyer_gstin as string | null) : null,
              address: o.canSeeBuyer && street ? street : null,
              city: ship?.city ?? null,
              stateName: ship?.state ?? null,
              pincode: ship?.pincode ?? null,
              payment: r.payment_method as string | null,
              paymentStatus: r.payment_status as string | null,
              fulfilledBy: r.fulfilled_by as string | null,
              tracking: r.tracking_id as string | null,
              items: r.items as string | null,
              total: num(r.total_paise),
              fees: num(r.marketplace_fees_paise),
              invoice: billed ? (r.invoice_number as string | null) : null,
            };
          }),
        };
      }
    }
  });
}

/** 14.2 AC1: the rows of one section as an export table. */
export async function listExport(db: Db, ctx: TenantContext, name: ListName, o: ListOptions): Promise<ExportTable> {
  const { columns, rows } = await build(db, ctx, name, o);
  if (rows.length > MAX_LIST_ROWS) throw new ListExportError();
  const shop = await withTenant(db, ctx, async (trx) => {
    const { rows: r } = await sql<{ name: string }>`
      select coalesce(display_name, legal_name) as name from lbg.businesses where id = ${ctx.businessId}`.execute(trx);
    return r[0]?.name ?? '';
  });
  const period = LIST_EXPORTS[name].dated && o.from && o.to ? `${o.from} to ${o.to} · ` : '';
  return { title: LIST_EXPORTS[name].title, subtitle: `${period}${shop}`, columns, rows };
}
