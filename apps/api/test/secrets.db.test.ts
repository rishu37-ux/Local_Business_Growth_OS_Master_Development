// Increment 7.2: the integration secret store (FR-HUB-3 AC1–5, ADR-13, T12).
// Synthetic keys and values only.
import { withTenant } from '@lbgos/db';
import { parseKeyring, readSecretValue, rewrapSecrets, SecretError } from '@lbgos/modules/secrets';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import { activeShop, errorCode, get, post, resetFixture, staff, type Session, type Shop } from './shop-fixture.ts';

const VALUE = 'sk-live-SYNTHETIC-7d1e9c2b4a6f8e0d';
const ROTATED = 'sk-live-SYNTHETIC-rotated-55aa66bb';

let h: Harness;
let shop: Shop;
let other: Shop;
let manager: Session;
let billing: Session;
let secretId = '';

const store = (body: object, who: Session = shop.owner, s: Shop = shop) => post(h, `${s.base}/secrets`, body, who);
const ctx = (s: Shop = shop) => ({ businessId: s.businessId, userId: s.ownerId });

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'sec-a');
  other = await activeShop(h, 'sec-b');
  manager = (await staff(h, shop, 'sec-manager@example.test', 'Manager')).session;
  billing = (await staff(h, shop, 'sec-billing@example.test', 'Billing')).session;
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('write-only secrets (FR-HUB-3 AC2, AC5)', () => {
  it('only integrations.manage stores; the response has metadata and a 4-character hint, never the value', async () => {
    expect((await store({ purpose: 'api_key', label: 'LLM key', value: VALUE }, manager)).statusCode).toBe(403);
    const res = await store({ purpose: 'api_key', label: 'LLM key', value: VALUE });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('SYNTHETIC');
    const s = res.json<{ secret: Record<string, unknown> }>().secret;
    expect(s).toMatchObject({ purpose: 'api_key', label: 'LLM key', hint: '8e0d', revokedAt: null });
    expect(Object.keys(s).sort()).toEqual(
      ['createdAt', 'hint', 'id', 'label', 'purpose', 'replacesSecretId', 'revokedAt', 'rewrappedAt'].sort(),
    );
    secretId = String(s.id);
  });

  it('listing shows metadata only, is audited, and needs integrations.view', async () => {
    const res = await get(h, `${shop.base}/secrets`, manager);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SYNTHETIC');
    expect(res.json<{ storeConfigured: boolean; secrets: { id: string }[] }>()).toMatchObject({
      storeConfigured: true,
      secrets: [{ id: secretId }],
    });
    expect((await get(h, `${shop.base}/secrets`, billing)).statusCode).toBe(403);
    const audit = await sql<{ action: string }>`select action from lbg.audit_events
      where business_id = ${shop.businessId} and action like 'secret.%' order by created_at`.execute(h.admin);
    expect(audit.rows.map((r) => r.action)).toEqual(['secret.store', 'secret.list']);
  });

  it('changing a secret needs a sign-in within 10 minutes; listing does not', async () => {
    await sql`update auth."session" set "createdAt" = now() - interval '1 hour' where "userId" = ${shop.ownerId}`.execute(
      h.admin,
    );
    const stale = await store({ purpose: 'api_key', label: 'Stale', value: VALUE });
    expect([stale.statusCode, errorCode(stale)]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(errorCode(await post(h, `${shop.base}/secrets/${secretId}/revoke`, {}, shop.owner))).toBe('REAUTH_REQUIRED');
    expect((await get(h, `${shop.base}/secrets`, shop.owner)).statusCode).toBe(200);
    await sql`update auth."session" set "createdAt" = now() where "userId" = ${shop.ownerId}`.execute(h.admin);
  });
});

describe('storage (FR-HUB-3 AC2–3)', () => {
  it('the tenant role cannot read the sealed material; the row holds no plaintext', async () => {
    await expect(
      withTenant(h.appDb, ctx(), (trx) =>
        sql`select payload from lbg.integration_secrets where id = ${secretId}`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(h.appDb, ctx(), (trx) => sql`select * from lbg.integration_secrets`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    const raw = await sql<{ payload: Buffer; wrapped_key: Buffer; kek_version: string }>`
      select payload, wrapped_key, kek_version from lbg.integration_secrets where id = ${secretId}`.execute(h.admin);
    const row = raw.rows[0];
    expect(row?.kek_version).toBe('t1');
    expect(
      Buffer.concat([row?.payload ?? Buffer.alloc(0), row?.wrapped_key ?? Buffer.alloc(0)]).includes(
        Buffer.from('SYNTHETIC'),
      ),
    ).toBe(false);
  });

  it('the secrets role opens it for its own business only', async () => {
    expect(await readSecretValue(h.secretsDb, h.keyring, ctx(), secretId)).toBe(VALUE);
    await expect(readSecretValue(h.secretsDb, h.keyring, ctx(other), secretId)).rejects.toBeInstanceOf(SecretError);
    // Without a tenant context the secrets role sees nothing (RLS).
    const none = await sql<{ n: number }>`select count(*)::int as n from lbg.integration_secrets`.execute(h.secretsDb);
    expect(none.rows[0]?.n).toBe(0);
  });

  it('the database refuses edits, deletes, a replaced value and a rewrap by the tenant role', async () => {
    const attempt = (q: ReturnType<typeof sql>) => withTenant(h.appDb, ctx(), (trx) => q.execute(trx));
    await expect(
      attempt(sql`update lbg.integration_secrets set payload = '\\x00' where id = ${secretId}`),
    ).rejects.toMatchObject({ code: 'LB022' });
    await expect(
      attempt(sql`update lbg.integration_secrets set wrapped_key = null where id = ${secretId}`),
    ).rejects.toMatchObject({ code: 'LB022' });
    await expect(
      sql`delete from lbg.integration_secrets where id = ${secretId}`.execute(h.admin),
    ).rejects.toMatchObject({
      code: 'LB001',
    });
    await expect(
      sql`update lbg.integration_secrets set label = 'renamed' where id = ${secretId}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB001' });
    await expect(
      withTenant(h.secretsDb, ctx(), (trx) =>
        sql`update lbg.integration_secrets set payload = '\\x00' where id = ${secretId}`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('rotation, revocation and KEK rotation (FR-HUB-4 AC2, ADR-13)', () => {
  it('rotating stores a new value and revokes the old one, destroying its material', async () => {
    const res = await post(h, `${shop.base}/secrets/${secretId}/rotate`, { value: ROTATED }, shop.owner);
    expect(res.statusCode).toBe(201);
    const next = res.json<{ secret: { id: string; replacesSecretId: string; hint: string } }>().secret;
    expect(next).toMatchObject({ replacesSecretId: secretId, hint: '66bb' });
    expect(await readSecretValue(h.secretsDb, h.keyring, ctx(), next.id)).toBe(ROTATED);
    await expect(readSecretValue(h.secretsDb, h.keyring, ctx(), secretId)).rejects.toMatchObject({ code: 'REVOKED' });
    const old = await sql<{ payload: Buffer | null; wrapped_key: Buffer | null }>`
      select payload, wrapped_key from lbg.integration_secrets where id = ${secretId}`.execute(h.admin);
    expect(old.rows[0]).toEqual({ payload: null, wrapped_key: null });
    expect(errorCode(await post(h, `${shop.base}/secrets/${secretId}/rotate`, { value: ROTATED }, shop.owner))).toBe(
      'REVOKED',
    );
    // Revoke the new one: material destroyed; a second revoke is refused.
    expect((await post(h, `${shop.base}/secrets/${next.id}/revoke`, {}, shop.owner)).statusCode).toBe(200);
    expect(errorCode(await post(h, `${shop.base}/secrets/${next.id}/revoke`, {}, shop.owner))).toBe('REVOKED');
  });

  it('KEK rotation re-seals live data keys; afterwards only the new KEK is needed', async () => {
    const id = (await store({ purpose: 'api_key', label: 'Image key', value: VALUE })).json<{
      secret: { id: string };
    }>().secret.id;
    const both = parseKeyring(
      `t2:${Buffer.alloc(32, 9).toString('base64')},t1:${Buffer.alloc(32, 7).toString('base64')}`,
    );
    expect(await rewrapSecrets(h.secretsDb, both, ctx())).toBe(1); // only the live secret
    const onlyNew = parseKeyring(`t2:${Buffer.alloc(32, 9).toString('base64')}`);
    expect(await readSecretValue(h.secretsDb, onlyNew, ctx(), id)).toBe(VALUE);
    expect(await rewrapSecrets(h.secretsDb, both, ctx())).toBe(0);
    const meta = (await get(h, `${shop.base}/secrets`, shop.owner)).json<{
      secrets: { id: string; rewrappedAt: string | null }[];
    }>().secrets;
    expect(meta.find((x) => x.id === id)?.rewrappedAt).not.toBeNull();
  });
});

describe('redaction (FR-HUB-3 AC3)', () => {
  it('no secret value appears in logs, audit events or error responses', async () => {
    // A rejected request that carries a value (unknown field) must not echo it.
    const bad = await store({ purpose: 'api_key', label: 'x', value: VALUE, extra: VALUE });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('SYNTHETIC');
    const badPurpose = await store({ purpose: 'Not Valid', label: 'x', value: VALUE });
    expect(badPurpose.body).not.toContain('SYNTHETIC');
    expect(h.logs.text).not.toContain('SYNTHETIC');
    const audit = await sql<{
      metadata: unknown;
    }>`select metadata from lbg.audit_events where business_id = ${shop.businessId}`.execute(h.admin);
    expect(JSON.stringify(audit.rows)).not.toContain('SYNTHETIC');
  });
});

describe('access', () => {
  it('other businesses get 404; read-only mode can list but not store; an unconfigured store says so', async () => {
    expect((await post(h, `${other.base}/secrets/${secretId}/revoke`, {}, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/secrets`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/secrets`, other.owner)).json<{ secrets: object[] }>().secrets).toEqual([]);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/secrets`, shop.owner)).statusCode).toBe(200);
    expect(errorCode(await store({ purpose: 'api_key', label: 'RO', value: VALUE }))).toBe('TENANT_READ_ONLY');
    const bare = await startHarness({ keyring: null });
    try {
      resetFixture();
      const s = await activeShop(bare, 'sec-c');
      const res = await post(bare, `${s.base}/secrets`, { purpose: 'api_key', label: 'k', value: VALUE }, s.owner);
      expect([res.statusCode, errorCode(res)]).toEqual([503, 'STORE_NOT_CONFIGURED']);
      expect((await get(bare, `${s.base}/secrets`, s.owner)).json<{ storeConfigured: boolean }>().storeConfigured).toBe(
        false,
      );
    } finally {
      await bare.close();
    }
  }, 120_000);
});
