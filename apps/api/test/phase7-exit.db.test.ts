// Phase 7 exit test in a real browser (Chromium via Playwright) against the
// real API, the built web app and a migrated throwaway DB (PHASE7_PLAN §Exit),
// with mock adapters only: the mock AI adapter, a recording messaging adapter
// and a local mock of the WhatsApp Cloud API through the injected transport.
// Nothing contacts a real provider. The owner adds an AI integration with a
// credential (afterwards only its last 4 characters are shown) and tests it;
// a private/metadata endpoint is refused; an approved offer and two products
// give a caption whose invented values block approval until fixed; the
// approved version goes to a tag segment where the customer without consent
// and the opted-out customer are left out and the counts are shown; editing an
// approved campaign returns it to draft; a scheduled campaign is cancelled;
// usage is recorded per business and the quota stops generation; a signed
// webhook updates a delivery status while unsigned and replayed ones are
// rejected; another business sees none of it. New screens are audited with
// axe at 1280/768/360 px. Synthetic data only.
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { createMessage, dispatchMessage, type MessageProvider, type OutboundMessage } from '@lbgos/modules/messaging';
import type { ResolvedAddress, TransportRequest, TransportResponse } from '@lbgos/modules/outbound';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, get, patch, post, resetFixture, SHOP_PW, variant, type Shop } from './shop-fixture.ts';

const PORT = 4340;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const SHOTS = process.env.SHOTS_DIR;
const LLM_KEY = 'mock-key-SYNTHETIC-7x9q';
const WA_SECRET = {
  accessToken: 'wa-token-SYNTHETIC',
  appSecret: 'wa-app-secret-SYNTHETIC',
  verifyToken: 'verify-SYNTHETIC',
};

class RecordingProvider implements MessageProvider {
  readonly sent: OutboundMessage[] = [];
  readonly configured = true;
  readonly name: string;
  constructor(name = 'test-adapter-p7') {
    this.name = name;
  }
  send(m: OutboundMessage) {
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `${this.name}-${String(this.sent.length)}` });
  }
}

const resolver = (host: string): Promise<readonly ResolvedAddress[]> =>
  Promise.resolve(host === 'graph.facebook.com' ? [{ address: '93.184.215.14', family: 4 }] : []);
/** Local mock of the Graph API connection test. */
const transport = (req: TransportRequest): Promise<TransportResponse> =>
  Promise.resolve({
    status:
      req.hostname === 'graph.facebook.com' && req.headers.authorization === `Bearer ${WA_SECRET.accessToken}`
        ? 200
        : 404,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"verified_name":"Synthetic"}'),
  });

