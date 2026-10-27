// Member and role assignment rules (ROLES_PERMISSIONS.md §5: R1, R2, R4).
import { OWNER_ROLE_NAME } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import type { BusinessAccess } from './access.ts';

export class MemberRuleError extends Error {
  readonly code: 'LAST_OWNER' | 'GRANT_EXCEEDS_OWN' | 'SELF_CHANGE' | 'NOT_FOUND' | 'OWNER_PROTECTED';

  constructor(code: MemberRuleError['code'], message: string) {
    super(message);
    this.name = 'MemberRuleError';
    this.code = code;
  }
}

export interface Member {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly roles: readonly string[];
}

export async function listMembers(db: Db, ctx: TenantContext): Promise<Member[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      user_id: string;
      email: string;
      display_name: string;
      status: string;
      roles: string[] | null;
    }>`select m.id, m.user_id, u.email, u.display_name, m.status,
              array_agg(r.name order by r.name) filter (where r.name is not null) as roles
         from lbg.memberships m
         join lbg.users u on u.id = m.user_id
         left join lbg.membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
         left join lbg.roles r on r.business_id = mr.business_id and r.id = mr.role_id
        where m.business_id = ${ctx.businessId}
        group by m.id, u.email, u.display_name
        order by u.email`.execute(trx);
    return rows.map((r) => ({
      membershipId: r.id,
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      status: r.status,
      roles: r.roles ?? [],
    }));
  });
}

/** The member's user ID, if the membership belongs to this business. */
export async function memberUser(db: Db, ctx: TenantContext, membershipId: string) {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ user_id: string; is_owner: boolean }>`
      select m.user_id, exists (
               select 1 from lbg.membership_roles mr join lbg.roles r on r.business_id = mr.business_id and r.id = mr.role_id
                where mr.business_id = m.business_id and mr.membership_id = m.id and r.is_system and r.name = ${OWNER_ROLE_NAME}
             ) as is_owner
        from lbg.memberships m where m.business_id = ${ctx.businessId} and m.id = ${membershipId}`.execute(trx);
    return rows[0] ? { userId: rows[0].user_id, isOwner: rows[0].is_owner } : null;
  });
}

/**
 * Replaces a member's roles. R1: at least one active Owner must remain.
 * R2: the actor may only assign roles whose permissions they hold themselves.
 * Changing your own roles is refused (no self-escalation).
 */
export async function setMemberRoles(
  db: Db,
  ctx: TenantContext,
  actor: BusinessAccess,
  membershipId: string,
  roleIds: readonly string[],
): Promise<{ targetUserId: string }> {
  return withTenant(db, ctx, async (trx) => {
    const target = await sql<{ user_id: string }>`
      select user_id from lbg.memberships where business_id = ${ctx.businessId} and id = ${membershipId} for update`.execute(
      trx,
    );
    const targetUserId = target.rows[0]?.user_id;
    if (!targetUserId) throw new MemberRuleError('NOT_FOUND', 'member not found');
    if (targetUserId === ctx.userId) throw new MemberRuleError('SELF_CHANGE', 'you cannot change your own roles');

    const roles = await sql<{ id: string; name: string; is_system: boolean; keys: string[] | null }>`
      select r.id, r.name, r.is_system, array_agg(rp.permission_key) filter (where rp.permission_key is not null) as keys
        from lbg.roles r left join lbg.role_permissions rp on rp.business_id = r.business_id and rp.role_id = r.id
       where r.business_id = ${ctx.businessId} and r.id = any(${roleIds})
       group by r.id`.execute(trx);
    if (roles.rows.length !== new Set(roleIds).size) throw new MemberRuleError('NOT_FOUND', 'unknown role');
    for (const role of roles.rows) {
      const missing = (role.keys ?? []).filter((k) => !actor.permissions.has(k));
      if (missing.length > 0) {
        throw new MemberRuleError(
          'GRANT_EXCEEDS_OWN',
          `you cannot assign ${role.name}: it has permissions you do not hold`,
        );
      }
    }

    await sql`delete from lbg.membership_roles where business_id = ${ctx.businessId} and membership_id = ${membershipId}`.execute(
      trx,
    );
    for (const role of roles.rows) {
      await sql`insert into lbg.membership_roles (business_id, membership_id, role_id)
                values (${ctx.businessId}, ${membershipId}, ${role.id})`.execute(trx);
    }
    await assertOwnerRemains(trx, ctx.businessId);
    await recordTenantEvent(trx, ctx, {
      action: 'member.roles.set',
      targetType: 'membership',
      targetId: membershipId,
      metadata: { roles: roles.rows.map((r) => r.name).sort() },
    });
    return { targetUserId };
  });
}

/** R4 (with the caller revoking sessions): deactivates a membership. Owners cannot be deactivated here. */
export async function deactivateMember(
  db: Db,
  ctx: TenantContext,
  membershipId: string,
): Promise<{ targetUserId: string }> {
  return withTenant(db, ctx, async (trx) => {
    const target = await sql<{ user_id: string }>`
      update lbg.memberships set status = 'DEACTIVATED'
       where business_id = ${ctx.businessId} and id = ${membershipId} and status <> 'DEACTIVATED'
       returning user_id`.execute(trx);
    const targetUserId = target.rows[0]?.user_id;
    if (!targetUserId) throw new MemberRuleError('NOT_FOUND', 'member not found or already deactivated');
    if (targetUserId === ctx.userId) throw new MemberRuleError('SELF_CHANGE', 'you cannot deactivate yourself');
    await assertOwnerRemains(trx, ctx.businessId);
    await recordTenantEvent(trx, ctx, {
      action: 'member.deactivate',
      targetType: 'membership',
      targetId: membershipId,
    });
    return { targetUserId };
  });
}

async function assertOwnerRemains(trx: Parameters<Parameters<typeof withTenant>[2]>[0], businessId: string) {
  const { rows } = await sql<{ n: string }>`
    select count(*) as n from lbg.memberships m
      join lbg.membership_roles mr on mr.business_id = m.business_id and mr.membership_id = m.id
      join lbg.roles r on r.business_id = mr.business_id and r.id = mr.role_id
     where m.business_id = ${businessId} and m.status = 'ACTIVE' and r.is_system and r.name = ${OWNER_ROLE_NAME}`.execute(
    trx,
  );
  if (Number(rows[0]?.n ?? 0) < 1)
    throw new MemberRuleError('LAST_OWNER', 'a business must keep at least one active owner');
}
