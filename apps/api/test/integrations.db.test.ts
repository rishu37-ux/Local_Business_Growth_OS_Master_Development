// Increment 7.3: the API & Integrations Hub (FR-HUB-1, -2, -4, -6, FR-SUB-3
// AC1–2, WORKFLOWS §10, D-056). Mock adapters and an injected transport only:
// nothing here contacts a real provider. Synthetic keys only.
import { callProvider, type HubDeps } from '@lbgos/modules/integrations';
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
  put,
  resetFixture,
  staff,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const KEY = 'mock-key-SYNTHETIC-1234567890';
const PUBLIC = '93.184.215.14';

const seen: TransportRequest[] = [];
let respond: (req: TransportRequest) => TransportResponse = () => ({
  status: 200,
  headers: {},
  body: Buffer.from('{}'),
});
const resolver = (host: string): Promise<readonly ResolvedAddress[]> =>
  Promise.resolve(
    host === 'internal.example.test'
      ? [{ address: '10.0.0.5', family: 4 }]
      : host.endsWith('.example.test')
        ? [{ address: PUBLIC, family: 4 }]
        : [],
  );
const transport = (req: TransportRequest): Promise<TransportResponse> => {
  seen.push(req);
  return Promise.resolve(respond(req));
};

let h: Harness;
let shop: Shop;
let other: Shop;
let manager: Session;
let billing: Session;

interface Integration {
  id: string;
  status: string;
  statusReason: string | null;
  secretId: string | null;
  lastErrorCode: string | null;
}
const create = (body: object, who: Session = shop.owner, s: Shop = shop) =>
  post(h, `${s.base}/integrations`, body, who);
const created = async (body: object) => {
  const res = await create(body);
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json<{ integration: Integration }>().integration;
};
const test = (id: string, who: Session = shop.owner) => post(h, `${shop.base}/integrations/${id}/test`, {}, who);
const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });
const deps = (): HubDeps => ({
  appDb: h.appDb,
  secrets: h.keyring ? { db: h.secretsDb, keyring: h.keyring } : null,
  allowMocks: true,
  retryBaseMs: 1,
});
const llm = { category: 'LLM', provider: 'mock', label: 'Mock LLM', authMethod: 'API_KEY', secret: KEY };

