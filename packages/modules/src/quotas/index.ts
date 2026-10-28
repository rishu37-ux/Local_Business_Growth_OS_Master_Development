// Plan quotas (increment 8.4: FR-SUB-3 AC2, D-062). The business's plan may
// set monthly limits (plans.limits: aiUnitsPerMonth, messagesPerMonth,
// storageMb); none are set until the product decides them, and an unset limit
// means no plan limit. Usage is counted per business and business month. At
// 80 % the managers are notified once a month; at 100 % the use stops, except
// AI use within the owner's overage cap.
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export type Metric = 'AI' | 'MESSAGES' | 'STORAGE';

export interface MetricStatus {
  readonly metric: Metric;
  /** Units for AI, messages for MESSAGES, bytes for STORAGE. */
  readonly used: number;
  /** null: the plan sets no limit. */
  readonly limit: number | null;
  /** Extra AI units the owner allows beyond the plan (0 = none). */
  readonly overage: number;
  readonly percent: number | null;
  readonly warning: boolean;
  readonly stopped: boolean;
}

export class QuotaError extends Error {
  readonly code = 'PLAN_QUOTA_EXCEEDED';
  readonly metric: Metric;

  constructor(metric: Metric, message: string) {
    super(message);
    this.name = 'QuotaError';
    this.metric = metric;
  }
}

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

async function planIn(trx: Trx, ctx: TenantContext) {
  const { rows } = await sql<{ limits: Record<string, unknown> | null; overage: number | null; month: string }>`
    select (select p.limits from lbg.subscriptions s join lbg.plans p on p.id = s.plan_id
             where s.business_id = b.id and s.status in ('TRIALING', 'ACTIVE', 'PAST_DUE')
             order by s.current_period_end desc limit 1) as limits,
           st.ai_overage_cap_units as overage,
           to_char(now() at time zone b.timezone, 'YYYY-MM') as month
      from lbg.businesses b left join lbg.business_settings st on st.business_id = b.id
     where b.id = ${ctx.businessId}`.execute(trx);
  const r = rows[0];
  const l = r?.limits ?? {};
  return {
    ai: positive(l.aiUnitsPerMonth),
    messages: positive(l.messagesPerMonth),
    storageBytes: positive(l.storageMb) === null ? null : (positive(l.storageMb) ?? 0) * 1024 * 1024,
    overage: r?.overage ?? 0,
    month: r?.month ?? '',
  };
}

const monthStart = sql`date_trunc('month', now() at time zone b.timezone) at time zone b.timezone`;

