// Business lifecycle and RBAC end to end (increment 3.6): registration →
// review → approval with default roles → owner MFA → activation → staff
// management → suspension/reinstatement, plus rejection. Synthetic data only.
import { DEFAULT_ROLES } from '@lbgos/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrolMfa, get, newUser, post, put, startHarness, type Harness } from './auth-harness.ts';

const PW = 'Lifecycle-Test-2026';
let h: Harness;

type Session = Record<string, string>;
const app = { legalName: 'Sharma Mobiles (synthetic)', category: 'MOBILE_ELECTRONICS', stateCode: '09' };

let applicant: { id: string; cookies: Session };
let owner: Session; // applicant's session after MFA enrolment
let admin: Session;
let businessId: string;

const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  h = await startHarness();
  // Platform admin with MFA (D-011). Granting admin is an operator action (owner role).
  const a = await newUser(h, 'platform-admin@example.test', PW);
  await sql`insert into lbg.platform_admins (user_id) values (${a.id})`.execute(h.admin);
  admin = (await enrolMfa(h, a.cookies, PW)).session;
  applicant = await newUser(h, 'applicant@example.test', PW);
});
afterAll(async () => {
  await h.close();
});

describe('registration (BR-T1, FR-ONB-1)', () => {
  it('creates a PENDING_APPROVAL application with the applicant as its only member', async () => {
    const res = await post(h, '/api/applications', app, applicant.cookies);
    expect(res.statusCode).toBe(201);
    businessId = res.json<{ businessId: string }>().businessId;
    const mine = await get(h, '/api/businesses', applicant.cookies);
    expect(mine.json()).toMatchObject({ businesses: [{ businessId, status: 'PENDING_APPROVAL' }] });
  });

  it('refuses a second open application from the same person (FR-ONB-1 AC3)', async () => {
    const res = await post(h, '/api/applications', app, applicant.cookies);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('DUPLICATE_APPLICATION');
  });

  it('validates input and rejects unknown fields (no setting status)', async () => {
    expect((await post(h, '/api/applications', { ...app, stateCode: 'UP' }, applicant.cookies)).statusCode).toBe(400);
    expect((await post(h, '/api/applications', { ...app, status: 'ACTIVE' }, applicant.cookies)).statusCode).toBe(400);
  });

  it('before approval the applicant can see the application but no business data (BR-T1 AC2)', async () => {
    expect((await get(h, `/api/businesses/${businessId}/application`, applicant.cookies)).statusCode).toBe(200);
    const blocked = await get(h, `/api/businesses/${businessId}`, applicant.cookies);
    expect(blocked.statusCode).toBe(403);
    expect(errorCode(blocked)).toBe('BUSINESS_NOT_AVAILABLE');
  });

  it('non-members get 404 for another business', async () => {
    const other = await newUser(h, 'nosy@example.test', PW);
    expect((await get(h, `/api/businesses/${businessId}/application`, other.cookies)).statusCode).toBe(404);
  });
});

