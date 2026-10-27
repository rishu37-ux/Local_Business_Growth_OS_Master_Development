// End-to-end auth tests (increment 3.5): real API + Better Auth + migrated DB.
// Each describe block names the SRS acceptance criteria it covers.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountKey, LOCKOUT, RESET_TOKEN_SECONDS, SESSION_ABSOLUTE_SECONDS } from '@lbgos/modules/auth';
import {
  cookiesFrom,
  createVerifiedUser,
  freshIp,
  get,
  ORIGIN,
  post,
  secretFromTotpUri,
  SESSION_COOKIE,
  setCookieHeaders,
  signIn,
  startHarness,
  totp,
  userId,
  type Harness,
} from './auth-harness.ts';

const PW = 'Sunny-Meadow-2026';
let h: Harness;
let n = 0;
const email = (tag: string) => `${tag}-${++n}@example.test`;

async function signedIn(tag: string) {
  const e = email(tag);
  await createVerifiedUser(h, e, PW);
  const { res, cookies } = await signIn(h, e, PW);
  expect(res.statusCode).toBe(200);
  expect(cookies[SESSION_COOKIE]).toBeDefined();
  return { email: e, cookies };
}

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('FR-AUTH-1 sessions', () => {
  it('AC1 session cookie is HttpOnly, SameSite=Lax, path /, and the token is not exposed in the body', async () => {
    const e = email('ac1');
    await createVerifiedUser(h, e, PW);
    const { res } = await signIn(h, e, PW);
    const cookie = setCookieHeaders(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.json()).toMatchObject({ token: null });
  });

  it('AC1 production cookies carry Secure and the __Secure- prefix', async () => {
    const prod = await startHarness({ secureCookies: true });
    try {
      const e = email('secure');
      await createVerifiedUser(prod, e, PW);
      const { res } = await signIn(prod, e, PW);
      const cookie = setCookieHeaders(res).find((c) => c.startsWith(`__Secure-${SESSION_COOKIE}=`));
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/; Secure/i);
    } finally {
      await prod.close();
    }
  });

  it('AC2 every sign-in issues a new token, ignoring a token the client already holds (no fixation)', async () => {
    const { email: e, cookies: first } = await signedIn('rotate');
    const second = await post(h, '/api/auth/sign-in/email', { email: e, password: PW }, first);
    const token2 = cookiesFrom(second)[SESSION_COOKIE];
    expect(token2).toBeDefined();
    expect(token2).not.toBe(first[SESSION_COOKIE]);
  });

  it('AC3 sessions expire absolutely after 7 days (no sliding refresh)', async () => {
    const { email: e } = await signedIn('absolute');
    const id = await userId(h, e);
    const { rows } = await sql<{ seconds: number }>`
      select extract(epoch from ("expiresAt" - "createdAt"))::int as seconds
        from auth."session" where "userId" = ${id}`.execute(h.admin);
    expect(rows[0]?.seconds).toBe(SESSION_ABSOLUTE_SECONDS);
  });

  it('AC3 a business user idle for more than 12 hours is signed out and the session deleted', async () => {
    const { email: e, cookies } = await signedIn('idle');
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(200);
    const id = await userId(h, e);
    await sql`update auth.session_activity set last_seen_at = now() - interval '12 hours 1 minute'
               where session_id in (select id from auth."session" where "userId" = ${id})`.execute(h.admin);
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(401);
    const { rows } = await sql<{ n: string }>`select count(*) as n from auth."session" where "userId" = ${id}`.execute(
      h.admin,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('AC3 an idle period under the limit keeps the session', async () => {
    const { email: e, cookies } = await signedIn('active');
    await get(h, '/api/me', cookies);
    const id = await userId(h, e);
    await sql`update auth.session_activity set last_seen_at = now() - interval '11 hours'
               where session_id in (select id from auth."session" where "userId" = ${id})`.execute(h.admin);
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(200);
  });

  it('AC3 a platform admin idle for more than 30 minutes is signed out', async () => {
    const { email: e, cookies } = await signedIn('admin-idle');
    const id = await userId(h, e);
    await sql`insert into lbg.platform_admins (user_id) values (${id})`.execute(h.admin);
    // Platform admins must have MFA (D-011); /api/me allows reaching enrolment.
    const me = await get(h, '/api/me', cookies);
    expect(me.json()).toMatchObject({ platformAdmin: true, mfaRequired: true });
    await sql`update auth.session_activity set last_seen_at = now() - interval '31 minutes'
               where session_id in (select id from auth."session" where "userId" = ${id})`.execute(h.admin);
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(401);
  });

  it('AC4 sign-out invalidates the session server-side; the old cookie stops working', async () => {
    const { cookies } = await signedIn('signout');
    expect((await post(h, '/api/auth/sign-out', {}, cookies)).statusCode).toBe(200);
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(401);
  });

  it('AC5 a user can list their sessions and revoke another one', async () => {
    const { email: e, cookies: a } = await signedIn('list');
    const { cookies: b } = await signIn(h, e, PW);
    const list = await get(h, '/api/auth/list-sessions', a);
    expect(list.statusCode).toBe(200);
    const sessions = list.json<{ token: string }[]>();
    expect(sessions).toHaveLength(2);
    const tokenB = b[SESSION_COOKIE]?.split('.')[0];
    expect((await post(h, '/api/auth/revoke-session', { token: tokenB }, a)).statusCode).toBe(200);
    expect((await get(h, '/api/me', b)).statusCode).toBe(401);
    expect((await get(h, '/api/me', a)).statusCode).toBe(200);
  });

  it('AC6 changing the password signs out every other session, even if the client asks not to', async () => {
    const { email: e, cookies: a } = await signedIn('chpw');
    const { cookies: b } = await signIn(h, e, PW);
    const res = await post(
      h,
      '/api/auth/change-password',
      { currentPassword: PW, newPassword: 'Quiet-Harbour-2027', revokeOtherSessions: false },
      a,
    );
    expect(res.statusCode).toBe(200);
    expect((await get(h, '/api/me', b)).statusCode).toBe(401);
  });
});

describe('FR-AUTH-2 password reset, verification, password policy', () => {
  it('AC1 reset requests answer identically for existing and unknown accounts', async () => {
    const e = email('reset-known');
    await createVerifiedUser(h, e, PW);
    const known = await post(h, '/api/auth/request-password-reset', { email: e, redirectTo: '/reset' });
    const unknown = await post(h, '/api/auth/request-password-reset', {
      email: 'nobody-x@example.test',
      redirectTo: '/reset',
    });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
  });

  it('AC2 reset tokens are stored hashed, expire in 30 minutes and are single-use; reset revokes sessions', async () => {
    const { email: e, cookies } = await signedIn('reset');
    await post(h, '/api/auth/request-password-reset', { email: e, redirectTo: '/reset' });
    const mail = h.emails.last(e, 'reset-password');
    expect(mail).toBeDefined();
    const token = new URL(mail?.url ?? 'http://x').pathname.split('/').at(-1) ?? '';
    expect(token.length).toBeGreaterThanOrEqual(16);

    // Identifiers are hashed (storeIdentifier: 'hashed'): the raw token appears nowhere.
    const leaked = await sql<{ n: string }>`
      select count(*) as n from auth.verification
       where identifier like ${'%' + token + '%'} or value like ${'%' + token + '%'}`.execute(h.admin);
    expect(Number(leaked.rows[0]?.n)).toBe(0);
    const { rows } = await sql<{ seconds: number }>`
      select extract(epoch from ("expiresAt" - "createdAt"))::int as seconds
        from auth.verification order by "createdAt" desc limit 1`.execute(h.admin);
    expect(Math.abs((rows[0]?.seconds ?? 0) - RESET_TOKEN_SECONDS)).toBeLessThanOrEqual(2);

    const first = await post(h, '/api/auth/reset-password', { token, newPassword: 'Bright-Lantern-2027' });
    expect(first.statusCode).toBe(200);
    const reuse = await post(h, '/api/auth/reset-password', { token, newPassword: 'Other-Lantern-2028' });
    expect(reuse.statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(401);
    expect((await signIn(h, e, 'Bright-Lantern-2027')).res.statusCode).toBe(200);
  });

  it('AC3 sign-in is refused until the email is verified', async () => {
    const e = email('unverified');
    await post(h, '/api/auth/sign-up/email', { email: e, password: PW, name: 'U' });
    const { res } = await signIn(h, e, PW);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('AC3 sign-up does not reveal whether an email is already registered', async () => {
    const e = email('dupe');
    const first = await post(h, '/api/auth/sign-up/email', { email: e, password: PW, name: 'D' });
    const again = await post(h, '/api/auth/sign-up/email', { email: e, password: PW, name: 'D' });
    expect(again.statusCode).toBe(first.statusCode);
    expect(Object.keys(again.json<{ user: object }>().user).sort()).toEqual(
      Object.keys(first.json<{ user: object }>().user).sort(),
    );
    expect(h.emails.sent.filter((m) => m.to === e && m.kind === 'verify-email')).toHaveLength(1);
  });

  it.each([
    ['too short (9)', 'Short-9ab'],
    ['common', 'password123'],
    ['contains the email name', 'policyuser-Rocks-77'],
    ['one repeated character', 'aaaaaaaaaaaa'],
  ])('AC4 rejects a password that is %s', async (_label, password) => {
    const res = await post(h, '/api/auth/sign-up/email', { email: 'policyuser@example.test', password, name: 'P' });
    expect(res.statusCode).toBe(400);
  });

  it('AC5 (NFR-13) passwords are stored as Argon2id hashes', async () => {
    const e = email('argon');
    await createVerifiedUser(h, e, PW);
    const { rows } = await sql<{ password: string }>`
      select a.password from auth.account a join auth."user" u on u.id = a."userId" where u.email = ${e}`.execute(
      h.admin,
    );
    expect(rows[0]?.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(rows[0]?.password).not.toContain(PW);
  });
});

describe('FR-AUTH-3 MFA', () => {
  async function enrol(cookies: Record<string, string>) {
    const enable = await post(h, '/api/auth/two-factor/enable', { password: PW }, cookies);
    expect(enable.statusCode).toBe(200);
    const { totpURI, backupCodes } = enable.json<{ totpURI: string; backupCodes: string[] }>();
    const secret = secretFromTotpUri(totpURI);
    const verify = await post(h, '/api/auth/two-factor/verify-totp', { code: totp(secret) }, cookies);
    expect(verify.statusCode).toBe(200);
    // Completing MFA rotates the session (FR-AUTH-1 AC2): the old cookie is dead.
    const rotated = cookiesFrom(verify)[SESSION_COOKIE];
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(cookies[SESSION_COOKIE]);
    expect((await get(h, '/api/me', cookies)).statusCode).toBe(401);
    return { secret, backupCodes, session: { [SESSION_COOKIE]: rotated ?? '' } };
  }

  it('AC2 an owner without MFA is blocked from business routes until enrolled, but can reach /api/me', async () => {
    const { email: e, cookies } = await signedIn('owner');
    const id = await userId(h, e);
    const biz = '00000000-0000-0000-0000-00000000e0a1';
    const role = '00000000-0000-0000-0000-00000000e0a2';
    const membership = '00000000-0000-0000-0000-00000000e0a3';
    await sql`insert into lbg.businesses (id, legal_name, category, status) values
                (${biz}, 'Owner Shop (synthetic)', 'MOBILE_ELECTRONICS', 'APPROVED_SETUP_PENDING')`.execute(h.admin);
    await sql`insert into lbg.roles (business_id, id, name, is_system) values (${biz}, ${role}, 'Owner', true)`.execute(
      h.admin,
    );
    await sql`insert into lbg.memberships (business_id, id, user_id) values (${biz}, ${membership}, ${id})`.execute(
      h.admin,
    );
    await sql`insert into lbg.membership_roles (business_id, membership_id, role_id)
                values (${biz}, ${membership}, ${role})`.execute(h.admin);

    expect((await get(h, '/api/me', cookies)).json()).toMatchObject({ mfaRequired: true, twoFactorEnabled: false });
    const blocked = await get(h, '/test/protected', cookies);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: 'MFA_ENROLMENT_REQUIRED' } });

    const { session } = await enrol(cookies);
    expect((await get(h, '/test/protected', session)).statusCode).toBe(200);
  });

  it('AC4 after enrolment, sign-in needs a valid TOTP before any session is issued', async () => {
    const { email: e, cookies } = await signedIn('totp');
    const { secret } = await enrol(cookies);

    const first = await signIn(h, e, PW);
    expect(first.res.statusCode).toBe(200);
    expect(first.res.json()).toMatchObject({ twoFactorRedirect: true });
    // No usable session yet (Better Auth may send a clearing cookie with an empty value).
    expect(first.cookies[SESSION_COOKIE] ?? '').toBe('');

    const wrong = await post(
      h,
      '/api/auth/two-factor/verify-totp',
      { code: '000000' === totp(secret) ? '111111' : '000000' },
      first.cookies,
    );
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    expect(cookiesFrom(wrong)[SESSION_COOKIE] ?? '').toBe('');

    const ok = await post(h, '/api/auth/two-factor/verify-totp', { code: totp(secret) }, first.cookies);
    expect(ok.statusCode).toBe(200);
    const session = { [SESSION_COOKIE]: cookiesFrom(ok)[SESSION_COOKIE] ?? '' };
    expect((await get(h, '/api/me', session)).json()).toMatchObject({ twoFactorEnabled: true });
  });

  it('AC5 ten backup codes are issued and each works only once', async () => {
    const { email: e, cookies } = await signedIn('backup');
    const { backupCodes } = await enrol(cookies);
    expect(backupCodes).toHaveLength(10);
    const code = backupCodes[0] ?? '';

    const first = await signIn(h, e, PW);
    const used = await post(h, '/api/auth/two-factor/verify-backup-code', { code }, first.cookies);
    expect(used.statusCode).toBe(200);
    expect(cookiesFrom(used)[SESSION_COOKIE]).toBeDefined();

    const second = await signIn(h, e, PW);
    const reused = await post(h, '/api/auth/two-factor/verify-backup-code', { code }, second.cookies);
    expect(reused.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('AC5 TOTP secrets and backup codes are not stored in plain text', async () => {
    const { email: e, cookies } = await signedIn('storage');
    const { secret, backupCodes } = await enrol(cookies);
    const id = await userId(h, e);
    const { rows } = await sql<{ secret: string; backupCodes: string }>`
      select secret, "backupCodes" from auth."twoFactor" where "userId" = ${id}`.execute(h.admin);
    expect(rows[0]?.secret).not.toContain(secret);
    for (const c of backupCodes) expect(rows[0]?.backupCodes).not.toContain(c);
  });
});

describe('FR-AUTH-4 rate limiting and lockout', () => {
  it('AC1 locks an account after 5 failures for 15 minutes; the right password is refused meanwhile', async () => {
    const e = email('lock');
    await createVerifiedUser(h, e, PW);
    for (let i = 0; i < LOCKOUT.maxFailures; i++) {
      expect((await signIn(h, e, 'Wrong-Password-00')).res.statusCode).toBe(401);
    }
    const locked = await signIn(h, e, PW);
    expect(locked.res.statusCode).toBe(429);
    expect(locked.cookies[SESSION_COOKIE] ?? '').toBe('');

    // After the window passes, sign-in works again and the counter resets.
    await sql`update auth.sign_in_failures set failed_at = now() - interval '16 minutes'
               where account_key = ${accountKey(e)}`.execute(h.admin);
    expect((await signIn(h, e, PW)).res.statusCode).toBe(200);
  });

  it('AC1 lockout responses are identical for unknown accounts (no enumeration)', async () => {
    const known = email('lock-known');
    await createVerifiedUser(h, known, PW);
    const unknown = 'lock-unknown@example.test';
    for (const target of [known, unknown]) {
      for (let i = 0; i < LOCKOUT.maxFailures; i++) await signIn(h, target, 'Wrong-Password-00');
    }
    const a = await signIn(h, known, 'Wrong-Password-00');
    const b = await signIn(h, unknown, 'Wrong-Password-00');
    expect(a.res.statusCode).toBe(429);
    expect(b.res.statusCode).toBe(429);
    expect(a.res.body).toBe(b.res.body);
  });

  it('AC1 per-IP limit on sign-in, which spoofed X-Forwarded-For headers cannot bypass', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: ip,
        headers: { origin: ORIGIN, 'x-forwarded-for': `198.51.100.${i}`, 'x-lbgos-client-ip': `203.0.113.${i}` },
        payload: { email: `ip-${i}@example.test`, password: 'Wrong-Password-00' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // A different client IP is unaffected.
    expect((await signIn(h, 'ip-other@example.test', 'Wrong-Password-00')).res.statusCode).toBe(401);
  });

  it('AC3 lockouts are recorded in the audit log without the email address', async () => {
    const e = email('lock-audit');
    for (let i = 0; i <= LOCKOUT.maxFailures; i++) await signIn(h, e, 'Wrong-Password-00');
    const { rows } = await sql<{ metadata: { account_key?: string } }>`
      select metadata from lbg.audit_events where action = 'auth.sign_in.locked'
         and metadata->>'account_key' = ${accountKey(e)}`.execute(h.admin);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows)).not.toContain(e);
  });
});

describe('session hook (increment 3.5)', () => {
  it('requires a session on non-public routes', async () => {
    expect((await get(h, '/test/protected')).statusCode).toBe(401);
  });

  it('rejects state-changing requests from another origin (CSRF, threat T4)', async () => {
    const { cookies } = await signedIn('csrf');
    const res = await h.app.inject({
      method: 'POST',
      url: '/test/protected',
      payload: {},
      headers: { origin: 'https://evil.example', cookie: `${SESSION_COOKIE}=${cookies[SESSION_COOKIE] ?? ''}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    expect((await post(h, '/test/protected', {}, cookies)).statusCode).toBe(200);
  });

  it('fails closed for business permissions until RBAC exists', async () => {
    const { cookies } = await signedIn('perm');
    const res = await get(h, '/test/needs-permission', cookies);
    expect(res.statusCode).toBe(403);
  });

  it('creates the lbg.users profile for every new identity', async () => {
    const e = email('profile');
    await createVerifiedUser(h, e, PW);
    const id = await userId(h, e);
    const { rows } = await sql<{ email: string }>`select email from lbg.users where id = ${id}`.execute(h.admin);
    expect(rows[0]?.email).toBe(e);
  });
});
