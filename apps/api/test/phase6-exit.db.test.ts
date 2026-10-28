// Phase 6 exit test in a real browser (Chromium via Playwright) against the
// real API, the built web app and a migrated throwaway DB (PHASE6_PLAN §Exit).
// The owner records WhatsApp marketing consent for one customer and none for
// another; a reminder run drafts the birthday and warranty reminders only
// where the recorded facts allow; with a recording test adapter (no real
// provider) a permitted message reaches SENT, while after an opt-out a send
// is blocked with the reason shown; without a provider a message fails as not
// configured; communications history shows each attempt; an expense changes
// the operating-profit estimate by exactly its amount; a customer export holds
// only the chosen fields and is audited; erasing a customer anonymises the
// profile while the old invoice still prints the original details; the tenant
// export ZIP holds the expected files; the dashboard shows the figures with
// definitions. New screens are audited with axe at 1280/768/360 px.
// The dates follow the real clock (the dashboard and reminders work on today).
// Synthetic data only.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import {
  createMessage,
  dispatchMessage,
  NOT_CONFIGURED,
  type MessageProvider,
  type OutboundMessage,
} from '@lbgos/modules/messaging';
import { createSaleDraft, issueSale, type SaleLineSpec } from '@lbgos/modules/sales';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, get, imei, patch, post, resetFixture, SHOP_PW, variant, type Shop } from './shop-fixture.ts';

const run = promisify(execFile);
const PORT = 4330;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const SHOTS = process.env.SHOTS_DIR;
const ACCESS = { discount: { limits: undefined }, priceOverride: true };

class RecordingProvider implements MessageProvider {
  readonly name = 'test-adapter-exit';
  readonly configured = true;
  readonly sent: OutboundMessage[] = [];
  send(m: OutboundMessage) {
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `exit-${String(this.sent.length)}` });
  }
}

let h: Harness;
let browser: Browser;
let shop: Shop;
let owner: Page;
let today = '';
const provider = new RecordingProvider();
const ids: Record<string, string> = {};
let chitraInvoice = '';
let imeiSeq = 9600;
const problems: string[] = [];
const a11y: { page: string; width: number; violations: string[] }[] = [];

async function audit(page: Page, label: string) {
  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    a11y.push({
      page: label,
      width,
      violations: result.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    });
    const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth'));
    if (overflow > 0) {
      const culprits = String(
        await page.evaluate(`[...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
          .map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 3).join('.') + ' ' + Math.round(e.getBoundingClientRect().width))
          .slice(-4).join(' | ')`),
      );
      problems.push(`${label} @${String(width)}px overflows horizontally by ${String(overflow)}px: ${culprits}`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name, exact: true }).click();
const section = (page: Page, heading: RegExp | string) =>
  page.locator('section', { has: page.getByRole('heading', { name: heading }) });
const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });

async function seedPhone(variantId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
    values (${shop.businessId}, ${variantId}, 'IN_STOCK', 800000) returning id`.execute(h.admin);
  const id = rows[0]?.id ?? '';
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
            values (${shop.businessId}, ${imei(imeiSeq++)}, ${id}, 1)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${variantId}, ${id}, 'OPENING', 1, 800000)`.execute(h.admin);
  return id;
}

/** A fully paid sale on business date `date` (noon IST). */
async function sellOn(date: string, lines: SaleLineSpec[], customerId: string): Promise<string> {
  const at = new Date(`${date}T06:30:00Z`);
  const draft = await createSaleDraft(h.appDb, ctx(), ACCESS, { customerId, lines }, at);
  await issueSale(
    h.appDb,
    ctx(),
    ACCESS,
    draft.id,
    {
      expectedTotalPaise: draft.totals.totalPaise,
      payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
    },
    { at },
  );
  return draft.id;
}

