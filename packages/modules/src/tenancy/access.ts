// Resolves what a user may do in one business (FR-RBAC-1, D-009, D-010). Read
// fresh on every request (rule R5) inside the tenant's RLS context.
import {
  accessMode,
  effectivePermissions,
  implicitPermissions,
  OWNER_ROLE_NAME,
  type AccessMode,
  type BusinessStatus,
  type EffectiveGrant,
  type PermissionLimits,
  type SubscriptionStatus,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db } from '@lbgos/db';

export interface BusinessAccess {
  readonly businessId: string;
  readonly membershipId: string;
  readonly businessStatus: BusinessStatus;
  readonly isOwner: boolean;
  readonly roles: readonly string[];
  readonly mode: AccessMode;
  /** Role grants plus mode-implicit grants; mode restrictions are applied by the caller. */
  readonly permissions: ReadonlyMap<string, EffectiveGrant>;
}

export async function loadBusinessAccess(db: Db, businessId: string, userId: string): Promise<BusinessAccess | null> {
  return withTenant(db, { businessId, userId }, async (trx) => {
    const membership = await sql<{ id: string }>`
      select id from lbg.memberships where user_id = ${userId} and business_id = ${businessId} and status = 'ACTIVE'`.execute(
      trx,
    );
    const membershipId = membership.rows[0]?.id;
    if (!membershipId) return null;

    const business = await sql<{
      status: BusinessStatus;
    }>`select status from lbg.businesses where id = ${businessId}`.execute(trx);
    const businessStatus = business.rows[0]?.status;
    if (!businessStatus) return null;

    const grants = await sql<{ role: string; is_system: boolean; key: string | null; limits: PermissionLimits | null }>`
      select r.name as role, r.is_system, rp.permission_key as key, rp.limits
        from lbg.membership_roles mr
        join lbg.roles r on r.business_id = mr.business_id and r.id = mr.role_id
        left join lbg.role_permissions rp on rp.business_id = r.business_id and rp.role_id = r.id
       where mr.business_id = ${businessId} and mr.membership_id = ${membershipId}`.execute(trx);

    // The renewal that failed is assumed to have been due at the end of the
    // current period, so the grace period starts there.
    const subscription = await sql<{ status: SubscriptionStatus; current_period_end: Date; grace_days: number }>`
      select status, current_period_end, grace_days from lbg.subscriptions
       where business_id = ${businessId} order by current_period_start desc limit 1`.execute(trx);

    const roles = [...new Set(grants.rows.map((g) => g.role))];
    const isOwner = grants.rows.some((g) => g.is_system && g.role === OWNER_ROLE_NAME);
    const sub = subscription.rows[0];
    const mode = accessMode({
      businessStatus,
      isOwner,
      ...(sub
        ? { subscription: { status: sub.status, graceDays: sub.grace_days, pastDueSince: sub.current_period_end } }
        : {}),
    });
    const permissions = effectivePermissions([
      ...grants.rows.flatMap((g) => (g.key ? [{ key: g.key, limits: g.limits }] : [])),
      ...implicitPermissions(mode).map((key) => ({ key })),
    ]);
    return { businessId, membershipId, businessStatus, isOwner, roles, mode, permissions };
  });
}