async function usedIn(trx: Trx, ctx: TenantContext, metric: Metric): Promise<number> {
  if (metric === 'AI') {
    const { rows } = await sql<{ n: string }>`
      select coalesce(sum(c.units), 0)::text as n from lbg.integration_calls c
        join lbg.integrations i on i.business_id = c.business_id and i.id = c.integration_id
        join lbg.businesses b on b.id = c.business_id
       where c.business_id = ${ctx.businessId} and c.kind = 'CALL' and i.category in ('LLM', 'IMAGE_VIDEO')
         and c.at >= ${monthStart}`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }
  if (metric === 'MESSAGES') {
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from lbg.message_events e join lbg.businesses b on b.id = e.business_id
       where e.business_id = ${ctx.businessId} and e.status = 'SUBMITTED' and e.at >= ${monthStart}`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }
  const { rows } = await sql<{ n: string }>`
    select coalesce(sum(byte_size), 0)::text as n from lbg.uploads where business_id = ${ctx.businessId}`.execute(trx);
  return Number(rows[0]?.n ?? 0);
}

function status(metric: Metric, used: number, limit: number | null, overage: number): MetricStatus {
  const percent = limit === null ? null : Math.floor((used * 100) / limit);
  const ceiling = limit === null ? null : limit + (metric === 'AI' ? overage : 0);
  return {
    metric,
    used,
    limit,
    overage: metric === 'AI' ? overage : 0,
    percent,
    warning: percent !== null && percent >= 80,
    stopped: ceiling !== null && used >= ceiling,
  };
}

export async function quotaStatusIn(trx: Trx, ctx: TenantContext): Promise<MetricStatus[]> {
  const p = await planIn(trx, ctx);
  return [
    status('AI', await usedIn(trx, ctx, 'AI'), p.ai, p.overage),
    status('MESSAGES', await usedIn(trx, ctx, 'MESSAGES'), p.messages, 0),
    status('STORAGE', await usedIn(trx, ctx, 'STORAGE'), p.storageBytes, 0),
  ];
}

const MESSAGES: Record<Metric, string> = {
  AI: "This month's AI allowance in your plan has been used.",
  MESSAGES: "This month's message allowance in your plan has been used.",
  STORAGE: 'The storage allowance in your plan is full.',
};

/**
 * Throws when using `amount` more would pass the plan limit (plus the AI
 * overage cap). Called where the usage happens: AI calls, message dispatch,
 * uploads.
 */
export async function assertQuotaIn(trx: Trx, ctx: TenantContext, metric: Metric, amount: number): Promise<void> {
  const p = await planIn(trx, ctx);
  const limit = metric === 'AI' ? p.ai : metric === 'MESSAGES' ? p.messages : p.storageBytes;
  if (limit === null) return;
  const ceiling = limit + (metric === 'AI' ? p.overage : 0);
  const used = await usedIn(trx, ctx, metric);
  // AI amounts are estimates (upper bounds): the stop is at 100 % of actual use. Messages and bytes are exact.
  if (metric === 'AI' ? used >= ceiling : used + amount > ceiling) throw new QuotaError(metric, MESSAGES[metric]);
}

const LABEL: Record<Metric, string> = { AI: 'AI use', MESSAGES: 'Messages', STORAGE: 'Storage' };

/**
 * Notifies the people who manage the business once per month and metric when
 * usage reaches 80 % and 100 % of the plan limit. Returns the notices sent.
 */
export async function quotaNoticesIn(trx: Trx, ctx: TenantContext): Promise<string[]> {
  const p = await planIn(trx, ctx);
  const sent: string[] = [];
  for (const s of await quotaStatusIn(trx, ctx)) {
    if (s.percent === null) continue;
    for (const level of [80, 100] as const) {
      if (s.percent < level) continue;
      const notice = `quota:${s.metric}:${p.month}:${String(level)}`;
      const { rows } = await sql<{ id: string }>`
        insert into lbg.job_notices (business_id, notice) values (${ctx.businessId}, ${notice})
        on conflict (business_id, notice) do nothing returning id`.execute(trx);
      if (!rows[0]) continue;
      await sql`select lbg.notify_permission_holders('business.settings.manage', 'quota.alert',
                  ${`${LABEL[s.metric]}: ${String(level)} % of your plan`},
                  ${level === 100 ? `${MESSAGES[s.metric]} It stops until next month or a plan change.` : `You have used ${String(s.percent)} % of this month's ${LABEL[s.metric].toLowerCase()} allowance.`})`.execute(
        trx,
      );
      sent.push(notice);
    }
  }
  return sent;
}

/** FR-SUB-3 AC2: the owner allows AI use beyond the plan up to `cap` units a month (0 = none); audited. */
export async function setAiOverageCap(db: Db, ctx: TenantContext, cap: number): Promise<number> {
  return withTenant(db, ctx, async (trx) => {
    await sql`update lbg.business_settings set ai_overage_cap_units = ${cap} where business_id = ${ctx.businessId}`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, {
      action: 'usage.overage_cap',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { aiOverageCapUnits: cap },
    });
    return cap;
  });
}

export async function usageView(db: Db, ctx: TenantContext) {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ cap: number | null }>`select ai_overage_cap_units as cap from lbg.business_settings
       where business_id = ${ctx.businessId}`.execute(trx);
    return { usage: await quotaStatusIn(trx, ctx), aiOverageCapUnits: rows[0]?.cap ?? 0 };
  });
}
