// Applicant side of the business lifecycle (BR-T1, FR-ONB-1, WORKFLOWS.md §1–2).
import { sql } from 'kysely';
import { withTenant, withUser, type Db, type TenantContext } from '@lbgos/db';
import type { BusinessStatus } from '@lbgos/domain';

export interface ApplicationInput {
  readonly legalName: string;
  readonly category: string;
  readonly stateCode: string;
}

export interface MyBusiness {
  readonly businessId: string;
  readonly legalName: string;
  readonly displayName: string | null;
  readonly status: BusinessStatus;
  readonly membershipStatus: string;
}

/** Creates a PENDING_APPROVAL business with the caller as its only member. */
export async function submitApplication(db: Db, userId: string, input: ApplicationInput): Promise<string> {
  return withUser(db, userId, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      select lbg.register_application(${input.legalName}, ${input.category}, ${input.stateCode}) as id`.execute(trx);
    const id = rows[0]?.id;
    if (!id) throw new Error('register_application returned no id');
    return id;
  });
}

export async function myBusinesses(db: Db, userId: string): Promise<MyBusiness[]> {
  return withUser(db, userId, async (trx) => {
    const { rows } = await sql<{
      business_id: string;
      legal_name: string;
      display_name: string | null;
      status: BusinessStatus;
      membership_status: string;
    }>`select * from lbg.my_businesses()`.execute(trx);
    return rows.map((r) => ({
      businessId: r.business_id,
      legalName: r.legal_name,
      displayName: r.display_name,
      status: r.status,
      membershipStatus: r.membership_status,
    }));
  });
}

export async function updateApplication(db: Db, ctx: TenantContext, input: ApplicationInput): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await sql`select lbg.update_application(${ctx.businessId}, ${input.legalName}, ${input.category},
                                             ${input.stateCode})`.execute(trx);
  });
}

export async function resubmitApplication(db: Db, ctx: TenantContext): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await sql`select lbg.resubmit_application(${ctx.businessId})`.execute(trx);
  });
}

export async function activateBusiness(db: Db, ctx: TenantContext): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await sql`select lbg.activate_business(${ctx.businessId})`.execute(trx);
  });
}

export interface StatusEvent {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

/** BR-T2 AC3: the business's own approval history. */
export async function statusHistory(db: Db, ctx: TenantContext): Promise<StatusEvent[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      from_status: string | null;
      to_status: string;
      reason: string | null;
      created_at: Date;
    }>`
      select from_status, to_status, reason, created_at from lbg.business_status_events
       where business_id = ${ctx.businessId} order by created_at, id`.execute(trx);
    return rows.map((r) => ({
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  });
}
