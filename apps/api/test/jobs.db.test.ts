// Increment 8.4: the job runner, plan quotas and monitoring (NFR-5, NFR-10,
// FR-SUB-1 AC2, FR-SUB-3 AC2, D-062). A recording test adapter stands in for
// a messaging provider and the mock AI adapter for a model. Synthetic data.
import { runJobsOnce } from '@lbgos/modules/jobs';
import type { MessageProvider, OutboundMessage } from '@lbgos/modules/messaging';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  fixtureAdmin,
  get,
  patch,
  post,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

class RecordingProvider implements MessageProvider {
  readonly name = 'jobs-test-adapter';
  readonly configured = true;
  readonly sent: OutboundMessage[] = [];
  send(m: OutboundMessage) {
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `job-${m.messageId}` });
  }
}

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
const provider = new RecordingProvider();
let planId = '';
let originalPlanId = '';
let phone = '';

const deps = () => ({ appDb: h.appDb, provider: () => Promise.resolve(provider as MessageProvider) });
const notifications = async (kind: string) =>
  (
    await sql<{ title: string }>`select title from lbg.notifications
      where business_id = ${shop.businessId} and kind = ${kind} and user_id = ${shop.ownerId} order by created_at, id`.execute(
      h.admin,
    )
  ).rows.map((r) => r.title);
const jobRuns = async (job: string) =>
  (
    await sql<{ status: string; processed: number; error_code: string | null }>`
      select status, processed, error_code from lbg.job_runs where business_id = ${shop.businessId} and job = ${job}
       order by started_at, id`.execute(h.admin)
  ).rows;