let h: Harness;
let browser: Browser;
let shop: Shop;
let other: Shop;
let owner: Page;
const provider = new RecordingProvider();
const ids: Record<string, string> = {};
let llmId = '';
let today = '';
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
const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({
    baseURL: ORIGIN,
    webRoot: WEB_ROOT,
    messaging: provider,
    outbound: { resolver, transport },
  });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'p7-exit');
  other = await activeShop(h, 'p7-other');
  await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
             where business_id = ${shop.businessId}`.execute(h.admin);
  today =
    (await sql<{ d: string }>`select (now() at time zone 'Asia/Kolkata')::date::text as d`.execute(h.admin)).rows[0]
      ?.d ?? '';
  for (const [sku, price, storage] of [
    ['P7-A', 1_500_000, '128GB'],
    ['P7-B', 1_800_000, '256GB'],
  ] as const) {
    ids[sku] = await variant(h, shop, sku, { serialized: true });
    await sql`update lbg.product_variants set selling_price_paise = ${price}, ram = '8GB', storage = ${storage}
               where id = ${ids[sku] ?? ''}`.execute(h.admin);
  }
  // Segment VIP: Asha agreed to WhatsApp marketing; Bilal did not; Chitra agreed and then opted out.
  for (const [key, mobile] of [
    ['asha', '9871000001'],
    ['bilal', '9871000002'],
    ['chitra', '9871000003'],
  ] as const) {
    const res = await post(
      h,
      `${shop.base}/customers`,
      { name: `${key} (synthetic)`, mobile, tags: ['VIP'] },
      shop.owner,
    );
    ids[key] = res.json<{ customer: { id: string } }>().customer.id;
    if (key !== 'bilal') {
      await post(
        h,
        `${shop.base}/customers/${ids[key] ?? ''}/consents`,
        { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
        shop.owner,
      );
    }
  }
  await post(h, `${shop.base}/customers/${ids.chitra ?? ''}/opt-out`, { channel: 'WHATSAPP' }, shop.owner);
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await c.newPage();
  owner.on('dialog', (d) => void d.accept());
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

describe('Phase 7 exit (browser)', () => {
  it('the owner adds and tests an AI integration; the credential is shown only as its last 4 characters', async () => {
    const p = owner;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(p, 'API Hub');
    await p.getByRole('heading', { name: 'API Hub' }).waitFor();
    await p.locator('#select-integrationCategory').selectOption('LLM');
    await p.locator('#select-integrationProvider').selectOption('mock');
    await p.locator('#select-integrationAuth').selectOption('API_KEY');
    await p.getByLabel('Name', { exact: true }).fill('Caption writer (test adapter)');
    await p.getByLabel('Model').fill('mock-invent');
    await p.getByLabel('Credential', { exact: true }).fill(LLM_KEY);
    await p.getByRole('button', { name: 'Save integration' }).click();
    await p.getByText('Integration saved. Test the connection before using it.').waitFor();
    const row = p.getByRole('row', { name: /Caption writer/ });
    await expect.poll(async () => row.innerText()).toContain('••••7x9q');
    expect(await row.innerText()).toContain('Configured');
    await row.getByRole('button', { name: /^Open/ }).click();
    await p.getByRole('button', { name: 'Test connection' }).click();
    await expect.poll(async () => row.innerText()).toContain('Tested');
    llmId =
      (await get(h, `${shop.base}/integrations`, shop.owner))
        .json<{ integrations: { id: string; label: string }[] }>()
        .integrations.find((i) => i.label.startsWith('Caption writer'))?.id ?? '';
    // A custom endpoint at the cloud metadata address is refused.
    await p.locator('#select-integrationCategory').selectOption('LLM');
    await p.locator('#select-integrationProvider').selectOption('custom_rest');
    await p.getByLabel('Name', { exact: true }).fill('Metadata probe');
    await p.getByLabel('Base URL (https)').fill('https://169.254.169.254/latest');
    await p.getByLabel('Credential', { exact: true }).fill('probe-key-SYNTHETIC-0000');
    await p.getByRole('button', { name: 'Save integration' }).click();
    await p.getByText('This endpoint is not allowed.').waitFor();
    await audit(p, 'api hub');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'api-hub.png'), fullPage: true });
    // The value appears nowhere: responses, audit, logs.
    for (const url of [`${shop.base}/integrations`, `${shop.base}/secrets`, `${shop.base}/integrations/${llmId}`]) {
      expect((await get(h, url, shop.owner)).body).not.toContain(LLM_KEY);
    }
    const audits = await sql<{ m: string }>`select metadata::text as m from lbg.audit_events
      where business_id = ${shop.businessId}`.execute(h.admin);
    expect(audits.rows.some((r) => r.m.includes('SYNTHETIC'))).toBe(false);
    expect(h.logs.text).not.toContain(LLM_KEY);
  }, 90_000);

  it('an approved offer and two products give a caption whose invented values block approval until fixed', async () => {
    const p = owner;
    await menu(p, 'Offers');
    await p.getByLabel('Title').fill('Diwali offer');
    await p.getByLabel('Discount (%)').fill('10');
    await p.getByLabel('Valid from (YYYY-MM-DD)').fill(today);
    await p.getByLabel('Valid to (YYYY-MM-DD)').fill(today);
    await p.getByRole('button', { name: 'Save offer' }).click();
    await p.getByText('Offer saved as a draft.', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Approve Diwali offer' }).click();
    await expect.poll(async () => p.getByRole('row', { name: /Diwali offer/ }).innerText()).toContain('Approved');
    await audit(p, 'offers');

    await menu(p, 'Creative Studio');
    await p.getByLabel('Find products (name, model or SKU)').fill('P7');
    await p.getByLabel('8GB 128GB — ₹15,000.00').check();
    await p.getByLabel('8GB 256GB — ₹18,000.00').check();
    await p.locator('#select-studioOffer').selectOption({ label: 'Diwali offer (10% off)' });
    await p.getByRole('button', { name: 'Generate' }).click();
    await p.getByText('Draft generated. Review it below.').waitFor();
    await p
      .getByRole('button', { name: /^Open draft/ })
      .first()
      .click();
    const review = p.locator('section', { has: p.getByRole('heading', { name: 'Review draft' }) });
    await review.getByText('Price not in the catalogue or offer: ₹999').waitFor();
    await review.getByText('Date not in the offer: 31 Dec 2099').waitFor();
    await review.getByRole('button', { name: 'Send for approval' }).click();
    await p.getByText('Sent for approval.').waitFor();
    await review.getByRole('button', { name: 'Approve this version' }).click();
    await p.getByText(/Check these values before approving: .*₹999/).waitFor();
    // Fix the text: a new version without the invented sentence.
    const box = review.getByLabel('Text');
    const text = await box.inputValue();
    expect(text).toContain('Model P7-A 8GB 128GB at ₹15,000');
    await box.fill(text.replace(' Only ₹999 and 50% off till 31 Dec 2099!', ''));
    await review.getByRole('button', { name: 'Save as new version' }).click();
    await p.getByText('Saved as a new version; it needs approval again.').waitFor();
    await review.getByText('No price, percentage, date or specification outside your facts.').waitFor();
    expect(await review.innerText()).toContain('version 2');
    await review.getByRole('button', { name: 'Send for approval' }).click();
    await p.getByText('Sent for approval.').waitFor();
    await review.getByRole('button', { name: 'Approve this version' }).click();
    await p.getByText('Approved: this exact version may be used.').waitFor();
    await audit(p, 'creative studio');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'studio.png'), fullPage: true });
  }, 120_000);

  it('the approved version goes to a tag segment; customers without consent or opted out are left out', async () => {
    const p = owner;
    await menu(p, 'Campaigns');
    await p.getByLabel('Name', { exact: true }).fill('Diwali VIP');
    await p.locator('#select-campaignSource').selectOption({ index: 1 });
    await p.getByLabel('Customer tags (comma separated; empty = all)').fill('VIP');
    await p.getByRole('button', { name: 'Save campaign' }).click();
    await p.getByText('Campaign saved as a draft.').waitFor();
    await p.getByRole('button', { name: 'Open Diwali VIP' }).click();
    const audience = p.getByTestId('campaign-audience');
    await expect.poll(async () => audience.innerText()).toContain('1 without marketing consent, 1 opted out');
    expect(await audience.innerText()).toMatch(/Customers in the group\s+3\s+Would receive it now\s+1/);
    await p.getByRole('button', { name: 'Send for approval' }).click();
    await p.getByText('Sent for approval.').waitFor();
    await p.getByRole('button', { name: 'Approve this version' }).click();
    await p.getByText('Approved: this exact version may be sent.').waitFor();
    const before = provider.sent.length;
    await p.getByRole('button', { name: 'Send now' }).click();
    await p.getByText('Campaign sent; see the results.').waitFor();
    const results = p.getByTestId('campaign-results');
    // In the group 3, left out 2, messages 1, waiting 0, sent 1, delivered 0, blocked 0, failed 0, cancelled 0.
    await expect.poll(async () => (await results.innerText()).split(/\s+/).join(' ')).toBe('3 2 1 0 1 0 0 0 0');
    const sent = provider.sent.slice(before);
    expect(sent.map((m) => m.to)).toEqual(['+919871000001']);
    const approvedText = (await get(h, `${shop.base}/studio/drafts`, shop.owner))
      .json<{ drafts: { status: string; body: string | null }[] }>()
      .drafts.find((d) => d.status === 'APPROVED')?.body;
    expect(sent[0]?.body).toBe(approvedText);
    await audit(p, 'campaigns');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'campaigns.png'), fullPage: true });
  }, 90_000);

  it('editing an approved campaign returns it to draft; a scheduled campaign can be cancelled', async () => {
    const p = owner;
    const make = async (name: string) => {
      await p.getByLabel('Name', { exact: true }).fill(name);
      await p.locator('#select-campaignSource').selectOption('');
      await p.getByLabel('Customer tags (comma separated; empty = all)').fill('VIP');
      await p.locator('#textarea-campaignBody').fill(`${name}: covers on sale this weekend (synthetic).`);
      await p.getByRole('button', { name: 'Save campaign' }).click();
      await p.getByText('Campaign saved as a draft.').waitFor();
      await p.getByRole('button', { name: `Open ${name}` }).click();
      await p.getByRole('button', { name: 'Send for approval' }).click();
      await p.getByText('Sent for approval.').waitFor();
      await p.getByRole('button', { name: 'Approve this version' }).click();
      await p.getByText('Approved: this exact version may be sent.').waitFor();
    };
    await make('Weekend');
    const detail = p.locator('section', { has: p.getByRole('heading', { name: 'Weekend', exact: true }) });
    await detail.locator('#textarea-campaignEdit').fill('Weekend: covers and chargers on sale (synthetic).');
    await detail.getByRole('button', { name: 'Save as new version' }).click();
    await p.getByText('Saved as a new version; it needs approval again.').waitFor();
    await expect.poll(async () => detail.innerText()).toMatch(/version 2[\s\S]*Draft/);
    await p.getByRole('button', { name: 'Close Weekend' }).click();

    await make('Later');
    const later = p.locator('section', { has: p.getByRole('heading', { name: 'Later', exact: true }) });
    const d = new Date(Date.now() + 2 * 86_400_000);
    const local = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T10:30`;
    await later.locator('#campaign-when').fill(local);
    await later.getByRole('button', { name: 'Schedule' }).click();
    await p.getByText('Campaign scheduled.').waitFor();
    await expect.poll(async () => p.getByRole('row', { name: /Later/ }).innerText()).toContain('Scheduled');
    await later.getByRole('button', { name: 'Cancel campaign' }).click();
    await p.getByText('Campaign cancelled.').waitFor();
    await expect.poll(async () => p.getByRole('row', { name: /Later/ }).innerText()).toContain('Cancelled');
  }, 90_000);

  it('usage is recorded per business and the quota stops generation', async () => {
    const calls = await sql<{ business_id: string; n: number }>`
      select business_id, count(*)::int as n from lbg.integration_calls
       where kind = 'CALL' and units > 0 and business_id in (${shop.businessId}, ${other.businessId})
       group by business_id`.execute(h.admin);
    expect(calls.rows).toEqual([{ business_id: shop.businessId, n: 1 }]);
    expect((await patch(h, `${shop.base}/integrations/${llmId}`, { monthlyUnitLimit: 1 }, shop.owner)).statusCode).toBe(
      200,
    );
    await post(h, `${shop.base}/integrations/${llmId}/test`, {}, shop.owner);
    const p = owner;
    await menu(p, 'Creative Studio');
    await p.getByLabel('Find products (name, model or SKU)').fill('P7');
    await p.getByLabel('8GB 128GB — ₹15,000.00').check();
    await p.getByRole('button', { name: 'Generate' }).click();
    await p.getByText('The monthly usage limit for this integration has been reached.').waitFor();
  }, 60_000);

  it('a signed webhook updates a delivery status; unsigned and replayed ones are rejected', async () => {
    const wa = await post(
      h,
      `${shop.base}/integrations`,
      {
        category: 'MESSAGING',
        provider: 'whatsapp_cloud',
        label: 'WhatsApp (mocked)',
        authMethod: 'BEARER',
        baseUrl: 'https://graph.facebook.com/v21.0',
        config: { phoneNumberId: '1098765432101', wabaId: '2098765432101' },
        secret: JSON.stringify(WA_SECRET),
      },
      shop.owner,
    );
    const waId = wa.json<{ integration: { id: string } }>().integration.id;
    expect(
      (await post(h, `${shop.base}/integrations/${waId}/test`, {}, shop.owner)).json<{ test: { ok: boolean } }>().test
        .ok,
    ).toBe(true);
    // A message handed to the (mocked) WhatsApp provider.
    const m = await createMessage(
      h.appDb,
      ctx(),
      { customerId: ids.asha ?? '', channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', body: 'Your phone is ready.' },
      { queue: true },
    );
    await dispatchMessage(h.appDb, ctx(), new RecordingProvider('whatsapp_cloud'), m.id);
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { statuses: [{ id: 'whatsapp_cloud-1', status: 'delivered', timestamp: ts }] } }] }],
    });
    const hook = (body: string, signature?: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/webhooks/whatsapp/${waId}`,
        headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
        payload: body,
      });
    const sig = (body: string) => `sha256=${createHmac('sha256', WA_SECRET.appSecret).update(body).digest('hex')}`;
    expect((await hook(raw)).statusCode).toBe(401);
    expect((await hook(raw, sig(raw))).json()).toMatchObject({ applied: 1 });
    expect((await hook(raw, sig(raw))).json()).toMatchObject({ applied: 0, duplicates: 1 });
    const stale = raw.replace(ts, String(Number(ts) - 900)).replace('delivered', 'read');
    expect((await hook(stale, sig(stale))).json()).toMatchObject({ applied: 0, stale: 1 });
    const msg = (await get(h, `${shop.base}/messages/${m.id}`, shop.owner)).json<{ message: { status: string } }>();
    expect(msg.message.status).toBe('DELIVERED');
    // The API Hub shows the integration as verified by that receipt.
    await menu(owner, 'API Hub');
    await expect
      .poll(async () => owner.getByRole('row', { name: /WhatsApp \(mocked\)/ }).innerText())
      .toContain('Verified');
  }, 60_000);

  it('another business sees none of it', async () => {
    const campaigns = (await get(h, `${shop.base}/campaigns`, shop.owner)).json<{ campaigns: { id: string }[] }>()
      .campaigns;
    const drafts = (await get(h, `${shop.base}/studio/drafts`, shop.owner)).json<{ drafts: { id: string }[] }>().drafts;
    for (const url of [
      `${other.base}/campaigns/${campaigns[0]?.id ?? ''}`,
      `${other.base}/studio/drafts/${drafts[0]?.id ?? ''}`,
      `${other.base}/integrations/${llmId}`,
    ]) {
      expect((await get(h, url, other.owner)).statusCode).toBe(404);
    }
    expect((await get(h, `${other.base}/campaigns`, other.owner)).json<{ campaigns: object[] }>().campaigns).toEqual(
      [],
    );
    // Not a member: the business is not found.
    expect((await get(h, `${shop.base}/campaigns`, other.owner)).statusCode).toBe(404);
  });

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(a11y.length).toBe(12); // 4 screens × 3 widths
  });
});
