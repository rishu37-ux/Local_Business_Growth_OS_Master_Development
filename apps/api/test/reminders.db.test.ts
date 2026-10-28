// Increment 6.3: reminders — birthday, warranty expiry, service due, payment
// due (FR-REM-1, D-049). Runs use a fixed clock: 10 Nov 2026, 11:30 IST.
// No provider is connected; a recording test adapter stands in for auto-send.
// Synthetic data only.
import { getMessage, type MessageProvider, type OutboundMessage } from '@lbgos/modules/messaging';
import { runReminders } from '@lbgos/modules/reminders';
import { createSaleDraft, issueSale, type SaleLineSpec } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  patch,
  post,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const NOW = new Date('2026-11-10T06:00:00Z'); // 11:30 IST
const ACCESS = { discount: { limits: undefined }, priceOverride: true };

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let manager: Session;
let phone: string; // serialised, 12 months warranty
let charger: string; // 6 months warranty, no IMEI
let imeiSeq = 8600;
let mobileSeq = 9840000001;
const people: Record<string, { id: string; mobile: string }> = {};

class RecordingProvider implements MessageProvider {
  readonly name = 'test-adapter-reminders';
  readonly configured = true;
  readonly sent: OutboundMessage[] = [];
  send(m: OutboundMessage) {
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `rem-${String(this.sent.length)}` });
  }
}

const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });

async function customer(key: string, extra: object = {}) {
  const mobile = String(mobileSeq++);
  const res = await post(h, `${shop.base}/customers`, { name: `${key} (synthetic)`, mobile, ...extra }, billing);
  if (res.statusCode !== 201) throw new Error(`customer failed: ${res.body}`);
  people[key] = { id: res.json<{ customer: { id: string } }>().customer.id, mobile: `+91${mobile}` };
  return people[key];
}

const consent = (customerId: string) =>
  post(
    h,
    `${shop.base}/customers/${customerId}/consents`,
    { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Signed the offers form' },
    billing,
  );

async function seedUnit(): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
    values (${shop.businessId}, ${phone}, 'IN_STOCK', 50000) returning id`.execute(h.admin);
  const id = rows[0]?.id ?? '';
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
            values (${shop.businessId}, ${imei(imeiSeq++)}, ${id}, 1)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${phone}, ${id}, 'OPENING', 1, 50000)`.execute(h.admin);
  return id;
}

/** A sale at a chosen time (IST noon of `date`), paying `paid` paise in cash (null: all). */
async function sellOn(date: string, lines: SaleLineSpec[], customerId: string, paid: number | null = null) {
  const at = new Date(`${date}T06:30:00Z`);
  const draft = await createSaleDraft(h.appDb, ctx(), ACCESS, { customerId, lines }, at);
  const amount = paid ?? draft.totals.totalPaise;
  await issueSale(
    h.appDb,
    ctx(),
    ACCESS,
    draft.id,
    {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: amount > 0 ? [{ method: 'CASH', amountPaise: amount, reference: null }] : [],
    },
    { at },
  );
}

const setting = (type: string, body: object, session: Session = shop.owner) =>
  put(h, `${shop.base}/reminders/settings/${type}`, body, session);
const defaults = async () =>
  (await get(h, `${shop.base}/reminders/settings`, shop.owner)).json<{
    settings: { type: string; template: string; days: number; enabled: boolean; autoSend: boolean; purpose: string }[];
  }>().settings;
