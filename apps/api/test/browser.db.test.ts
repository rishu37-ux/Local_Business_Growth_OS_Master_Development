// Phase 3 exit test in a real browser (Chromium via Playwright), against the
// real API, the built web app (apps/web/dist) and a migrated throwaway DB:
// register → platform admin approves → owner enrols MFA → setup → go live →
// invite a Billing staff member → staff accepts. Every page visited is checked
// with axe (WCAG 2.x A/AA, serious/critical), for horizontal overflow at
// 360/768/1280 px, and for CSP violations. Synthetic accounts only.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { sql } from 'kysely';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUser, enrolMfa, newUser, startHarness, totp, type Harness } from './auth-harness.ts';

const PORT = 4317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const PW = 'Browser-Exit-2026';

let h: Harness;
let browser: Browser;
let adminSecret = '';
const problems: string[] = [];
const a11y: { page: string; width: number; violations: string[] }[] = [];

async function context(): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  ctx.on('page', (p) => {
    p.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
        problems.push(`CSP: ${m.text()}`);
    });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  });
  return ctx;
}

/** axe + overflow check of the current page at the current viewport width. */
async function audit(page: Page, label: string) {
  const width = page.viewportSize()?.width ?? 0;
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);
  a11y.push({ page: label, width, violations: serious });
  // Evaluated in the browser; the API package has no DOM types, hence a string expression.
  const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth'));
  if (overflow > 0) problems.push(`${label} @${width}px overflows horizontally by ${overflow}px`);
}

async function auditAllWidths(page: Page, label: string) {
  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await audit(page, label);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function signInViaUi(page: Page, email: string, secret?: string) {
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (secret) {
    await page.getByLabel('Six-digit code from your authenticator app').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify code' }).click();
  }
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
}

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  // Platform admin seeded through the API (granting admin is an operator action).
  const admin = await newUser(h, 'exit-admin@example.test', PW);
  await sql`insert into lbg.platform_admins (user_id) values (${admin.id})`.execute(h.admin);
  adminSecret = (await enrolMfa(h, admin.cookies, PW)).secret;
  // A second pending application, so the review queue never holds only ours
  // (CI run #9 failed when other test files left applications behind).
  const decoy = await newUser(h, 'exit-decoy@example.test', PW);
  await h.app.inject({
    method: 'POST',
    url: '/api/applications',
    payload: { legalName: 'Decoy Shop (synthetic)', category: 'MOBILE_ELECTRONICS', stateCode: '27' },
    headers: {
      origin: ORIGIN,
      cookie: Object.entries(decoy.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    },
  });
}, 60_000);

afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 3 exit: register → approve → MFA → setup → live → invite staff', () => {
  let owner: Page;
  let businessUrl = '';

  it('an applicant signs up, verifies the email, signs in and applies', async () => {
    const ctx = await context();
    owner = await ctx.newPage();
    await owner.goto(`${ORIGIN}/sign-up`);
    await auditAllWidths(owner, 'sign-up');
    await owner.getByLabel('Your name').fill('Exit Owner');
    await owner.getByLabel('Email').fill('exit-owner@example.test');
    await owner.getByLabel('Password').fill(PW);
    await owner.getByRole('button', { name: 'Create account' }).click();
    await owner.getByText('Check your email for a verification link').waitFor();

    const link = new URL(h.emails.last('exit-owner@example.test', 'verify-email')?.url ?? '');
    await owner.goto(`${ORIGIN}${link.pathname}${link.search}`);
    await owner.goto(`${ORIGIN}/sign-in`);
    await auditAllWidths(owner, 'sign-in');
    await signInViaUi(owner, 'exit-owner@example.test');

    await owner.getByLabel('Legal business name').fill('Exit Test Mobiles (synthetic)');
    await owner.getByLabel('State').selectOption('09');
    await owner.getByRole('button', { name: 'Submit application' }).click();
    await owner.getByRole('status').getByText('Application submitted').waitFor();
    await auditAllWidths(owner, 'home');
    await owner.getByRole('link', { name: 'Exit Test Mobiles (synthetic)' }).click();
    await owner.getByText('Application status:').waitFor();
    businessUrl = owner.url();
    expect(await owner.getByText('pending approval').count()).toBeGreaterThan(0);
  }, 60_000);

  it('a platform admin signs in with TOTP and approves it in the review queue', async () => {
    const ctx = await context();
    const admin = await ctx.newPage();
    await signInViaUi(admin, 'exit-admin@example.test', adminSecret);
    await admin.getByRole('link', { name: 'Review' }).click();
    // Other test files share this database and may leave applications in the
    // queue, so act on this application's own card only.
    const card = admin
      .getByRole('listitem')
      .filter({ has: admin.getByRole('heading', { name: 'Exit Test Mobiles (synthetic)' }) });
    await card.waitFor();
    await auditAllWidths(admin, 'platform review');
    await card.getByRole('button', { name: 'Approve' }).click();
    await card.waitFor({ state: 'detached' });
    await ctx.close();
  }, 60_000);

  it('the new owner is sent to MFA enrolment, enrols, completes setup and goes live', async () => {
    // Before enrolling, the home page still lists the business and prompts for MFA
    // (regression: the list used to be blocked until enrolment).
    await owner.goto(`${ORIGIN}/`);
    await owner.getByRole('link', { name: 'Exit Test Mobiles (synthetic)' }).waitFor();
    await owner.getByRole('alert').getByText('Two-step verification is required').waitFor();
    await owner.goto(businessUrl);
    await owner.getByRole('link', { name: 'Set up two-step verification' }).click();
    await owner.getByLabel('Password').fill(PW);
    await owner.getByRole('button', { name: 'Continue' }).click();
    const secret = (await owner.getByTestId('totp-secret').textContent())?.trim() ?? '';
    await auditAllWidths(owner, 'mfa enrolment');
    await owner.getByLabel('Six-digit code').fill(totp(secret));
    await owner.getByRole('button', { name: 'Turn on' }).click();
    await owner.getByRole('heading', { name: /Welcome/ }).waitFor();

    await owner.goto(businessUrl);
    await owner.getByRole('heading', { name: 'Set up your shop' }).waitFor();
    await auditAllWidths(owner, 'setup wizard');
    await owner.getByLabel('Shop name shown to customers').fill('Exit Mobiles');
    // The shop's address (Phase 14, D-073); the state comes from the application.
    await owner.getByLabel('Address line 1 (shop number, building, street)').fill('12 Test Market');
    await owner.getByLabel('City or town').fill('Lucknow');
    await owner.getByLabel('District').fill('Lucknow');
    expect(await owner.getByLabel('State or union territory', { exact: true }).inputValue()).toBe('09');
    await owner.getByLabel('PIN code (6 digits)').fill('226001');
    await owner.getByRole('button', { name: 'Save details' }).click();
    await owner.getByText('Details saved.').waitFor();
    await owner.getByLabel('Invoice number prefix (up to 6 characters)').fill('EX');
    await owner.getByRole('button', { name: 'Save tax settings' }).click();
    await owner.getByText('Tax settings saved.').waitFor();
    await owner.getByRole('button', { name: 'Go live' }).click();
    await owner.getByText('Status:').getByText('active').waitFor();
  }, 60_000);

  it('the owner invites a Billing staff member, who accepts with exactly that role', async () => {
    await owner.getByRole('link', { name: 'Staff and invitations' }).click();
    await owner.getByRole('heading', { name: 'Staff and invitations' }).waitFor();
    await auditAllWidths(owner, 'members');
    await owner.getByLabel('Email').fill('exit-staff@example.test');
    await owner.getByLabel('Role').selectOption({ label: 'Billing' });
    await owner.getByRole('button', { name: 'Send invitation' }).click();
    await owner.getByText('Invitation sent to exit-staff@example.test.').waitFor();

    await createVerifiedUser(h, 'exit-staff@example.test', PW, 'Exit Staff');
    const ctx = await context();
    const staff = await ctx.newPage();
    const invite = /\/invite\?token=[^\s]+/.exec(h.mail.last('exit-staff@example.test')?.text ?? '')?.[0] ?? '';
    await staff.goto(`${ORIGIN}${invite}`);
    // Not signed in yet: sent to sign-in, then back to the invitation.
    await staff.getByLabel('Email').fill('exit-staff@example.test');
    await staff.getByLabel('Password').fill(PW);
    await staff.getByRole('button', { name: 'Sign in' }).click();
    await staff.getByRole('button', { name: 'Accept invitation' }).waitFor();
    await auditAllWidths(staff, 'invitation');
    await staff.getByRole('button', { name: 'Accept invitation' }).click();
    await staff.waitForURL(/\/b\//);

    await owner.reload();
    const row = owner.getByRole('row', { name: /exit-staff@example.test/ });
    await row.waitFor();
    expect(await row.textContent()).toContain('Billing');
    await ctx.close();
  }, 60_000);

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    const failing = a11y.filter((r) => r.violations.length > 0);
    expect(failing).toEqual([]);
    expect(a11y.length).toBe(24); // 8 screens × 3 widths
  });
});
