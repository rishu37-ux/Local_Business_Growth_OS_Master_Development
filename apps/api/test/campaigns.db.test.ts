// Increment 7.5: campaigns (FR-AIC-3 AC1, FR-AIC-4 AC2, WORKFLOWS §9, D-058).
// A recording test adapter stands in for a messaging provider (it contacts
// nobody); the mock AI adapter writes the Studio caption. Synthetic data only.
import { launchCampaign, runDueCampaigns } from '@lbgos/modules/campaigns';
import { NOT_CONFIGURED, type MessageProvider, type OutboundMessage } from '@lbgos/modules/messaging';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  patch,
  post,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

/** Records what it was asked to send; never contacts anyone. */
class RecordingProvider implements MessageProvider {
  readonly name = 'campaign-test-adapter';
  readonly configured = true;
  readonly sent: OutboundMessage[] = [];
  mode: 'accept' | 'reject' = 'accept';
  send(m: OutboundMessage) {
    if (this.mode === 'reject') return Promise.resolve({ ok: false as const, code: 'RECIPIENT_NOT_ON_CHANNEL' });
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `cmp-${m.messageId}` });
  }
}

interface Counts {
  recipients: number;
  pending: number;
  sent: number;
  blocked: number;
  failed: number;
  cancelled: number;
}
interface Campaign {
  id: string;
  status: string;
  statusReason: string | null;
  body: string;
  version: number;
  contentSha256: string;
  approvedBy: string | null;
  scheduledAt: string | null;
  segmentTags: string[];
  audienceCount: number | null;
  excludedCount: number | null;
  counts: Counts;
}
interface Audience {
  members: number;
  eligible: number;
  noAddress: number;
  noConsent: number;
  suppressed: number;
}

let h: Harness;
let shop: Shop;
let other: Shop;
let manager: Session;
let billing: Session;
const provider = new RecordingProvider();
let mobileSeq = 9840000001;
const vip: string[] = [];

const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });
const url = (id = '', path = '') => `${shop.base}/campaigns${id ? `/${id}` : ''}${path ? `/${path}` : ''}`;
const campaignOf = (res: { json: () => unknown }) => (res.json() as { campaign: Campaign }).campaign;
const read = async (id: string, who: Session = shop.owner) =>
  (await get(h, url(id), who)).json<{ campaign: Campaign; audience: Audience }>();

