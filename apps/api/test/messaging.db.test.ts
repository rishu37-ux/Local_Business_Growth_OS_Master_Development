// Increment 6.2: consent, suppression, the send-time gate, the message status
// machine and the provider adapter (FR-CON-1, FR-MSG-1 AC3–4, WORKFLOWS §9,
// D-048). No real provider: the API runs with none configured; a recording
// test adapter stands in where a provider result is needed. Synthetic data only.
import {
  createMessage,
  dispatchDue,
  dispatchMessage,
  getMessage,
  handleInboundOptOut,
  recordProviderStatus,
  type MessageProvider,
  type OutboundMessage,
} from '@lbgos/modules/messaging';
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
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let manager: Session;
let mobileSeq = 9830000001;

interface ChannelState {
  channel: string;
  suppressed: boolean;
  marketing: string | null;
  transactionalAllowed: boolean;
  marketingAllowed: boolean;
}
interface Msg {
  id: string;
  status: string;
  statusReason: string | null;
  toAddress: string;
  notBefore: string | null;
  providerMessageId: string | null;
  events: { status: string; reason: string | null }[];
}

let adapterSeq = 0;

/** Records what it was asked to send; never contacts anyone. References are unique per instance (by name). */
class RecordingProvider implements MessageProvider {
  readonly name = `test-adapter-${String(++adapterSeq)}`;
  readonly configured = true;
  readonly sent: OutboundMessage[] = [];
  mode: 'accept' | 'reject' | 'throw' = 'accept';
  send(m: OutboundMessage) {
    if (this.mode === 'throw') return Promise.reject(new Error('network down'));
    if (this.mode === 'reject') return Promise.resolve({ ok: false as const, code: 'RECIPIENT_NOT_ON_CHANNEL' });
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `test-${String(this.sent.length)}` });
  }
}

const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });

async function customer(name: string, extra: object = {}): Promise<{ id: string; mobile: string }> {
  const mobile = String(mobileSeq++);
  const res = await post(h, `${shop.base}/customers`, { name: `${name} (synthetic)`, mobile, ...extra }, billing);
  if (res.statusCode !== 201) throw new Error(`customer failed: ${res.body}`);
  return { id: res.json<{ customer: { id: string } }>().customer.id, mobile: `+91${mobile}` };
}

const channels = async (customerId: string, session: Session = billing) =>
  (await get(h, `${shop.base}/customers/${customerId}/consents`, session)).json<{
    consents: { channels: ChannelState[]; history: { status: string; source: string }[] };
  }>().consents;

