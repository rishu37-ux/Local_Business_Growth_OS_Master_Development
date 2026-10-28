// Increment 7.6: WhatsApp Cloud API and DLT SMS adapters, provider templates
// and signed webhooks (FR-MSG-1, -2, -4, -5 AC3, NFR-18, D-059). A local mock
// of the documented endpoints answers through the injected transport: nothing
// here contacts Meta or an SMS gateway. Synthetic keys and data only.
import { createHmac } from 'node:crypto';
import type { ResolvedAddress, TransportRequest, TransportResponse } from '@lbgos/modules/outbound';
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

const GRAPH = 'https://graph.facebook.com/v21.0';
const PHONE_ID = '1098765432101';
const WABA_ID = '2098765432101';
const WA_SECRET = {
  accessToken: 'wa-token-SYNTHETIC',
  appSecret: 'wa-app-secret-SYNTHETIC',
  verifyToken: 'verify-SYNTHETIC',
};
const SMS_SECRET = { apiKey: 'sms-key-SYNTHETIC', webhookSecret: 'sms-hook-SYNTHETIC' };
const DLT = { dltEntityId: '1201234567890123456', headers: { TRANSACTIONAL: 'SHOPIN', MARKETING: '123456' } };

const seen: TransportRequest[] = [];
let waTemplates: object[] = [];
let sendSeq = 0;
const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
/** The documented endpoints, mocked: Graph API (test, send, templates) and the SMS gateway contract. */
const transport = (req: TransportRequest): Promise<TransportResponse> => {
  seen.push(req);
  if (req.hostname === 'graph.facebook.com') {
    if (req.headers.authorization !== `Bearer ${WA_SECRET.accessToken}`) {
      return Promise.resolve(json(401, { error: { code: 190, message: 'Invalid OAuth access token' } }));
    }
    if (req.method === 'GET' && req.path.startsWith(`/v21.0/${PHONE_ID}?`)) {
      return Promise.resolve(json(200, { display_phone_number: '+91 98000 00000', verified_name: 'Synthetic Shop' }));
    }
    if (req.method === 'POST' && req.path === `/v21.0/${PHONE_ID}/messages`) {
      return Promise.resolve(
        json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${String(++sendSeq)}` }] }),
      );
    }
    if (req.method === 'GET' && req.path.startsWith(`/v21.0/${WABA_ID}/message_templates?`)) {
      return Promise.resolve(json(200, { data: waTemplates }));
    }
  }
  if (req.hostname === 'sms.example.test') {
    if (req.headers['x-api-key'] !== SMS_SECRET.apiKey) return Promise.resolve(json(401, { code: 'AUTH' }));
    if (req.method === 'GET' && req.path === '/v1/account') return Promise.resolve(json(200, { ok: true }));
    if (req.method === 'POST' && req.path === '/v1/sms')
      return Promise.resolve(json(202, { id: `sms-${String(++sendSeq)}` }));
  }
  return Promise.resolve(json(404, {}));
};
const resolver = (host: string): Promise<readonly ResolvedAddress[]> =>
  Promise.resolve(
    host === 'graph.facebook.com' || host === 'sms.example.test' ? [{ address: '93.184.215.14', family: 4 }] : [],
  );

let h: Harness;
let shop: Shop;
let manager: Session;
let billing: Session;
let waId = '';
let smsId = '';
let mobileSeq = 9850000001;
const last = () => seen[seen.length - 1];
const lastBody = () => JSON.parse(last()?.body?.toString() ?? '{}') as Record<string, unknown>;
const nowSec = () => Math.floor(Date.now() / 1000);

async function customer(consent: string[] = []): Promise<{ id: string; mobile: string }> {
  const mobile = String(mobileSeq++);
  const res = await post(
    h,
    `${shop.base}/customers`,
    { name: `Channel customer ${mobile} (synthetic)`, mobile },
    billing,
  );
  const id = res.json<{ customer: { id: string } }>().customer.id;
  for (const ch of consent) {
    await post(
      h,
      `${shop.base}/customers/${id}/consents`,
      { channel: ch, purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
      billing,
    );
  }
  return { id, mobile: `+91${mobile}` };
}

interface Msg {
  id: string;
  status: string;
  statusReason: string | null;
  provider: string | null;
  providerMessageId: string | null;
}
const message = async (id: string) =>
  (await get(h, `${shop.base}/messages/${id}`, shop.owner)).json<{ message: Msg }>().message;

/** A marketing message drafted, approved and sent through the hub provider. */
async function sendMarketing(customerId: string, channel: string, body: string): Promise<Msg> {
  const d = await post(h, `${shop.base}/messages`, { customerId, channel, purpose: 'MARKETING', body }, manager);
  const id = d.json<{ message: Msg }>().message.id;
  await post(h, `${shop.base}/messages/${id}/submit`, {}, manager);
  await post(h, `${shop.base}/messages/${id}/approve`, {}, shop.owner);
  await post(h, `${shop.base}/messages/${id}/send`, {}, shop.owner);
  return message(id);
}
const sendTransactional = async (customerId: string, channel: string, body: string) =>
  (
    await post(h, `${shop.base}/messages`, { customerId, channel, purpose: 'TRANSACTIONAL', body, send: true }, billing)
  ).json<{ message: Msg }>().message;

const sign = (secret: string, raw: string) => createHmac('sha256', secret).update(raw).digest('hex');
const waHook = (raw: string, signature?: string) =>
  h.app.inject({
    method: 'POST',
    url: `/api/webhooks/whatsapp/${waId}`,
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    payload: raw,
  });
const waStatus = (id: string, status: string, ts = nowSec(), extra: object = {}) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: { statuses: [{ id, status, timestamp: String(ts), recipient_id: '919850000001', ...extra }] },
          },
        ],
      },
    ],
  });
const smsHook = (raw: string, t = nowSec(), secret = SMS_SECRET.webhookSecret) =>
  h.app.inject({
    method: 'POST',
    url: `/api/webhooks/sms/${smsId}`,
    headers: {
      'content-type': 'application/json',
      'x-lbgos-signature': `t=${String(t)},v1=${sign(secret, `${String(t)}.${raw}`)}`,
    },
    payload: raw,
  });

beforeAll(async () => {
  h = await startHarness({ outbound: { resolver, transport } });
  resetFixture();
  shop = await activeShop(h, 'chn-a');
  manager = (await staff(h, shop, 'chn-manager@example.test', 'Manager')).session;
  billing = (await staff(h, shop, 'chn-billing@example.test', 'Billing')).session;
  await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
             where business_id = ${shop.businessId}`.execute(h.admin);
  waTemplates = [
    {
      name: 'diwali_offer',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Diwali: {{1}} off at {{2}}!' }],
    },
    {
      name: 'invoice_ready',
      language: 'en',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Invoice' },
        { type: 'BODY', text: 'Invoice {{1}} is ready.' },
      ],
    },
    {
      name: 'new_arrivals',
      language: 'en_US',
      status: 'PENDING',
      category: 'MARKETING',
      components: [{ type: 'BODY', text: 'New: {{1}}' }],
    },
    {
      name: 'broken',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Hi {{2}}' }],
    },
  ];
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('configuration (FR-MSG-2 AC1)', () => {
  it('WhatsApp needs its account IDs, SMS its DLT entity and headers; the credential is sealed', async () => {
    const wa = {
      category: 'MESSAGING',
      provider: 'whatsapp_cloud',
      label: 'WhatsApp',
      authMethod: 'BEARER',
      baseUrl: GRAPH,
    };
    const bad = await post(h, `${shop.base}/integrations`, { ...wa, secret: JSON.stringify(WA_SECRET) }, shop.owner);
    expect([bad.statusCode, errorCode(bad)]).toEqual([422, 'CONFIG_INVALID']);
    const ok = await post(
      h,
      `${shop.base}/integrations`,
      { ...wa, config: { phoneNumberId: PHONE_ID, wabaId: WABA_ID }, secret: JSON.stringify(WA_SECRET) },
      shop.owner,
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.body).not.toContain('SYNTHETIC');
    waId = ok.json<{ integration: { id: string } }>().integration.id;

    const sms = {
      category: 'SMS',
      provider: 'sms_dlt_json',
      label: 'SMS',
      authMethod: 'API_KEY',
      baseUrl: 'https://sms.example.test',
    };
    const noDlt = await post(
      h,
      `${shop.base}/integrations`,
      { ...sms, secret: JSON.stringify(SMS_SECRET) },
      shop.owner,
    );
    expect([noDlt.statusCode, errorCode(noDlt)]).toEqual([422, 'CONFIG_INVALID']);
    const badHeader = await post(
      h,
      `${shop.base}/integrations`,
      { ...sms, config: { ...DLT, headers: { MARKETING: 'SHOPIN' } }, secret: JSON.stringify(SMS_SECRET) },
      shop.owner,
    );
    expect(badHeader.json<{ error: { message: string } }>().error.message).toBe('A promotional header has 6 digits.');
    const smsOk = await post(
      h,
      `${shop.base}/integrations`,
      { ...sms, config: DLT, secret: JSON.stringify(SMS_SECRET) },
      shop.owner,
    );
    expect(smsOk.statusCode).toBe(201);
    smsId = smsOk.json<{ integration: { id: string } }>().integration.id;
  });

  it('test connection uses the documented endpoints with the stored credential', async () => {
    seen.length = 0;
    const t = await post(h, `${shop.base}/integrations/${waId}/test`, {}, shop.owner);
    expect(t.json<{ test: { ok: boolean; integration: { status: string } } }>().test).toMatchObject({
      ok: true,
      integration: { status: 'TESTED' },
    });
    expect(seen[0]).toMatchObject({
      hostname: 'graph.facebook.com',
      method: 'GET',
      path: `/v21.0/${PHONE_ID}?fields=display_phone_number,verified_name`,
    });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${WA_SECRET.accessToken}`);
    const s = await post(h, `${shop.base}/integrations/${smsId}/test`, {}, shop.owner);
    expect(s.json<{ test: { ok: boolean } }>().test.ok).toBe(true);
    expect(last()).toMatchObject({ hostname: 'sms.example.test', path: '/v1/account' });
  });
});

describe('templates (FR-MSG-1 AC1, FR-MSG-2 AC1–2)', () => {
  it('WhatsApp templates are read from the provider; invalid ones are disabled; missing ones later disabled', async () => {
    expect((await post(h, `${shop.base}/integrations/${waId}/templates/sync`, {}, manager)).statusCode).toBe(403);
    const res = await post(h, `${shop.base}/integrations/${waId}/templates/sync`, {}, shop.owner);
    expect(res.statusCode).toBe(200);
    const list = res.json<{ templates: { name: string; purpose: string; status: string; body: string }[] }>().templates;
    expect(list.map((t) => [t.name, t.purpose, t.status])).toEqual([
      ['broken', 'MARKETING', 'DISABLED'],
      ['diwali_offer', 'MARKETING', 'APPROVED'],
      ['invoice_ready', 'TRANSACTIONAL', 'APPROVED'],
      ['new_arrivals', 'MARKETING', 'PENDING'],
    ]);
    expect(list.find((t) => t.name === 'invoice_ready')?.body).toBe('Invoice {{1}} is ready.');
    expect(last()?.path).toBe(
      `/v21.0/${WABA_ID}/message_templates?fields=name,language,status,category,components&limit=200`,
    );
    // The manager may look, not change.
    expect((await get(h, `${shop.base}/integrations/${waId}/templates`, manager)).statusCode).toBe(200);
  });

  it('SMS templates are entered as registered on DLT and cannot be edited afterwards', async () => {
    const reg = (body: object, who: Session = shop.owner) =>
      post(h, `${shop.base}/integrations/${smsId}/templates`, body, who);
    const txn = {
      name: 'invoice_paid',
      purpose: 'TRANSACTIONAL',
      body: 'Dear {#var#}, invoice {#var#} paid. -Shop',
      dltTemplateId: '1107161234567890123',
    };
    expect((await reg(txn, manager)).statusCode).toBe(403);
    expect((await reg(txn)).statusCode).toBe(201);
    expect(errorCode(await reg(txn))).toBe('TEMPLATE_INVALID'); // same name
    const promo = {
      name: 'sale',
      purpose: 'MARKETING',
      body: 'Sale: {#var#} off on {#var#}. -Shop',
      dltTemplateId: '1107161234567890124',
    };
    expect((await reg(promo)).statusCode).toBe(201);
    expect(errorCode(await post(h, `${shop.base}/integrations/${waId}/templates`, promo, shop.owner))).toBe(
      'OPERATION_NOT_SUPPORTED',
    );
    await expect(
      sql`update lbg.message_templates set body = 'Changed {#var#}' where integration_id = ${smsId} and name = 'sale'`.execute(
        h.admin,
      ),
    ).rejects.toMatchObject({ code: 'LB003' });
  });
});

describe('sending (FR-MSG-1 AC1, FR-MSG-2, FR-MSG-4)', () => {
  it('WhatsApp marketing goes out as the matching approved template with its parameters', async () => {
    const c = await customer(['WHATSAPP']);
    const m = await sendMarketing(c.id, 'WHATSAPP', 'Diwali: 10% off at Model X!');
    expect(m).toMatchObject({
      status: 'SENT',
      provider: 'whatsapp_cloud',
      providerMessageId: expect.stringMatching(/^wamid\.TEST/) as string,
    });
    expect(last()).toMatchObject({ method: 'POST', path: `/v21.0/${PHONE_ID}/messages` });
    expect(lastBody()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: c.mobile.slice(1),
      type: 'template',
      template: {
        name: 'diwali_offer',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '10%' },
              { type: 'text', text: 'Model X' },
            ],
          },
        ],
      },
    });
    const calls = await sql<{ n: number }>`select count(*)::int as n from lbg.integration_calls
      where integration_id = ${waId} and kind = 'CALL' and purpose = 'message.marketing' and ok`.execute(h.admin);
    expect(calls.rows[0]?.n).toBe(1);
  });

  it('text without a matching approved template never leaves; marketing and transactional never mix', async () => {
    const c = await customer(['WHATSAPP']);
    const before = seen.length;
    const free = await sendMarketing(c.id, 'WHATSAPP', 'Come and see our new phones!');
    expect(free).toMatchObject({ status: 'FAILED', statusReason: 'NO_APPROVED_TEMPLATE', providerMessageId: null });
    // The transactional template's text, sent as marketing, is refused too.
    expect((await sendMarketing(c.id, 'WHATSAPP', 'Invoice INV-9 is ready.')).statusReason).toBe(
      'NO_APPROVED_TEMPLATE',
    );
    expect(seen.length).toBe(before);
    const txn = await sendTransactional(c.id, 'WHATSAPP', 'Invoice INV-9 is ready.');
    expect(txn.status).toBe('SENT');
    expect((lastBody().template as { name: string }).name).toBe('invoice_ready');
  });

  it('SMS carries the DLT entity, the header for its purpose and the template ID', async () => {
    const c = await customer(['SMS']);
    const txn = await sendTransactional(c.id, 'SMS', 'Dear Asha, invoice INV-12 paid. -Shop');
    expect(txn).toMatchObject({ status: 'SENT', provider: 'sms_dlt_json' });
    expect(last()).toMatchObject({ hostname: 'sms.example.test', method: 'POST', path: '/v1/sms' });
    expect(lastBody()).toEqual({
      to: c.mobile,
      text: 'Dear Asha, invoice INV-12 paid. -Shop',
      category: 'TRANSACTIONAL',
      dlt: { entityId: DLT.dltEntityId, header: 'SHOPIN', templateId: '1107161234567890123' },
      reference: txn.id,
    });
    const promo = await sendMarketing(c.id, 'SMS', 'Sale: 10% off on covers. -Shop');
    expect(promo.status).toBe('SENT');
    expect(lastBody()).toMatchObject({
      category: 'PROMOTIONAL',
      dlt: { header: '123456', templateId: '1107161234567890124' },
    });
    expect((await sendMarketing(c.id, 'SMS', 'Dear Asha, invoice INV-12 paid. -Shop')).statusReason).toBe(
      'NO_DLT_TEMPLATE',
    );
  });
});

describe('WhatsApp webhooks (NFR-18, FR-MSG-1 AC4, FR-MSG-5 AC3)', () => {
  it('the subscription check answers only the configured verify token', async () => {
    const q = (token: string) =>
      h.app.inject({
        method: 'GET',
        url: `/api/webhooks/whatsapp/${waId}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
      });
    const ok = await q(WA_SECRET.verifyToken);
    expect([ok.statusCode, ok.body]).toEqual([200, '1158201444']);
    expect((await q('wrong')).statusCode).toBe(403);
  });

  it('statuses need a valid signature, are applied once, and stale ones are not applied', async () => {
    const c = await customer(['WHATSAPP']);
    const m = await sendMarketing(c.id, 'WHATSAPP', 'Diwali: 5% off at covers!');
    const ref = m.providerMessageId ?? '';
    const raw = waStatus(ref, 'delivered');
    expect((await waHook(raw)).statusCode).toBe(401);
    expect((await waHook(raw, `sha256=${sign('wrong-secret', raw)}`)).statusCode).toBe(401);
    expect((await waHook(raw, `sha256=${sign(WA_SECRET.appSecret, `${raw} `)}`)).statusCode).toBe(401); // body changed
    const ok = await waHook(raw, `sha256=${sign(WA_SECRET.appSecret, raw)}`);
    expect(ok.json()).toMatchObject({ applied: 1, duplicates: 0, stale: 0 });
    expect((await message(m.id)).status).toBe('DELIVERED');
    const integ = (await get(h, `${shop.base}/integrations/${waId}`, shop.owner)).json<{
      integration: { status: string };
    }>();
    expect(integ.integration.status).toBe('VERIFIED');
    expect((await waHook(raw, `sha256=${sign(WA_SECRET.appSecret, raw)}`)).json()).toMatchObject({
      applied: 0,
      duplicates: 1,
    });
    const old = waStatus(ref, 'read', nowSec() - 600);
    expect((await waHook(old, `sha256=${sign(WA_SECRET.appSecret, old)}`)).json()).toMatchObject({
      applied: 0,
      stale: 1,
    });
    expect((await message(m.id)).status).toBe('DELIVERED');
    // A failure reported after delivery is contradictory and changes nothing; on a sent message it is applied.
    const late = waStatus(ref, 'failed', nowSec(), { errors: [{ code: 131026 }] });
    expect((await waHook(late, `sha256=${sign(WA_SECRET.appSecret, late)}`)).statusCode).toBe(200);
    expect((await message(m.id)).status).toBe('DELIVERED');
    const m2 = await sendMarketing(c.id, 'WHATSAPP', 'Diwali: 7% off at chargers!');
    const failed = waStatus(m2.providerMessageId ?? '', 'failed', nowSec(), {
      errors: [{ code: 131026, title: 'Message undeliverable' }],
    });
    expect((await waHook(failed, `sha256=${sign(WA_SECRET.appSecret, failed)}`)).json()).toMatchObject({ applied: 1 });
    expect(await message(m2.id)).toMatchObject({ status: 'FAILED', statusReason: 'WA_131026' });
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp/00000000-0000-4000-8000-000000000000',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${sign(WA_SECRET.appSecret, raw)}`,
      },
      payload: raw,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('an inbound STOP suppresses the sender and withdraws marketing consent, recorded as the system', async () => {
    const c = await customer(['WHATSAPP']);
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: c.mobile.slice(1),
                    id: 'wamid.IN1',
                    timestamp: String(nowSec()),
                    type: 'text',
                    text: { body: ' stop ' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect((await waHook(raw, `sha256=${sign(WA_SECRET.appSecret, raw)}`)).json()).toMatchObject({ applied: 1 });
    const consents = (await get(h, `${shop.base}/customers/${c.id}/consents`, billing)).json<{
      consents: { channels: { channel: string; suppressed: boolean; marketing: string | null }[] };
    }>().consents;
    expect(consents.channels[0]).toMatchObject({ channel: 'WHATSAPP', suppressed: true, marketing: 'WITHDRAWN' });
    const audit = await sql<{ actor_type: string; actor_user_id: string | null }>`
      select actor_type, actor_user_id from lbg.audit_events
       where business_id = ${shop.businessId} and action = 'contact.suppress' and target_id = ${c.id}`.execute(h.admin);
    expect(audit.rows).toEqual([{ actor_type: 'SYSTEM', actor_user_id: null }]);
    // Afterwards nothing more is sent to this customer.
    expect((await sendMarketing(c.id, 'WHATSAPP', 'Diwali: 5% off at covers!')).statusReason).toBe('SUPPRESSED');
  });
});

describe('SMS webhooks (NFR-18)', () => {
  it('the signed timestamp must be within 5 minutes; delivery receipts are applied once', async () => {
    const c = await customer();
    const m = await sendTransactional(c.id, 'SMS', 'Dear Ravi, invoice INV-14 paid. -Shop');
    const raw = JSON.stringify({
      events: [{ id: 'dlr-1', type: 'status', messageId: m.providerMessageId, status: 'DELIVERED' }],
    });
    expect((await smsHook(raw, nowSec(), 'wrong')).statusCode).toBe(401);
    expect((await smsHook(raw, nowSec() - 400)).statusCode).toBe(401);
    expect((await smsHook(raw)).json()).toMatchObject({ applied: 1 });
    expect((await message(m.id)).status).toBe('DELIVERED');
    expect((await smsHook(raw)).json()).toMatchObject({ duplicates: 1 });
    const bad = await h.app.inject({
      method: 'POST',
      url: `/api/webhooks/sms/${smsId}`,
      headers: { 'content-type': 'application/json', 'x-lbgos-signature': 'v1=abc' },
      payload: raw,
    });
    expect(bad.statusCode).toBe(401);
    // The WhatsApp URL does not accept the SMS integration.
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/webhooks/whatsapp/${smsId}`,
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
          payload: raw,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('a disabled integration receives no webhooks and sends nothing', async () => {
    await post(h, `${shop.base}/integrations/${smsId}/disable`, {}, shop.owner);
    const raw = JSON.stringify({ events: [] });
    expect((await smsHook(raw)).statusCode).toBe(404);
    const c = await customer();
    expect(await sendTransactional(c.id, 'SMS', 'Dear Ravi, invoice INV-15 paid. -Shop')).toMatchObject({
      status: 'FAILED',
      statusReason: 'PROVIDER_NOT_CONFIGURED',
    });
    // A changed configuration needs a new test (WORKFLOWS §10).
    const changed = await patch(
      h,
      `${shop.base}/integrations/${waId}`,
      { config: { phoneNumberId: PHONE_ID, wabaId: '3098765432101' } },
      shop.owner,
    );
    expect(changed.json<{ integration: { status: string } }>().integration.status).toBe('CONFIGURED');
  });
});