beforeAll(async () => {
  h = await startHarness({ messaging: provider });
  resetFixture();
  shop = await activeShop(h, 'job-a');
  other = await activeShop(h, 'job-b');
  billing = (await staff(h, shop, 'job-billing@example.test', 'Billing')).session;
  await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
             where business_id = ${shop.businessId}`.execute(h.admin);
  // A plan of its own, so limits set here affect no other business (removed again in afterAll).
  originalPlanId =
    (
      await sql<{
        p: string;
      }>`select plan_id as p from lbg.subscriptions where business_id = ${shop.businessId}`.execute(h.admin)
    ).rows[0]?.p ?? '';
  planId =
    (
      await sql<{ id: string }>`insert into lbg.plans (code, name, price_paise, billing_period, limits)
        values ('JOBTEST', 'Job test plan', 0, 'MONTH', '{}') returning id`.execute(h.admin)
    ).rows[0]?.id ?? '';
  await sql`update lbg.subscriptions set plan_id = ${planId} where business_id = ${shop.businessId}`.execute(h.admin);
  phone = await variant(h, shop, 'JOB-PH', { serialized: true });
  await sql`update lbg.product_variants set selling_price_paise = 1000000 where id = ${phone}`.execute(h.admin);
}, 180_000);
afterAll(async () => {
  // The database is shared with later test files: leave the plans as they were.
  await sql`update lbg.subscriptions set plan_id = ${originalPlanId} where plan_id = ${planId}`.execute(h.admin);
  await sql`delete from lbg.plans where id = ${planId}`.execute(h.admin);
  await h.close();
});

describe('job runner (NFR-5)', () => {
  it('sends a due scheduled campaign once, and records the work', async () => {
    const c = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Job customer (synthetic)', mobile: '9861000001', tags: ['VIP'] },
      billing,
    );
    const customerId = c.json<{ customer: { id: string } }>().customer.id;
    await post(
      h,
      `${shop.base}/customers/${customerId}/consents`,
      { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
      billing,
    );
    const created = (
      await post(
        h,
        `${shop.base}/campaigns`,
        { name: 'Weekend', channel: 'WHATSAPP', body: 'Weekend offer on covers (synthetic).', segmentTags: ['VIP'] },
        shop.owner,
      )
    ).json<{ campaign: { id: string; contentSha256: string } }>().campaign;
    await post(h, `${shop.base}/campaigns/${created.id}/submit`, {}, shop.owner);
    await post(h, `${shop.base}/campaigns/${created.id}/approve`, { contentSha256: created.contentSha256 }, shop.owner);
    const at = new Date(Date.now() + 3_600_000);
    await post(h, `${shop.base}/campaigns/${created.id}/schedule`, { at: at.toISOString() }, shop.owner);
    // Not due yet.
    expect(
      (await runJobsOnce(deps())).steps.find((s) => s.businessId === shop.businessId && s.job === 'campaigns')
        ?.processed,
    ).toBe(0);
    const later = new Date(at.getTime() + 60_000);
    const tick = await runJobsOnce(deps(), later);
    expect(tick.ran).toBe(true);
    expect(tick.steps.filter((s) => s.businessId === shop.businessId).map((s) => s.job)).toEqual([
      'campaigns',
      'messages',
      'reminders',
      'agent_timeouts',
      'trial_notices',
      'quota_notices',
    ]);
    const camp = (await get(h, `${shop.base}/campaigns/${created.id}`, shop.owner)).json<{
      campaign: { status: string; counts: { sent: number } };
    }>().campaign;
    expect(camp).toMatchObject({ status: 'COMPLETED', counts: { sent: 1 } });
    expect(provider.sent.filter((m) => m.body === 'Weekend offer on covers (synthetic).').length).toBe(1);
    expect(await jobRuns('campaigns')).toEqual([{ status: 'SUCCEEDED', processed: 1, error_code: null }]);
    // Running again sends nothing more and records nothing new for campaigns.
    await runJobsOnce(deps(), new Date(later.getTime() + 60_000));
    expect(provider.sent.filter((m) => m.body === 'Weekend offer on covers (synthetic).').length).toBe(1);
    expect((await jobRuns('campaigns')).length).toBe(1);
    // The daily reminder run happened once for the day, not on every tick.
    const reminderRuns = await sql<{
      n: number;
    }>`select count(*)::int as n from lbg.reminder_runs where business_id = ${shop.businessId}`.execute(h.admin);
    expect(reminderRuns.rows[0]?.n).toBe(1);
  });

  it('only one runner works at a time; a failing step is recorded and the others still run', async () => {
    const result = await h.appDb.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(hashtextextended('lbgos:job-runner', 0))`.execute(conn);
      try {
        return await runJobsOnce(deps());
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended('lbgos:job-runner', 0))`.execute(conn);
      }
    });
    expect(result).toEqual({ ran: false, businesses: 0, steps: [] });
    const failing = {
      appDb: h.appDb,
      provider: () => Promise.reject(Object.assign(new Error('provider down'), { code: 'PROVIDER_DOWN' })),
    };
    const tick = await runJobsOnce(failing);
    const mine = tick.steps.filter((s) => s.businessId === shop.businessId);
    expect(mine.find((s) => s.job === 'campaigns')).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_DOWN' });
    expect(mine.find((s) => s.job === 'trial_notices')?.status).toBe('SUCCEEDED');
    expect((await jobRuns('campaigns')).at(-1)).toEqual({
      status: 'FAILED',
      processed: 0,
      error_code: 'PROVIDER_DOWN',
    });
  });

  it('trial-end notices go out at 7, 3 and 1 days, once each (FR-SUB-1 AC2)', async () => {
    await sql`update lbg.subscriptions set status = 'TRIALING', current_period_end = now() + interval '7 days 1 hour'
               where business_id = ${shop.businessId}`.execute(h.admin);
    await runJobsOnce(deps());
    await runJobsOnce(deps());
    expect(await notifications('subscription.trial')).toEqual(['Your trial ends in 7 days']);
    await runJobsOnce(deps(), new Date(Date.now() + 4 * 86_400_000));
    await runJobsOnce(deps(), new Date(Date.now() + 6 * 86_400_000));
    expect(await notifications('subscription.trial')).toEqual([
      'Your trial ends in 7 days',
      'Your trial ends in 3 days',
      'Your trial ends in 1 day',
    ]);
  });

  it('assistant runs past their deadline stop as LIMIT_REACHED', async () => {
    const { rows } = await sql<{ id: string }>`
      insert into lbg.agent_runs (business_id, agent, user_id, idempotency_key, question)
      values (${shop.businessId}, 'GROWTH', ${shop.ownerId}, 'stale-run-0001', 'Overview') returning id`.execute(
      h.admin,
    );
    const id = rows[0]?.id ?? '';
    await runJobsOnce(deps(), new Date(Date.now() + 10 * 60_000));
    const r = await sql<{
      status: string;
      status_reason: string;
    }>`select status, status_reason from lbg.agent_runs where id = ${id}`.execute(h.admin);
    expect(r.rows[0]).toEqual({ status: 'LIMIT_REACHED', status_reason: 'Time limit reached.' });
  });
});

describe('plan quotas (FR-SUB-3 AC2)', () => {
  it('the platform admin sets plan limits; the owner sees usage against them', async () => {
    const admin = fixtureAdmin();
    const res = await patch(
      h,
      `/api/platform/plans/${planId}`,
      { limits: { aiUnitsPerMonth: 60, messagesPerMonth: 3, storageMb: 1 } },
      admin,
    );
    expect(res.statusCode).toBe(204);
    const usage = (await get(h, `${shop.base}/usage`, shop.owner)).json<{
      usage: { metric: string; used: number; limit: number | null; stopped: boolean }[];
    }>().usage;
    expect(usage.map((u) => [u.metric, u.limit])).toEqual([
      ['AI', 60],
      ['MESSAGES', 3],
      ['STORAGE', 1024 * 1024],
    ]);
    expect((await get(h, `${shop.base}/usage`, billing)).statusCode).toBe(403);
  });

  it('AI use warns at 80 %, stops at 100 %, and continues within the owner’s overage cap', async () => {
    const llm = (
      await post(
        h,
        `${shop.base}/integrations`,
        {
          category: 'LLM',
          provider: 'mock',
          label: 'Captions',
          authMethod: 'API_KEY',
          modelId: 'mock-ok',
          secret: 'quota-key-SYNTHETIC-1111',
        },
        shop.owner,
      )
    ).json<{ integration: { id: string } }>().integration.id;
    await post(h, `${shop.base}/integrations/${llm}/test`, {}, shop.owner);
    const gen = () =>
      post(
        h,
        `${shop.base}/studio/generate`,
        { kind: 'CAPTION', productIds: [phone], platform: 'WHATSAPP' },
        shop.owner,
      );
    let last = await gen();
    let n = 0;
    while (last.statusCode === 201 && n < 20) {
      last = await gen();
      n++;
    }
    expect([last.statusCode, last.json<{ error: { message: string } }>().error.message]).toEqual([
      429,
      "This month's AI allowance in your plan has been used.",
    ]);
    const titles = await notifications('quota.alert');
    expect(titles).toContain('AI use: 80 % of your plan');
    const ai = (await get(h, `${shop.base}/usage`, shop.owner)).json<{
      usage: { metric: string; warning: boolean }[];
    }>().usage[0];
    expect(ai?.warning).toBe(true);
    expect((await put(h, `${shop.base}/usage/overage`, { aiOverageCapUnits: 1000 }, billing)).statusCode).toBe(403);
    expect((await put(h, `${shop.base}/usage/overage`, { aiOverageCapUnits: 1000 }, shop.owner)).statusCode).toBe(200);
    expect((await gen()).statusCode).toBe(201);
    await runJobsOnce(deps());
    expect((await notifications('quota.alert')).filter((t) => t === 'AI use: 80 % of your plan').length).toBe(1);
  });

  it('messages beyond the plan are blocked with the reason; storage beyond the plan is refused', async () => {
    const c = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Quota customer (synthetic)', mobile: '9861000002' },
      billing,
    );
    const customerId = c.json<{ customer: { id: string } }>().customer.id;
    const send = () =>
      post(
        h,
        `${shop.base}/messages`,
        { customerId, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', body: 'Your repair is ready.', send: true },
        billing,
      );
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        (await send()).json<{ message: { status: string; statusReason: string | null } }>().message.statusReason ??
          'SENT',
      );
    }
    // 1 message went out in the campaign test; the plan allows 3 this month.
    expect(results).toEqual(['SENT', 'SENT', 'PLAN_QUOTA_EXCEEDED', 'PLAN_QUOTA_EXCEEDED']);
    await sql`insert into lbg.uploads (business_id, storage_key, content_type, byte_size, sha256, width, height, uploaded_by)
              values (${shop.businessId}, ${shop.businessId}::text || '/' || gen_random_uuid()::text, 'image/png', 1048576,
                      ${'0'.repeat(64)}, 1, 1, ${shop.ownerId})`.execute(h.admin);
    const imageAi = (
      await post(
        h,
        `${shop.base}/integrations`,
        {
          category: 'IMAGE_VIDEO',
          provider: 'mock',
          label: 'Images',
          authMethod: 'API_KEY',
          secret: 'image-key-SYNTHETIC-2222',
        },
        shop.owner,
      )
    ).json<{ integration: { id: string } }>().integration.id;
    await post(h, `${shop.base}/integrations/${imageAi}/test`, {}, shop.owner);
    const img = await post(
      h,
      `${shop.base}/studio/generate`,
      { kind: 'IMAGE', productIds: [phone], platform: 'INSTAGRAM', aspect: '1:1' },
      shop.owner,
    );
    expect([img.statusCode, errorCode(img)]).toEqual([429, 'QUOTA_EXCEEDED']);
  });
});

describe('monitoring (NFR-10)', () => {
  it('the owner sees jobs, integration health and assistant runs; the platform sees counts only', async () => {
    const m = (await get(h, `${shop.base}/monitoring`, shop.owner)).json<{
      monitoring: {
        jobs: { job: string; status: string }[];
        integrations: { label: string; status: string; calls24h: number }[];
        agentRuns7d: { status: string; n: number }[];
      };
    }>().monitoring;
    expect(m.jobs.some((j) => j.job === 'campaigns' && j.status === 'FAILED')).toBe(true);
    expect(m.integrations.find((i) => i.label === 'Captions')?.calls24h).toBeGreaterThan(0);
    expect(m.agentRuns7d).toEqual([{ status: 'LIMIT_REACHED', n: 1 }]);
    expect((await get(h, `${shop.base}/monitoring`, billing)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/monitoring`, other.owner)).statusCode).toBe(404);
    const platform = await get(h, '/api/platform/monitoring', fixtureAdmin());
    const counts = platform.json<{ counts: { metric: string; label: string; n: number }[] }>().counts;
    expect(counts.some((c) => c.metric === 'job' && c.label === 'campaigns:FAILED')).toBe(true);
    expect(Object.keys(counts[0] ?? {}).sort()).toEqual(['label', 'metric', 'n']);
    expect(platform.body).not.toContain(shop.businessId);
    expect((await get(h, '/api/platform/monitoring', shop.owner)).statusCode).toBe(403);
  });
});
