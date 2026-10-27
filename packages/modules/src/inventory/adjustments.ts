// Stock adjustments, damage write-offs and corrections (FR-INV-4 AC2, AC4).
// Holders of inventory.adjust.approve act directly; holders of only
// inventory.adjust.request raise an approval request that an approver executes.
import { randomUUID } from 'node:crypto';
import { milliToQuantity, quantityToMilli, UNIT_BUCKET } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { createApprovalRequest, type ApprovalExecutor } from '../approvals/index.ts';
import { recordTenantEvent } from '../audit/index.ts';
import { lockUnit, setUnitStatus, StockRuleError, writeMovement } from './ledger.ts';

export const ADJUSTMENT_ACTION = 'inventory.adjustment';

export type AdjustmentAction =
  /** Non-serialized count correction in AVAILABLE; signed quantity ("-2", "3.5"). */
  | { readonly kind: 'QUANTITY'; readonly variantId: string; readonly quantity: string; readonly reason: string }
  /** Non-serialized damaged goods written off from AVAILABLE; positive quantity. */
  | { readonly kind: 'DAMAGE'; readonly variantId: string; readonly quantity: string; readonly reason: string }
  /** A serialized unit (IN_STOCK or DAMAGED) written off. */
  | { readonly kind: 'UNIT_WRITE_OFF'; readonly unitId: string; readonly reason: string }
  /** Reverses a wrong adjustment movement; enter the right one afterwards. */
  | { readonly kind: 'CORRECTION'; readonly movementId: string; readonly reason: string };

export class InventoryError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'NOT_ALLOWED'
    | 'ALREADY_REVERSED'
    | 'INSUFFICIENT_STOCK'
    | 'INVALID_UNIT_TRANSITION'
    | 'INVALID_QUANTITY';

  constructor(code: InventoryError['code'], message: string) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
  }
}

async function variantFacts(trx: Trx, ctx: TenantContext, variantId: string) {
  const { rows } = await sql<{ is_serialized: boolean; avg_cost_paise: string | null }>`
    select p.is_serialized, v.avg_cost_paise from lbg.product_variants v
      join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
     where v.business_id = ${ctx.businessId} and v.id = ${variantId}`.execute(trx);
  const r = rows[0];
  if (!r) throw new InventoryError('NOT_FOUND', 'variant not found');
  return { serialized: r.is_serialized, avgCost: r.avg_cost_paise === null ? null : Number(r.avg_cost_paise) };
}

function signedMilli(text: string): number {
  const negative = text.trim().startsWith('-');
  const milli = quantityToMilli(negative ? text.trim().slice(1) : text);
  return negative ? -milli : milli;
}

/** Checks that the action refers to real records of this business and is well-formed. */
async function validate(trx: Trx, ctx: TenantContext, a: AdjustmentAction): Promise<void> {
  if (a.reason.trim().length < 10)
    throw new InventoryError('NOT_ALLOWED', 'A reason of at least 10 characters is required.');
  if (a.kind === 'QUANTITY' || a.kind === 'DAMAGE') {
    let milli: number;
    try {
      milli = signedMilli(a.quantity);
    } catch {
      throw new InventoryError('INVALID_QUANTITY', 'invalid quantity');
    }
    if (milli === 0 || (a.kind === 'DAMAGE' && milli < 0))
      throw new InventoryError('INVALID_QUANTITY', 'invalid quantity');
    const v = await variantFacts(trx, ctx, a.variantId);
    if (v.serialized) throw new InventoryError('NOT_ALLOWED', 'Serialized stock is adjusted unit by unit.');
    return;
  }
  if (a.kind === 'UNIT_WRITE_OFF') {
    const { rows } =
      await sql`select 1 from lbg.serialized_units where business_id = ${ctx.businessId} and id = ${a.unitId}`.execute(
        trx,
      );
    if (rows.length === 0) throw new InventoryError('NOT_FOUND', 'unit not found');
    return;
  }
  const { rows } =
    await sql`select 1 from lbg.stock_movements where business_id = ${ctx.businessId} and id = ${a.movementId}`.execute(
      trx,
    );
  if (rows.length === 0) throw new InventoryError('NOT_FOUND', 'movement not found');
}

const pgCode = (err: unknown) => (err as { code?: string }).code;