const enable = async (type: string, over: object = {}, session: Session = shop.owner) => {
  const d = (await defaults()).find((s) => s.type === type);
  return setting(
    type,
    { enabled: true, autoSend: false, channel: 'WHATSAPP', template: d?.template, days: d?.days, ...over },
    session,
  );
};

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'rem-a');
  other = await activeShop(h, 'rem-b');
  billing = (await staff(h, shop, 'rem-billing@example.test', 'Billing')).session;
  manager = (await staff(h, shop, 'rem-manager@example.test', 'Manager')).session;
  phone = await variant(h, shop, 'REM-PH', { serialized: true });
  charger = await variant(h, shop, 'REM-CH', { serialized: false });
  await patch(h, `${shop.base}/variants/${phone}`, { warrantyMonths: 12 }, shop.owner);
  await patch(h, `${shop.base}/variants/${charger}`, { warrantyMonths: 6 }, shop.owner);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${charger}, 'OPENING', 20, 10000)`.execute(h.admin);
  await sql`update lbg.product_variants set avg_cost_paise = 10000 where id = ${charger}`.execute(h.admin);

  // Asha: birthday today, marketing consent, phone sold 20 Nov 2025 (warranty ends 20 Nov 2026, in 10 days).
  const asha = await customer('Asha', { dob: '1990-11-10' });
  await consent(asha.id);
  await sellOn('2025-11-20', [{ unitId: await seedUnit() }], asha.id);
  // Bilal: birthday today but no consent; phone warranty ended 1 Jun 2026.
  const bilal = await customer('Bilal', { dob: '1985-11-10' });
  await sellOn('2025-06-01', [{ unitId: await seedUnit() }], bilal.id);
  // Chitra: no DOB; charger 15 May 2026 (warranty ends 15 Nov, no IMEI); phone 19 May 2026, ₹600 still owed.
  const chitra = await customer('Chitra');
  await sellOn('2026-05-15', [{ variantId: charger, quantity: '1' }], chitra.id);
  await sellOn('2026-05-19', [{ unitId: await seedUnit() }], chitra.id, 40_000);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('settings and templates (FR-REM-1 AC2–3)', () => {
  it('every type is off by default with auto-send off; payment due is transactional, the rest marketing', async () => {
    expect((await defaults()).map((s) => [s.type, s.enabled, s.autoSend, s.purpose, s.days])).toEqual([
      ['BIRTHDAY', false, false, 'MARKETING', 0],
      ['WARRANTY_EXPIRY', false, false, 'MARKETING', 15],
      ['SERVICE_DUE', false, false, 'MARKETING', 180],
      ['PAYMENT_DUE', false, false, 'TRANSACTIONAL', 30],
    ]);
    expect((await get(h, `${shop.base}/reminders/settings`, billing)).statusCode).toBe(200);
    const change = await setting(
      'BIRTHDAY',
      { enabled: true, autoSend: false, channel: 'SMS', template: 'Hi {name}', days: 0 },
      billing,
    );
    expect(change.statusCode).toBe(403); // Billing lacks marketing.draft
  });

  it('unknown placeholders and ones the type cannot fill are refused when saved', async () => {
    const res = await setting('BIRTHDAY', {
      enabled: true,
      autoSend: false,
      channel: 'WHATSAPP',
      template: 'Hi {name}, {discount} off your {model}!',
      days: 0,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string; problems: string[] } }>().error).toMatchObject({
      code: 'TEMPLATE_INVALID',
      problems: ['Unknown placeholder {discount}.', '{model} is not available for this reminder.'],
    });
  });

  it('only an approver can turn on auto-send; staff with marketing.draft can enable drafts', async () => {
    const auto = await enable('BIRTHDAY', { autoSend: true }, manager);
    expect([auto.statusCode, errorCode(auto)]).toEqual([403, 'AUTO_SEND_NEEDS_APPROVER']);
    expect((await enable('BIRTHDAY', {}, manager)).statusCode).toBe(200);
    const audit = await sql<{ metadata: object }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'reminder.settings'`.execute(h.admin);
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { type: 'BIRTHDAY', enabled: true, autoSend: false, channel: 'WHATSAPP', days: 0 },
    ]);
  });
});

