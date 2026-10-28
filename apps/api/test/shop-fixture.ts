// Phase 4 test fixture: an ACTIVE synthetic shop driven through the real API
// (apply → approve → owner MFA → setup → activate), plus staff with chosen
// default roles. Synthetic data only.
import { luhnCheckDigit } from '@lbgos/domain';
import { sql } from 'kysely';
import { cookieHeader, enrolMfa, freshIp, get, newUser, post, put, type Harness } from './auth-harness.ts';

export const SHOP_PW = 'Shop-Fixture-2026';
export type Session = Record<string, string>;

export interface Shop {
  readonly businessId: string;
  readonly owner: Session;
  readonly ownerId: string;
  readonly ownerEmail: string;
  /** TOTP secret of the owner (for signing in through the browser). */
  readonly ownerSecret: string;
  readonly base: string;
}

let adminSession: Session | undefined;
let adminLogin: { email: string; secret: string } | undefined;

async function platformAdmin(h: Harness, prefix: string): Promise<Session> {
  if (adminSession) return adminSession;
  const a = await newUser(h, `${prefix}-admin@example.test`, SHOP_PW);
  await sql`insert into lbg.platform_admins (user_id) values (${a.id})`.execute(h.admin);
  const enrolled = await enrolMfa(h, a.cookies, SHOP_PW);
  adminSession = enrolled.session;
  adminLogin = { email: a.email, secret: enrolled.secret };
  return adminSession;
}

export function resetFixture(): void {
  adminSession = undefined;
  adminLogin = undefined;
}

/** Email and TOTP secret of the fixture's platform admin (for signing in through the browser). */
export function fixtureAdminLogin(): { email: string; secret: string } {
  if (!adminLogin) throw new Error('call activeShop first');
  return adminLogin;
}

/** The platform admin created by the first `activeShop` since `resetFixture`. */
export function fixtureAdmin(): Session {
  if (!adminSession) throw new Error('call activeShop first');
  return adminSession;
}

/**
 * stateCode defaults to Maharashtra (27). `gstin` makes the shop a REGULAR GST
 * registrant (its first two digits must match the state); otherwise UNREGISTERED.
 */
export async function activeShop(
  h: Harness,
  prefix: string,
  options: { readonly stateCode?: string; readonly gstin?: string } = {},
): Promise<Shop> {
  const stateCode = options.stateCode ?? '27';
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
  const mfa = await enrolMfa(h, o.cookies, SHOP_PW);
  const owner = mfa.session;
  const base = `/api/businesses/${businessId}`;
  const steps = [
    await put(
      h,
      `${base}/setup/details`,
      { displayName: `${prefix} Mobiles`, timezone: 'Asia/Kolkata', fyStartMonth: 4 },
      owner,
    ),
    await put(
      h,
      `${base}/setup/tax`,
      options.gstin
        ? { registrationType: 'REGULAR', gstin: options.gstin, invoicePrefix: 'T' }
        : { registrationType: 'UNREGISTERED', invoicePrefix: 'T' },
      owner,
    ),
    await post(h, `${base}/activate`, {}, owner),
  ];
  for (const r of steps) if (r.statusCode >= 300) throw new Error(`setup failed: ${r.statusCode} ${r.body}`);
  return { businessId, owner, ownerId: o.id, ownerEmail: o.email, ownerSecret: mfa.secret, base };
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
    headers: { origin: h.origin, cookie: cookieHeader(cookies) },
  });
}

export async function del(h: Harness, url: string, cookies: Session = {}) {
  return h.app.inject({
    method: 'DELETE',
    url,
    remoteAddress: freshIp(),
    headers: { origin: h.origin, cookie: cookieHeader(cookies) },
  });
}

export const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;

export { get, post, put };

/** A valid synthetic IMEI (Luhn check digit) from a small number; the 35-990 prefix keeps it obviously synthetic. */
export function imei(n: number): string {
  const body = `35990${String(n).padStart(9, '0')}`;
  return body + String(luhnCheckDigit(body));
}

/** A product with one variant; returns the variant ID. */
export async function variant(
  h: Harness,
  shop: Shop,
  sku: string,
  options: { readonly serialized: boolean; readonly taxRateId?: string },
): Promise<string> {
  const res = await post(
    h,
    `${shop.base}/products`,
    {
      modelName: `Model ${sku}`,
      isSerialized: options.serialized,
      variants: [{ sku, sellingPricePaise: 100_000, ...(options.taxRateId ? { taxRateId: options.taxRateId } : {}) }],
    },
    shop.owner,
  );
  if (res.statusCode !== 201) throw new Error(`product failed: ${res.statusCode} ${res.body}`);
  return res.json<{ variantIds: string[] }>().variantIds[0] ?? '';
}
