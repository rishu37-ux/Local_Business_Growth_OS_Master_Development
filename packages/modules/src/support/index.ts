// Owner-granted, time-boxed platform support access (increment 10.1:
// FR-SUP-1, threat T8, D-067). The owner grants and revokes; the database
// bounds the grant to 72 hours and allows one revocation. Access itself is
// resolved by tenancy's loadBusinessAccess; this module records each use.
import { SUPPORT_MAX_HOURS } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export class SupportError extends Error {
  readonly code: 'NOT_FOUND' | 'ALREADY_REVOKED' | 'DURATION_INVALID';

  constructor(code: SupportError['code'], message: string) {
    super(message);
    this.name = 'SupportError';
    this.code = code;
  }
}

export interface SupportGrant {
  readonly id: string;
  readonly purpose: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

export interface SupportAction {
  readonly at: string;
  readonly action: string;
  readonly actorUserId: string | null;
  readonly method: string | null;
  readonly route: string | null;
  readonly grantId: string | null;
  /** True for a request support made but was not allowed to (any change). */
  readonly refused: boolean;
}

interface GrantRow {
  id: string;
  purpose: string;
  granted_by: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  active: boolean;
}

const toGrant = (r: GrantRow): SupportGrant => ({
  id: r.id,
  purpose: r.purpose,
  grantedBy: r.granted_by,
  grantedAt: new Date(r.granted_at).toISOString(),
  expiresAt: new Date(r.expires_at).toISOString(),
  revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  status: r.revoked_at ? 'REVOKED' : r.active ? 'ACTIVE' : 'EXPIRED',
});

const GRANT_COLUMNS = sql`id, purpose, granted_by, granted_at, expires_at, revoked_at,
                          (revoked_at is null and expires_at > now()) as active`;

export async function grantSupport(
  db: Db,
  ctx: TenantContext,
  input: { readonly purpose: string; readonly hours: number },
  requestId?: string,
): Promise<SupportGrant> {
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > SUPPORT_MAX_HOURS)
    throw new SupportError('DURATION_INVALID', `Choose between 1 and ${String(SUPPORT_MAX_HOURS)} hours.`);
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<GrantRow>`
      insert into lbg.support_grants (business_id, granted_by, purpose, expires_at)
      values (${ctx.businessId}, ${ctx.userId}, ${input.purpose}, now() + make_interval(hours => ${input.hours}))
      returning ${GRANT_COLUMNS}`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('support grant not created');
    await recordTenantEvent(trx, ctx, {
      action: 'support.granted',
      targetType: 'support_grant',
      targetId: row.id,
      metadata: { hours: input.hours },
      ...(requestId ? { requestId } : {}),
    });
    return toGrant(row);
  });
}

export async function revokeSupport(
  db: Db,
  ctx: TenantContext,
  grantId: string,
  requestId?: string,
): Promise<SupportGrant> {
  return withTenant(db, ctx, async (trx) => {
    const current = await sql<{ revoked_at: Date | null }>`
      select revoked_at from lbg.support_grants where id = ${grantId} for update`.execute(trx);
    const row = current.rows[0];
    if (!row) throw new SupportError('NOT_FOUND', 'Not found.');
    if (row.revoked_at) throw new SupportError('ALREADY_REVOKED', 'This support access was already revoked.');
    const { rows } = await sql<GrantRow>`
      update lbg.support_grants set revoked_by = ${ctx.userId} where id = ${grantId}
      returning ${GRANT_COLUMNS}`.execute(trx);
    const updated = rows[0];
    if (!updated) throw new SupportError('NOT_FOUND', 'Not found.');
    await recordTenantEvent(trx, ctx, {
      action: 'support.revoked',
      targetType: 'support_grant',
      targetId: grantId,
      ...(requestId ? { requestId } : {}),
    });
    return toGrant(updated);
  });
}

/** The business's grants (newest first) and the last 200 support events, for the owner. */
export async function supportOverview(
  db: Db,
  ctx: TenantContext,
): Promise<{ grants: SupportGrant[]; actions: SupportAction[] }> {
  return withTenant(db, ctx, async (trx) => {
    const grants = await sql<GrantRow>`
      select ${GRANT_COLUMNS} from lbg.support_grants order by granted_at desc, id limit 100`.execute(trx);
    const events = await sql<{
      created_at: Date;
      action: string;
      actor_user_id: string | null;
      metadata: { method?: string; route?: string; grantId?: string; refused?: boolean };
      target_id: string | null;
    }>`
      select created_at, action, actor_user_id, metadata, target_id from lbg.audit_events
       where action like 'support.%' order by created_at desc, id limit 200`.execute(trx);
    return {
      grants: grants.rows.map(toGrant),
      actions: events.rows.map((e) => ({
        at: new Date(e.created_at).toISOString(),
        action: e.action,
        actorUserId: e.actor_user_id,
        method: e.metadata.method ?? null,
        route: e.metadata.route ?? null,
        grantId: e.metadata.grantId ?? e.target_id,
        refused: e.metadata.refused === true,
      })),
    };
  });
}

/**
 * FR-SUP-1 AC2: one tenant audit event per request made under a grant, with
 * the route pattern (never the query or body, which may hold personal data).
 */
export async function recordSupportAccess(
  db: Db,
  ctx: TenantContext,
  use: {
    readonly grantId: string;
    readonly method: string;
    readonly route: string;
    readonly requestId: string;
    readonly refused: boolean;
  },
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await sql`insert into lbg.audit_events (scope, business_id, actor_type, actor_user_id, action, target_type,
                                            target_id, request_id, metadata)
              values ('TENANT', ${ctx.businessId}, 'PLATFORM_ADMIN', ${ctx.userId}, 'support.access', 'support_grant',
                      ${use.grantId}, ${use.requestId},
                      ${JSON.stringify({ method: use.method, route: use.route, grantId: use.grantId, refused: use.refused })}::jsonb)`.execute(
      trx,
    );
  });
}
