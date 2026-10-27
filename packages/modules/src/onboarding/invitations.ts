// Staff and owner invitations (FR-ONB-1 AC2, FR-ONB-2 "users" step).
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { withTenant, withUser, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import type { Mailer } from '../notifications/index.ts';
import type { BusinessAccess } from '../tenancy/index.ts';

export const INVITATION_HOURS = 72;

export class InvitationError extends Error {
  readonly code: 'ALREADY_MEMBER' | 'GRANT_EXCEEDS_OWN' | 'UNKNOWN_ROLE' | 'NOT_FOUND';

  constructor(code: InvitationError['code'], message: string) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
  }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 256-bit random token (base64url) and its stored hash. */
export function newInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const invitationLink = (baseURL: string, token: string) =>
  `${baseURL.replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`;

export async function createInvitation(
  db: Db,
  ctx: TenantContext,
  actor: BusinessAccess,
  input: { readonly email: string; readonly roleIds: readonly string[] },
  deps: { readonly mailer: Mailer; readonly baseURL: string },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const { token, hash } = newInvitationToken();
  const id = await withTenant(db, ctx, async (trx) => {
    const member = await sql<{ n: string }>`
      select count(*) as n from lbg.memberships m join lbg.users u on u.id = m.user_id
       where m.business_id = ${ctx.businessId} and m.status = 'ACTIVE' and u.email = ${email}`.execute(trx);
    if (Number(member.rows[0]?.n ?? 0) > 0) throw new InvitationError('ALREADY_MEMBER', 'already a member');

    const roles = await sql<{ id: string; name: string; keys: string[] | null }>`
      select r.id, r.name, array_agg(rp.permission_key) filter (where rp.permission_key is not null) as keys
        from lbg.roles r left join lbg.role_permissions rp on rp.business_id = r.business_id and rp.role_id = r.id
       where r.business_id = ${ctx.businessId} and r.id = any(${input.roleIds})
       group by r.id`.execute(trx);
    if (roles.rows.length !== new Set(input.roleIds).size) throw new InvitationError('UNKNOWN_ROLE', 'unknown role');
    // R2: you cannot invite someone into permissions you do not hold.
    for (const role of roles.rows) {
      if ((role.keys ?? []).some((k) => !actor.permissions.has(k))) {
        throw new InvitationError('GRANT_EXCEEDS_OWN', `you cannot grant ${role.name}`);
      }
    }
    const inserted = await sql<{ id: string }>`
      insert into lbg.invitations (business_id, email, role_ids, token_hash, invited_by, expires_at)
      values (${ctx.businessId}, ${email}, ${input.roleIds}::uuid[], ${hash}, ${ctx.userId},
              now() + make_interval(hours => ${INVITATION_HOURS}))
      returning id`.execute(trx);
    const invitationId = inserted.rows[0]?.id ?? '';
    await recordTenantEvent(trx, ctx, {
      action: 'invitation.create',
      targetType: 'invitation',
      targetId: invitationId,
      metadata: { roles: roles.rows.map((r) => r.name).sort() },
    });
    return invitationId;
  });
  // Sent after commit: a rolled-back invitation never produces an email.
  await deps.mailer.send({
    to: email,
    subject: 'You have been invited to a business on Local Business Growth OS',
    text: `You have been invited to join a business. This link works once and expires in ${INVITATION_HOURS} hours:\n${invitationLink(deps.baseURL, token)}\n\nSign in (or create an account) with this email address before opening it.`,
  });
  return id;
}

export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  readonly expiresAt: Date;
}

export async function listInvitations(db: Db, ctx: TenantContext): Promise<InvitationSummary[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      email: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>`
      select id, email, expires_at, accepted_at, revoked_at from lbg.invitations
       where business_id = ${ctx.businessId} order by created_at desc`.execute(trx);
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      expiresAt: r.expires_at,
      status: r.accepted_at
        ? 'ACCEPTED'
        : r.revoked_at
          ? 'REVOKED'
          : r.expires_at.getTime() <= now
            ? 'EXPIRED'
            : 'PENDING',
    }));
  });
}

export async function revokeInvitation(db: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const res = await sql`update lbg.invitations set revoked_at = now()
                           where business_id = ${ctx.businessId} and id = ${id} and accepted_at is null and revoked_at is null`.execute(
      trx,
    );
    if (Number(res.numAffectedRows ?? 0) === 0) throw new InvitationError('NOT_FOUND', 'no open invitation');
    await recordTenantEvent(trx, ctx, { action: 'invitation.revoke', targetType: 'invitation', targetId: id });
  });
}

/** Accepts as the signed-in user; their verified email must match the invitation. */
export async function acceptInvitation(db: Db, userId: string, token: string): Promise<string> {
  return withUser(db, userId, async (trx) => {
    const { rows } = await sql<{
      business_id: string;
    }>`select lbg.accept_invitation(${hashToken(token)}) as business_id`.execute(trx);
    return rows[0]?.business_id ?? '';
  });
}
