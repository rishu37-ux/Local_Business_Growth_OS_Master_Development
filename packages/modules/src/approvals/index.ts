// Approval requests (WORKFLOWS §11, FR-INV-4 AC4, rule R3). A request stores
// the exact action payload and its SHA-256; approving requires the decider to
// have seen that same hash. Execution runs once, in the approving transaction,
// through an executor supplied by the module that owns the action.
import { createHash } from 'node:crypto';
import type { EffectiveGrant } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export const APPROVAL_TTL_HOURS = 72;

export type ApprovalStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'EXECUTED' | 'EXECUTION_FAILED';

/** Runs an approved action; throws to fail it. Returns a small result summary. */
export type ApprovalExecutor = (
  trx: Trx,
  ctx: TenantContext,
  payload: unknown,
  requestId: string,
) => Promise<Record<string, unknown>>;

/** The decider's effective permissions (a Map carries limits, e.g. for pos.discount). */
export type DeciderPermissions = ReadonlySet<string> | ReadonlyMap<string, EffectiveGrant>;

/** An executor with an extra check on the decider, beyond holding the required permission. */
export interface ApprovalAction {
  readonly execute: ApprovalExecutor;
  /** Returns why this decider may not approve the payload (e.g. above their limit), or null. */
  readonly authorize?: (permissions: DeciderPermissions, payload: unknown) => string | null;
}

