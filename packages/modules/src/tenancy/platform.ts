// Platform-admin side of the lifecycle (BR-T2, BR-T3, BR-T4). Runs on the
// platform role, which can change business status but has no access to
// tenant business data (D-015).
import {
  DEFAULT_ROLES,
  MIN_REASON_LENGTH,
  PLATFORM_ACTIONS,
  type BusinessStatus,
  type PlatformAction,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { withoutTenant, type Db, type Trx } from '@lbgos/db';
import { recordPlatformEvent } from '../audit/index.ts';

export class LifecycleError extends Error {
  readonly code: 'REASON_REQUIRED' | 'INVALID_STATE' | 'NOT_FOUND';

  constructor(code: LifecycleError['code'], message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

export interface ApplicationSummary {
  readonly businessId: string;
  readonly legalName: string;
  readonly category: string;
  readonly stateCode: string | null;
  readonly status: BusinessStatus;
  readonly createdAt: Date;
  readonly applicants: readonly { readonly userId: string; readonly email: string; readonly displayName: string }[];
}

export async function listApplications(db: Db, statuses: readonly BusinessStatus[]): Promise<ApplicationSummary[]> {
  return withoutTenant(db, async (trx) => {
    const { rows } = await sql<{
      id: string;
      legal_name: string;
      category: string;
      state_code: string | null;
      status: BusinessStatus;
      created_at: Date;
    }>`select id, legal_name, category, state_code, status, created_at from lbg.businesses
        where status = any(${statuses}) order by created_at`.execute(trx);
    const out: ApplicationSummary[] = [];
    for (const r of rows) {
      const applicants = await sql<{ user_id: string; email: string; display_name: string }>`
        select * from lbg.application_applicants(${r.id})`.execute(trx);
      out.push({
        businessId: r.id,
        legalName: r.legal_name,
        category: r.category,
        stateCode: r.state_code,
        status: r.status,
        createdAt: r.created_at,
        applicants: applicants.rows.map((a) => ({ userId: a.user_id, email: a.email, displayName: a.display_name })),
      });
    }
    return out;
  });
}

async function transition(
  trx: Trx,
  actorUserId: string,
  businessId: string,
  allowedFrom: readonly BusinessStatus[],
  to: BusinessStatus,
  action: string,
  reason: string | null,
  requestId: string | undefined,
): Promise<BusinessStatus> {
  const current = await sql<{ status: BusinessStatus }>`
    select status from lbg.businesses where id = ${businessId} for update`.execute(trx);
  const from = current.rows[0]?.status;
  if (!from) throw new LifecycleError('NOT_FOUND', 'business not found');
  if (!allowedFrom.includes(from))
    throw new LifecycleError('INVALID_STATE', `cannot ${action} a business that is ${from}`);
  await sql`update lbg.businesses set status = ${to} where id = ${businessId}`.execute(trx);
  await sql`insert into lbg.business_status_events (business_id, from_status, to_status, actor_user_id, reason)
            values (${businessId}, ${from}, ${to}, ${actorUserId}, ${reason})`.execute(trx);
  await recordPlatformEvent(trx, actorUserId, {
    action: `business.${action}`,
    businessId,
    targetType: 'business',
    targetId: businessId,
    metadata: { from, to },
    ...(requestId ? { requestId } : {}),
  });
  return from;
}

function requireReason(action: PlatformAction, reason: string | undefined): string | null {
  if (action === 'approve') return reason?.trim() ? reason.trim() : null;
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw new LifecycleError('REASON_REQUIRED', `a reason of at least ${MIN_REASON_LENGTH} characters is required`);
  }
  return trimmed;
}

/**
 * approve / request_changes / reject / suspend (BR-T2, BR-T3). Approval also
 * creates the default roles and makes the applicant the Owner, in the same
 * transaction.
 */
export async function decide(
  db: Db,
  actorUserId: string,
  businessId: string,
  action: keyof typeof PLATFORM_ACTIONS,
  reason?: string,
  requestId?: string,
): Promise<void> {
  const why = requireReason(action, reason);
  const rule = PLATFORM_ACTIONS[action];
  await withoutTenant(db, async (trx) => {
    await transition(trx, actorUserId, businessId, rule.from, rule.to, action, why, requestId);
    if (action === 'approve') {
      await sql`select lbg.provision_business(${businessId}, ${JSON.stringify(DEFAULT_ROLES)}::jsonb)`.execute(trx);
    }
  });
}

/** SUSPENDED → the status it had before suspension (WORKFLOWS.md §1). */
export async function reinstate(db: Db, actorUserId: string, businessId: string, reason: string, requestId?: string) {
  const why = requireReason('reinstate', reason);
  await withoutTenant(db, async (trx) => {
    const prior = await sql<{ from_status: BusinessStatus }>`
      select from_status from lbg.business_status_events
       where business_id = ${businessId} and to_status = 'SUSPENDED' order by created_at desc, id desc limit 1`.execute(
      trx,
    );
    const back = prior.rows[0]?.from_status === 'ACTIVE' ? 'ACTIVE' : 'APPROVED_SETUP_PENDING';
    await transition(trx, actorUserId, businessId, ['SUSPENDED'], back, 'reinstate', why, requestId);
  });
}
