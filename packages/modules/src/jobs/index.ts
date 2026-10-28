// Job runner (increment 8.4: NFR-5, FR-SUB-1 AC2, D-062). One tick works
// business by business as the system actor: due scheduled campaigns and
// queued messages (quiet hours respected by dispatch), the daily reminder run,
// agent runs past their deadline, trial-end notices and quota notices. Only
// one runner works at a time (a database session lock); every step is
// idempotent, so a tick that runs twice changes nothing more.
import { sql } from 'kysely';
import { SYSTEM_ACTOR, withTenant, type Db, type TenantContext } from '@lbgos/db';
import { expireRuns } from '../agents/index.ts';
import { importChannelOrders, pushChannelStock } from '../commerce/index.ts';
import { runDueCampaigns } from '../campaigns/index.ts';
import type { HubDeps } from '../integrations/index.ts';
import { dispatchDue, type MessageProvider } from '../messaging/index.ts';
import { quotaNoticesIn } from '../quotas/index.ts';
import { runReminders } from '../reminders/index.ts';

export interface JobDeps {
  readonly appDb: Db;
  /** The message provider for a business (the hub's tested channel integrations in production). */
  readonly provider: (ctx: TenantContext) => Promise<MessageProvider>;
  /** The integration hub; without it marketplace channels are not synced (11.2–11.3). */
  readonly hub?: HubDeps | undefined;
}

export interface JobStep {
  readonly businessId: string;
  readonly job: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly processed: number;
  readonly errorCode: string | null;
}

export interface TickResult {
  /** false when another runner holds the lock. */
  readonly ran: boolean;
  readonly businesses: number;
  readonly steps: readonly JobStep[];
}

const LOCK = 'lbgos:job-runner';
const TRIAL_DAYS = [7, 3, 1] as const;

