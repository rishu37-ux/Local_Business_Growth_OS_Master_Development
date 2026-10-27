// Inspection of returned or repaired goods (FR-INV-6, WORKFLOWS §4, §8).
// Only RESTOCK makes goods sellable again (AC3). Outcomes move stock between
// buckets with RECLASSIFY pairs; RETURN_TO_SUPPLIER takes it out of stock.
import { milliToQuantity, quantityToMilli, type UnitStatus } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { InventoryError } from './adjustments.ts';
import { lockUnit, setUnitStatus, StockRuleError, writeMovement, type Bucket } from './ledger.ts';

export type InspectionOutcome = 'RESTOCK' | 'DAMAGED' | 'REPAIR' | 'RETURN_TO_SUPPLIER' | 'REPAIRED';

const TARGET: Readonly<Record<InspectionOutcome, { bucket: Bucket | null; status: UnitStatus }>> = {
  RESTOCK: { bucket: 'AVAILABLE', status: 'IN_STOCK' },
  DAMAGED: { bucket: 'DAMAGED', status: 'DAMAGED' },
  REPAIR: { bucket: 'REPAIR', status: 'IN_REPAIR' },
  RETURN_TO_SUPPLIER: { bucket: null, status: 'RETURNED_TO_SUPPLIER' },
  REPAIRED: { bucket: 'INSPECTION', status: 'PENDING_INSPECTION' },
};

export type InspectionInput =
  | { readonly unitId: string; readonly outcome: InspectionOutcome; readonly notes?: string | undefined }
  | {
      readonly variantId: string;
      /** Positive exact decimal text. */
      readonly quantity: string;
      readonly outcome: InspectionOutcome;
      readonly notes?: string | undefined;
    };

const pgCode = (err: unknown) => (err as { code?: string }).code;

async function move(
  trx: Trx,
  ctx: TenantContext,
  args: {
    variantId: string;
    unitId: string | null;
    quantity: string;
    from: Bucket;
    to: Bucket | null;
    unitCostPaise: number | null;
    inspectionId: string;
    notes: string | null;
  },
) {
  const ref = {
    referenceType: 'INSPECTION',
    referenceId: args.inspectionId,
    ...(args.notes ? { reason: args.notes } : {}),
  };
  const base = { variantId: args.variantId, unitId: args.unitId, unitCostPaise: args.unitCostPaise, ...ref };
  if (args.to === null) {
    await writeMovement(trx, ctx, {
      ...base,
      type: 'PURCHASE_RETURN',
      quantity: `-${args.quantity}`,
      bucket: args.from,
    });
    return;
  }
  await writeMovement(trx, ctx, { ...base, type: 'RECLASSIFY', quantity: `-${args.quantity}`, bucket: args.from });
  await writeMovement(trx, ctx, { ...base, type: 'RECLASSIFY', quantity: args.quantity, bucket: args.to });
}