export class ApprovalError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'NOT_PENDING'
    | 'EXPIRED'
    | 'PAYLOAD_CHANGED'
    | 'SELF_APPROVAL'
    | 'FORBIDDEN'
    | 'NOTE_REQUIRED'
    | 'NOT_REQUESTER'
    | 'UNKNOWN_ACTION';

  constructor(code: ApprovalError['code'], message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** JSON with object keys sorted, so equal payloads always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const payloadHash = (payload: unknown): string =>
  createHash('sha256').update(canonicalJson(payload)).digest('hex');

export async function createApprovalRequest(
  trx: Trx,
  ctx: TenantContext,
  input: {
    readonly actionType: string;
    readonly payload: unknown;
    readonly requiredPermission: string;
    readonly reason: string;
  },
): Promise<{ id: string; payloadSha256: string }> {
  const hash = payloadHash(input.payload);
  const { rows } = await sql<{ id: string }>`
    insert into lbg.approval_requests (business_id, requested_by, action_type, payload, payload_sha256,
                                       required_permission, reason, expires_at)
    values (${ctx.businessId}, ${ctx.userId}, ${input.actionType}, ${canonicalJson(input.payload)}::jsonb, ${hash},
            ${input.requiredPermission}, ${input.reason}, now() + make_interval(hours => ${APPROVAL_TTL_HOURS}))
    returning id`.execute(trx);
  const id = rows[0]?.id ?? '';
  await recordTenantEvent(trx, ctx, {
    action: 'approval.request',
    targetType: 'approval_request',
    targetId: id,
    metadata: { actionType: input.actionType },
  });
  return { id, payloadSha256: hash };
}

export interface ApprovalRequest {
  readonly id: string;
  readonly actionType: string;
  readonly payload: unknown;
  readonly payloadSha256: string;
  readonly requiredPermission: string;
  readonly reason: string | null;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly requestedByName: string | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  readonly errorCode: string | null;
  readonly result: unknown;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface Row {
  id: string;
  action_type: string;
  payload: unknown;
  payload_sha256: string;
  required_permission: string;
  reason: string | null;
  status: ApprovalStatus;
  requested_by: string;
  requested_by_name: string | null;
  decided_by: string | null;
  decision_note: string | null;
  error_code: string | null;
  result: unknown;
  created_at: Date;
  expires_at: Date;
}

const toRequest = (r: Row): ApprovalRequest => ({
  id: r.id,
  actionType: r.action_type,
  payload: r.payload,
  payloadSha256: r.payload_sha256,
  requiredPermission: r.required_permission,
  reason: r.reason,
  status: r.status,
  requestedBy: r.requested_by,
  requestedByName: r.requested_by_name,
  decidedBy: r.decided_by,
  decisionNote: r.decision_note,
  errorCode: r.error_code,
  result: r.result,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

const SELECT = sql`select a.id, a.action_type, a.payload, a.payload_sha256, a.required_permission, a.reason, a.status,
                          a.requested_by, u.display_name as requested_by_name, a.decided_by, a.decision_note,
                          a.error_code, a.result, a.created_at, a.expires_at
                     from lbg.approval_requests a left join lbg.users u on u.id = a.requested_by`;

/** Pending requests past their expiry become EXPIRED (lazily, on read or decision). */
async function expireDue(trx: Trx, ctx: TenantContext): Promise<void> {
  await sql`update lbg.approval_requests set status = 'EXPIRED'
             where business_id = ${ctx.businessId} and status = 'PENDING' and expires_at <= now()`.execute(trx);
}

export async function listApprovals(
  db: Db,
  ctx: TenantContext,
  filter: { readonly status?: ApprovalStatus | undefined; readonly requestedBy?: string | undefined } = {},
): Promise<ApprovalRequest[]> {
  return withTenant(db, ctx, async (trx) => {
    await expireDue(trx, ctx);
    const { rows } = await sql<Row>`${SELECT}
      where a.business_id = ${ctx.businessId}
        ${filter.status ? sql`and a.status = ${filter.status}` : sql``}
        ${filter.requestedBy ? sql`and a.requested_by = ${filter.requestedBy}` : sql``}
      order by a.created_at desc limit 200`.execute(trx);
    return rows.map(toRequest);
  });
}

const pgCode = (err: unknown) => (err as { code?: string }).code;
const errorCodeOf = (err: unknown): string => {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code)) return code;
  if (code === 'LB015' || pgCode(err) === 'LB015') return 'INSUFFICIENT_STOCK';
  return 'EXECUTION_ERROR';
};

/**
 * Approves or rejects a pending request. `permissions` are the decider's
 * effective permissions; `payloadSha256` is the hash the decider reviewed.
 */
export async function decideApproval(
  db: Db,
  ctx: TenantContext,
  permissions: DeciderPermissions,
  id: string,
  decision: {
    readonly approve: boolean;
    readonly payloadSha256: string;
    readonly note?: string | undefined;
    readonly requestId?: string | undefined;
  },
  executors: Readonly<Record<string, ApprovalExecutor | ApprovalAction>>,
): Promise<ApprovalRequest> {
  return withTenant(db, ctx, async (trx) => {
    await expireDue(trx, ctx);
    const row = (
      await sql<Row>`${SELECT} where a.business_id = ${ctx.businessId} and a.id = ${id} for update of a`.execute(trx)
    ).rows[0];
    if (!row) throw new ApprovalError('NOT_FOUND', 'approval request not found');
    if (row.status === 'EXPIRED') throw new ApprovalError('EXPIRED', 'This request has expired.');
    if (row.status !== 'PENDING')
      throw new ApprovalError('NOT_PENDING', `This request is ${row.status.toLowerCase()}.`);
    if (!permissions.has(row.required_permission)) {
      throw new ApprovalError('FORBIDDEN', 'You do not hold the permission this request needs.');
    }
    if (decision.payloadSha256 !== row.payload_sha256) {
      throw new ApprovalError('PAYLOAD_CHANGED', 'The request differs from what you reviewed. Reload it.');
    }
    // R3: no self-approval while someone else could approve.
    let selfApproved = false;
    if (row.requested_by === ctx.userId) {
      const holders = await sql<{
        id: string;
      }>`select lbg.members_with_permission(${row.required_permission}) as id`.execute(trx);
      if (holders.rows.some((h) => h.id !== ctx.userId)) {
        throw new ApprovalError('SELF_APPROVAL', 'Another member must approve your own request.');
      }
      selfApproved = true;
    }
    const note = decision.note?.trim() ?? null;
    if (!decision.approve) {
      if (!note || note.length < 10)
        throw new ApprovalError('NOTE_REQUIRED', 'Give a reason of at least 10 characters.');
      await sql`update lbg.approval_requests set status = 'REJECTED', decided_by = ${ctx.userId}, decided_at = now(),
                  decision_note = ${note} where id = ${id}`.execute(trx);
      await recordTenantEvent(trx, ctx, {
        action: 'approval.reject',
        targetType: 'approval_request',
        targetId: id,
        ...(decision.requestId ? { requestId: decision.requestId } : {}),
      });
    } else {
      const entry = executors[row.action_type];
      if (!entry) throw new ApprovalError('UNKNOWN_ACTION', `no executor for ${row.action_type}`);
      const action = typeof entry === 'function' ? { execute: entry } : entry;
      const refusal = action.authorize?.(permissions, row.payload) ?? null;
      if (refusal) throw new ApprovalError('FORBIDDEN', refusal);
      await sql`update lbg.approval_requests set status = 'APPROVED', decided_by = ${ctx.userId}, decided_at = now(),
                  decision_note = ${note} where id = ${id}`.execute(trx);
      // Execution failures (e.g. the stock is no longer there) are recorded
      // on the request; only the execution's own writes are rolled back.
      await sql`savepoint approval_execution`.execute(trx);
      try {
        const result = await action.execute(trx, ctx, row.payload, id);
        await sql`release savepoint approval_execution`.execute(trx);
        await sql`update lbg.approval_requests set status = 'EXECUTED', executed_at = now(), result = ${JSON.stringify(result)}::jsonb
                   where id = ${id}`.execute(trx);
      } catch (err) {
        await sql`rollback to savepoint approval_execution`.execute(trx);
        await sql`update lbg.approval_requests set status = 'EXECUTION_FAILED', executed_at = now(), error_code = ${errorCodeOf(err)}
                   where id = ${id}`.execute(trx);
      }
      await recordTenantEvent(trx, ctx, {
        action: 'approval.approve',
        targetType: 'approval_request',
        targetId: id,
        metadata: { actionType: row.action_type, selfApproved },
        ...(decision.requestId ? { requestId: decision.requestId } : {}),
      });
    }
    const after = (await sql<Row>`${SELECT} where a.id = ${id}`.execute(trx)).rows[0];
    if (!after) throw new ApprovalError('NOT_FOUND', 'approval request not found');
    return toRequest(after);
  });
}

/** The requester withdraws a pending request. */
export async function cancelApproval(db: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await expireDue(trx, ctx);
    const { rows } = await sql<{ status: ApprovalStatus; requested_by: string }>`
      select status, requested_by from lbg.approval_requests where business_id = ${ctx.businessId} and id = ${id} for update`.execute(
      trx,
    );
    const r = rows[0];
    if (!r) throw new ApprovalError('NOT_FOUND', 'approval request not found');
    if (r.requested_by !== ctx.userId)
      throw new ApprovalError('NOT_REQUESTER', 'Only the requester can cancel this request.');
    if (r.status !== 'PENDING') throw new ApprovalError('NOT_PENDING', `This request is ${r.status.toLowerCase()}.`);
    await sql`update lbg.approval_requests set status = 'CANCELLED' where id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, { action: 'approval.cancel', targetType: 'approval_request', targetId: id });
  });
}
