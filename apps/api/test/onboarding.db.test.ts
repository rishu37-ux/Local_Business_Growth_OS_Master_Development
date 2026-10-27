// Onboarding end to end (increment 3.7a): trial subscription and notifications
// on approval, setup wizard steps, tax profile + invoice series, staff
// invitations, staff-MFA requirement, platform-created businesses, plans.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrolMfa, get, newUser, post, put, signIn, startHarness, type Harness } from './auth-harness.ts';

const PW = 'Onboarding-Test-2026';
let h: Harness;
type Session = Record<string, string>;
let admin: Session;
let owner: Session;
let businessId: string;
const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
const roleId = async (name: string) =>
  (
    await sql<{ id: string }>`select id from lbg.roles where business_id = ${businessId} and name = ${name}`.execute(
      h.admin,
    )
  ).rows[0]?.id ?? '';

/** Token from the last mailed invitation link for `to`. */
function invitationToken(to: string): string {
  const text = h.mail.last(to)?.text ?? '';
  const match = /\/invite\?token=([A-Za-z0-9_%-]+)/.exec(text);
  return decodeURIComponent(match?.[1] ?? '');
}

beforeAll(async () => {
  h = await startHarness();
  const a = await newUser(h, 'ob-admin@example.test', PW);
  await sql`insert into lbg.platform_admins (user_id) values (${a.id})`.execute(h.admin);
  admin = (await enrolMfa(h, a.cookies, PW)).session;

  const o = await newUser(h, 'ob-owner@example.test', PW);
  const created = await post(
    h,
    '/api/applications',
    { legalName: 'Verma Electronics (synthetic)', category: 'MOBILE_ELECTRONICS', stateCode: '27' },
    o.cookies,
  );
  businessId = created.json<{ businessId: string }>().businessId;
  await post(
    h,
    `/api/platform/businesses/${businessId}/request-changes`,
    { reason: 'Please confirm the trading name of the shop.' },
    admin,
  );
  await post(h, `/api/businesses/${businessId}/application/resubmit`, {}, o.cookies);
  await post(h, `/api/platform/businesses/${businessId}/approve`, {}, admin);
  owner = (await enrolMfa(h, o.cookies, PW)).session;
});
afterAll(async () => {
  await h.close();
});

describe('approval side effects (FR-SUB-1, FR-ONB-3, BR-T3 AC2)', () => {
  it('starts a 14-day TRIALING subscription on the Starter plan', async () => {
    const { rows } = await sql<{ code: string; status: string; days: number }>`
      select p.code, s.status, extract(day from s.current_period_end - s.current_period_start)::int as days
        from lbg.subscriptions s join lbg.plans p on p.id = s.plan_id where s.business_id = ${businessId}`.execute(
      h.admin,
    );
    expect(rows).toEqual([{ code: 'STARTER', status: 'TRIALING', days: 14 }]);
  });

  it('notifies the applicant in-app and by email, including the reason for requested changes', async () => {
    const res = await get(h, '/api/notifications', owner);
    const kinds = res.json<{ notifications: { kind: string; body: string }[] }>().notifications.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['business.changes_requested', 'business.approved']));
    const emails = h.mail.sent.filter((m) => m.to === 'ob-owner@example.test').map((m) => m.text);
    expect(emails.some((t) => t.includes('Please confirm the trading name'))).toBe(true);
  });

  it('users can mark their own notifications read but cannot touch anyone else’s', async () => {
    const list = (await get(h, '/api/notifications', owner)).json<{ notifications: { id: string }[] }>().notifications;
    const id = list[0]?.id ?? '';
    expect((await post(h, `/api/notifications/${id}/read`, {}, owner)).statusCode).toBe(204);
    expect((await post(h, `/api/notifications/${id}/read`, {}, admin)).statusCode).toBe(404);
  });
});

