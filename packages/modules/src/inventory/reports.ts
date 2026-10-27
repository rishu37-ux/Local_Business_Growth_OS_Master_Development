// Stock reports and code lookup (FR-INV-7 AC2–3, FR-INV-9 AC1). Sales are
// SALE movements (net of SALE_RETURN); purchase orders do not exist yet, so
// "on order" is reported as 0 and labelled as such.
import {
  classifyAge,
  milliToQuantity,
  quantityToMilli,
  REORDER_FORMULA,
  reorderSuggestion,
  type MovementAge,
} from '@lbgos/domain';
import { sql, type RawBuilder } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';

const toMilli = (text: string) => (text.startsWith('-') ? -quantityToMilli(text.slice(1)) : quantityToMilli(text));

export interface AgedStockRow {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly available: string;
  readonly lastSaleAt: string | null;
  readonly firstReceivedAt: string | null;
  readonly daysWithoutSale: number;
  readonly age: MovementAge;
}

export async function agedStock(
  db: Db,
  ctx: TenantContext,
  options: { readonly slowDays: number; readonly deadDays: number; readonly now?: Date },
): Promise<{ slowDays: number; deadDays: number; rows: AgedStockRow[] }> {
  const now = options.now ?? new Date();
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      variant_id: string;
      sku: string;
      model_name: string;
      available: string;
      last_sale: Date | null;
      first_in: Date | null;
    }>`
      select v.id as variant_id, v.sku, p.model_name, l.quantity::text as available,
             (select max(m.created_at) from lbg.stock_movements m
               where m.business_id = v.business_id and m.variant_id = v.id and m.movement_type = 'SALE') as last_sale,
             (select min(m.created_at) from lbg.stock_movements m
               where m.business_id = v.business_id and m.variant_id = v.id and m.quantity_delta > 0
                 and m.movement_type in ('PURCHASE', 'OPENING', 'ADJUSTMENT')) as first_in
        from lbg.stock_levels l
        join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where l.business_id = ${ctx.businessId} and l.bucket = 'AVAILABLE' and l.quantity > 0
         and v.status = 'ACTIVE'`.execute(trx);
    const day = 24 * 60 * 60 * 1000;
    const out = rows
      .map((r) => {
        const since = r.last_sale ?? r.first_in;
        const days = since ? Math.floor((now.getTime() - since.getTime()) / day) : 0;
        return {
          variantId: r.variant_id,
          sku: r.sku,
          productName: r.model_name,
          available: r.available,
          lastSaleAt: r.last_sale?.toISOString() ?? null,
          firstReceivedAt: r.first_in?.toISOString() ?? null,
          daysWithoutSale: days,
          age: classifyAge(days, options.slowDays, options.deadDays),
        };
      })
      .filter((r) => r.age !== 'ACTIVE')
      .sort((a, b) => b.daysWithoutSale - a.daysWithoutSale);
    return { slowDays: options.slowDays, deadDays: options.deadDays, rows: out };
  });
}

export interface ReorderRow {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly onHand: string;
  readonly reorderLevel: number | null;
  readonly soldInWindow: string;
  readonly averageDailySales: string;
  readonly suggestedQuantity: string;
  readonly suggestedUnits: number;
}

export interface ReorderReport {
  readonly label: 'suggestion';
  readonly formula: string;
  readonly period: { readonly from: string; readonly to: string; readonly days: number };
  readonly leadTimeDays: number;
  readonly onOrderNote: string;
  readonly rows: readonly ReorderRow[];
}

