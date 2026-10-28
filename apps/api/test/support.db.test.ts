// Increment 10.1: owner-granted, time-boxed support access (FR-SUP-1, T8).
// Synthetic data only.
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
  resetFixture,
  staff,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let a: Shop;
let b: Shop;
let admin: Session;
let adminId: string;

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  a = await activeShop(h, 'sup-a');
  b = await activeShop(h, 'sup-b');
  admin = fixtureAdmin();
  adminId = (await get(h, '/api/me', admin)).json<{ userId: string }>().userId;
  await post(h, `${a.base}/customers`, { name: 'Support check customer (synthetic)', mobile: '9863000001' }, a.owner);
}, 180_000);
afterAll(async () => {
  await h.close();
});

const grant = (shop: Shop, body: object, who: Session = shop.owner) =>
  post(h, `${shop.base}/support/grants`, body, who);

describe('support access (FR-SUP-1)', () => {
  it('without a grant the platform admin is a non-member: 404', async () => {
    expect((await get(h, a.base, admin)).statusCode).toBe(404);
    expect((await get(h, `${a.base}/customers`, admin)).statusCode).toBe(404);
  });

  it('AC1: only the owner grants, with a purpose and 1–72 hours; the database refuses longer grants', async () => {
    const billing = await staff(h, a, 'sup-a-billing@example.test', 'Billing');
    expect((await grant(a, { purpose: 'Check a stock mismatch', hours: 2 }, billing.session)).statusCode).toBe(403);
    expect((await grant(a, { purpose: 'short', hours: 2 })).statusCode).toBe(400);
    expect((await grant(a, { purpose: 'Check a stock mismatch', hours: 73 })).statusCode).toBe(400);
    expect((await grant(a, { purpose: 'Check a stock mismatch', hours: 0 })).statusCode).toBe(400);
    // The bound holds in the database too, whatever the API sends.
    await expect(
      sql`insert into lbg.support_grants (business_id, granted_by, purpose, expires_at)
          values (${a.businessId}, ${a.ownerId}, 'Direct insert beyond the limit', now() + interval '73 hours')`.execute(
        h.admin,
      ),
    ).rejects.toThrow(/check constraint/);
    // Staff cannot see the grants either.
    expect((await get(h, `${a.base}/support`, billing.session)).statusCode).toBe(403);
  });

  it('AC2/AC3: under a grant the admin reads with view permissions only, and every request is audited', async () => {
    const res = await grant(a, { purpose: 'Customer asked why stock shows 0', hours: 2 });
    expect(res.statusCode).toBe(201);
    const g = res.json<{ grant: { id: string; status: string; expiresAt: string } }>().grant;
    expect(g.status).toBe('ACTIVE');
    expect(new Date(g.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 3600_000);

    const overview = await get(h, a.base, admin);
    expect(overview.statusCode).toBe(200);
    expect(overview.json<{ access: { mode: string; roles: string[] } }>().access).toMatchObject({
      mode: 'READ_ONLY',
      roles: ['Platform support (read-only)'],
    });
    const customers = await get(h, `${a.base}/customers?q=Support`, admin);
    expect(customers.statusCode).toBe(200);
    expect(customers.body).toContain('Support check customer');

    // No writes of any kind, no exports, nothing owner-only, no support management.
    const write = await post(h, `${a.base}/customers`, { name: 'Written by support', mobile: '9863000002' }, admin);
    expect([write.statusCode, errorCode(write)]).toEqual([403, 'SUPPORT_READ_ONLY']);
    const put = await h.app.inject({
      method: 'PUT',
      url: `${a.base}/setup/details`,
      payload: { displayName: 'Changed by support' },
      headers: {
        origin: h.origin,
        cookie: Object.entries(admin)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
    });
    expect([put.statusCode, errorCode(put)]).toEqual([403, 'SUPPORT_READ_ONLY']);
    const patched = await patch(h, `${a.base}/categories/00000000-0000-4000-8000-000000000000`, { name: 'x' }, admin);
    expect([patched.statusCode, errorCode(patched)]).toEqual([403, 'SUPPORT_READ_ONLY']);
    const exp = await get(h, `${a.base}/reports/sales-summary/export?period=month&date=2026-10-15&format=csv`, admin);
    expect(exp.statusCode).toBe(403);
    expect((await get(h, `${a.base}/export/business-data`, admin)).statusCode).toBe(403);
    expect((await get(h, `${a.base}/support`, admin)).statusCode).toBe(403);
    expect((await get(h, `${a.base}/expenses?from=2026-10-01&to=2026-10-31`, admin)).statusCode).toBe(403);

    // The owner sees the grant and each support request (route pattern, never the query).
    const seen = await get(h, `${a.base}/support`, a.owner);
    const body = seen.json<{
      grants: { id: string; status: string }[];
      actions: { action: string; actorUserId: string; method: string | null; route: string | null; refused: boolean }[];
    }>();
    expect(body.grants[0]).toMatchObject({ id: g.id, status: 'ACTIVE' });
    const uses = body.actions.filter((x) => x.action === 'support.access');
    expect(uses.length).toBeGreaterThanOrEqual(9);
    expect(
      uses
        .filter((x) => x.refused)
        .map((x) => x.method)
        .sort(),
    ).toEqual(['PATCH', 'POST', 'PUT']);
    expect(uses.every((x) => x.actorUserId === adminId)).toBe(true);
    expect(uses.map((x) => x.route)).toContain('/api/businesses/:businessId/customers');
    expect(seen.body).not.toContain('q=Support');
    expect(body.actions.map((x) => x.action)).toContain('support.granted');
  });

  it("cross-tenant: A's grant gives nothing in B; B's owner cannot see or revoke A's grants", async () => {
    expect((await get(h, b.base, admin)).statusCode).toBe(404);
    const bView = await get(h, `${b.base}/support`, b.owner);
    expect(bView.json<{ grants: unknown[] }>().grants).toEqual([]);
    const aGrant =
      (await get(h, `${a.base}/support`, a.owner)).json<{ grants: { id: string }[] }>().grants[0]?.id ?? '';
    expect((await post(h, `${b.base}/support/grants/${aGrant}/revoke`, {}, b.owner)).statusCode).toBe(404);
    expect((await post(h, `${a.base}/support/grants/${aGrant}/revoke`, {}, b.owner)).statusCode).toBe(404);
  });

  it('AC4: revocation ends access at once and happens once; grants cannot be edited or deleted', async () => {
    const id = (await get(h, `${a.base}/support`, a.owner)).json<{ grants: { id: string }[] }>().grants[0]?.id ?? '';
    const revoked = await post(h, `${a.base}/support/grants/${id}/revoke`, {}, a.owner);
    expect(revoked.json<{ grant: { status: string } }>().grant.status).toBe('REVOKED');
    expect((await get(h, a.base, admin)).statusCode).toBe(404);
    const again = await post(h, `${a.base}/support/grants/${id}/revoke`, {}, a.owner);
    expect([again.statusCode, errorCode(again)]).toEqual([409, 'ALREADY_REVOKED']);
    await expect(sql`delete from lbg.support_grants where id = ${id}`.execute(h.admin)).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      sql`update lbg.support_grants set expires_at = expires_at + interval '1 hour' where id = ${id}`.execute(h.admin),
    ).rejects.toThrow(/already revoked/);
  });

  it('AC4: access ends by itself at expiry', async () => {
    const res = await grant(a, { purpose: 'Look at a failed print', hours: 1 });
    const id = res.json<{ grant: { id: string } }>().grant.id;
    expect((await get(h, a.base, admin)).statusCode).toBe(200);
    // Simulate the passage of time: move the grant window into the past (owner role, test only).
    await sql`alter table lbg.support_grants disable trigger support_grants_guard`.execute(h.admin);
    await sql`update lbg.support_grants set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
              where id = ${id}`.execute(h.admin);
    await sql`alter table lbg.support_grants enable trigger support_grants_guard`.execute(h.admin);
    expect((await get(h, a.base, admin)).statusCode).toBe(404);
    const grants = (await get(h, `${a.base}/support`, a.owner)).json<{ grants: { id: string; status: string }[] }>()
      .grants;
    expect(grants.find((x) => x.id === id)?.status).toBe('EXPIRED');
  });

  it('a grant cannot be created from an old sign-in (re-authentication)', async () => {
    await sql`update auth."session" set "createdAt" = now() - interval '1 day' where "userId" = ${a.ownerId}`.execute(
      h.admin,
    );
    const res = await grant(a, { purpose: 'Should need a fresh sign-in', hours: 1 });
    expect([res.statusCode, errorCode(res)]).toEqual([403, 'REAUTH_REQUIRED']);
  });
});