const grantMarketing = (customerId: string, session: Session = billing, ch = 'WHATSAPP') =>
  post(
    h,
    `${shop.base}/customers/${customerId}/consents`,
    { channel: ch, purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
    session,
  );

/** Drafts, submits and approves a marketing message; returns its id. */
async function approvedMarketing(customerId: string): Promise<string> {
  const d = await post(
    h,
    `${shop.base}/messages`,
    { customerId, channel: 'WHATSAPP', purpose: 'MARKETING', body: 'Diwali offer: 10% off covers (synthetic).' },
    manager,
  );
  if (d.statusCode !== 201) throw new Error(`draft failed: ${d.body}`);
  const id = d.json<{ message: Msg }>().message.id;
  expect((await post(h, `${shop.base}/messages/${id}/submit`, {}, manager)).statusCode).toBe(200);
  expect((await post(h, `${shop.base}/messages/${id}/approve`, {}, shop.owner)).statusCode).toBe(200);
  return id;
}

const send = (id: string, session: Session = shop.owner) => post(h, `${shop.base}/messages/${id}/send`, {}, session);

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'msg-a');
  other = await activeShop(h, 'msg-b');
  billing = (await staff(h, shop, 'msg-billing@example.test', 'Billing')).session;
  manager = (await staff(h, shop, 'msg-manager@example.test', 'Manager')).session;
  // The API tests run at the real clock; open the window all day so quiet hours
  // do not depend on when the suite runs (quiet hours are tested below with a fixed clock).
  const opened = await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
                             where business_id = ${shop.businessId}`.execute(h.admin);
  expect(opened.numAffectedRows).toBe(1n);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('consent records (FR-CON-1 AC1, AC4)', () => {
  it('new customers: transactional allowed, marketing not; no address means not allowed', async () => {
    const c = await customer('Default Policy');
    const s = await channels(c.id);
    expect(s.channels.map((x) => [x.channel, x.transactionalAllowed, x.marketingAllowed])).toEqual([
      ['WHATSAPP', true, false],
      ['SMS', true, false],
      ['EMAIL', false, false], // no email recorded
    ]);
  });

  it('a consent is appended with source and actor; the latest record decides; audit has no personal data', async () => {
    const c = await customer('Consent History');
    expect((await grantMarketing(c.id)).statusCode).toBe(201);
    expect((await channels(c.id)).channels[0]?.marketingAllowed).toBe(true);
    const w = await post(
      h,
      `${shop.base}/customers/${c.id}/consents`,
      {
        channel: 'WHATSAPP',
        purpose: 'MARKETING',
        status: 'WITHDRAWN',
        source: 'Customer called to say no more offers',
      },
      billing,
    );
    expect(w.statusCode).toBe(201);
    const s = await channels(c.id);
    expect(s.channels[0]).toMatchObject({
      marketing: 'WITHDRAWN',
      marketingAllowed: false,
      transactionalAllowed: true,
    });
    expect(s.history.map((r) => r.status)).toEqual(['WITHDRAWN', 'GRANTED']);
    const audit = await sql<{ metadata: object; actor_user_id: string }>`
      select metadata, actor_user_id from lbg.audit_events
       where business_id = ${shop.businessId} and action = 'consent.record' and target_id = ${c.id}
       order by created_at`.execute(h.admin);
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', released: false },
      { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'WITHDRAWN', released: false },
    ]);
    // Append-only, even for the owner role.
    await expect(
      sql`update lbg.customer_consents set status = 'GRANTED' where customer_id = ${c.id}`.execute(h.admin),
    ).rejects.toThrow();
    expect(
      (
        await post(
          h,
          `${shop.base}/customers/${c.id}/consents`,
          { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'x' },
          billing,
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe('approval and the send-time gate (FR-CON-1 AC2–3, WORKFLOWS §9)', () => {
  it('marketing needs marketing.draft, .approve and .send; without a provider it fails as not configured', async () => {
    const yes = await customer('Marketing Yes');
    await grantMarketing(yes.id);
    const draft = { customerId: yes.id, channel: 'WHATSAPP', purpose: 'MARKETING', body: 'New stock arrived.' };
    expect((await post(h, `${shop.base}/messages`, draft, billing)).statusCode).toBe(403);
    const d = await post(h, `${shop.base}/messages`, draft, manager);
    expect(d.statusCode).toBe(201);
    const id = d.json<{ message: Msg }>().message.id;
    expect(d.json<{ message: Msg }>().message).toMatchObject({ status: 'DRAFT', toAddress: yes.mobile });
    // Not approved yet: cannot be sent.
    expect(errorCode(await send(id))).toBe('INVALID_STATE');
    await post(h, `${shop.base}/messages/${id}/submit`, {}, manager);
    expect((await post(h, `${shop.base}/messages/${id}/approve`, {}, manager)).statusCode).toBe(403);
    expect((await post(h, `${shop.base}/messages/${id}/approve`, {}, shop.owner)).statusCode).toBe(200);
    expect((await send(id, manager)).statusCode).toBe(403); // Manager lacks marketing.send
    const res = await send(id);
    expect(res.statusCode).toBe(200);
    const out = res.json<{ message: Msg; dispatch: object }>();
    expect(out.dispatch).toEqual({ outcome: 'FAILED', reason: 'PROVIDER_NOT_CONFIGURED' });
    expect(out.message.status).toBe('FAILED');
    expect(out.message.events.map((e) => e.status)).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'APPROVED',
      'QUEUED',
      'FAILED',
    ]);
    const list = await get(h, `${shop.base}/messages?customerId=${yes.id}`, billing);
    expect(list.json<{ provider: object }>().provider).toEqual({ configured: false });
  });

  it('marketing to a customer without consent is blocked at send time with the reason', async () => {
    const no = await customer('Marketing No');
    const id = await approvedMarketing(no.id);
    const out = (await send(id)).json<{ message: Msg; dispatch: object }>();
    expect(out.dispatch).toEqual({ outcome: 'BLOCKED', reason: 'NO_MARKETING_CONSENT' });
    expect(out.message).toMatchObject({ status: 'BLOCKED', statusReason: 'NO_MARKETING_CONSENT' });
  });

  it('an opt-out blocks messages approved or queued before it, and suppresses at once', async () => {
    const c = await customer('Opts Out');
    await grantMarketing(c.id);
    const approved = await approvedMarketing(c.id);
    const queued = await createMessage(
      h.appDb,
      ctx(),
      { customerId: c.id, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', body: 'Your repair is ready.' },
      { queue: true },
    );
    const opt = await post(h, `${shop.base}/customers/${c.id}/opt-out`, { channel: 'WHATSAPP' }, billing);
    expect(opt.statusCode).toBe(200);
    expect(opt.json<{ consents: { channels: ChannelState[] } }>().consents.channels[0]).toMatchObject({
      suppressed: true,
      marketing: 'WITHDRAWN',
      transactionalAllowed: false,
      marketingAllowed: false,
    });
    const out = (await send(approved)).json<{ message: Msg; dispatch: object }>();
    expect(out.dispatch).toEqual({ outcome: 'BLOCKED', reason: 'SUPPRESSED' });
    const due = await dispatchDue(h.appDb, ctx(), new RecordingProvider());
    expect(due).toEqual([{ id: queued.id, result: { outcome: 'BLOCKED', reason: 'SUPPRESSED' } }]);
    const history = (await get(h, `${shop.base}/messages?customerId=${c.id}`, billing)).json<{ messages: Msg[] }>()
      .messages;
    expect(history.map((m) => [m.status, m.statusReason])).toEqual([
      ['BLOCKED', 'SUPPRESSED'],
      ['BLOCKED', 'SUPPRESSED'],
    ]);
    const sup = (await get(h, `${shop.base}/suppressions`, billing)).json<{ suppressions: object[] }>().suppressions;
    expect(sup).toContainEqual(
      expect.objectContaining({ channel: 'WHATSAPP', address: c.mobile, reason: 'OWNER_OPT_OUT' }),
    );
    // SMS is a different channel and stays allowed for transactional messages.
    expect((await channels(c.id)).channels[1]).toMatchObject({ suppressed: false, transactionalAllowed: true });
    // Only someone who can approve marketing records new consent on a suppressed contact.
    const again = await grantMarketing(c.id, manager);
    expect([again.statusCode, errorCode(again)]).toEqual([403, 'RELEASE_NEEDS_APPROVER']);
    expect((await grantMarketing(c.id, shop.owner)).statusCode).toBe(201);
    expect((await channels(c.id)).channels[0]).toMatchObject({ suppressed: false, marketingAllowed: true });
  });

  it('an inbound STOP suppresses the address, also for an unknown number', async () => {
    const c = await customer('Replied Stop');
    await grantMarketing(c.id);
    expect(await handleInboundOptOut(h.appDb, ctx(), 'WHATSAPP', c.mobile)).toBe(true);
    expect(await handleInboundOptOut(h.appDb, ctx(), 'WHATSAPP', c.mobile)).toBe(false); // already suppressed
    expect((await channels(c.id)).channels[0]).toMatchObject({ suppressed: true, marketing: 'WITHDRAWN' });
    expect(await handleInboundOptOut(h.appDb, ctx(), 'SMS', '+919899999999')).toBe(true);
    const sup = (await get(h, `${shop.base}/suppressions`, billing)).json<{ suppressions: object[] }>().suppressions;
    expect(sup).toContainEqual(expect.objectContaining({ channel: 'SMS', address: '+919899999999', customerId: null }));
  });

  it('transactional with send: queued and dispatched at once; no provider means FAILED, never SENT', async () => {
    const c = await customer('Transactional');
    const res = await post(
      h,
      `${shop.base}/messages`,
      { customerId: c.id, channel: 'SMS', purpose: 'TRANSACTIONAL', body: 'Invoice T/0001 total ₹500.', send: true },
      billing,
    );
    expect(res.statusCode).toBe(201);
    const out = res.json<{ message: Msg; dispatch: object }>();
    expect(out.dispatch).toEqual({ outcome: 'FAILED', reason: 'PROVIDER_NOT_CONFIGURED' });
    expect(out.message.events.map((e) => e.status)).toEqual(['QUEUED', 'FAILED']);
    const mkt = await post(
      h,
      `${shop.base}/messages`,
      { customerId: c.id, channel: 'SMS', purpose: 'MARKETING', body: 'Offer', send: true },
      manager,
    );
    expect(errorCode(mkt)).toBe('MARKETING_NOT_TRANSACTIONAL');
    const noEmail = await post(
      h,
      `${shop.base}/messages`,
      { customerId: c.id, channel: 'EMAIL', purpose: 'TRANSACTIONAL', body: 'Hi' },
      billing,
    );
    expect(errorCode(noEmail)).toBe('NO_ADDRESS');
  });
});

describe('provider adapter (FR-MSG-1 AC4, test adapter only)', () => {
  it('SENT only with the provider reference; receipts move it to DELIVERED and READ; failures are recorded', async () => {
    const provider = new RecordingProvider();
    const c = await customer('Adapter');
    const m = await createMessage(
      h.appDb,
      ctx(),
      { customerId: c.id, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', body: 'Your phone is ready for pickup.' },
      { queue: true },
    );
    expect(await dispatchMessage(h.appDb, ctx(), provider, m.id)).toEqual({
      outcome: 'SENT',
      providerMessageId: 'test-1',
    });
    expect(provider.sent).toEqual([
      { messageId: m.id, channel: 'WHATSAPP', to: c.mobile, body: 'Your phone is ready for pickup.' },
    ]);
    expect(await dispatchMessage(h.appDb, ctx(), provider, m.id)).toEqual({ outcome: 'SKIPPED', status: 'SENT' });
    expect(await recordProviderStatus(h.appDb, ctx(), provider.name, 'test-1', 'DELIVERED')).toBe(true);
    expect(await recordProviderStatus(h.appDb, ctx(), provider.name, 'test-1', 'READ')).toBe(true);
    expect(await recordProviderStatus(h.appDb, ctx(), provider.name, 'test-1', 'DELIVERED')).toBe(true); // late, ignored
    expect(await recordProviderStatus(h.appDb, ctx(), 'other-provider', 'test-1', 'READ')).toBe(false);
    const done = await getMessage(h.appDb, ctx(), m.id);
    expect(done.events.map((e) => e.status)).toEqual(['QUEUED', 'SUBMITTED', 'SENT', 'DELIVERED', 'READ']);
    expect(done.provider).toBe(provider.name);

    for (const [mode, reason] of [
      ['reject', 'RECIPIENT_NOT_ON_CHANNEL'],
      ['throw', 'PROVIDER_ERROR'],
    ] as const) {
      provider.mode = mode;
      const f = await createMessage(
        h.appDb,
        ctx(),
        { customerId: c.id, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', body: 'Reminder.' },
        { queue: true },
      );
      expect(await dispatchMessage(h.appDb, ctx(), provider, f.id)).toEqual({ outcome: 'FAILED', reason });
      expect((await getMessage(h.appDb, ctx(), f.id)).events.map((e) => e.status)).toEqual([
        'QUEUED',
        'SUBMITTED',
        'FAILED',
      ]);
    }
  });

  it('the database enforces the status machine and provider confirmation', async () => {
    const c = await customer('Db Rules');
    const m = await createMessage(h.appDb, ctx(), {
      customerId: c.id,
      channel: 'SMS',
      purpose: 'MARKETING',
      body: 'Offer text.',
    });
    const set = (status: string, extra = sql``) =>
      sql`update lbg.messages set status = ${status} ${extra} where id = ${m.id}`.execute(h.admin);
    await expect(set('SENT')).rejects.toMatchObject({ code: 'LB002' }); // DRAFT → SENT
    await expect(set('QUEUED')).rejects.toMatchObject({ code: 'LB002' }); // skips approval
    await set('PENDING_APPROVAL');
    await set('APPROVED');
    await expect(
      sql`update lbg.messages set body = 'changed after approval' where id = ${m.id}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB003' });
    await set('QUEUED');
    await set('SUBMITTED', sql`, provider = 'x'`);
    await expect(set('SENT')).rejects.toMatchObject({ code: 'LB020' }); // no provider reference
    await expect(
      sql`insert into lbg.messages (business_id, customer_id, channel, purpose, to_address, body, status)
          values (${shop.businessId}, ${c.id}, 'SMS', 'MARKETING', ${c.mobile}, 'x', 'QUEUED')`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB002' }); // marketing cannot start queued
    await expect(
      sql`insert into lbg.messages (business_id, customer_id, channel, purpose, to_address, body, status, provider, provider_message_id)
          values (${shop.businessId}, ${c.id}, 'SMS', 'TRANSACTIONAL', ${c.mobile}, 'x', 'SENT', 'x', 'y')`.execute(
        h.admin,
      ),
    ).rejects.toMatchObject({ code: 'LB002' });
    await expect(
      sql`update lbg.message_events set status = 'SENT' where message_id = ${m.id}`.execute(h.admin),
    ).rejects.toThrow();
    await expect(sql`delete from lbg.contact_suppressions`.execute(h.admin)).rejects.toThrow();
  });
});

