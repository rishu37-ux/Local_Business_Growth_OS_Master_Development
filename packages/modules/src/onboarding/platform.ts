// Platform-created businesses (FR-ONB-1 AC2) and plan management (FR-SUB-2).
// Runs on the platform role.
import { DEFAULT_ROLES } from '@lbgos/domain';
import { sql } from 'kysely';
import { withoutTenant, type Db } from '@lbgos/db';
import { recordPlatformEvent } from '../audit/index.ts';
import type { Mailer } from '../notifications/index.ts';
import { INVITATION_HOURS, invitationLink, newInvitationToken } from './invitations.ts';

export interface NewBusinessInput {
  readonly legalName: string;
  readonly category: string;
  readonly stateCode: string;
  readonly ownerEmail: string;
}

/**
 * Creates a business directly in APPROVED_SETUP_PENDING with the default roles,
 * a trial subscription and a single-use 72-hour owner invitation.
 */
export async function createBusinessForOwner(
  db: Db,
  actorUserId: string,
  input: NewBusinessInput,
  deps: { readonly mailer: Mailer; readonly baseURL: string; readonly trialDays: number; readonly planCode: string },
): Promise<string> {
  const email = input.ownerEmail.trim().toLowerCase();
  const { token, hash } = newInvitationToken();
  const businessId = await withoutTenant(db, async (trx) => {
    const created = await sql<{ id: string }>`
      insert into lbg.businesses (legal_name, category, state_code, status)
      values (${input.legalName}, ${input.category}, ${input.stateCode}, 'APPROVED_SETUP_PENDING') returning id`.execute(
      trx,
    );
    const id = created.rows[0]?.id ?? '';
    await sql`insert into lbg.business_status_events (business_id, from_status, to_status, actor_user_id, reason)
              values (${id}, null, 'APPROVED_SETUP_PENDING', ${actorUserId}, 'Created by platform admin')`.execute(trx);
    await sql`select lbg.provision_business(${id}, ${JSON.stringify(DEFAULT_ROLES)}::jsonb)`.execute(trx);
    await sql`insert into lbg.subscriptions (business_id, plan_id, status, current_period_start, current_period_end)
              select ${id}, p.id, 'TRIALING', now(), now() + make_interval(days => ${deps.trialDays})
                from lbg.plans p where p.code = ${deps.planCode}`.execute(trx);
    await sql`select lbg.create_owner_invitation(${id}, ${email}::citext, ${hash},
                                                 now() + make_interval(hours => ${INVITATION_HOURS}), ${actorUserId})`.execute(
      trx,
    );
    await recordPlatformEvent(trx, actorUserId, {
      action: 'business.create',
      businessId: id,
      targetType: 'business',
      targetId: id,
    });
    return id;
  });
  await deps.mailer.send({
    to: email,
    subject: 'Your business account on Local Business Growth OS',
    text: `A business account was created for you. Accept the owner invitation (single use, expires in ${INVITATION_HOURS} hours):\n${invitationLink(deps.baseURL, token)}`,
  });
  return businessId;
}

export interface Plan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly pricePaise: number;
  readonly billingPeriod: 'MONTH' | 'YEAR';
  readonly limits: Record<string, unknown>;
  readonly active: boolean;
  readonly pilotPricing: boolean;
  readonly notes: string | null;
}

export async function listPlans(db: Db): Promise<Plan[]> {
  return withoutTenant(db, async (trx) => {
    const { rows } = await sql<{
      id: string;
      code: string;
      name: string;
      price_paise: string;
      billing_period: 'MONTH' | 'YEAR';
      limits: Record<string, unknown>;
      active: boolean;
      pilot_pricing: boolean;
      notes: string | null;
    }>`select * from lbg.plans order by price_paise`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      pricePaise: Number(r.price_paise), // bigint arrives as a string; plan prices are far below 2^53
      billingPeriod: r.billing_period,
      limits: r.limits,
      active: r.active,
      pilotPricing: r.pilot_pricing,
      notes: r.notes,
    }));
  });
}

/** FR-SUB-2 AC1: price and status changes without a deployment, audited. */
export async function updatePlan(
  db: Db,
  actorUserId: string,
  planId: string,
  input: { readonly pricePaise?: number; readonly active?: boolean; readonly notes?: string },
): Promise<boolean> {
  return withoutTenant(db, async (trx) => {
    const res = await sql`update lbg.plans set price_paise = coalesce(${input.pricePaise ?? null}::bigint, price_paise),
                                               active = coalesce(${input.active ?? null}::boolean, active),
                                               notes = coalesce(${input.notes ?? null}, notes)
                           where id = ${planId}`.execute(trx);
    if (Number(res.numAffectedRows ?? 0) === 0) return false;
    await recordPlatformEvent(trx, actorUserId, {
      action: 'plan.update',
      targetType: 'plan',
      targetId: planId,
      metadata: { ...input },
    });
    return true;
  });
}