describe('platform review (BR-T2, BR-T3)', () => {
  it('only platform admins see the review queue', async () => {
    expect((await get(h, '/api/platform/applications', applicant.cookies)).statusCode).toBe(403);
    const queue = await get(h, '/api/platform/applications', admin);
    expect(queue.statusCode).toBe(200);
    // Other test files share this database, so look for this application rather than an exact queue.
    const mine = queue
      .json<{ applications: { businessId: string }[] }>()
      .applications.find((a) => a.businessId === businessId);
    expect(mine).toMatchObject({
      businessId,
      status: 'PENDING_APPROVAL',
      applicants: [{ email: 'applicant@example.test' }],
    });
  });

  it('a platform admin without MFA is blocked (D-011)', async () => {
    const b = await newUser(h, 'admin-nomfa@example.test', PW);
    await sql`insert into lbg.platform_admins (user_id) values (${b.id})`.execute(h.admin);
    const res = await get(h, '/api/platform/applications', b.cookies);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('MFA_ENROLMENT_REQUIRED');
  });

  it('requesting changes needs a reason of at least 10 characters (BR-T3 AC1)', async () => {
    const short = await post(h, `/api/platform/businesses/${businessId}/request-changes`, { reason: 'fix it' }, admin);
    expect(short.statusCode).toBe(422);
    expect(errorCode(short)).toBe('REASON_REQUIRED');
    const ok = await post(
      h,
      `/api/platform/businesses/${businessId}/request-changes`,
      { reason: 'Please add the shop state and correct the legal name.' },
      admin,
    );
    expect(ok.statusCode).toBe(204);
  });

  it('the applicant edits and resubmits; history records each step with reasons (BR-T2)', async () => {
    const edit = await put(
      h,
      `/api/businesses/${businessId}/application`,
      { ...app, legalName: 'Sharma Mobile World (synthetic)' },
      applicant.cookies,
    );
    expect(edit.statusCode).toBe(204);
    expect(
      (await post(h, `/api/businesses/${businessId}/application/resubmit`, {}, applicant.cookies)).statusCode,
    ).toBe(204);
    const view = await get(h, `/api/businesses/${businessId}/application`, applicant.cookies);
    const body = view.json<{
      legal_name: string;
      status: string;
      history: { toStatus: string; reason: string | null }[];
    }>();
    expect(body.legal_name).toBe('Sharma Mobile World (synthetic)');
    expect(body.status).toBe('PENDING_APPROVAL');
    expect(body.history.map((e) => e.toStatus)).toEqual(['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'PENDING_APPROVAL']);
    expect(body.history[1]?.reason).toContain('Please add the shop state');
  });

  it('approval creates the default roles and makes the applicant the Owner', async () => {
    expect((await post(h, `/api/platform/businesses/${businessId}/approve`, {}, admin)).statusCode).toBe(204);
    const { rows } = await sql<{
      name: string;
    }>`select name from lbg.roles where business_id = ${businessId} order by name`.execute(h.admin);
    expect(rows.map((r) => r.name)).toEqual(DEFAULT_ROLES.map((r) => r.name).sort());
    const perms = await sql<{
      n: string;
    }>`select count(*) as n from lbg.role_permissions rp join lbg.roles r on r.id = rp.role_id
                                            where r.business_id = ${businessId} and r.name = 'Owner'`.execute(h.admin);
    expect(Number(perms.rows[0]?.n)).toBe(DEFAULT_ROLES[0]?.permissions.length);
  });

  it('invalid transitions are refused (approving twice)', async () => {
    const again = await post(h, `/api/platform/businesses/${businessId}/approve`, {}, admin);
    expect(again.statusCode).toBe(409);
  });
});

describe('setup and activation (FR-ONB-2 AC3, D-011)', () => {
  it('once Owner, the applicant must enrol MFA before using the business', async () => {
    // The business list stays reachable so the owner can find it and the enrolment prompt.
    const list = await get(h, '/api/businesses', applicant.cookies);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ businesses: [{ businessId, status: 'APPROVED_SETUP_PENDING' }] });
    const res = await get(h, `/api/businesses/${businessId}`, applicant.cookies);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('MFA_ENROLMENT_REQUIRED');
    owner = (await enrolMfa(h, applicant.cookies, PW)).session;
    const ok = await get(h, `/api/businesses/${businessId}`, owner);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      business: { status: 'APPROVED_SETUP_PENDING' },
      access: { mode: 'SETUP', roles: ['Owner'] },
    });
  });

  it('the owner activates the business once tax is set up; activating again is refused', async () => {
    const early = await post(h, `/api/businesses/${businessId}/activate`, {}, owner);
    expect(early.statusCode).toBe(409); // migration 0006: tax profile required first
    const tax = await put(
      h,
      `/api/businesses/${businessId}/setup/tax`,
      { registrationType: 'UNREGISTERED', invoicePrefix: 'SM' },
      owner,
    );
    expect(tax.statusCode).toBe(200);
    expect((await post(h, `/api/businesses/${businessId}/activate`, {}, owner)).statusCode).toBe(204);
    expect((await get(h, `/api/businesses/${businessId}`, owner)).json()).toMatchObject({
      business: { status: 'ACTIVE' },
      access: { mode: 'FULL' },
    });
    expect((await post(h, `/api/businesses/${businessId}/activate`, {}, owner)).statusCode).toBe(409);
  });
});

