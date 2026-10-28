// Resolves what a user may do in one business (FR-RBAC-1, D-009, D-010). Read
// fresh on every request (rule R5) inside the tenant's RLS context.
import {
  accessMode,
  effectivePermissions,
  implicitPermissions,
  OWNER_ROLE_NAME,
  SUPPORT_PERMISSIONS,
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
  /** Set when the access comes from an owner's support grant (FR-SUP-1), not a membership. */
  readonly support?: { readonly grantId: string; readonly expiresAt: Date };
}

/** The role name shown for access through a support grant. */
export const SUPPORT_ROLE_NAME = 'Platform support (read-only)';

export async function loadBusinessAccess(
  db: Db,
  businessId: string,
  userId: string,
  options: { readonly platformAdmin?: boolean } = {},
): Promise<BusinessAccess | null> {
  return withTenant(db, { businessId, userId }, async (trx) => {
    const membership = await sql<{ id: string }>`
      select id from lbg.memberships where user_id = ${userId} and business_id = ${businessId} and status = 'ACTIVE'`.execute(
      trx,
    );
    const membershipId = membership.rows[0]?.id;
    if (!membershipId) {
      // FR-SUP-1: a platform admin who is not a member may read the business only under an active grant.
      if (options.platformAdmin !== true) return null;
      const grant = await sql<{ id: string; expires_at: Date; status: BusinessStatus }>`
        select g.id, g.expires_at, b.status from lbg.support_grants g join lbg.businesses b on b.id = g.business_id
         where g.business_id = ${businessId} and g.revoked_at is null and g.expires_at > now()
         order by g.expires_at desc limit 1`.execute(trx);
      const g = grant.rows[0];
      if (!g) return null;
      return {
        businessId,
        membershipId: '',
        businessStatus: g.status,
        isOwner: false,
        roles: [SUPPORT_ROLE_NAME],
        mode: 'READ_ONLY',
        permissions: effectivePermissions(SUPPORT_PERMISSIONS.map((key) => ({ key }))),
        support: { grantId: g.id, expiresAt: new Date(g.expires_at) },
      };
    }

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