async function customer(tags: string[], opts: { consent?: boolean; email?: string } = {}): Promise<string> {
  const mobile = String(mobileSeq++);
  const res = await post(
    h,
    `${shop.base}/customers`,
    { name: `Campaign customer ${mobile} (synthetic)`, mobile, tags, ...(opts.email ? { email: opts.email } : {}) },
    billing,
  );
  if (res.statusCode !== 201) throw new Error(`customer failed: ${res.body}`);
  const id = res.json<{ customer: { id: string } }>().customer.id;
  if (opts.consent) {
    const c = await post(
      h,
      `${shop.base}/customers/${id}/consents`,
      { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
      billing,
    );
    if (c.statusCode !== 201) throw new Error(`consent failed: ${c.body}`);
  }
  return id;
}

/** Created by the Manager, submitted, approved by the owner. */
async function approved(input: object = {}): Promise<Campaign> {
  const c = campaignOf(
    await post(
      h,
      url(),
      {
        name: 'Diwali covers',
        channel: 'WHATSAPP',
        body: 'Diwali: covers 10% off (synthetic).',
        segmentTags: ['VIP'],
        ...input,
      },
      manager,
    ),
  );
  await post(h, url(c.id, 'submit'), {}, manager);
  const res = await post(h, url(c.id, 'approve'), { contentSha256: c.contentSha256 }, shop.owner);
  if (res.statusCode !== 200) throw new Error(`approve failed: ${res.body}`);
  return campaignOf(res);
}

const setQuiet = (start: number, end: number) =>
  sql`update lbg.business_settings set quiet_start_minute = ${start}, quiet_end_minute = ${end}
       where business_id = ${shop.businessId}`.execute(h.admin);

beforeAll(async () => {
  h = await startHarness({ messaging: provider });
  resetFixture();
  shop = await activeShop(h, 'cmp-a');
  other = await activeShop(h, 'cmp-b');
  manager = (await staff(h, shop, 'cmp-manager@example.test', 'Manager')).session;
  billing = (await staff(h, shop, 'cmp-billing@example.test', 'Billing')).session;
  await setQuiet(0, 1440); // the API tests run at the real clock; quiet hours are tested with a fixed clock
  // Segment "vip": three with marketing consent, one without, one that opted out after consenting.
  for (let i = 0; i < 3; i++) vip.push(await customer(['VIP'], { consent: true }));
  await customer(['vip']);
  const optedOut = await customer(['VIP', 'repair'], { consent: true });
  expect(
    (await post(h, `${shop.base}/customers/${optedOut}/opt-out`, { channel: 'WHATSAPP' }, billing)).statusCode,
  ).toBe(200);
  await customer(['repair'], { consent: true }); // outside the segment
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('drafting and exact-version approval (FR-AIC-3 AC1, WORKFLOWS §9)', () => {
  it('approval binds the reviewed version; an edit makes a new draft version without approval', async () => {
    const res = await post(
      h,
      url(),
      { name: 'Festive', channel: 'WHATSAPP', body: 'Festive covers 10% off (synthetic).', segmentTags: [' VIP '] },
      manager,
    );
    expect(res.statusCode).toBe(201);
    const c = campaignOf(res);
    expect(c).toMatchObject({ status: 'DRAFT', version: 1, segmentTags: ['vip'], approvedBy: null });
    expect((await read(c.id)).audience).toEqual({ members: 5, eligible: 3, noAddress: 0, noConsent: 1, suppressed: 1 });
    expect(errorCode(await post(h, url(c.id, 'approve'), { contentSha256: c.contentSha256 }, shop.owner))).toBe(
      'INVALID_STATE',
    );
    expect((await post(h, url(c.id, 'submit'), {}, manager)).statusCode).toBe(200);
    expect(errorCode(await post(h, url(c.id, 'approve'), { contentSha256: c.contentSha256 }, manager))).toBe(
      'FORBIDDEN',
    );
    const stale = await post(h, url(c.id, 'approve'), { contentSha256: 'f'.repeat(64) }, shop.owner);
    expect([stale.statusCode, errorCode(stale)]).toEqual([409, 'DRAFT_CHANGED']);
    const ok = campaignOf(await post(h, url(c.id, 'approve'), { contentSha256: c.contentSha256 }, shop.owner));
    expect(ok).toMatchObject({ status: 'APPROVED', approvedBy: shop.ownerId, contentSha256: c.contentSha256 });
    // Renaming is not a content change; changing the segment is.
    expect(campaignOf(await patch(h, url(c.id), { name: 'Festive 2' }, manager)).status).toBe('APPROVED');
    const edited = campaignOf(await patch(h, url(c.id), { segmentTags: ['VIP', 'repair'] }, manager));
    expect(edited).toMatchObject({ status: 'DRAFT', version: 2, approvedBy: null });
    expect(edited.contentSha256).not.toBe(c.contentSha256);
    const audit = await sql<{ action: string; metadata: { selfApproved?: boolean; wasApproved?: boolean } }>`
      select action, metadata from lbg.audit_events where business_id = ${shop.businessId}
         and target_id = ${c.id} order by created_at, id`.execute(h.admin);
    expect(audit.rows.map((r) => r.action)).toEqual(['campaign.create', 'campaign.approve', 'campaign.edit']);
    expect(audit.rows[1]?.metadata.selfApproved).toBe(false);
    expect(audit.rows[2]?.metadata.wasApproved).toBe(true);
  });

  it('per-channel length limits stop submission (FR-AIC-4 AC3)', async () => {
    const c = campaignOf(
      await post(h, url(), { name: 'Long SMS', channel: 'SMS', body: 'x'.repeat(161), segmentTags: ['vip'] }, manager),
    );
    const res = await post(h, url(c.id, 'submit'), {}, manager);
    expect([res.statusCode, errorCode(res)]).toEqual([422, 'TOO_LONG']);
  });

  it('text from the Studio must be approved there, and still the same at campaign approval', async () => {
    const phone = await variant(h, shop, 'CMP-PH', { serialized: true });
    await sql`update lbg.product_variants set selling_price_paise = 1200000 where id = ${phone}`.execute(h.admin);
    const llm = (
      await post(
        h,
        `${shop.base}/integrations`,
        { category: 'LLM', provider: 'mock', label: 'Mock LLM', authMethod: 'NONE', modelId: 'mock-ok' },
        shop.owner,
      )
    ).json<{ integration: { id: string } }>().integration.id;
    await post(h, `${shop.base}/integrations/${llm}/test`, {}, shop.owner);
    const draft = (
      await post(
        h,
        `${shop.base}/studio/generate`,
        { kind: 'CAPTION', productIds: [phone], platform: 'WHATSAPP' },
        manager,
      )
    ).json<{ draft: { id: string; body: string } }>().draft;
    const early = await post(h, url(), { name: 'From Studio', channel: 'WHATSAPP', draftId: draft.id }, manager);
    expect([early.statusCode, errorCode(early)]).toEqual([409, 'DRAFT_NOT_APPROVED']);
    await post(h, `${shop.base}/studio/drafts/${draft.id}/submit`, {}, manager);
    expect((await post(h, `${shop.base}/studio/drafts/${draft.id}/approve`, {}, shop.owner)).statusCode).toBe(200);
    const c = campaignOf(
      await post(h, url(), { name: 'From Studio', channel: 'WHATSAPP', draftId: draft.id }, manager),
    );
    expect(c.body).toBe(draft.body);
    await post(h, url(c.id, 'submit'), {}, manager);
    // The Studio text is edited after it was added: the campaign can no longer be approved as it is.
    await patch(h, `${shop.base}/studio/drafts/${draft.id}`, { body: `${draft.body} Visit us today.` }, manager);
    const res = await post(h, url(c.id, 'approve'), { contentSha256: c.contentSha256 }, shop.owner);
    expect([res.statusCode, errorCode(res)]).toEqual([409, 'DRAFT_NOT_APPROVED']);
  });
});

describe('sending through the send-time gate (FR-AIC-4 AC2, FR-CON-1 AC2)', () => {
  it('one message per eligible recipient with the approved text; counts are truthful', async () => {
    const c = await approved();
    expect(errorCode(await post(h, url(c.id, 'send'), {}, manager))).toBe('FORBIDDEN'); // Manager lacks marketing.send
    const before = provider.sent.length;
    const res = await post(h, url(c.id, 'send'), {}, shop.owner);
    expect(res.statusCode).toBe(200);
    const done = campaignOf(res);
    expect(done).toMatchObject({ status: 'COMPLETED', audienceCount: 5, excludedCount: 2 });
    expect(done.counts).toMatchObject({ recipients: 3, pending: 0, sent: 3, blocked: 0, failed: 0 });
    const sent = provider.sent.slice(before);
    expect(sent.map((m) => m.body)).toEqual(Array(3).fill('Diwali: covers 10% off (synthetic).'));
    const msgs = await sql<{ customer_id: string; origin: string; purpose: string; approved_by: string }>`
      select customer_id, origin, purpose, approved_by from lbg.messages where campaign_id = ${c.id}
       order by customer_id`.execute(h.admin);
    expect(msgs.rows.map((m) => m.customer_id).sort()).toEqual([...vip].sort());
    expect(msgs.rows.every((m) => m.origin === 'CAMPAIGN' && m.purpose === 'MARKETING')).toBe(true);
    expect(msgs.rows[0]?.approved_by).toBe(shop.ownerId);
    expect(errorCode(await post(h, url(c.id, 'send'), {}, shop.owner))).toBe('INVALID_STATE');
    expect(errorCode(await patch(h, url(c.id), { body: 'Changed after sending.' }, manager))).toBe('INVALID_STATE');
  });

  it('quiet hours defer the messages; an opt-out before dispatch still blocks that one', async () => {
    await setQuiet(540, 1260);
    try {
      const c = await approved({ name: 'Night launch' });
      const night = new Date('2026-11-02T21:30:00Z'); // 03:00 in Asia/Kolkata
      const running = await launchCampaign(h.appDb, ctx(), provider, c.id, night);
      expect(running).toMatchObject({ status: 'RUNNING' });
      expect(running.counts).toMatchObject({ recipients: 3, pending: 3, sent: 0 });
      await post(h, `${shop.base}/customers/${vip[0] ?? ''}/opt-out`, { channel: 'WHATSAPP' }, billing);
      const morning = new Date('2026-11-03T05:00:00Z'); // 10:30
      await runDueCampaigns(h.appDb, ctx(), provider, morning);
      const after = (await read(c.id)).campaign;
      expect(after).toMatchObject({ status: 'COMPLETED' });
      expect(after.counts).toMatchObject({ recipients: 3, pending: 0, sent: 2, blocked: 1, failed: 0 });
      const blocked = await sql<{ status_reason: string }>`select status_reason from lbg.messages
        where campaign_id = ${c.id} and status = 'BLOCKED'`.execute(h.admin);
      expect(blocked.rows[0]?.status_reason).toBe('SUPPRESSED');
    } finally {
      await setQuiet(0, 1440);
    }
  });

  it('provider failures end the campaign as PARTIALLY_FAILED; without a provider nothing starts', async () => {
    vip.shift(); // the first one has opted out
    const c = await approved({ name: 'Rejected' });
    provider.mode = 'reject';
    try {
      const res = campaignOf(await post(h, url(c.id, 'send'), {}, shop.owner));
      expect(res).toMatchObject({ status: 'PARTIALLY_FAILED', statusReason: '2 of 2 failed' });
      expect(res.counts).toMatchObject({ recipients: 2, sent: 0, failed: 2 });
    } finally {
      provider.mode = 'accept';
    }
    const idle = await approved({ name: 'No provider' });
    await expect(launchCampaign(h.appDb, ctx(), NOT_CONFIGURED, idle.id)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    expect((await read(idle.id)).campaign).toMatchObject({ status: 'APPROVED', counts: { recipients: 0 } });
    const nobody = await approved({ name: 'Nobody', segmentTags: ['no-such-tag'] });
    const empty = await post(h, url(nobody.id, 'send'), {}, shop.owner);
    expect([empty.statusCode, errorCode(empty)]).toEqual([422, 'AUDIENCE_EMPTY']);
  });
});

describe('scheduling and cancelling (FR-AIC-4 AC2)', () => {
  it('approved campaigns can be scheduled, unscheduled and cancelled until sent; an edit clears the schedule', async () => {
    const c = await approved({ name: 'Scheduled' });
    const past = await post(h, url(c.id, 'schedule'), { at: new Date(Date.now() - 60_000).toISOString() }, shop.owner);
    expect([past.statusCode, errorCode(past)]).toEqual([422, 'SCHEDULE_INVALID']);
    const at = new Date(Date.now() + 3_600_000);
    const s = campaignOf(await post(h, url(c.id, 'schedule'), { at: at.toISOString() }, shop.owner));
    expect(s).toMatchObject({ status: 'SCHEDULED', scheduledAt: at.toISOString() });
    // Not yet due.
    expect((await runDueCampaigns(h.appDb, ctx(), provider)).started).not.toContain(c.id);
    const edited = campaignOf(await patch(h, url(c.id), { body: 'Scheduled text, edited (synthetic).' }, manager));
    expect(edited).toMatchObject({ status: 'DRAFT', scheduledAt: null, approvedBy: null, version: 2 });
    await post(h, url(c.id, 'submit'), {}, manager);
    await post(h, url(c.id, 'approve'), { contentSha256: edited.contentSha256 }, shop.owner);
    await post(h, url(c.id, 'schedule'), { at: at.toISOString() }, shop.owner);
    expect(campaignOf(await post(h, url(c.id, 'unschedule'), {}, shop.owner)).status).toBe('APPROVED');
    await post(h, url(c.id, 'schedule'), { at: at.toISOString() }, shop.owner);
    const due = await runDueCampaigns(h.appDb, ctx(), provider, new Date(at.getTime() + 1000));
    expect(due.started).toContain(c.id);
    expect((await read(c.id)).campaign).toMatchObject({ status: 'COMPLETED', counts: { sent: 2 } });

    const later = await approved({ name: 'Cancelled' });
    await post(h, url(later.id, 'schedule'), { at: at.toISOString() }, shop.owner);
    expect(campaignOf(await post(h, url(later.id, 'cancel'), {}, manager)).status).toBe('CANCELLED');
    expect(errorCode(await post(h, url(later.id, 'cancel'), {}, manager))).toBe('INVALID_STATE');
    expect((await runDueCampaigns(h.appDb, ctx(), provider, new Date(at.getTime() + 1000))).started).not.toContain(
      later.id,
    );
  });

  it('cancelling a running campaign cancels the messages not yet handed to the provider', async () => {
    await setQuiet(540, 1260);
    try {
      const c = await approved({ name: 'Cancelled while deferred' });
      await launchCampaign(h.appDb, ctx(), provider, c.id, new Date('2026-11-02T21:30:00Z'));
      const res = campaignOf(await post(h, url(c.id, 'cancel'), {}, shop.owner));
      expect(res).toMatchObject({ status: 'CANCELLED', counts: { recipients: 2, pending: 0, cancelled: 2, sent: 0 } });
    } finally {
      await setQuiet(0, 1440);
    }
  });
});

describe('database rules (WORKFLOWS §9, LB023)', () => {
  it('the trigger keeps the hash, versions, approval and campaign messages honest', async () => {
    const c = await approved({ name: 'DB rules' });
    // The hash is computed by the database; a forged one is replaced, so approval no longer matches.
    await expect(
      sql`update lbg.campaigns set content_sha256 = ${'0'.repeat(64)} where id = ${c.id}`.execute(h.admin),
    ).resolves.toBeDefined();
    expect((await read(c.id)).campaign.contentSha256).toBe(c.contentSha256);
    await expect(
      sql`update lbg.campaigns set body = 'Sneaky change' where id = ${c.id}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB023' });
    await expect(
      sql`update lbg.campaigns set status = 'RUNNING', started_at = now(), approved_sha256 = ${'1'.repeat(64)}
           where id = ${c.id}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB023' });
    await expect(
      sql`update lbg.campaigns set status = 'COMPLETED' where id = ${c.id}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB002' });
    await expect(sql`delete from lbg.campaigns where id = ${c.id}`.execute(h.admin)).rejects.toMatchObject({
      code: 'LB001',
    });
    // A campaign message needs its running campaign and the approved text.
    await expect(
      sql`insert into lbg.messages (business_id, customer_id, channel, purpose, origin, campaign_id, to_address, body, status)
          values (${shop.businessId}, ${vip[0] ?? ''}, 'WHATSAPP', 'MARKETING', 'CAMPAIGN', ${c.id}, '+919840000099',
                  ${c.body}, 'QUEUED')`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB023' });
    await expect(
      sql`insert into lbg.messages (business_id, customer_id, channel, purpose, to_address, body, status)
          values (${shop.businessId}, ${vip[0] ?? ''}, 'WHATSAPP', 'MARKETING', '+919840000099', 'Hi', 'QUEUED')`.execute(
        h.admin,
      ),
    ).rejects.toMatchObject({ code: 'LB002' });
  });
});

describe('access', () => {
  it('other businesses get 404; Billing cannot read; read-only mode lists but cannot send', async () => {
    const c = (await get(h, url(), manager)).json<{ campaigns: Campaign[]; provider: { configured: boolean } }>();
    expect(c.provider.configured).toBe(true);
    const id = c.campaigns[0]?.id ?? '';
    expect((await get(h, `${other.base}/campaigns/${id}`, other.owner)).statusCode).toBe(404);
    expect((await post(h, `${other.base}/campaigns/${id}/send`, {}, other.owner)).statusCode).toBe(404);
    expect((await get(h, url(), billing)).statusCode).toBe(403);
    const draft = campaignOf(
      await post(h, url(), { name: 'RO', channel: 'WHATSAPP', body: 'Hello (synthetic).' }, manager),
    );
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, url(), shop.owner)).statusCode).toBe(200);
    expect(errorCode(await post(h, url(draft.id, 'submit'), {}, shop.owner))).toBe('TENANT_READ_ONLY');
  });
});