describe('staff and roles (FR-RBAC-1 R1, R2, R4; FR-AUTH-1 AC2/AC5; FR-AUTH-5 AC1)', () => {
  let staff: { id: string; cookies: Session; membershipId: string };
  let ownerMembership: string;
  const roleId = async (name: string) =>
    (
      await sql<{ id: string }>`select id from lbg.roles where business_id = ${businessId} and name = ${name}`.execute(
        h.admin,
      )
    ).rows[0]?.id ?? '';

  beforeAll(async () => {
    // Invitations arrive in 3.7; until then staff membership is seeded directly.
    const s = await newUser(h, 'staff@example.test', PW);
    const m = await sql<{
      id: string;
    }>`insert into lbg.memberships (business_id, user_id) values (${businessId}, ${s.id}) returning id`.execute(
      h.admin,
    );
    const membershipId = m.rows[0]?.id ?? '';
    await sql`insert into lbg.membership_roles (business_id, membership_id, role_id) values (${businessId}, ${membershipId}, ${await roleId('Billing')})`.execute(
      h.admin,
    );
    staff = { ...s, membershipId };
    ownerMembership =
      (
        await sql<{
          id: string;
        }>`select id from lbg.memberships where business_id = ${businessId} and user_id = ${applicant.id}`.execute(
          h.admin,
        )
      ).rows[0]?.id ?? '';
  });

  it('Billing staff are refused routes their role does not grant', async () => {
    expect((await get(h, `/api/businesses/${businessId}/members`, staff.cookies)).statusCode).toBe(403);
    expect((await get(h, `/api/businesses/${businessId}`, staff.cookies)).statusCode).toBe(403);
  });

  it('the owner lists members with their roles', async () => {
    const res = await get(h, `/api/businesses/${businessId}/members`, owner);
    expect(res.json()).toMatchObject({
      members: [
        { email: 'applicant@example.test', roles: ['Owner'] },
        { email: 'staff@example.test', roles: ['Billing'] },
      ],
    });
  });

  it('changing a member’s roles takes effect and signs them out (rotation on privilege change)', async () => {
    const res = await put(
      h,
      `/api/businesses/${businessId}/members/${staff.membershipId}/roles`,
      { roleIds: [await roleId('Manager')] },
      owner,
    );
    expect(res.statusCode).toBe(204);
    expect((await get(h, '/api/me', staff.cookies)).statusCode).toBe(401);
    staff.cookies = (await (await import('./auth-harness.ts')).signIn(h, 'staff@example.test', PW)).cookies;
    expect((await get(h, `/api/businesses/${businessId}`, staff.cookies)).statusCode).toBe(200);
  });

  it('nobody can change their own roles', async () => {
    const res = await put(h, `/api/businesses/${businessId}/members/${ownerMembership}/roles`, { roleIds: [] }, owner);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('SELF_CHANGE');
  });

  it('R2: a delegated admin cannot assign a role with permissions they lack; R1: the last owner cannot be removed', async () => {
    // A custom role with user/role management but nothing else.
    const custom = await sql<{
      id: string;
    }>`insert into lbg.roles (business_id, name) values (${businessId}, 'People admin') returning id`.execute(h.admin);
    const customId = custom.rows[0]?.id ?? '';
    for (const key of ['users.view', 'users.manage', 'roles.manage']) {
      await sql`insert into lbg.role_permissions (business_id, role_id, permission_key) values (${businessId}, ${customId}, ${key})`.execute(
        h.admin,
      );
    }
    await sql`delete from lbg.membership_roles where membership_id = ${staff.membershipId}`.execute(h.admin);
    await sql`insert into lbg.membership_roles (business_id, membership_id, role_id) values (${businessId}, ${staff.membershipId}, ${customId})`.execute(
      h.admin,
    );

    const escalate = await put(
      h,
      `/api/businesses/${businessId}/members/${ownerMembership}/roles`,
      { roleIds: [await roleId('Owner'), await roleId('Manager')] },
      staff.cookies,
    );
    expect(escalate.statusCode).toBe(403);
    expect(errorCode(escalate)).toBe('GRANT_EXCEEDS_OWN');

    const removeOwner = await put(
      h,
      `/api/businesses/${businessId}/members/${ownerMembership}/roles`,
      { roleIds: [] },
      staff.cookies,
    );
    expect(removeOwner.statusCode).toBe(409);
    expect(errorCode(removeOwner)).toBe('LAST_OWNER');
    expect((await get(h, `/api/businesses/${businessId}`, owner)).statusCode).toBe(200);
  });

  it('owners cannot have MFA reset or sessions revoked by staff; staff MFA reset works and is audited', async () => {
    const onOwner = await post(
      h,
      `/api/businesses/${businessId}/members/${ownerMembership}/reset-mfa`,
      {},
      staff.cookies,
    );
    expect(onOwner.statusCode).toBe(403);
    await enrolMfa(h, staff.cookies, PW);
    const reset = await post(h, `/api/businesses/${businessId}/members/${staff.membershipId}/reset-mfa`, {}, owner);
    expect(reset.statusCode).toBe(204);
    const { rows } = await sql<{
      enabled: boolean | null;
    }>`select "twoFactorEnabled" as enabled from auth."user" where id = ${staff.id}`.execute(h.admin);
    expect(rows[0]?.enabled).toBe(false);
  });

  it('deactivation revokes the member’s sessions and access (R4)', async () => {
    const { signIn } = await import('./auth-harness.ts');
    staff.cookies = (await signIn(h, 'staff@example.test', PW)).cookies;
    expect(
      (await post(h, `/api/businesses/${businessId}/members/${staff.membershipId}/deactivate`, {}, owner)).statusCode,
    ).toBe(204);
    expect((await get(h, '/api/me', staff.cookies)).statusCode).toBe(401);
    staff.cookies = (await signIn(h, 'staff@example.test', PW)).cookies;
    expect((await get(h, `/api/businesses/${businessId}/members`, staff.cookies)).statusCode).toBe(404);
  });
});

