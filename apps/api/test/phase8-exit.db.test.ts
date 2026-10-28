// Phase 8 exit test in a real browser (Chromium via Playwright) against the
// real API, the built web app and a migrated throwaway DB (PHASE8_PLAN §Exit),
// with mock adapters only: the mock AI adapter plays the model (scripted by
// `[[call tool {json}]]` in the question) and a recording adapter stands in
// for a messaging provider. Nothing contacts a real provider. Synthetic data.
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { runJobsOnce } from '@lbgos/modules/jobs';
import type { MessageProvider, OutboundMessage } from '@lbgos/modules/messaging';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, totp, type Harness } from './auth-harness.ts';
import { activeShop, get, patch, post, resetFixture, SHOP_PW, variant, type Shop } from './shop-fixture.ts';

const PORT = 4350;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
const SHOTS = process.env.SHOTS_DIR;
const LLM_KEY = 'p8-llm-key-SYNTHETIC-5u4t';

class RecordingProvider implements MessageProvider {
  readonly name = 'p8-adapter';
  readonly configured = true;
  readonly sent: OutboundMessage[] = [];
  send(m: OutboundMessage) {
    this.sent.push(m);
    return Promise.resolve({ ok: true as const, providerMessageId: `p8-${String(this.sent.length)}` });
  }
}