async function notice(db: Db, ctx: TenantContext, key: string, title: string, body: string): Promise<boolean> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      insert into lbg.job_notices (business_id, notice) values (${ctx.businessId}, ${key})
      on conflict (business_id, notice) do nothing returning id`.execute(trx);
    if (!rows[0]) return false;
    await sql`select lbg.notify_permission_holders('business.settings.manage', 'subscription.trial', ${title}, ${body})`.execute(
      trx,
    );
    return true;
  });
}

/** FR-SUB-1 AC2: trial ending in 7, 3 and 1 days (business date), once each. */
async function trialNotices(db: Db, ctx: TenantContext, now: Date): Promise<number> {
  const { rows } = await withTenant(db, ctx, (trx) =>
    sql<{ id: string; days: number; ends: string }>`
      select s.id, ((s.current_period_end at time zone b.timezone)::date - (${now}::timestamptz at time zone b.timezone)::date) as days,
             (s.current_period_end at time zone b.timezone)::date::text as ends
        from lbg.subscriptions s join lbg.businesses b on b.id = s.business_id
       where s.business_id = ${ctx.businessId} and s.status = 'TRIALING'`.execute(trx),
  );
  let sent = 0;
  for (const s of rows) {
    if (!(TRIAL_DAYS as readonly number[]).includes(s.days)) continue;
    const day = s.days === 1 ? '1 day' : `${String(s.days)} days`;
    if (
      await notice(
        db,
        ctx,
        `trial:${s.id}:${String(s.days)}`,
        `Your trial ends in ${day}`,
        `The trial ends on ${s.ends}. Choose a plan to keep using the shop without interruption.`,
      )
    ) {
      sent++;
    }
  }
  return sent;
}

async function dailyReminders(db: Db, ctx: TenantContext, provider: MessageProvider, now: Date): Promise<number> {
  const today = await withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ d: string }>`
      select (${now}::timestamptz at time zone timezone)::date::text as d from lbg.businesses where id = ${ctx.businessId}`.execute(
      trx,
    );
    const d = rows[0]?.d ?? '';
    const { rows: ins } = await sql<{ id: string }>`
      insert into lbg.job_notices (business_id, notice) values (${ctx.businessId}, ${`reminders:${d}`})
      on conflict (business_id, notice) do nothing returning id`.execute(trx);
    return ins[0] ? d : null;
  });
  if (today === null) return 0;
  const run = await runReminders(db, ctx, provider, now);
  return run.created.length;
}

/** One tick of every job for every live business. */
export async function runJobsOnce(deps: JobDeps, now: Date = new Date()): Promise<TickResult> {
  return deps.appDb.connection().execute(async (conn) => {
    const { rows: got } = await sql<{
      ok: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(${LOCK}, 0)) as ok`.execute(conn);
    if (!got[0]?.ok) return { ran: false, businesses: 0, steps: [] };
    try {
      const { rows } = await sql<{ id: string }>`select id from lbg.job_businesses() as id`.execute(conn);
      const steps: JobStep[] = [];
      for (const { id } of rows) {
        const ctx = { businessId: id, userId: SYSTEM_ACTOR };
        let provider: MessageProvider | null = null;
        const jobs: [string, () => Promise<number>][] = [
          [
            'campaigns',
            async () => {
              provider ??= await deps.provider(ctx);
              return (await runDueCampaigns(deps.appDb, ctx, provider, now)).started.length;
            },
          ],
          [
            'messages',
            async () => {
              provider ??= await deps.provider(ctx);
              return (await dispatchDue(deps.appDb, ctx, provider, now)).length;
            },
          ],
          [
            'reminders',
            async () => {
              provider ??= await deps.provider(ctx);
              return dailyReminders(deps.appDb, ctx, provider, now);
            },
          ],
          ['agent_timeouts', () => expireRuns(deps.appDb, ctx, now)],
          ['trial_notices', () => trialNotices(deps.appDb, ctx, now)],
          ['quota_notices', async () => (await withTenant(deps.appDb, ctx, (trx) => quotaNoticesIn(trx, ctx))).length],
          // Orders first, so the stock pushed next already accounts for their reservations.
          ['channel_orders', () => (deps.hub ? importChannelOrders(deps.hub, ctx) : Promise.resolve(0))],
          ['channel_stock', () => (deps.hub ? pushChannelStock(deps.hub, ctx, now) : Promise.resolve(0))],
        ];
        for (const [job, fn] of jobs) {
          const started = new Date();
          let processed = 0;
          let errorCode: string | null = null;
          try {
            processed = await fn();
          } catch (err) {
            const code = (err as { code?: unknown }).code;
            errorCode = (typeof code === 'string' ? code : 'JOB_ERROR')
              .toUpperCase()
              .replace(/[^A-Z0-9_]/g, '_')
              .slice(0, 40);
          }
          const status = errorCode ? ('FAILED' as const) : ('SUCCEEDED' as const);
          // Quiet ticks are not recorded; work done and failures are.
          if (processed > 0 || errorCode) {
            await withTenant(deps.appDb, ctx, (trx) =>
              sql`insert into lbg.job_runs (business_id, job, status, processed, error_code, started_at)
                  values (${id}, ${job}, ${status}, ${processed}, ${errorCode}, ${started})`.execute(trx),
            );
          }
          steps.push({ businessId: id, job, status, processed, errorCode });
        }
      }
      return { ran: true, businesses: rows.length, steps };
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${LOCK}, 0))`.execute(conn);
    }
  });
}

/** Runs a tick every `intervalSeconds` (no overlap); returns a stop function. */
export function startJobRunner(
  deps: JobDeps,
  intervalSeconds: number,
  onError: (err: unknown) => void,
): () => Promise<void> {
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    current = runJobsOnce(deps)
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalSeconds * 1000);
      });
  };
  let timer: NodeJS.Timeout = setTimeout(tick, intervalSeconds * 1000);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}

export interface JobRun {
  readonly job: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly processed: number;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export async function listJobRuns(db: Db, ctx: TenantContext, limit = 50): Promise<JobRun[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      job: string;
      status: JobRun['status'];
      processed: number;
      error_code: string | null;
      started_at: Date;
      finished_at: Date;
    }>`select job, status, processed, error_code, started_at, finished_at from lbg.job_runs
        where business_id = ${ctx.businessId} order by started_at desc, id desc limit ${limit}`.execute(trx);
    return rows.map((r) => ({
      job: r.job,
      status: r.status,
      processed: r.processed,
      errorCode: r.error_code,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at.toISOString(),
    }));
  });
}

export interface BusinessMonitoring {
  readonly jobs: readonly JobRun[];
  readonly integrations: readonly {
    readonly id: string;
    readonly label: string;
    readonly category: string;
    readonly status: string;
    readonly lastSuccessAt: string | null;
    readonly lastErrorAt: string | null;
    readonly lastErrorCode: string | null;
    readonly calls24h: number;
    readonly errors24h: number;
  }[];
  readonly agentRuns7d: readonly { readonly status: string; readonly n: number }[];
}

/** NFR-10 for the owner: recent job work and failures, integration health, assistant runs. */
export async function businessMonitoring(db: Db, ctx: TenantContext): Promise<BusinessMonitoring> {
  const jobs = await listJobRuns(db, ctx, 30);
  return withTenant(db, ctx, async (trx) => {
    const { rows: integrations } = await sql<{
      id: string;
      label: string;
      category: string;
      status: string;
      last_success_at: Date | null;
      last_error_at: Date | null;
      last_error_code: string | null;
      calls: number;
      errors: number;
    }>`
      select i.id, i.label, i.category, i.status, i.last_success_at, i.last_error_at, i.last_error_code,
             count(c.id)::int as calls, count(c.id) filter (where not c.ok)::int as errors
        from lbg.integrations i
        left join lbg.integration_calls c on c.business_id = i.business_id and c.integration_id = i.id
             and c.at > now() - interval '24 hours'
       where i.business_id = ${ctx.businessId} and i.status <> 'REVOKED'
       group by i.id order by i.label`.execute(trx);
    const { rows: runs } = await sql<{ status: string; n: number }>`
      select status, count(*)::int as n from lbg.agent_runs
       where business_id = ${ctx.businessId} and created_at > now() - interval '7 days'
       group by status order by status`.execute(trx);
    return {
      jobs,
      integrations: integrations.map((i) => ({
        id: i.id,
        label: i.label,
        category: i.category,
        status: i.status,
        lastSuccessAt: i.last_success_at?.toISOString() ?? null,
        lastErrorAt: i.last_error_at?.toISOString() ?? null,
        lastErrorCode: i.last_error_code,
        calls24h: i.calls,
        errors24h: i.errors,
      })),
      agentRuns7d: runs,
    };
  });
}

/** Platform view: counts only (D-015). */
export async function platformMonitoring(platformDb: Db): Promise<{ metric: string; label: string; n: number }[]> {
  const { rows } = await sql<{ metric: string; label: string; n: string }>`
    select metric, label, n::text as n from lbg.platform_monitoring(24) order by metric, label`.execute(platformDb);
  return rows.map((r) => ({ metric: r.metric, label: r.label, n: Number(r.n) }));
}