describe('suspension (BR-T4, D-009)', () => {
  it('suspension needs a reason; the owner keeps read-only access', async () => {
    expect((await post(h, `/api/platform/businesses/${businessId}/suspend`, {}, admin)).statusCode).toBe(422);
    expect(
      (
        await post(
          h,
          `/api/platform/businesses/${businessId}/suspend`,
          { reason: 'Payment dispute under investigation.' },
          admin,
        )
      ).statusCode,
    ).toBe(204);
    const view = await get(h, `/api/businesses/${businessId}`, owner);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ access: { mode: 'READ_ONLY' } });
    const change = await post(h, `/api/businesses/${businessId}/activate`, {}, owner);
    expect(change.statusCode).toBe(403);
    expect(errorCode(change)).toBe('TENANT_READ_ONLY');
  });

  it('reinstatement returns the business to its previous status', async () => {
    expect(
      (
        await post(
          h,
          `/api/platform/businesses/${businessId}/reinstate`,
          { reason: 'Dispute resolved with the owner.' },
          admin,
        )
      ).statusCode,
    ).toBe(204);
    expect((await get(h, `/api/businesses/${businessId}`, owner)).json()).toMatchObject({
      business: { status: 'ACTIVE' },
      access: { mode: 'FULL' },
    });
  });

  it('the business audit log shows platform decisions and owner actions (FR-AUD-1)', async () => {
    const res = await get(h, `/api/businesses/${businessId}/audit`, owner);
    const actions = res.json<{ events: { action: string }[] }>().events.map((e) => e.action);
    for (const a of [
      'business.request_changes',
      'application.resubmit',
      'business.approve',
      'business.activate',
      'member.roles.set',
      'member.mfa.reset',
      'member.deactivate',
      'business.suspend',
      'business.reinstate',
    ]) {
      expect(actions).toContain(a);
    }
  });
});

describe('rejection (BR-T3 AC2, CLOSED mode)', () => {
  it('a rejected applicant can read the decision and reason but nothing else', async () => {
    const r = await newUser(h, 'rejected@example.test', PW);
    const created = await post(
      h,
      '/api/applications',
      { ...app, legalName: 'Unverifiable Shop (synthetic)' },
      r.cookies,
    );
    const id = created.json<{ businessId: string }>().businessId;
    expect(
      (
        await post(
          h,
          `/api/platform/businesses/${id}/reject`,
          { reason: 'Business documents could not be verified.' },
          admin,
        )
      ).statusCode,
    ).toBe(204);
    const view = await get(h, `/api/businesses/${id}/application`, r.cookies);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ status: 'REJECTED' });
    expect(JSON.stringify(view.json())).toContain('could not be verified');
    expect((await put(h, `/api/businesses/${id}/application`, app, r.cookies)).statusCode).toBe(403);
    // A new application is allowed after rejection.
    expect((await post(h, '/api/applications', app, r.cookies)).statusCode).toBe(201);
  });
});