describe('setup wizard (FR-ONB-2)', () => {
  it('reports required steps; MFA counts as done for an enrolled owner', async () => {
    const res = await get(h, `/api/businesses/${businessId}/setup`, owner);
    expect(res.json()).toMatchObject({ required: ['details', 'tax', 'mfa'], remainingRequired: ['details', 'tax'] });
  });

  it('details: validates the timezone and saves display name / FY start', async () => {
    const bad = await put(
      h,
      `/api/businesses/${businessId}/setup/details`,
      { displayName: 'Verma Mobiles', timezone: 'Mars/Olympus', fyStartMonth: 4 },
      owner,
    );
    expect(bad.statusCode).toBe(422);
    const ok = await put(
      h,
      `/api/businesses/${businessId}/setup/details`,
      { displayName: 'Verma Mobiles', timezone: 'Asia/Kolkata', fyStartMonth: 4 },
      owner,
    );
    expect(ok.statusCode).toBe(204);
  });

  it('tax: rejects a bad GSTIN checksum and a GSTIN from another state (AC4)', async () => {
    const checksum = await put(
      h,
      `/api/businesses/${businessId}/setup/tax`,
      { registrationType: 'REGULAR', gstin: '27AAPFU0939F1ZW', invoicePrefix: 'VM' },
      owner,
    );
    expect(checksum.statusCode).toBe(422);
    expect(errorCode(checksum)).toBe('GSTIN_INVALID');
    const state = await put(
      h,
      `/api/businesses/${businessId}/setup/tax`,
      { registrationType: 'REGULAR', gstin: '29AAGCB7383J1Z4', invoicePrefix: 'VM' },
      owner,
    );
    expect(state.statusCode).toBe(422);
  });

  it('tax: saves a valid profile and creates invoice series for the current financial year', async () => {
    const res = await put(
      h,
      `/api/businesses/${businessId}/setup/tax`,
      { registrationType: 'REGULAR', gstin: '27AAPFU0939F1ZV', invoicePrefix: 'VM' },
      owner,
    );
    expect(res.statusCode).toBe(200);
    const fy = res.json<{ financialYear: string }>().financialYear;
    expect(fy).toMatch(/^[0-9]{4}-[0-9]{2}$/);
    const { rows } = await sql<{ document_type: string }>`
      select document_type from lbg.invoice_series where business_id = ${businessId} and financial_year = ${fy}
       order by document_type`.execute(h.admin);
    expect(rows.map((r) => r.document_type)).toEqual(['CREDIT_NOTE', 'DEBIT_NOTE', 'TAX_INVOICE']);
    expect((await get(h, `/api/businesses/${businessId}/setup`, owner)).json()).toMatchObject({
      remainingRequired: [],
    });
  });

  it('activation succeeds once the required steps are done', async () => {
    expect((await post(h, `/api/businesses/${businessId}/activate`, {}, owner)).statusCode).toBe(204);
  });
});

describe('invitations', () => {
  let invitee: { id: string; cookies: Session };

  it('the owner invites staff; only a hash of the single-use token is stored', async () => {
    const res = await post(
      h,
      `/api/businesses/${businessId}/invitations`,
      { email: 'ob-staff@example.test', roleIds: [await roleId('Billing')] },
      owner,
    );
    expect(res.statusCode).toBe(201);
    const token = invitationToken('ob-staff@example.test');
    expect(token.length).toBeGreaterThanOrEqual(40);
    const leaked = await sql<{
      n: string;
    }>`select count(*) as n from lbg.invitations where token_hash = ${token}`.execute(h.admin);
    expect(Number(leaked.rows[0]?.n)).toBe(0);
    const list = await get(h, `/api/businesses/${businessId}/invitations`, owner);
    expect(list.json()).toMatchObject({ invitations: [{ email: 'ob-staff@example.test', status: 'PENDING' }] });
  });

  it('a different signed-in user cannot accept it', async () => {
    const other = await newUser(h, 'ob-other@example.test', PW);
    const res = await post(
      h,
      '/api/invitations/accept',
      { token: invitationToken('ob-staff@example.test') },
      other.cookies,
    );
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('the invitee accepts once and gets exactly the invited role', async () => {
    invitee = await newUser(h, 'ob-staff@example.test', PW);
    const token = invitationToken('ob-staff@example.test');
    const res = await post(h, '/api/invitations/accept', { token }, invitee.cookies);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ businessId });
    const members = (await get(h, `/api/businesses/${businessId}/members`, owner)).json<{
      members: { email: string; roles: string[] }[];
    }>();
    expect(members.members.find((m) => m.email === 'ob-staff@example.test')?.roles).toEqual(['Billing']);
    const again = await post(h, '/api/invitations/accept', { token }, invitee.cookies);
    expect(again.statusCode).toBe(410);
  });

  it('inviting an existing member is refused; expired and revoked invitations cannot be used', async () => {
    const dup = await post(
      h,
      `/api/businesses/${businessId}/invitations`,
      { email: 'ob-staff@example.test', roleIds: [await roleId('Billing')] },
      owner,
    );
    expect(dup.statusCode).toBe(409);

    await post(
      h,
      `/api/businesses/${businessId}/invitations`,
      { email: 'ob-late@example.test', roleIds: [await roleId('Inventory')] },
      owner,
    );
    const lateToken = invitationToken('ob-late@example.test');
    await sql`update lbg.invitations set created_at = now() - interval '4 days', expires_at = now() - interval '1 day'
               where email = 'ob-late@example.test'`.execute(h.admin);
    const late = await newUser(h, 'ob-late@example.test', PW);
    expect((await post(h, '/api/invitations/accept', { token: lateToken }, late.cookies)).statusCode).toBe(410);

    const created = await post(
      h,
      `/api/businesses/${businessId}/invitations`,
      { email: 'ob-revoked@example.test', roleIds: [await roleId('Inventory')] },
      owner,
    );
    const revokedToken = invitationToken('ob-revoked@example.test');
    const invitationId = created.json<{ invitationId: string }>().invitationId;
    expect(
      (await post(h, `/api/businesses/${businessId}/invitations/${invitationId}/revoke`, {}, owner)).statusCode,
    ).toBe(204);
    const revoked = await newUser(h, 'ob-revoked@example.test', PW);
    expect((await post(h, '/api/invitations/accept', { token: revokedToken }, revoked.cookies)).statusCode).toBe(410);
  });

  it('R2: a delegated people admin cannot invite someone into the Owner role', async () => {
    const pa = await newUser(h, 'ob-people-admin@example.test', PW);
    const role = await sql<{
      id: string;
    }>`insert into lbg.roles (business_id, name) values (${businessId}, 'People admin') returning id`.execute(h.admin);
    const customId = role.rows[0]?.id ?? '';
    for (const key of ['users.view', 'users.manage']) {
      await sql`insert into lbg.role_permissions (business_id, role_id, permission_key) values (${businessId}, ${customId}, ${key})`.execute(
        h.admin,
      );
    }
    const m = await sql<{
      id: string;
    }>`insert into lbg.memberships (business_id, user_id) values (${businessId}, ${pa.id}) returning id`.execute(
      h.admin,
    );
    await sql`insert into lbg.membership_roles (business_id, membership_id, role_id) values (${businessId}, ${m.rows[0]?.id ?? ''}, ${customId})`.execute(
      h.admin,
    );
    const res = await post(
      h,
      `/api/businesses/${businessId}/invitations`,
      { email: 'ob-escalate@example.test', roleIds: [await roleId('Owner')] },
      pa.cookies,
    );
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('GRANT_EXCEEDS_OWN');
    expect(h.mail.last('ob-escalate@example.test')).toBeUndefined();
  });

  it('the owner can require MFA for all staff (FR-AUTH-3 AC3)', async () => {
    const staffSession = (await signIn(h, 'ob-staff@example.test', PW)).cookies;
    expect((await get(h, `/api/businesses/${businessId}/application`, staffSession)).statusCode).toBe(403); // Billing lacks application.view
    const before = await get(h, '/api/me', staffSession);
    expect(before.json()).toMatchObject({ mfaRequired: false });
    const prefs = await put(
      h,
      `/api/businesses/${businessId}/setup/preferences`,
      { printSize: '80MM', weekStart: 1, requireStaffMfa: true },
      owner,
    );
    expect(prefs.statusCode).toBe(204);
    expect((await get(h, '/api/me', staffSession)).json()).toMatchObject({
      mfaRequired: true,
      twoFactorEnabled: false,
    });
    const blocked = await get(h, `/api/businesses/${businessId}/members`, staffSession);
    expect(errorCode(blocked)).toBe('MFA_ENROLMENT_REQUIRED');
  });
});