async function unzip(bytes: Buffer): Promise<Record<string, string>> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'exit-zip-')), 'data.zip');
  writeFileSync(file, bytes);
  const out = await run('python3', [
    '-I',
    '-c',
    'import sys, zipfile, json\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))',
    file,
  ]);
  return JSON.parse(out.stdout) as Record<string, string>;
}

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT, messaging: provider });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'p6-exit');
  // Tests run at any hour; open the quiet-hours window so offers are not deferred (quiet hours: TR-0027 #10).
  await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
             where business_id = ${shop.businessId}`.execute(h.admin);
  today =
    (await sql<{ d: string }>`select (now() at time zone 'Asia/Kolkata')::date::text as d`.execute(h.admin)).rows[0]
      ?.d ?? '';
  const md = today.slice(5);
  const dob = (year: number) => `${String(year)}-${md === '02-29' ? '02-28' : md}`;
  const phone = await variant(h, shop, 'P6-PH', { serialized: true });
  await patch(h, `${shop.base}/variants/${phone}`, { warrantyMonths: 12, sellingPricePaise: 1_200_000 }, shop.owner);
  for (const [key, body] of [
    ['asha', { name: 'Asha Rao (synthetic)', mobile: '9870000001', dob: dob(1990) }],
    ['bilal', { name: 'Bilal Khan (synthetic)', mobile: '9870000002', dob: dob(1988) }],
    ['chitra', { name: 'Chitra Iyer (synthetic)', mobile: '9870000003', email: 'chitra.synthetic@example.test' }],
  ] as const) {
    const res = await post(h, `${shop.base}/customers`, { ...body, tags: key === 'asha' ? ['VIP'] : [] }, shop.owner);
    ids[key] = res.json<{ customer: { id: string } }>().customer.id;
  }
  const d = async (expr: string) =>
    (await sql<{ d: string }>`select (${sql.raw(expr)})::date::text as d`.execute(h.admin)).rows[0]?.d ?? '';
  // Asha's warranty ends in 5 days; Bilal's ended last year; Chitra bought today (ends in a year).
  await sellOn(
    await d(`date '${today}' + 5 - interval '12 months'`),
    [{ unitId: await seedPhone(phone) }],
    ids.asha ?? '',
  );
  await sellOn(
    await d(`date '${today}' - interval '24 months'`),
    [{ unitId: await seedPhone(phone) }],
    ids.bilal ?? '',
  );
  chitraInvoice = await sellOn(today, [{ unitId: await seedPhone(phone) }], ids.chitra ?? '');
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  owner = await c.newPage();
  owner.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
  owner.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await owner.goto(`${ORIGIN}/sign-in`);
  await owner.getByLabel('Email').fill(shop.ownerEmail);
  await owner.getByLabel('Password').fill(SHOP_PW);
  await owner.getByRole('button', { name: 'Sign in' }).click();
  await owner.getByLabel('Six-digit code from your authenticator app').fill(totp(shop.ownerSecret));
  await owner.getByRole('button', { name: 'Verify code' }).click();
  await owner.getByRole('heading', { name: /Welcome/ }).waitFor();
}, 180_000);
afterAll(async () => {
  await browser.close();
  await h.close();
});

describe('Phase 6 exit (browser)', () => {
  it('consent for one customer, none for the other', async () => {
    const p = owner;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(p, 'Customers');
    await p.getByLabel('Name or mobile').fill('Asha');
    await p.getByRole('link', { name: 'Asha Rao (synthetic)' }).click();
    await p.getByRole('heading', { name: 'Asha Rao (synthetic)' }).waitFor();
    await p.locator('#select-consentChannel').selectOption('WHATSAPP');
    await p.locator('#select-consentPurpose').selectOption('MARKETING');
    await p.locator('#select-consentStatus').selectOption('GRANTED');
    await p
      .getByLabel('How it was given (e.g. asked at the counter, signed form)')
      .fill('Asked at the counter, said yes');
    await p.getByRole('button', { name: 'Record consent' }).click();
    await p.getByText('Consent recorded.').waitFor();
    const whatsapp = section(p, 'Consent and opt-out').getByRole('row', { name: /^WhatsApp/ });
    await expect.poll(async () => whatsapp.innerText()).toMatch(/Allowed\s+Allowed/);
    // Phones owned: the warranty end date as recorded.
    await section(p, 'Phones and items owned')
      .getByRole('cell', { name: /^\d{4}-\d{2}-\d{2}$/ })
      .first()
      .waitFor();
    await audit(p, 'customer profile');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'customer-profile.png'), fullPage: true });
    const bilal = (await get(h, `${shop.base}/customers/${ids.bilal ?? ''}/consents`, shop.owner)).json<{
      consents: { channels: { marketingAllowed: boolean }[] };
    }>().consents;
    expect(bilal.channels.map((x) => x.marketingAllowed)).toEqual([false, false, false]);
  }, 60_000);

  it('a reminder run drafts birthday and warranty reminders only where the records allow', async () => {
    const p = owner;
    await menu(p, 'Reminders');
    await p.getByRole('heading', { name: 'Reminders', level: 1 }).waitFor();
    for (const title of [/^Birthday/, /^Warranty ending/]) {
      const s = section(p, title);
      await s.getByLabel('Turned on').check();
      await s.getByRole('button', { name: 'Save' }).click();
      await p.getByText(/reminder saved\./).waitFor();
    }
    await p.getByRole('button', { name: 'Run reminders now' }).click();
    await p.getByText(`Run for ${today}: 2 drafted, 1 skipped.`).waitFor();
    await section(p, 'Skipped in this run')
      .getByText(/no marketing consent/)
      .waitFor();
    const drafted = section(p, 'Drafted reminders');
    await expect.poll(async () => drafted.getByRole('row').count()).toBe(3); // header + 2
    const text = await drafted.innerText();
    expect(text).toContain('Birthday');
    expect(text).toContain('Warranty ending');
    expect(text).not.toContain('Bilal');
    expect(text).not.toContain('Chitra');
    await audit(p, 'reminders');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'reminders.png'), fullPage: true });
  }, 60_000);

  it('a permitted message is SENT (test adapter); after an opt-out a send is blocked with the reason', async () => {
    const p = owner;
    const drafted = section(p, 'Drafted reminders');
    const birthday = drafted.getByRole('row', { name: /^Birthday/ });
    await birthday.getByRole('button', { name: 'Send for approval' }).click();
    await birthday.getByRole('button', { name: 'Approve' }).click();
    await birthday.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => birthday.innerText()).toContain('Sent');
    expect(provider.sent.map((m) => m.to)).toEqual(['+919870000001']);
    const warranty = drafted.getByRole('row', { name: /^Warranty ending/ });
    await warranty.getByRole('button', { name: 'Send for approval' }).click();
    await warranty.getByRole('button', { name: 'Approve' }).click();
    await warranty.getByRole('button', { name: 'Send' }).waitFor();
    // The customer opts out (staff record it on the profile) before the send.
    await p.goto(`${ORIGIN}/b/${shop.businessId}/customers/${ids.asha ?? ''}`);
    await p.getByRole('button', { name: 'Opt out of WhatsApp' }).click();
    await p.getByText('Opted out of WhatsApp.').waitFor();
    await menu(p, 'Reminders');
    await section(p, 'Drafted reminders')
      .getByRole('row', { name: /^Warranty ending/ })
      .getByRole('button', { name: 'Send' })
      .click();
    await expect
      .poll(async () =>
        section(p, 'Drafted reminders')
          .getByRole('row', { name: /^Warranty ending/ })
          .innerText(),
      )
      .toContain('Blocked');
    expect(provider.sent).toHaveLength(1);
    // Communications history on the profile shows each attempt with its reason.
    await p.goto(`${ORIGIN}/b/${shop.businessId}/customers/${ids.asha ?? ''}`);
    const messages = section(p, /^Messages$/);
    await messages.getByText('Reason: the contact opted out').waitFor();
    const history = await messages.innerText();
    expect(history).toContain('Draft → Pending approval → Approved → Queued → Submitted → Sent');
    expect(history).toContain('Draft → Pending approval → Approved → Queued → Blocked');
  }, 60_000);

  it('without a provider a message fails as not configured, and the history says so', async () => {
    const m = await createMessage(
      h.appDb,
      ctx(),
      {
        customerId: ids.chitra ?? '',
        channel: 'SMS',
        purpose: 'TRANSACTIONAL',
        body: 'Your invoice is ready (synthetic).',
      },
      { queue: true },
    );
    expect(await dispatchMessage(h.appDb, ctx(), NOT_CONFIGURED, m.id)).toEqual({
      outcome: 'FAILED',
      reason: 'PROVIDER_NOT_CONFIGURED',
    });
    await owner.goto(`${ORIGIN}/b/${shop.businessId}/customers/${ids.chitra ?? ''}`);
    await section(owner, /^Messages$/)
      .getByText('Reason: no messaging provider is connected')
      .waitFor();
  }, 60_000);

  it('an expense changes the operating-profit estimate by exactly its amount', async () => {
    const p = owner;
    const profit = async () =>
      (await get(h, `${shop.base}/reports/operating-profit?period=day`, shop.owner)).json<{
        report: { operatingProfitPaise: number };
      }>().report.operatingProfitPaise;
    const before = await profit();
    await menu(p, 'Expenses');
    await p.getByRole('button', { name: 'Turn expenses on' }).click();
    await p.getByText('Expenses turned on.').waitFor();
    await p.getByLabel('Date (YYYY-MM-DD)').fill(today);
    await p.locator('#select-expenseCategory').selectOption('ELECTRICITY');
    await p.getByLabel('Amount (₹)').fill('1234.56');
    await p.getByRole('button', { name: 'Record expense' }).click();
    await p.getByText('Expense recorded.').waitFor();
    await section(p, /^Expenses in/)
      .getByRole('cell', { name: '₹1,234.56' })
      .waitFor();
    expect((await profit()) - before).toBe(-123_456);
    await audit(p, 'expenses');
    await menu(p, 'Reports');
    await p.getByRole('combobox', { name: 'Period', exact: true }).selectOption('day');
    await section(p, 'Operating profit (estimate)').getByText('₹1,234.56').waitFor();
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'expenses-report.png'), fullPage: false });
  }, 60_000);

  it('a customer export contains only the chosen fields and is audited', async () => {
    const p = owner;
    await menu(p, 'Customers');
    const exp = section(p, 'Export customers');
    await exp.getByLabel('Mobile', { exact: true }).uncheck();
    await exp.getByLabel('Tags').check();
    const href = await exp.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(href).toContain('fields=name,tags');
    const res = await p.request.get(`${ORIGIN}${href ?? ''}`);
    expect(res.status()).toBe(200);
    const lines = (await res.text()).slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Name,Tags');
    expect(lines).toContain('Asha Rao (synthetic),VIP');
    expect(lines.join('\n')).not.toMatch(/9870000/);
    const audit = await sql<{ metadata: { fields: string[] } }>`select metadata from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'customer.export'`.execute(h.admin);
    expect(audit.rows.map((r) => r.metadata.fields)).toEqual([['name', 'tags']]);
    await audit_(p);
  }, 60_000);

  it('erasing a customer anonymises the profile while the old invoice still prints the original details', async () => {
    const p = owner;
    await p.goto(`${ORIGIN}/b/${shop.businessId}/customers/${ids.chitra ?? ''}`);
    await p.getByLabel('Reason (at least 10 characters)').fill('Customer asked us to delete her data');
    await p.getByRole('button', { name: 'Erase personal data' }).click();
    // The profile reloads at once (the erase section goes away with the data it held).
    await p.getByRole('heading', { name: 'Erased customer', level: 1 }).waitFor();
    await p.getByText('This customer’s personal data was erased.').waitFor();
    // Checked at once: no section may show the old details while it refetches.
    expect(await p.locator('main').innerText()).not.toContain('chitra.synthetic@example.test');
    const print = await p.request.get(`${ORIGIN}/api/businesses/${shop.businessId}/invoices/${chitraInvoice}/print`);
    expect(await print.text()).toContain('Chitra Iyer (synthetic)');
  }, 60_000);

  it('the tenant export ZIP holds the expected files', async () => {
    await owner.goto(`${ORIGIN}/b/${shop.businessId}`);
    const href = await owner
      .getByRole('link', { name: 'Download all shop data (ZIP of CSV files)' })
      .getAttribute('href');
    const res = await owner.request.get(`${ORIGIN}${href ?? ''}`);
    expect(res.status()).toBe(200);
    const files = await unzip(Buffer.from(await res.body()));
    for (const f of [
      'README.txt',
      'customers.csv',
      'invoices.csv',
      'invoice_lines.csv',
      'payments.csv',
      'expenses.csv',
      'messages.csv',
    ])
      expect(Object.keys(files)).toContain(f);
    expect(files['customers.csv']).toContain('Erased customer');
    expect(files['expenses.csv']).toContain('123456');
  }, 60_000);

  it('the dashboard shows the expected figures with definitions', async () => {
    const p = owner;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    const board = (await get(h, `${shop.base}/dashboard`, shop.owner)).json<{
      dashboard: { tiles: { key: string; today?: number; now?: number; definition: string }[] };
    }>().dashboard;
    const net = board.tiles.find((t) => t.key === 'netSales');
    expect(net?.today).toBe(1_200_000); // Chitra's phone today
    const tile = p.getByTestId('tile-netSales');
    await expect.poll(async () => tile.innerText()).toContain('₹12,000.00');
    expect(await tile.innerText()).toContain('Gross sales minus returns.');
    await p.getByTestId('tile-remindersWaiting').waitFor();
    expect(await p.getByTestId('tile-lowStock').innerText()).toContain('reorder level');
    await audit(p, 'overview');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'overview.png'), fullPage: true });
  }, 60_000);

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(a11y.length).toBe(15); // 5 screens × 3 widths
  });
});

/** The customers list with the export section. */
async function audit_(p: Page) {
  await audit(p, 'customers');
}
