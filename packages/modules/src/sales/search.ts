// Product search at the counter (FR-POS-1 AC1–2). A 15-digit code is first
// tried as an IMEI (the unit itself is returned, ready to sell); otherwise
// variants match by barcode, SKU, model name, model number or variant details.
// Serialized variants list their in-stock units so the cashier can pick one.
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';

export interface PosUnit {
  readonly unitId: string;
  readonly imeis: readonly string[];
  readonly serialNumber: string | null;
}

export interface PosItem {
  readonly variantId: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly serialized: boolean;
  readonly sellingPricePaise: number;
  readonly priceIncludesTax: boolean;
  /** Sellable quantity (thousandths as decimal text). */
  readonly available: string;
  /** In-stock units (serialized items only, at most 20). */
  readonly units: readonly PosUnit[];
}

export interface PosSearchResult {
  /** Set when the code is the IMEI or serial number of an in-stock unit. */
  readonly unit: (PosUnit & { readonly variantId: string }) | null;
  readonly items: readonly PosItem[];
}

export async function posSearch(db: Db, ctx: TenantContext, query: string): Promise<PosSearchResult> {
  const q = query.trim();
  if (q.length === 0) return { unit: null, items: [] };
  return withTenant(db, ctx, async (trx) => {
    const { rows: hit } = await sql<{ unit_id: string; variant_id: string }>`
      select u.id as unit_id, u.variant_id from lbg.serialized_units u
       where u.business_id = ${ctx.businessId} and u.status = 'IN_STOCK'
         and (exists (select 1 from lbg.serialized_unit_imeis i
                       where i.business_id = u.business_id and i.unit_id = u.id and i.imei = ${q})
              or u.serial_number = ${q})
       limit 1`.execute(trx);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { rows } = await sql<{
      variant_id: string;
      sku: string;
      barcode: string | null;
      name: string;
      serialized: boolean;
      price: string;
      includes_tax: boolean;
      available: string;
    }>`
      select v.id as variant_id, v.sku, v.barcode,
             p.model_name || coalesce(' ' || nullif(concat_ws(' / ', v.ram, v.storage, v.colour), ''), '') as name,
             p.is_serialized as serialized, v.selling_price_paise as price, v.price_includes_tax as includes_tax,
             coalesce((select l.quantity from lbg.stock_levels l where l.business_id = v.business_id
                         and l.variant_id = v.id and l.bucket = 'AVAILABLE'), 0)::numeric(12,3)::text as available
        from lbg.product_variants v
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where v.business_id = ${ctx.businessId} and v.status = 'ACTIVE' and p.status = 'ACTIVE'
         and (${hit[0] ? sql`v.id = ${hit[0].variant_id}` : sql`false`}
              or v.barcode = ${q} or v.sku ilike ${pattern} or p.model_name ilike ${pattern}
              or p.model_number ilike ${pattern} or concat_ws(' ', v.ram, v.storage, v.colour) ilike ${pattern})
       order by (v.barcode = ${q}) desc nulls last, (lower(v.sku) = lower(${q})) desc, p.model_name, v.sku
       limit 20`.execute(trx);
    const serializedIds = rows.filter((r) => r.serialized).map((r) => r.variant_id);
    const { rows: units } = await sql<{
      id: string;
      variant_id: string;
      serial_number: string | null;
      imeis: string[];
    }>`
      select u.id, u.variant_id, u.serial_number,
             coalesce(array(select i.imei from lbg.serialized_unit_imeis i
                             where i.business_id = u.business_id and i.unit_id = u.id order by i.slot), '{}') as imeis
        from lbg.serialized_units u
       where u.business_id = ${ctx.businessId} and u.status = 'IN_STOCK' and u.variant_id = any(${serializedIds}::uuid[])
       order by u.created_at, u.id`.execute(trx);
    const unitsOf = (variantId: string) =>
      units
        .filter((u) => u.variant_id === variantId)
        .slice(0, 20)
        .map((u) => ({ unitId: u.id, imeis: u.imeis, serialNumber: u.serial_number }));
    const items = rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      barcode: r.barcode,
      name: r.name,
      serialized: r.serialized,
      sellingPricePaise: Number(r.price),
      priceIncludesTax: r.includes_tax,
      available: r.available,
      units: r.serialized ? unitsOf(r.variant_id) : [],
    }));
    const h = hit[0];
    const unit = h ? (units.find((u) => u.id === h.unit_id) ?? null) : null;
    return {
      unit:
        unit && h
          ? { unitId: unit.id, variantId: h.variant_id, imeis: unit.imeis, serialNumber: unit.serial_number }
          : null,
      items,
    };
  });
}