describe('quiet hours (FR-REM-1 AC3: marketing and reminders, default 09:00–21:00)', () => {
  it('outside the window a message waits until 09:00 business time, then goes', async () => {
    await sql`update lbg.business_settings set quiet_start_minute = 540, quiet_end_minute = 1260
               where business_id = ${shop.businessId}`.execute(h.admin);
    try {
      const provider = new RecordingProvider();
      const c = await customer('Quiet Hours');
      await grantMarketing(c.id);
      const id = await approvedMarketing(c.id);
      await sql`update lbg.messages set status = 'QUEUED' where id = ${id}`.execute(h.admin);
      const night = new Date('2026-10-28T16:30:00Z'); // 22:00 IST
      expect(await dispatchMessage(h.appDb, ctx(), provider, id, night)).toEqual({
        outcome: 'DEFERRED',
        notBefore: '2026-10-29T03:30:00.000Z', // 09:00 IST next day
      });
      expect(await dispatchDue(h.appDb, ctx(), provider, new Date('2026-10-29T03:29:00Z'))).toEqual([]);
      const due = await dispatchDue(h.appDb, ctx(), provider, new Date('2026-10-29T03:30:00Z'));
      expect(due).toEqual([{ id, result: { outcome: 'SENT', providerMessageId: 'test-1' } }]);
      // Transactional messages are not held by quiet hours.
      const t = await createMessage(
        h.appDb,
        ctx(),
        { customerId: c.id, channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', body: 'Receipt.' },
        { queue: true },
      );
      expect((await dispatchMessage(h.appDb, ctx(), provider, t.id, night)).outcome).toBe('SENT');
    } finally {
      await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
                 where business_id = ${shop.businessId}`.execute(h.admin);
    }
  });
});

describe('access', () => {
  it('other businesses get 404; read-only mode can view but not record, draft or send', async () => {
    const c = await customer('Tenant Check');
    const d = await post(
      h,
      `${shop.base}/messages`,
      { customerId: c.id, channel: 'SMS', purpose: 'TRANSACTIONAL', body: 'Hello.' },
      billing,
    );
    const id = d.json<{ message: Msg }>().message.id;
    expect((await get(h, `${other.base}/customers/${c.id}/consents`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/messages/${id}`, other.owner)).statusCode).toBe(404);
    expect((await send(id, other.owner)).statusCode).toBe(404);
    expect((await post(h, `${other.base}/messages/${id}/send`, {}, other.owner)).statusCode).toBe(404);
    expect((await grantMarketing(c.id, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/messages`, other.owner)).json<{ messages: object[] }>().messages).toEqual([]);
    expect(
      (await get(h, `${other.base}/suppressions`, other.owner)).json<{ suppressions: object[] }>().suppressions,
    ).toEqual([]);

    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/customers/${c.id}/consents`, shop.owner)).statusCode).toBe(200);
    expect((await get(h, `${shop.base}/messages/${id}`, shop.owner)).statusCode).toBe(200);
    for (const res of [
      await grantMarketing(c.id, shop.owner),
      await post(
        h,
        `${shop.base}/messages`,
        { customerId: c.id, channel: 'SMS', purpose: 'TRANSACTIONAL', body: 'x' },
        shop.owner,
      ),
      await post(h, `${shop.base}/messages/${id}/approve`, {}, shop.owner),
      await patch(h, `${shop.base}/messages/${id}`, { body: 'changed' }, shop.owner),
    ]) {
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'TENANT_READ_ONLY']);
    }
  });
});