let h: Harness;
let browser: Browser;
let shop: Shop;
let other: Shop;
let owner: Page;
let llmId = '';
let cable = '';
let planId = '';
let originalPlanId = '';
const provider = new RecordingProvider();
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
    if (overflow > 0) problems.push(`${label} @${String(width)}px overflows horizontally by ${String(overflow)}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Business' }).getByRole('link', { name, exact: true }).click();
const answer = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Answer' }) });
async function ask(page: Page, agent: string, question: string) {
  await page.locator('#select-agent').selectOption(agent);
  await page.getByLabel('Your question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
  await page.getByText('The assistant has answered.').waitFor();
}
async function useModel(modelId: string) {
  await patch(h, `${shop.base}/integrations/${llmId}`, { modelId }, shop.owner);
  await post(h, `${shop.base}/integrations/${llmId}/test`, {}, shop.owner);
}
const available = async () =>
  (
    await sql<{ q: string }>`select quantity::text as q from lbg.stock_levels
      where variant_id = ${cable} and bucket = 'AVAILABLE'`.execute(h.admin)
  ).rows[0]?.q;

beforeAll(async () => {
  if (!existsSync(path.join(WEB_ROOT, 'index.html')))
    throw new Error('build the web app first: pnpm -F @lbgos/web build');
  h = await startHarness({ baseURL: ORIGIN, webRoot: WEB_ROOT, messaging: provider });
  await h.app.listen({ host: '127.0.0.1', port: PORT });
  browser = await chromium.launch();
  resetFixture();
  shop = await activeShop(h, 'p8-exit');
  other = await activeShop(h, 'p8-other');
  await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
             where business_id = ${shop.businessId}`.execute(h.admin);
  cable = await variant(h, shop, 'P8-CB', { serialized: false });
  await sql`update lbg.product_variants set reorder_level = 10 where id = ${cable}`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 5, 20000)`.execute(h.admin);
  const created = await post(
    h,
    `${shop.base}/integrations`,
    {
      category: 'LLM',
      provider: 'mock',
      label: 'Assistant model',
      authMethod: 'API_KEY',
      modelId: 'mock-agent',
      secret: LLM_KEY,
    },
    shop.owner,
  );
  llmId = created.json<{ integration: { id: string } }>().integration.id;
  await post(h, `${shop.base}/integrations/${llmId}/test`, {}, shop.owner);
  // A plan of its own for the quota display (restored in afterAll).
  originalPlanId =
    (
      await sql<{
        p: string;
      }>`select plan_id as p from lbg.subscriptions where business_id = ${shop.businessId}`.execute(h.admin)
    ).rows[0]?.p ?? '';
  planId =
    (
      await sql<{ id: string }>`insert into lbg.plans (code, name, price_paise, billing_period, limits)
        values ('P8TEST', 'Phase 8 test plan', 0, 'MONTH', '{}') returning id`.execute(h.admin)
    ).rows[0]?.id ?? '';
  await sql`update lbg.subscriptions set plan_id = ${planId} where business_id = ${shop.businessId}`.execute(h.admin);
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
  await sql`update lbg.subscriptions set plan_id = ${originalPlanId} where plan_id = ${planId}`.execute(h.admin);
  await sql`delete from lbg.plans where id = ${planId}`.execute(h.admin);
  await browser.close();
  await h.close();
});

describe('Phase 8 exit (browser)', () => {
  it('the Inventory assistant answers about low stock with facts, their period and source', async () => {
    const p = owner;
    await p.goto(`${ORIGIN}/b/${shop.businessId}`);
    await menu(p, 'Assistants');
    await p.getByRole('heading', { name: 'AI assistants' }).waitFor();
    await ask(p, 'INVENTORY', 'Which items are low? [[call low_stock {}]]');
    const a = answer(p);
    const row = a.getByRole('row', { name: /Items at or below reorder level/ });
    await expect.poll(async () => row.innerText()).toMatch(/1\s+—\s+Stock levels \(reorder level\)/);
    expect(await a.getByTestId('agent-suggestions').innerText()).toBe('Based on your records: 1.');
    expect(await a.innerText()).toContain('Completed');
    await audit(p, 'assistants');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'assistants.png'), fullPage: true });
  }, 60_000);

  it('a proposed adjustment waits for approval with its expected effect and executes once', async () => {
    const p = owner;
    await ask(
      p,
      'INVENTORY',
      `Counted the cables. [[call propose_stock_adjustment {"variantId":"${cable}","quantity":"-1","expectedAvailableAfter":"4","reason":"Shelf count found one cable less"}]]`,
    );
    const a = answer(p);
    await expect.poll(async () => a.innerText()).toContain('Awaiting approval');
    expect(await a.innerText()).toContain('Available stock of Model P8-CB goes from 5.000 to 4.000.');
    expect(await available()).toBe('5.000');
    await menu(p, 'Approvals');
    const effect = p.getByTestId('approval-effect');
    await expect
      .poll(async () => effect.innerText())
      .toBe('Expected effect: Available stock of Model P8-CB goes from 5.000 to 4.000.');
    await audit(p, 'approvals');
    await p.getByRole('button', { name: 'Approve' }).click();
    await p.getByText('Approved and carried out.').waitFor();
    expect(await available()).toBe('4.000');
    await menu(p, 'Assistants');
    await p
      .getByRole('button', { name: /^Show answer/ })
      .first()
      .click();
    await p.getByRole('button', { name: 'Continue after the decision' }).click();
    await p.getByText('Checked the decision.').waitFor();
    await expect.poll(async () => answer(p).innerText()).toContain('Completed');
    expect(await available()).toBe('4.000');
  }, 90_000);

  it('a wrong model-supplied quantity and a forged business ID are refused by the tools', async () => {
    const p = owner;
    await ask(
      p,
      'INVENTORY',
      `[[call propose_stock_adjustment {"variantId":"${cable}","quantity":"-1","expectedAvailableAfter":"10","reason":"Shelf count found one cable less"}]]`,
    );
    await answer(p).getByText('Steps (3)').click();
    await answer(p).getByText('refused (VALUE_MISMATCH)').waitFor();
    await ask(p, 'INVENTORY', `[[call stock_levels {"businessId":"${other.businessId}"}]]`);
    await answer(p).getByText('Steps (3)').click();
    await answer(p).getByText('refused (FOREIGN_SCOPE)').waitFor();
    expect(await available()).toBe('4.000');
  }, 60_000);

  it('limits stop a run, a waiting run can be cancelled, and the daily budget stops further runs', async () => {
    const p = owner;
    await useModel('mock-agent-loop');
    await ask(p, 'INVENTORY', 'Keep checking');
    // The mock model's cost grows with the history, so the run budget is reached before 20 tool calls
    // (the tool-call limit itself: agents.db.test.ts, TR-0040 #5).
    await expect.poll(async () => answer(p).innerText()).toContain('Run budget of 4000 units reached.');
    expect(await answer(p).innerText()).toContain('Limit reached');
    await useModel('mock-agent');
    await ask(
      p,
      'INVENTORY',
      `[[call propose_stock_adjustment {"variantId":"${cable}","quantity":"-1","expectedAvailableAfter":"3","reason":"Shelf count found one cable less"}]]`,
    );
    await p.getByRole('button', { name: 'Cancel this run' }).click();
    await p.getByText('Cancelled.').waitFor();
    await expect.poll(async () => answer(p).innerText()).toContain('Cancelled by the user.');
    await sql`update lbg.business_settings set agent_daily_unit_limit = 1 where business_id = ${shop.businessId}`.execute(
      h.admin,
    );
    await ask(p, 'GROWTH', 'Overview please');
    await expect.poll(async () => answer(p).innerText()).toContain('Daily assistant budget of 1 units reached.');
    await sql`update lbg.business_settings set agent_daily_unit_limit = 20000 where business_id = ${shop.businessId}`.execute(
      h.admin,
    );
  }, 90_000);

  it('the job runner sends a due scheduled campaign; usage against the plan shows the 80 % alert', async () => {
    const c = await post(
      h,
      `${shop.base}/customers`,
      { name: 'P8 customer (synthetic)', mobile: '9863000001', tags: ['VIP'] },
      shop.owner,
    );
    const customerId = c.json<{ customer: { id: string } }>().customer.id;
    await post(
      h,
      `${shop.base}/customers/${customerId}/consents`,
      { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
      shop.owner,
    );
    const camp = (
      await post(
        h,
        `${shop.base}/campaigns`,
        { name: 'Night sale', channel: 'WHATSAPP', body: 'Night sale on covers (synthetic).', segmentTags: ['VIP'] },
        shop.owner,
      )
    ).json<{ campaign: { id: string; contentSha256: string } }>().campaign;
    await post(h, `${shop.base}/campaigns/${camp.id}/submit`, {}, shop.owner);
    await post(h, `${shop.base}/campaigns/${camp.id}/approve`, { contentSha256: camp.contentSha256 }, shop.owner);
    const at = new Date(Date.now() + 3_600_000);
    await post(h, `${shop.base}/campaigns/${camp.id}/schedule`, { at: at.toISOString() }, shop.owner);
    await runJobsOnce({ appDb: h.appDb, provider: () => Promise.resolve(provider) }, new Date(at.getTime() + 60_000));
    expect(provider.sent.map((m) => m.body)).toEqual(['Night sale on covers (synthetic).']);
    // A plan allowance such that this month's AI use is between 80 % and 100 %.
    const used = Number(
      (
        await sql<{ n: string }>`select coalesce(sum(units), 0)::text as n from lbg.integration_calls
          where business_id = ${shop.businessId} and kind = 'CALL'`.execute(h.admin)
      ).rows[0]?.n ?? 0,
    );
    await sql`update lbg.plans set limits = ${JSON.stringify({ aiUnitsPerMonth: Math.ceil(used / 0.9) })}::jsonb
               where id = ${planId}`.execute(h.admin);
    const p = owner;
    await menu(p, 'Usage and monitoring');
    await p.getByRole('heading', { name: 'Usage and monitoring' }).waitFor();
    await expect.poll(async () => p.getByTestId('usage-AI').innerText()).toMatch(/(8\d|9\d) % used/);
    await expect.poll(async () => p.getByRole('row', { name: /Scheduled campaigns/ }).innerText()).toMatch(/Done\s+1/);
    await audit(p, 'usage and monitoring');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'usage.png'), fullPage: true });
    await menu(p, 'Reports');
    await p.getByRole('heading', { name: 'Campaign results' }).waitFor();
    await expect
      .poll(async () => p.getByRole('row', { name: /Night sale/ }).innerText())
      .toMatch(/1\s+1\s+0\s+0\s+0\s+0$/);
    await audit(p, 'reports');
  }, 90_000);

  it('run records hold no secret or full mobile number; another business sees none of it', async () => {
    const p = owner;
    await menu(p, 'Assistants');
    await ask(p, 'CRM', 'Call +91 98765 43210 about dues [[call receivables {}]]');
    await expect.poll(async () => answer(p).innerText()).toContain('Question: Call [number] about dues');
    const stored = await sql<{ t: string }>`
      select coalesce((select string_agg(r::text, ' ') from lbg.agent_runs r where r.business_id = ${shop.businessId}), '')
          || coalesce((select string_agg(s::text, ' ') from lbg.agent_steps s where s.business_id = ${shop.businessId}), '') as t`.execute(
      h.admin,
    );
    expect(stored.rows[0]?.t).not.toContain('98765');
    expect(stored.rows[0]?.t).not.toContain(LLM_KEY);
    const runs = (await get(h, `${shop.base}/agents/runs`, shop.owner)).json<{ runs: { id: string }[] }>().runs;
    expect((await get(h, `${other.base}/agents/runs/${runs[0]?.id ?? ''}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/agents/runs`, other.owner)).json<{ runs: object[] }>().runs).toEqual([]);
    expect((await get(h, `${shop.base}/usage`, other.owner)).statusCode).toBe(404);
  }, 60_000);

  it('no CSP violations, page errors, horizontal overflow or serious accessibility issues', () => {
    expect(problems).toEqual([]);
    expect(a11y.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(a11y.length).toBe(12); // 4 screens × 3 widths
  });
});