describe('platform-created businesses and plans (FR-ONB-1 AC2, FR-SUB-2)', () => {
  it('a platform admin creates a business and its owner accepts the emailed invitation', async () => {
    const res = await post(
      h,
      '/api/platform/businesses',
      {
        legalName: 'Admin Created Shop (synthetic)',
        category: 'MOBILE_ELECTRONICS',
        stateCode: '07',
        ownerEmail: 'ob-invited-owner@example.test',
      },
      admin,
    );
    expect(res.statusCode).toBe(201);
    const id = res.json<{ businessId: string }>().businessId;
    const invited = await newUser(h, 'ob-invited-owner@example.test', PW);
    const accept = await post(
      h,
      '/api/invitations/accept',
      { token: invitationToken('ob-invited-owner@example.test') },
      invited.cookies,
    );
    expect(accept.json()).toEqual({ businessId: id });
    expect((await get(h, '/api/me', invited.cookies)).json()).toMatchObject({ mfaRequired: true });
    const session = (await enrolMfa(h, invited.cookies, PW)).session;
    expect((await get(h, `/api/businesses/${id}`, session)).json()).toMatchObject({
      access: { mode: 'SETUP', roles: ['Owner'] },
    });
  });

  it('only platform admins create businesses or manage plans', async () => {
    expect(
      (
        await post(
          h,
          '/api/platform/businesses',
          { legalName: 'Nope Shop', category: 'MOBILE_ELECTRONICS', stateCode: '07', ownerEmail: 'x@example.test' },
          owner,
        )
      ).statusCode,
    ).toBe(403);
    expect((await get(h, '/api/platform/plans', owner)).statusCode).toBe(403);
  });

  it('seed plans carry the pilot prices flagged as unvalidated; price changes are audited', async () => {
    const plans = (await get(h, '/api/platform/plans', admin)).json<{
      plans: { id: string; code: string; pricePaise: number; pilotPricing: boolean }[];
    }>().plans;
    expect(plans.map((p) => [p.code, p.pricePaise, p.pilotPricing])).toEqual([
      ['STARTER', 99900, true],
      ['GROWTH', 199900, true],
      ['PRO', 349900, true],
    ]);
    const growth = plans.find((p) => p.code === 'GROWTH')?.id ?? '';
    expect(
      (
        await h.app.inject({
          method: 'PATCH',
          url: `/api/platform/plans/${growth}`,
          payload: { pricePaise: 189900 },
          headers: {
            origin: 'http://localhost:3000',
            cookie: Object.entries(admin)
              .map(([k, v]) => `${k}=${v}`)
              .join('; '),
          },
        })
      ).statusCode,
    ).toBe(204);
    const { rows } = await sql<{
      n: string;
    }>`select count(*) as n from lbg.audit_events where action = 'plan.update' and target_id = ${growth}`.execute(
      h.admin,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