beforeAll(async () => {
  h = await startHarness({ outbound: { resolver, transport } });
  resetFixture();
  shop = await activeShop(h, 'hub-a');
  other = await activeShop(h, 'hub-b');
  manager = (await staff(h, shop, 'hub-manager@example.test', 'Manager')).session;
  billing = (await staff(h, shop, 'hub-billing@example.test', 'Billing')).session;
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('records and configuration (FR-HUB-1, -2)', () => {
  it('lists providers with every category; viewing needs integrations.view', async () => {
    const res = await get(h, `${shop.base}/integrations/providers`, manager);
    expect(res.statusCode).toBe(200);
    const p = res.json<{
      providers: { provider: string; categories: string[]; mock: boolean }[];
      categories: string[];
    }>();
    expect(p.categories).toEqual([
      'MESSAGING',
      'SMS',
      'EMAIL',
      'LLM',
      'IMAGE_VIDEO',
      'OCR',
      'STORAGE',
      'PAYMENTS',
      'SOCIAL',
    ]);
    expect(p.providers.find((x) => x.provider === 'mock')?.categories).toEqual(p.categories); // a mock per category
    expect(p.providers.some((x) => x.provider === 'custom_rest')).toBe(true);
    expect((await get(h, `${shop.base}/integrations`, billing)).statusCode).toBe(403);
  });

  it('creating stores the credential sealed and returns only its ID; needs integrations.manage', async () => {
    expect((await create(llm, manager)).statusCode).toBe(403);
    const res = await create(llm);
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('SYNTHETIC');
    const i = res.json<{ integration: Integration & { timeoutMs: number; maxRetries: number } }>().integration;
    expect(i).toMatchObject({ status: 'CONFIGURED', timeoutMs: 15_000, maxRetries: 3 });
    expect(i.secretId).not.toBeNull();
    const noKey = await created({ ...llm, secret: undefined, label: 'No key yet' });
    expect(noKey.status).toBe('PLANNED');
  });

  it('refuses unknown providers, unsupported categories and unsafe endpoints', async () => {
    const rest = { category: 'LLM', provider: 'custom_rest', label: 'Custom', authMethod: 'API_KEY', secret: KEY };
    expect(errorCode(await create({ ...llm, provider: 'nonexistent' }))).toBe('PROVIDER_UNKNOWN');
    expect(errorCode(await create({ ...rest, category: 'OCR', baseUrl: 'https://api.example.test' }))).toBe(
      'CATEGORY_NOT_SUPPORTED',
    );
    expect(errorCode(await create(rest))).toBe('BASE_URL_REQUIRED');
    for (const [baseUrl, detail] of [
      ['https://169.254.169.254', 'BLOCKED_ADDRESS'],
      ['https://internal.example.test', 'BLOCKED_ADDRESS'],
      ['https://0x7f.1', 'BLOCKED_ADDRESS'],
      ['https://api.example.test:8443', 'PORT_NOT_ALLOWED'],
    ] as const) {
      const res = await create({ ...rest, baseUrl });
      expect([res.statusCode, errorCode(res), res.json<{ error: { detail?: string } }>().error.detail]).toEqual([
        422,
        'ENDPOINT_NOT_ALLOWED',
        detail,
      ]);
    }
    expect((await create({ ...rest, baseUrl: 'http://api.example.test' })).statusCode).toBe(400);
    expect(
      errorCode(await create({ ...rest, baseUrl: 'https://api.example.test:8443', allowedPort: 8443 })),
    ).toBeUndefined();
  });
});

describe('lifecycle (FR-HUB-4, WORKFLOWS §10)', () => {
  it('test connection: TESTED only on success, with latency recorded; failures are FAILED with the code', async () => {
    const i = await created({ ...llm, label: 'Lifecycle' });
    const ok = await test(i.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ test: { ok: boolean; latencyMs: number; integration: Integration } }>().test).toMatchObject({
      ok: true,
      integration: { status: 'TESTED' },
    });
    // Changing the configuration requires testing again.
    const changed = await patch(h, `${shop.base}/integrations/${i.id}`, { modelId: 'mock-fail' }, shop.owner);
    expect(changed.json<{ integration: Integration }>().integration).toMatchObject({
      status: 'CONFIGURED',
      statusReason: 'Configuration changed; test again.',
    });
    const bad = (await test(i.id)).json<{ test: { ok: boolean; errorCode: string; integration: Integration } }>().test;
    expect(bad).toMatchObject({
      ok: false,
      errorCode: 'MOCK_FAILURE',
      integration: { status: 'FAILED', lastErrorCode: 'MOCK_FAILURE' },
    });
    await patch(h, `${shop.base}/integrations/${i.id}`, { modelId: 'mock-ok' }, shop.owner);
    expect((await test(i.id)).json<{ test: { integration: Integration } }>().test.integration.status).toBe('TESTED');
    const detail = (await get(h, `${shop.base}/integrations/${i.id}`, manager)).json<{
      health: {
        calls24h: number;
        errors24h: number;
        errorRate24h: number;
        lastSuccessAt: string;
        lastErrorCode: string;
        recent: { kind: string; ok: boolean; latencyMs: number }[];
      };
    }>().health;
    expect(detail).toMatchObject({ calls24h: 3, errors24h: 1, lastErrorCode: 'MOCK_FAILURE' });
    expect(detail.errorRate24h).toBeCloseTo(1 / 3);
    expect(detail.recent.map((r) => [r.kind, r.ok])).toEqual([
      ['TEST', true],
      ['TEST', false],
      ['TEST', true],
    ]);
    expect(detail.recent.every((r) => r.latencyMs >= 0)).toBe(true);
    const audit = await sql<{ action: string }>`select action from lbg.audit_events
      where business_id = ${shop.businessId} and target_id = ${i.id} order by created_at`.execute(h.admin);
    expect(audit.rows.map((r) => r.action)).toEqual([
      'integration.create',
      'integration.test',
      'integration.update',
      'integration.test',
      'integration.update',
      'integration.test',
      'integration.view', // viewing the configuration is audited (FR-HUB-3 AC4)
    ]);
  });

  it('disable, enable, rotate the credential and revoke (terminal)', async () => {
    const i = await created({ ...llm, label: 'Rotate' });
    await test(i.id);
    expect((await post(h, `${shop.base}/integrations/${i.id}/disable`, {}, shop.owner)).statusCode).toBe(200);
    expect(errorCode(await test(i.id))).toBe('INVALID_STATE');
    const en = await post(h, `${shop.base}/integrations/${i.id}/enable`, {}, shop.owner);
    expect(en.json<{ integration: Integration }>().integration.status).toBe('CONFIGURED');
    await test(i.id);
    const rotated = await put(h, `${shop.base}/integrations/${i.id}/secret`, { secret: `${KEY}-v2` }, shop.owner);
    const r = rotated.json<{ integration: Integration }>().integration;
    expect(r.status).toBe('CONFIGURED');
    expect(r.secretId).not.toBe(i.secretId);
    const old = await sql<{ revoked: boolean }>`select revoked_at is not null as revoked from lbg.integration_secrets
      where id = ${i.secretId}`.execute(h.admin);
    expect(old.rows[0]?.revoked).toBe(true);
    const rev = await post(h, `${shop.base}/integrations/${i.id}/revoke`, {}, shop.owner);
    expect(rev.json<{ integration: Integration }>().integration.status).toBe('REVOKED');
    const destroyed = await sql<{
      payload: Buffer | null;
    }>`select payload from lbg.integration_secrets where id = ${r.secretId}`.execute(h.admin);
    expect(destroyed.rows[0]?.payload).toBeNull();
    expect(errorCode(await patch(h, `${shop.base}/integrations/${i.id}`, { label: 'x' }, shop.owner))).toBe(
      'INVALID_STATE',
    );
    expect(errorCode(await post(h, `${shop.base}/integrations/${i.id}/enable`, {}, shop.owner))).toBe('INVALID_STATE');
  });

  it('the database enforces the status machine', async () => {
    const i = await created({ ...llm, secret: undefined, label: 'Planned' });
    const set = (status: string) =>
      sql`update lbg.integrations set status = ${status} where id = ${i.id}`.execute(h.admin);
    await expect(set('TESTED')).rejects.toMatchObject({ code: 'LB002' }); // PLANNED → TESTED
    await expect(set('VERIFIED')).rejects.toMatchObject({ code: 'LB002' });
    await expect(set('FAILED')).rejects.toMatchObject({ code: 'LB002' }); // nothing was tested
    await expect(
      sql`insert into lbg.integrations (business_id, category, provider, label, auth_method, status, created_by)
          values (${shop.businessId}, 'LLM', 'mock', 'x', 'NONE', 'VERIFIED', ${shop.ownerId})`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB002' });
    await expect(sql`delete from lbg.integrations where id = ${i.id}`.execute(h.admin)).rejects.toThrow();
    await set('REVOKED');
    await expect(set('CONFIGURED')).rejects.toMatchObject({ code: 'LB003' });
  });
});

describe('custom REST through the guarded client (FR-HUB-1 AC3, FR-HUB-5)', () => {
  it('API key, bearer and OAuth2 client credentials; only the checked address is contacted', async () => {
    const rest = {
      category: 'SMS',
      provider: 'custom_rest',
      baseUrl: 'https://api.example.test',
      testPath: '/v1/health',
    };
    seen.length = 0;
    respond = () => ({ status: 200, headers: {}, body: Buffer.from('{"ok":true}') });
    const apiKey = await created({ ...rest, label: 'Key', authMethod: 'API_KEY', secret: KEY });
    expect((await test(apiKey.id)).json<{ test: { ok: boolean } }>().test.ok).toBe(true);
    expect(seen.map((r) => [r.address, r.hostname, r.path, r.headers['x-api-key'] === KEY])).toEqual([
      [PUBLIC, 'api.example.test', '/v1/health', true],
    ]);
    seen.length = 0;
    const bearer = await created({ ...rest, label: 'Bearer', authMethod: 'BEARER', secret: KEY });
    await test(bearer.id);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    seen.length = 0;
    respond = (req) =>
      req.path === '/oauth/token'
        ? { status: 200, headers: {}, body: Buffer.from('{"access_token":"tok-SYNTHETIC-abc"}') }
        : { status: 200, headers: {}, body: Buffer.from('{}') };
    const oauth = await created({
      ...rest,
      label: 'OAuth',
      authMethod: 'OAUTH2_CLIENT_CREDENTIALS',
      tokenUrl: 'https://auth.example.test/oauth/token',
      scopes: ['sms.send'],
      secret: 'client-1:client-secret-SYNTHETIC',
    });
    expect((await test(oauth.id)).json<{ test: { ok: boolean } }>().test.ok).toBe(true);
    expect(seen.map((r) => [r.method, r.hostname, r.path])).toEqual([
      ['POST', 'auth.example.test', '/oauth/token'],
      ['GET', 'api.example.test', '/v1/health'],
    ]);
    expect(seen[0]?.body?.toString()).toContain('grant_type=client_credentials');
    expect(seen[0]?.body?.toString()).toContain('scope=sms.send');
    expect(seen[1]?.headers.authorization).toBe('Bearer tok-SYNTHETIC-abc');
    // A provider error is recorded as FAILED with the HTTP status; a redirect to a private address is refused.
    respond = () => ({ status: 503, headers: {}, body: Buffer.alloc(0) });
    expect((await test(apiKey.id)).json<{ test: { errorCode: string } }>().test.errorCode).toBe('HTTP_503');
    respond = () => ({ status: 302, headers: { location: 'https://10.0.0.1/' }, body: Buffer.alloc(0) });
    expect((await test(bearer.id)).json<{ test: { errorCode: string } }>().test.errorCode).toBe('BLOCKED_ADDRESS');
  });
});

describe('calls: quota, retries, usage per tenant (FR-HUB-2, FR-HUB-6, FR-SUB-3)', () => {
  it('records units and cost; warns at 80 %, stops at 100 %', async () => {
    const q = await created({
      category: 'IMAGE_VIDEO',
      provider: 'mock',
      label: 'Images',
      authMethod: 'NONE',
      monthlyUnitLimit: 5,
    });
    await test(q.id);
    const gen = () =>
      callProvider(
        deps(),
        ctx(),
        'IMAGE_VIDEO',
        'studio.image',
        (a, c) => a.generateImage?.(c, { prompt: 'p', aspect: '1:1' }) ?? null,
        {
          units: 1,
          costPaise: 200,
        },
      );
    const usages = [];
    for (let n = 0; n < 4; n++) usages.push((await gen()).usage);
    expect(usages.map((u) => [u.monthUnits, u.percent, u.warning, u.stopped])).toEqual([
      [1, 20, false, false],
      [2, 40, false, false],
      [3, 60, false, false],
      [4, 80, true, false],
    ]);
    expect(usages[3]?.monthCostPaise).toBe(800);
    await gen(); // the 5th unit
    await expect(gen()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const calls = await sql<{ n: number; cost: string }>`select count(*)::int as n, sum(cost_paise)::text as cost
      from lbg.integration_calls where integration_id = ${q.id} and kind = 'CALL'`.execute(h.admin);
    expect(calls.rows[0]).toEqual({ n: 5, cost: '1000' });
  });

  it('retries retryable failures with backoff up to the integration’s limit', async () => {
    const flaky = await created({ ...llm, label: 'Flaky', modelId: 'mock-flaky-2', maxRetries: 3 });
    await sql`update lbg.integrations set status = 'TESTED' where id = ${flaky.id}`.execute(h.admin);
    // Make it the newest TESTED LLM integration for this business.
    const r = await callProvider(
      deps(),
      ctx(),
      'LLM',
      'studio.caption',
      (a, c) => a.generateText?.(c, { system: 's', input: '{"products":[]}', maxUnits: 100 }) ?? null,
    );
    expect([r.result.ok, r.attempts]).toEqual([true, 3]);
    await patch(h, `${shop.base}/integrations/${flaky.id}`, { modelId: 'mock-flaky-3', maxRetries: 1 }, shop.owner);
    await sql`update lbg.integrations set status = 'TESTED' where id = ${flaky.id}`.execute(h.admin);
    const r2 = await callProvider(
      deps(),
      ctx(),
      'LLM',
      'studio.caption',
      (a, c) => a.generateText?.(c, { system: 's', input: '{}', maxUnits: 100 }) ?? null,
    );
    expect([r2.result.ok, r2.attempts]).toEqual([false, 2]);
  });

  it('without a tested integration a call is refused as not configured', async () => {
    await expect(
      callProvider(
        deps(),
        { businessId: other.businessId, userId: other.ownerId },
        'LLM',
        'studio.caption',
        () => null,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('secrets, access and production behaviour', () => {
  it('no credential appears in responses, logs or audit events', async () => {
    const list = await get(h, `${shop.base}/integrations`, shop.owner);
    expect(list.body).not.toContain('SYNTHETIC');
    expect(h.logs.text).not.toContain('SYNTHETIC');
    const audit = await sql<{
      metadata: unknown;
    }>`select metadata from lbg.audit_events where business_id = ${shop.businessId}`.execute(h.admin);
    expect(JSON.stringify(audit.rows)).not.toContain('SYNTHETIC');
  });

  it('re-authentication for credential and endpoint changes; other businesses 404; read-only lists only', async () => {
    const i = await created({ ...llm, label: 'Access' });
    await sql`update auth."session" set "createdAt" = now() - interval '1 hour' where "userId" = ${shop.ownerId}`.execute(
      h.admin,
    );
    for (const res of [
      await create(llm),
      await patch(h, `${shop.base}/integrations/${i.id}`, { baseUrl: 'https://api.example.test' }, shop.owner),
      await put(h, `${shop.base}/integrations/${i.id}/secret`, { secret: KEY }, shop.owner),
      await post(h, `${shop.base}/integrations/${i.id}/revoke`, {}, shop.owner),
    ]) {
      expect(errorCode(res)).toBe('REAUTH_REQUIRED');
    }
    expect((await test(i.id)).statusCode).toBe(200); // testing does not need re-authentication
    await sql`update auth."session" set "createdAt" = now() where "userId" = ${shop.ownerId}`.execute(h.admin);
    expect((await get(h, `${other.base}/integrations/${i.id}`, other.owner)).statusCode).toBe(404);
    expect((await post(h, `${other.base}/integrations/${i.id}/test`, {}, other.owner)).statusCode).toBe(404);
    expect(
      (await get(h, `${other.base}/integrations`, other.owner)).json<{ integrations: object[] }>().integrations,
    ).toEqual([]);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/integrations`, shop.owner)).statusCode).toBe(200);
    expect(errorCode(await test(i.id))).toBe('TENANT_READ_ONLY');
    expect(errorCode(await create(llm))).toBe('TENANT_READ_ONLY');
  });

  it('with mock adapters off (production), the test adapter is not offered', async () => {
    const prod = await startHarness({ allowMocks: false, keepRateLimits: true });
    try {
      resetFixture();
      const s = await activeShop(prod, 'hub-c');
      const p = (await get(prod, `${s.base}/integrations/providers`, s.owner)).json<{
        providers: { provider: string }[];
      }>();
      expect(p.providers.map((x) => x.provider)).toEqual(['whatsapp_cloud', 'sms_dlt_json', 'custom_rest']);
      const res = await post(prod, `${s.base}/integrations`, llm, s.owner);
      expect(errorCode(res)).toBe('PROVIDER_UNKNOWN');
    } finally {
      await prod.close();
    }
  }, 120_000);
});
