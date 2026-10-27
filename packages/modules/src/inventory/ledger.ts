// Stock ledger writes (FR-INV-4). Every stock change goes through here inside
// the caller's transaction; the database keeps the stock_levels projection
// and refuses negative stock (migration 0008).
import { canUnitTransition, type UnitStatus } from '@lbgos/domain';
import { sql } from 'kysely';
import type { TenantContext, Trx } from '@lbgos/db';

export type Bucket = 'AVAILABLE' | 'INSPECTION' | 'DAMAGED' | 'REPAIR';
export type MovementType =
  | 'OPENING'
  | 'PURCHASE'
  | 'SALE'
  | 'SALE_RETURN'
  | 'PURCHASE_RETURN'
  | 'DAMAGE'
  | 'ADJUSTMENT'
  | 'CORRECTION'
  | 'REVERSAL'
  | 'RECLASSIFY';

export interface MovementInput {
  readonly variantId: string;
  readonly unitId?: string | null;
  readonly type: MovementType;
  /** Signed quantity as exact decimal text, e.g. "-1" or "2.500". */
  readonly quantity: string;
  readonly bucket?: Bucket;
  readonly unitCostPaise?: number | null;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly reversesMovementId?: string;
  readonly reason?: string;
}

export class StockRuleError extends Error {
  readonly code: 'UNIT_NOT_FOUND' | 'INVALID_UNIT_TRANSITION';
  readonly unitId: string;

  constructor(code: StockRuleError['code'], unitId: string, message: string) {
    super(message);
    this.name = 'StockRuleError';
    this.code = code;
    this.unitId = unitId;
  }
}

export async function writeMovement(trx: Trx, ctx: TenantContext, m: MovementInput): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, bucket,
                                     unit_cost_paise, reference_type, reference_id, reverses_movement_id, reason,
                                     created_by)
    values (${ctx.businessId}, ${m.variantId}, ${m.unitId ?? null}, ${m.type}, ${m.quantity}::numeric,
            ${m.bucket ?? 'AVAILABLE'}, ${m.unitCostPaise ?? null}, ${m.referenceType ?? null}, ${m.referenceId ?? null},
            ${m.reversesMovementId ?? null}, ${m.reason ?? null}, ${ctx.userId})
    returning id`.execute(trx);
  const id = rows[0]?.id;
  if (!id) throw new Error('movement insert returned no id');
  return id;
}

export interface LockedUnit {
  readonly id: string;
  readonly variantId: string;
  readonly status: UnitStatus;
  readonly unitCostPaise: number;
}

/** Locks a unit row for the rest of the transaction (concurrent changes queue). */
export async function lockUnit(trx: Trx, ctx: TenantContext, unitId: string): Promise<LockedUnit> {
  const { rows } = await sql<{ id: string; variant_id: string; status: UnitStatus; unit_cost_paise: string }>`
    select id, variant_id, status, unit_cost_paise from lbg.serialized_units
     where business_id = ${ctx.businessId} and id = ${unitId} for update`.execute(trx);
  const r = rows[0];
  if (!r) throw new StockRuleError('UNIT_NOT_FOUND', unitId, 'unit not found');
  return { id: r.id, variantId: r.variant_id, status: r.status, unitCostPaise: Number(r.unit_cost_paise) };
}

/** Changes a locked unit's status if WORKFLOWS §4 allows it. */
export async function setUnitStatus(trx: Trx, ctx: TenantContext, unit: LockedUnit, to: UnitStatus): Promise<void> {
  if (!canUnitTransition(unit.status, to)) {
    throw new StockRuleError('INVALID_UNIT_TRANSITION', unit.id, `unit cannot go from ${unit.status} to ${to}`);
  }
  await sql`update lbg.serialized_units set status = ${to} where business_id = ${ctx.businessId} and id = ${unit.id}`.execute(
    trx,
  );
}