/** Executes an adjustment inside the caller's transaction; returns the movements written. */
export async function executeAdjustment(
  trx: Trx,
  ctx: TenantContext,
  a: AdjustmentAction,
  reference: { readonly type: 'ADJUSTMENT' | 'APPROVAL'; readonly id: string },
): Promise<{ movementIds: string[] }> {
  await validate(trx, ctx, a);
  const ref = { referenceType: reference.type, referenceId: reference.id, reason: a.reason.trim() };
  try {
    if (a.kind === 'QUANTITY' || a.kind === 'DAMAGE') {
      const v = await variantFacts(trx, ctx, a.variantId);
      const milli = signedMilli(a.quantity);
      const id = await writeMovement(trx, ctx, {
        ...ref,
        variantId: a.variantId,
        type: a.kind === 'QUANTITY' ? 'ADJUSTMENT' : 'DAMAGE',
        quantity: milliToQuantity(a.kind === 'DAMAGE' ? -milli : milli),
        unitCostPaise: v.avgCost,
      });
      return { movementIds: [id] };
    }
    if (a.kind === 'UNIT_WRITE_OFF') {
      const unit = await lockUnit(trx, ctx, a.unitId);
      const bucket = UNIT_BUCKET[unit.status];
      await setUnitStatus(trx, ctx, unit, 'WRITTEN_OFF');
      if (!bucket) throw new InventoryError('INVALID_UNIT_TRANSITION', 'unit is not in stock');
      const id = await writeMovement(trx, ctx, {
        ...ref,
        variantId: unit.variantId,
        unitId: unit.id,
        type: bucket === 'DAMAGED' ? 'DAMAGE' : 'ADJUSTMENT',
        quantity: '-1',
        bucket,
        unitCostPaise: unit.unitCostPaise,
      });
      return { movementIds: [id] };
    }
    // CORRECTION: only adjustment-type movements without a unit; purchases are reversed as documents.
    const { rows } = await sql<{
      variant_id: string;
      unit_id: string | null;
      movement_type: string;
      quantity_delta: string;
      bucket: 'AVAILABLE' | 'INSPECTION' | 'DAMAGED' | 'REPAIR';
      unit_cost_paise: string | null;
    }>`select variant_id, unit_id, movement_type, quantity_delta::text as quantity_delta, bucket, unit_cost_paise
         from lbg.stock_movements where business_id = ${ctx.businessId} and id = ${a.movementId}`.execute(trx);
    const m = rows[0];
    if (!m) throw new InventoryError('NOT_FOUND', 'movement not found');
    if (m.unit_id !== null || !['ADJUSTMENT', 'DAMAGE', 'OPENING', 'CORRECTION'].includes(m.movement_type)) {
      throw new InventoryError(
        'NOT_ALLOWED',
        'Only quantity adjustments can be corrected here; documents are reversed as documents.',
      );
    }
    const id = await writeMovement(trx, ctx, {
      ...ref,
      variantId: m.variant_id,
      type: 'REVERSAL',
      quantity: milliToQuantity(-signedMilli(m.quantity_delta)),
      bucket: m.bucket,
      unitCostPaise: m.unit_cost_paise === null ? null : Number(m.unit_cost_paise),
      reversesMovementId: a.movementId,
    });
    return { movementIds: [id] };
  } catch (err) {
    if (err instanceof StockRuleError) throw new InventoryError('INVALID_UNIT_TRANSITION', err.message);
    if (pgCode(err) === 'LB015')
      throw new InventoryError('INSUFFICIENT_STOCK', 'There is not enough stock for this change.');
    if (pgCode(err) === '23505') throw new InventoryError('ALREADY_REVERSED', 'This movement was already corrected.');
    throw err;
  }
}

/** Approval executor for ADJUSTMENT_ACTION (payload = the stored action). */
export const adjustmentExecutor: ApprovalExecutor = (trx, ctx, payload, requestId) =>
  executeAdjustment(trx, ctx, payload as AdjustmentAction, { type: 'APPROVAL', id: requestId });

export type AdjustmentOutcome =
  | { readonly status: 'EXECUTED'; readonly movementIds: readonly string[] }
  | { readonly status: 'PENDING_APPROVAL'; readonly approvalRequestId: string; readonly payloadSha256: string };

/** Direct execution for approvers; an approval request for everyone else. */
export async function adjustStock(
  db: Db,
  ctx: TenantContext,
  canApprove: boolean,
  action: AdjustmentAction,
  requestId?: string,
): Promise<AdjustmentOutcome> {
  return withTenant(db, ctx, async (trx) => {
    if (canApprove) {
      const { movementIds } = await executeAdjustment(trx, ctx, action, { type: 'ADJUSTMENT', id: randomUUID() });
      await recordTenantEvent(trx, ctx, {
        action: 'inventory.adjust',
        targetType:
          action.kind === 'UNIT_WRITE_OFF' ? 'unit' : action.kind === 'CORRECTION' ? 'stock_movement' : 'variant',
        targetId:
          action.kind === 'UNIT_WRITE_OFF'
            ? action.unitId
            : action.kind === 'CORRECTION'
              ? action.movementId
              : action.variantId,
        metadata: { kind: action.kind, movementIds },
        ...(requestId ? { requestId } : {}),
      });
      return { status: 'EXECUTED', movementIds };
    }
    await validate(trx, ctx, action);
    const created = await createApprovalRequest(trx, ctx, {
      actionType: ADJUSTMENT_ACTION,
      payload: action,
      requiredPermission: 'inventory.adjust.approve',
      reason: action.reason.trim(),
    });
    return { status: 'PENDING_APPROVAL', approvalRequestId: created.id, payloadSha256: created.payloadSha256 };
  });
}
