// Stock reads: levels, units, movements, reconciliation (FR-INV-4 AC3).
import type { UnitStatus } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';

export interface StockRow {
  readonly variantId: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly variantLabel: string;
  readonly serialized: boolean;
  /** Quantities per bucket as exact decimal text. */
  readonly available: string;
  readonly inspection: string;
  readonly damaged: string;
  readonly repair: string;
  readonly reorderLevel: number | null;
  /** available ≤ reorder level (FR-INV-7 AC1). */
  readonly low: boolean;
  /** Present only with catalogue.cost.view: cost of AVAILABLE stock. */
  readonly availableValuePaise?: number;
}

export async function stockOverview(
  db: Db,
  ctx: TenantContext,
  options: {
    readonly search?: string | undefined;
    readonly lowOnly?: boolean | undefined;
    readonly canSeeCost: boolean;
  },
): Promise<StockRow[]> {
  return withTenant(db, ctx, async (trx) => {
    const search = options.search?.trim();
    const pattern = search ? `%${search.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
    const { rows } = await sql<{
      variant_id: string;
      sku: string;
      barcode: string | null;
      product_id: string;
      model_name: string;
      label: string;
      is_serialized: boolean;
      available: string;
      inspection: string;
      damaged: string;
      repair: string;
      reorder_level: number | null;
      value: string | null;
    }>`
      with lv as (
        select variant_id,
               sum(quantity) filter (where bucket = 'AVAILABLE') as available,
               sum(quantity) filter (where bucket = 'INSPECTION') as inspection,
               sum(quantity) filter (where bucket = 'DAMAGED') as damaged,
               sum(quantity) filter (where bucket = 'REPAIR') as repair
          from lbg.stock_levels where business_id = ${ctx.businessId} group by variant_id
      )
      select v.id as variant_id, v.sku, v.barcode, p.id as product_id, p.model_name,
             concat_ws(' / ', v.ram, v.storage, v.colour) as label, p.is_serialized,
             coalesce(lv.available, 0)::numeric(12,3)::text as available,
             coalesce(lv.inspection, 0)::numeric(12,3)::text as inspection,
             coalesce(lv.damaged, 0)::numeric(12,3)::text as damaged,
             coalesce(lv.repair, 0)::numeric(12,3)::text as repair,
             v.reorder_level,
             case when p.is_serialized then
                    (select coalesce(sum(u.unit_cost_paise), 0) from lbg.serialized_units u
                      where u.business_id = v.business_id and u.variant_id = v.id and u.status in ('IN_STOCK', 'RESERVED'))
                  else round(greatest(coalesce(lv.available, 0), 0) * coalesce(v.avg_cost_paise, 0)) end::text as value
        from lbg.product_variants v
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
        left join lv on lv.variant_id = v.id
       where v.business_id = ${ctx.businessId} and v.status = 'ACTIVE' and p.status = 'ACTIVE'
         ${pattern ? sql`and (p.model_name ilike ${pattern} or v.sku ilike ${pattern} or v.barcode = ${search})` : sql``}
         ${options.lowOnly ? sql`and v.reorder_level is not null and coalesce(lv.available, 0) <= v.reorder_level` : sql``}
       order by lower(p.model_name), v.sku
       limit 1000`.execute(trx);
    return rows.map((r) => {
      const base: StockRow = {
        variantId: r.variant_id,
        sku: r.sku,
        barcode: r.barcode,
        productId: r.product_id,
        productName: r.model_name,
        variantLabel: r.label,
        serialized: r.is_serialized,
        available: r.available,
        inspection: r.inspection,
        damaged: r.damaged,
        repair: r.repair,
        reorderLevel: r.reorder_level,
        low: r.reorder_level !== null && Number(r.available) <= r.reorder_level,
      };
      return options.canSeeCost ? { ...base, availableValuePaise: Number(r.value ?? 0) } : base;
    });
  });
}

export interface UnitRow {
  readonly id: string;
  readonly variantId: string;
  readonly sku: string;
  readonly status: UnitStatus;
  readonly imei1: string | null;
  readonly imei2: string | null;
  readonly serialNumber: string | null;
  readonly purchaseId: string | null;
  readonly createdAt: string;
  readonly unitCostPaise?: number;
}

export async function listUnits(
  db: Db,
  ctx: TenantContext,
  filter: {
    readonly variantId?: string | undefined;
    readonly status?: UnitStatus | undefined;
    readonly imei?: string | undefined;
    readonly canSeeCost: boolean;
  },
): Promise<UnitRow[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      variant_id: string;
      sku: string;
      status: UnitStatus;
      imei1: string | null;
      imei2: string | null;
      serial_number: string | null;
      purchase_id: string | null;
      created_at: Date;
      unit_cost_paise: string;
    }>`
      select u.id, u.variant_id, v.sku, u.status, i1.imei as imei1, i2.imei as imei2, u.serial_number, u.purchase_id,
             u.created_at, u.unit_cost_paise
        from lbg.serialized_units u
        join lbg.product_variants v on v.business_id = u.business_id and v.id = u.variant_id
        left join lbg.serialized_unit_imeis i1 on i1.business_id = u.business_id and i1.unit_id = u.id and i1.slot = 1
        left join lbg.serialized_unit_imeis i2 on i2.business_id = u.business_id and i2.unit_id = u.id and i2.slot = 2
       where u.business_id = ${ctx.businessId}
         ${filter.variantId ? sql`and u.variant_id = ${filter.variantId}` : sql``}
         ${filter.status ? sql`and u.status = ${filter.status}` : sql``}
         ${filter.imei ? sql`and (i1.imei = ${filter.imei} or i2.imei = ${filter.imei})` : sql``}
       order by u.created_at desc limit 1000`.execute(trx);
    return rows.map((r) => {
      const base: UnitRow = {
        id: r.id,
        variantId: r.variant_id,
        sku: r.sku,
        status: r.status,
        imei1: r.imei1,
        imei2: r.imei2,
        serialNumber: r.serial_number,
        purchaseId: r.purchase_id,
        createdAt: r.created_at.toISOString(),
      };
      return filter.canSeeCost ? { ...base, unitCostPaise: Number(r.unit_cost_paise) } : base;
    });
  });
}

export interface MovementRow {
  readonly id: string;
  readonly variantId: string;
  readonly sku: string;
  readonly unitId: string | null;
  readonly type: string;
  readonly bucket: string;
  readonly quantity: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly reversesMovementId: string | null;
  readonly reason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly unitCostPaise?: number | null;
}

export async function listMovements(
  db: Db,
  ctx: TenantContext,
  filter: {
    readonly variantId?: string | undefined;
    readonly unitId?: string | undefined;
    readonly canSeeCost: boolean;
  },
): Promise<MovementRow[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      variant_id: string;
      sku: string;
      unit_id: string | null;
      movement_type: string;
      bucket: string;
      quantity_delta: string;
      reference_type: string | null;
      reference_id: string | null;
      reverses_movement_id: string | null;
      reason: string | null;
      created_by: string | null;
      created_at: Date;
      unit_cost_paise: string | null;
    }>`
      select m.id, m.variant_id, v.sku, m.unit_id, m.movement_type, m.bucket, m.quantity_delta::text as quantity_delta,
             m.reference_type, m.reference_id, m.reverses_movement_id, m.reason, m.created_by, m.created_at, m.unit_cost_paise
        from lbg.stock_movements m
        join lbg.product_variants v on v.business_id = m.business_id and v.id = m.variant_id
       where m.business_id = ${ctx.businessId}
         ${filter.variantId ? sql`and m.variant_id = ${filter.variantId}` : sql``}
         ${filter.unitId ? sql`and m.unit_id = ${filter.unitId}` : sql``}
       order by m.created_at desc, m.id limit 500`.execute(trx);
    return rows.map((r) => {
      const base: MovementRow = {
        id: r.id,
        variantId: r.variant_id,
        sku: r.sku,
        unitId: r.unit_id,
        type: r.movement_type,
        bucket: r.bucket,
        quantity: r.quantity_delta,
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        reversesMovementId: r.reverses_movement_id,
        reason: r.reason,
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
      };
      return filter.canSeeCost
        ? { ...base, unitCostPaise: r.unit_cost_paise === null ? null : Number(r.unit_cost_paise) }
        : base;
    });
  });
}

export interface Mismatch {
  readonly variantId: string;
  readonly bucket: string;
  readonly projected: string;
  readonly ledger: string;
}

/** Differences between stock_levels and Σ stock_movements (should always be empty). */
export async function reconcileStock(db: Db, ctx: TenantContext): Promise<Mismatch[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ variant_id: string; bucket: string; projected: string; ledger: string }>`
      select variant_id, bucket, projected::text as projected, ledger::text as ledger from lbg.stock_level_mismatches()`.execute(
      trx,
    );
    return rows.map((r) => ({ variantId: r.variant_id, bucket: r.bucket, projected: r.projected, ledger: r.ledger }));
  });
}
