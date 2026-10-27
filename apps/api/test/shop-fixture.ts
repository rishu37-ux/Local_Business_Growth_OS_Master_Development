// Phase 4 test fixture: an ACTIVE synthetic shop driven through the real API
// (apply → approve → owner MFA → setup → activate), plus staff with chosen
// default roles. Synthetic data only.
import { sql } from 'kysely';
import { cookieHeader, enrolMfa, freshIp, get, newUser, ORIGIN, post, put, type Harness } from './auth-harness.ts';

export const SHOP_PW = 'Shop-Fixture-2026';
export type Session = Record<string, string>;

export interface Shop {
  readonly businessId: string;
  readonly owner: Session;
  readonly ownerId: string;
  readonly base: string;
}

let adminSession: Session | undefined;

async function platformAdmin(h: Harness, prefix: string): Promise<Session> {
  if (adminSession) return adminSession;
  const a = await newUser(h, `${prefix}-admin@example.test`, SHOP_PW);
  await sql`insert into lbg.platform_admins (user_id) values (${a.id})`.execute(h.admin);
  adminSession = (await enrolMfa(h, a.cookies, SHOP_PW)).session;
  return adminSession;
}

export function resetFixture(): void {
  adminSession = undefined;
}

/** stateCode defaults to Maharashtra (27). */
export async function activeShop(h: Harness, prefix: string, stateCode = '27'): Promise<Shop> {
  const admin = await platformAdmin(h, prefix);
  const o = await newUser(h, `${prefix}-owner@example.test`, SHOP_PW);
  const created = await post(
    h,
    '/api/applications',
    { legalName: `${prefix} Mobiles (synthetic)`, category: 'MOBILE_ELECTRONICS', stateCode },
    o.cookies,
  );
  if (created.statusCode !== 201) throw new Error(`apply failed: ${created.statusCode} ${created.body}`);
  const businessId = created.json<{ businessId: string }>().businessId;
  const approved = await post(h, `/api/platform/businesses/${businessId}/approve`, {}, admin);
  if (approved.statusCode >= 300) throw new Error(`approve failed: ${approved.statusCode} ${approved.body}`);
  const owner = (await enrolMfa(h, o.cookies, SHOP_PW)).session;
  const base = `/api/businesses/${businessId}`;
  const steps = [
    await put(
      h,
      `${base}/setup/details`,
      { displayName: `${prefix} Mobiles`, timezone: 'Asia/Kolkata', fyStartMonth: 4 },
      owner,
    ),
    await put(h, `${base}/setup/tax`, { registrationType: 'UNREGISTERED', invoicePrefix: 'T' }, owner),
    await post(h, `${base}/activate`, {}, owner),
  ];
  for (const r of steps) if (r.statusCode >= 300) throw new Error(`setup failed: ${r.statusCode} ${r.body}`);
  return { businessId, owner, ownerId: o.id, base };
}

/** A verified user who joined `shop` with the default role `roleName` (accepted invitation). */
export async function staff(
  h: Harness,
  shop: Shop,
  email: string,
  roleName: string,
): Promise<{ id: string; session: Session }> {
  const { rows } = await sql<{ id: string }>`
    select id from lbg.roles where business_id = ${shop.businessId} and name = ${roleName}`.execute(h.admin);
  const roleId = rows[0]?.id;
  if (!roleId) throw new Error(`no role ${roleName}`);
  const invited = await post(h, `${shop.base}/invitations`, { email, roleIds: [roleId] }, shop.owner);
  if (invited.statusCode !== 201) throw new Error(`invite failed: ${invited.statusCode} ${invited.body}`);
  const token = decodeURIComponent(/\/invite\?token=([A-Za-z0-9_%-]+)/.exec(h.mail.last(email)?.text ?? '')?.[1] ?? '');
  const u = await newUser(h, email, SHOP_PW);
  const accepted = await post(h, '/api/invitations/accept', { token }, u.cookies);
  if (accepted.statusCode !== 200) throw new Error(`accept failed: ${accepted.statusCode} ${accepted.body}`);
  return { id: u.id, session: u.cookies };
}

export async function patch(h: Harness, url: string, payload: object, cookies: Session = {}) {
  return h.app.inject({
    method: 'PATCH',
    url,
    payload,
    remoteAddress: freshIp(),
    headers: { origin: ORIGIN, cookie: cookieHeader(cookies) },
  });
}

export async function del(h: Harness, url: string, cookies: Session = {}) {
  return h.app.inject({
    method: 'DELETE',
    url,
    remoteAddress: freshIp(),
    headers: { origin: ORIGIN, cookie: cookieHeader(cookies) },
  });
}

export const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;

export { get, post, put };