/** Records an inspection outcome (needs returns.inspect, checked by the API). */
export async function recordInspection(
  db: Db,
  ctx: TenantContext,
  input: InspectionInput,
  requestId?: string,
): Promise<{ inspectionId: string }> {
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  const from: Bucket = input.outcome === 'REPAIRED' ? 'REPAIR' : 'INSPECTION';
  const target = TARGET[input.outcome];
  return withTenant(db, ctx, async (trx) => {
    try {
      let variantId: string;
      let unitId: string | null = null;
      let quantity = '1';
      let unitCost: number | null = null;
      if ('unitId' in input) {
        const unit = await lockUnit(trx, ctx, input.unitId);
        const expected: UnitStatus = from === 'REPAIR' ? 'IN_REPAIR' : 'PENDING_INSPECTION';
        if (unit.status !== expected) {
          throw new InventoryError(
            'INVALID_UNIT_TRANSITION',
            `The unit is ${unit.status.toLowerCase()}, not awaiting this step.`,
          );
        }
        await setUnitStatus(trx, ctx, unit, target.status);
        variantId = unit.variantId;
        unitId = unit.id;
        unitCost = unit.unitCostPaise;
      } else {
        let milli: number;
        try {
          milli = quantityToMilli(input.quantity);
        } catch {
          throw new InventoryError('INVALID_QUANTITY', 'invalid quantity');
        }
        if (milli === 0) throw new InventoryError('INVALID_QUANTITY', 'invalid quantity');
        const { rows } = await sql<{ is_serialized: boolean; avg_cost_paise: string | null }>`
          select p.is_serialized, v.avg_cost_paise from lbg.product_variants v
            join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
           where v.business_id = ${ctx.businessId} and v.id = ${input.variantId}`.execute(trx);
        const v = rows[0];
        if (!v) throw new InventoryError('NOT_FOUND', 'variant not found');
        if (v.is_serialized) throw new InventoryError('NOT_ALLOWED', 'Serialized goods are inspected unit by unit.');
        variantId = input.variantId;
        quantity = milliToQuantity(milli);
        unitCost = v.avg_cost_paise === null ? null : Number(v.avg_cost_paise);
      }
      const { rows } = await sql<{ id: string }>`
        insert into lbg.inspections (business_id, variant_id, unit_id, quantity, from_bucket, outcome, notes, inspected_by)
        values (${ctx.businessId}, ${variantId}, ${unitId}, ${quantity}::numeric, ${from}, ${input.outcome}, ${notes},
                ${ctx.userId})
        returning id`.execute(trx);
      const inspectionId = rows[0]?.id ?? '';
      await move(trx, ctx, {
        variantId,
        unitId,
        quantity,
        from,
        to: target.bucket,
        unitCostPaise: unitCost,
        inspectionId,
        notes,
      });
      await recordTenantEvent(trx, ctx, {
        action: 'inventory.inspect',
        targetType: unitId ? 'unit' : 'variant',
        targetId: unitId ?? variantId,
        metadata: { outcome: input.outcome, quantity, inspectionId },
        ...(requestId ? { requestId } : {}),
      });
      return { inspectionId };
    } catch (err) {
      if (err instanceof StockRuleError) {
        throw new InventoryError(err.code === 'UNIT_NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_UNIT_TRANSITION', err.message);
      }
      if (pgCode(err) === 'LB015')
        throw new InventoryError('INSUFFICIENT_STOCK', 'Not that much is awaiting this step.');
      throw err;
    }
  });
}

export interface InspectionQueueItem {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly unitId: string | null;
  readonly imei1: string | null;
  readonly status: 'PENDING_INSPECTION' | 'IN_REPAIR';
  /** For non-serialized goods: quantity in the bucket. */
  readonly quantity: string;
}

/** Everything awaiting inspection or back from repair. */
export async function inspectionQueue(db: Db, ctx: TenantContext): Promise<InspectionQueueItem[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      variant_id: string;
      sku: string;
      model_name: string;
      unit_id: string | null;
      imei1: string | null;
      status: 'PENDING_INSPECTION' | 'IN_REPAIR';
      quantity: string;
    }>`
      select u.variant_id, v.sku, p.model_name, u.id as unit_id, i.imei as imei1, u.status, '1.000' as quantity
        from lbg.serialized_units u
        join lbg.product_variants v on v.business_id = u.business_id and v.id = u.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
        left join lbg.serialized_unit_imeis i on i.business_id = u.business_id and i.unit_id = u.id and i.slot = 1
       where u.business_id = ${ctx.businessId} and u.status in ('PENDING_INSPECTION', 'IN_REPAIR')
      union all
      select l.variant_id, v.sku, p.model_name, null, null,
             case l.bucket when 'INSPECTION' then 'PENDING_INSPECTION' else 'IN_REPAIR' end, l.quantity::text
        from lbg.stock_levels l
        join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where l.business_id = ${ctx.businessId} and l.bucket in ('INSPECTION', 'REPAIR') and l.quantity > 0
         and not p.is_serialized
       order by 3, 2`.execute(trx);
    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      productName: r.model_name,
      unitId: r.unit_id,
      imei1: r.imei1,
      status: r.status,
      quantity: r.quantity,
    }));
  });
}