export async function reorderReport(
  db: Db,
  ctx: TenantContext,
  options: { readonly windowDays: number; readonly leadTimeDays: number; readonly now?: Date },
): Promise<ReorderReport> {
  const to = options.now ?? new Date();
  const from = new Date(to.getTime() - options.windowDays * 24 * 60 * 60 * 1000);
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      variant_id: string;
      sku: string;
      model_name: string;
      reorder_level: number | null;
      on_hand: string;
      sold: string;
    }>`
      select v.id as variant_id, v.sku, p.model_name, v.reorder_level,
             coalesce((select sum(l.quantity) from lbg.stock_levels l
                        where l.business_id = v.business_id and l.variant_id = v.id and l.bucket = 'AVAILABLE'), 0)::numeric(12,3)::text as on_hand,
             coalesce((select -sum(m.quantity_delta) from lbg.stock_movements m
                        where m.business_id = v.business_id and m.variant_id = v.id
                          and m.movement_type in ('SALE', 'SALE_RETURN')
                          and m.created_at > ${from} and m.created_at <= ${to}), 0)::numeric(12,3)::text as sold
        from lbg.product_variants v
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where v.business_id = ${ctx.businessId} and v.status = 'ACTIVE' and p.status = 'ACTIVE'
       order by lower(p.model_name), v.sku`.execute(trx);
    const out = rows
      .map((r): ReorderRow => {
        const s = reorderSuggestion({
          soldMilli: toMilli(r.sold),
          windowDays: options.windowDays,
          leadTimeDays: options.leadTimeDays,
          reorderLevel: r.reorder_level,
          onHandMilli: toMilli(r.on_hand),
          onOrderMilli: 0,
        });
        return {
          variantId: r.variant_id,
          sku: r.sku,
          productName: r.model_name,
          onHand: r.on_hand,
          reorderLevel: r.reorder_level,
          soldInWindow: r.sold,
          averageDailySales: milliToQuantity(s.averageDailyMilli),
          suggestedQuantity: milliToQuantity(s.suggestedMilli),
          suggestedUnits: s.suggestedUnits,
        };
      })
      .filter((r) => r.suggestedUnits > 0);
    return {
      label: 'suggestion',
      formula: REORDER_FORMULA,
      period: { from: from.toISOString(), to: to.toISOString(), days: options.windowDays },
      leadTimeDays: options.leadTimeDays,
      onOrderNote: 'Purchase orders are not tracked yet; "on order" is counted as 0.',
      rows: out,
    };
  });
}

export type LookupResult =
  | {
      readonly match: 'BARCODE' | 'SKU';
      readonly variantId: string;
      readonly productId: string;
      readonly sku: string;
      readonly productName: string;
    }
  | {
      readonly match: 'IMEI';
      readonly variantId: string;
      readonly productId: string;
      readonly sku: string;
      readonly productName: string;
      readonly unitId: string;
      readonly unitStatus: string;
    };

/** Resolves a scanned/typed code: exact barcode, then SKU (case-insensitive), then IMEI. */
export async function lookupCode(
  db: Db,
  ctx: TenantContext,
  code: string,
  options: { readonly includeUnits: boolean },
): Promise<LookupResult | null> {
  const c = code.trim();
  if (!c) return null;
  return withTenant(db, ctx, async (trx) => {
    const byVariant = async (where: RawBuilder<unknown>) =>
      (
        await sql<{ variant_id: string; product_id: string; sku: string; model_name: string }>`
          select v.id as variant_id, p.id as product_id, v.sku, p.model_name from lbg.product_variants v
            join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
           where v.business_id = ${ctx.businessId} and ${where} limit 1`.execute(trx)
      ).rows[0];
    const barcode = await byVariant(sql`v.barcode = ${c}`);
    const toVariant = (r: { variant_id: string; product_id: string; sku: string; model_name: string }) => ({
      variantId: r.variant_id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.model_name,
    });
    if (barcode) return { match: 'BARCODE', ...toVariant(barcode) };
    const sku = await byVariant(sql`lower(v.sku) = lower(${c})`);
    if (sku) return { match: 'SKU', ...toVariant(sku) };
    if (!options.includeUnits || !/^\d{15}$/.test(c)) return null;
    const { rows } = await sql<{
      variant_id: string;
      product_id: string;
      sku: string;
      model_name: string;
      unit_id: string;
      status: string;
    }>`
      select v.id as variant_id, p.id as product_id, v.sku, p.model_name, u.id as unit_id, u.status
        from lbg.serialized_unit_imeis i
        join lbg.serialized_units u on u.business_id = i.business_id and u.id = i.unit_id
        join lbg.product_variants v on v.business_id = u.business_id and v.id = u.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where i.business_id = ${ctx.businessId} and i.imei = ${c}`.execute(trx);
    const u = rows[0];
    return u ? { match: 'IMEI', ...toVariant(u), unitId: u.unit_id, unitStatus: u.status } : null;
  });
}