describe('the run (FR-REM-1 AC1–3)', () => {
  it('drafts only where the recorded facts allow it, reports skips, and does not send', async () => {
    await enable('WARRANTY_EXPIRY');
    await enable('SERVICE_DUE', { days: 175 }); // 19 May + 175 days = 10 Nov
    await enable('PAYMENT_DUE', { channel: 'EMAIL' }); // Chitra has no email
    const run = await runReminders(h.appDb, ctx(), new RecordingProvider(), NOW);
    expect(run.date).toBe('2026-11-10');
    const name = (id: string) => Object.entries(people).find(([, p]) => p.id === id)?.[0];
    expect(run.created.map((c) => [c.type, name(c.customerId)])).toEqual([
      ['BIRTHDAY', 'Asha'],
      ['WARRANTY_EXPIRY', 'Asha'],
      ['SERVICE_DUE', 'Chitra'],
    ]);
    expect(run.skipped.map((s) => [s.type, name(s.customerId), s.reason, s.missing ?? null])).toEqual([
      ['BIRTHDAY', 'Bilal', 'NO_CONSENT', null], // FR-REM-1 AC1: DOB and consent
      ['WARRANTY_EXPIRY', 'Chitra', 'MISSING_FIELD', ['imei_last4']], // charger: no IMEI recorded
      ['PAYMENT_DUE', 'Chitra', 'NO_ADDRESS', null],
    ]);
    expect(run.dispatched).toEqual([]);
    const birthday = await getMessage(h.appDb, ctx(), run.created[0]?.messageId ?? '');
    expect(birthday).toMatchObject({
      status: 'DRAFT',
      purpose: 'MARKETING',
      origin: 'REMINDER',
      body: 'Happy birthday, Asha (synthetic)! Best wishes from rem-a Mobiles.',
    });
    const warranty = await getMessage(h.appDb, ctx(), run.created[1]?.messageId ?? '');
    expect(warranty.body).toMatch(
      /^Hello Asha \(synthetic\), the warranty on your .+ \(IMEI ending \d{4}\) ends on 20 Nov 2026\. — rem-a Mobiles$/,
    );
    const service = await getMessage(h.appDb, ctx(), run.created[2]?.messageId ?? '');
    expect(service.body).toContain('is due for a check-up from 10 Nov 2026');
    // The run summary and audit hold counts only.
    const runs = await sql<{
      created_count: number;
      skipped: object;
    }>`select created_count, skipped from lbg.reminder_runs
      where business_id = ${shop.businessId}`.execute(h.admin);
    expect(runs.rows).toEqual([
      {
        created_count: 3,
        skipped: { 'BIRTHDAY.NO_CONSENT': 1, 'WARRANTY_EXPIRY.MISSING_FIELD': 1, 'PAYMENT_DUE.NO_ADDRESS': 1 },
      },
    ]);
    const audit = await sql<{ metadata: object }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'reminder.run'`.execute(h.admin);
    expect(JSON.stringify(audit.rows)).not.toMatch(/Asha|Bilal|Chitra|\+91/);
  });

  it('running again creates nothing new; a fixed setting picks up what was skipped', async () => {
    const again = await runReminders(h.appDb, ctx(), new RecordingProvider(), NOW);
    expect([again.created.length, again.alreadyDrafted]).toEqual([0, 3]);
    await enable('PAYMENT_DUE'); // WhatsApp now
    const third = await runReminders(h.appDb, ctx(), new RecordingProvider(), NOW);
    expect(third.created.map((c) => c.type)).toEqual(['PAYMENT_DUE']);
    const pay = await getMessage(h.appDb, ctx(), third.created[0]?.messageId ?? '');
    expect(pay).toMatchObject({ purpose: 'TRANSACTIONAL', status: 'DRAFT' });
    expect(pay.body).toBe('Hello Chitra (synthetic), ₹600.00 is due at rem-a Mobiles. Thank you.');
    const list = await get(h, `${shop.base}/reminders?status=DRAFT`, billing);
    expect(
      list
        .json<{ reminders: { type: string }[] }>()
        .reminders.map((r) => r.type)
        .sort(),
    ).toEqual(['BIRTHDAY', 'PAYMENT_DUE', 'SERVICE_DUE', 'WARRANTY_EXPIRY']);
    // Concurrent runs are serialised: still nothing new.
    const both = await Promise.all([
      runReminders(h.appDb, ctx(), new RecordingProvider(), NOW),
      runReminders(h.appDb, ctx(), new RecordingProvider(), NOW),
    ]);
    expect(both.map((r) => r.created.length)).toEqual([0, 0]);
  });

  it('auto-send (approved by the owner) dispatches through the gate: consented goes, opted-out is blocked', async () => {
    const dev = await customer('Dev', { dob: '2000-11-11' }); // birthday tomorrow
    await consent(dev.id);
    const esha = await customer('Esha', { dob: '1999-11-11' });
    await consent(esha.id);
    await post(h, `${shop.base}/customers/${esha.id}/opt-out`, { channel: 'WHATSAPP' }, billing);
    expect((await enable('BIRTHDAY', { autoSend: true, days: 1 })).statusCode).toBe(200);
    const provider = new RecordingProvider();
    const run = await runReminders(h.appDb, ctx(), provider, NOW);
    // Esha opted out, so her marketing consent is withdrawn: not drafted at all.
    expect(run.created.map((c) => c.customerId)).toEqual([dev.id]);
    expect(run.skipped).toContainEqual({ type: 'BIRTHDAY', customerId: esha.id, reason: 'NO_CONSENT' });
    expect(run.dispatched).toEqual([
      { messageId: run.created[0]?.messageId, result: { outcome: 'SENT', providerMessageId: 'rem-1' } },
    ]);
    expect(provider.sent.map((m) => m.to)).toEqual([dev.mobile]);
    const m = await getMessage(h.appDb, ctx(), run.created[0]?.messageId ?? '');
    expect(m.events.map((e) => e.status)).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'APPROVED',
      'QUEUED',
      'SUBMITTED',
      'SENT',
    ]);
    expect(m.approvedBy).toBe(shop.ownerId);
  });

  it('auto-send still respects suppression at send time and quiet hours', async () => {
    const farah = await customer('Farah', { dob: '1995-11-11' });
    await consent(farah.id);
    // Suppressed by an inbound STOP on a number whose consent stays granted (gate must still block).
    await sql`insert into lbg.contact_suppressions (business_id, channel, address, action, reason)
              values (${shop.businessId}, 'WHATSAPP', ${farah.mobile}, 'SUPPRESS', 'STOP_REPLY')`.execute(h.admin);
    const gita = await customer('Gita', { dob: '1993-11-11' });
    await consent(gita.id);
    const night = new Date('2026-11-10T17:00:00Z'); // 22:30 IST, still 10 Nov
    const run = await runReminders(h.appDb, ctx(), new RecordingProvider(), night);
    const result = (id: string) =>
      run.dispatched.find((d) => d.messageId === run.created.find((c) => c.customerId === id)?.messageId)?.result;
    expect(result(farah.id)).toEqual({ outcome: 'BLOCKED', reason: 'SUPPRESSED' });
    expect(result(gita.id)).toEqual({ outcome: 'DEFERRED', notBefore: '2026-11-11T03:30:00.000Z' });
  });
});

describe('access', () => {
  it('other businesses see nothing; read-only mode cannot change settings or run', async () => {
    expect((await get(h, `${other.base}/reminders`, other.owner)).json<{ reminders: object[] }>().reminders).toEqual(
      [],
    );
    expect((await get(h, `${shop.base}/reminders`, other.owner)).statusCode).toBe(404);
    expect((await post(h, `${shop.base}/reminders/run`, {}, other.owner)).statusCode).toBe(404);
    const otherRun = await post(h, `${other.base}/reminders/run`, {}, other.owner);
    expect(otherRun.json<{ run: { created: object[] } }>().run.created).toEqual([]);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/reminders`, shop.owner)).statusCode).toBe(200);
    for (const res of [await enable('BIRTHDAY'), await post(h, `${shop.base}/reminders/run`, {}, shop.owner)]) {
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'TENANT_READ_ONLY']);
    }
  });
});
