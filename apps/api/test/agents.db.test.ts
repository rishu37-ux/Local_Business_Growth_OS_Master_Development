// Increments 8.1–8.3: the agent runtime, tools, the five assistants and
// approval of their proposals (FR-AGT-1…6, FR-RPT-5, WORKFLOWS §11–12,
// D-061). The mock AI adapter plays the model (its replies are scripted by
// `[[call tool {json}]]` in the question); nothing contacts a real provider.
// Synthetic data only.
import { startRun, type AgentDeps } from '@lbgos/modules/agents';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  patch,
  post,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

const LLM_KEY = 'agent-llm-key-SYNTHETIC-9z8y';

interface Step {
  seq: number;
  kind: string;
  tool: string | null;
  arguments: unknown;
  result: { facts?: { label: string; value: string }[]; proposal?: { id: string; effect: string } } | null;
  errorCode: string | null;
  approvalId: string | null;
}
interface Run {
  id: string;
  status: string;
  statusReason: string | null;
  question: string;
  usage: { toolCalls: number; modelCalls: number; units: number };
  answer: {
    facts: { label: string; value: string; period?: string; source: string }[];
    suggestions: string;
    flags: { kind: string; text: string }[];
    proposals: { kind: string; id: string; effect: string }[];
  } | null;
  steps: Step[];
}

let h: Harness;
let shop: Shop;
let other: Shop;
let manager: Session;
let billing: Session;
let llmId = '';
let cable = '';
let keySeq = 0;

const key = () => `test-run-${String(++keySeq).padStart(4, '0')}`;
const ask = (agent: string, question: string, who: Session = manager, idempotencyKey = key()) =>
  post(h, `${shop.base}/agents/runs`, { agent, question, idempotencyKey }, who);
const runOf = (res: { json: () => unknown }) => (res.json() as { run: Run }).run;
const deps = (): AgentDeps => ({
  appDb: h.appDb,
  secrets: h.keyring ? { db: h.secretsDb, keyring: h.keyring } : null,
  allowMocks: true,
  retryBaseMs: 1,
  storage: h.ocr,
});
const managerCtx = () => ({ businessId: shop.businessId, userId: managerId });
let managerId = '';
const ALL = new Set(['inventory.view', 'inventory.adjust.request', 'reports.sales.view']);
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
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'agt-a');
  other = await activeShop(h, 'agt-b');
  const m = await staff(h, shop, 'agt-manager@example.test', 'Manager');
  manager = m.session;
  managerId =
    (await sql<{ id: string }>`select id from auth."user" where email = 'agt-manager@example.test'`.execute(h.admin))
      .rows[0]?.id ?? '';
  billing = (await staff(h, shop, 'agt-billing@example.test', 'Billing')).session;
  cable = await variant(h, shop, 'AGT-CB', { serialized: false });
  await sql`update lbg.product_variants set reorder_level = 10 where id = ${cable}`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 5, 20000)`.execute(h.admin);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('runtime (FR-AGT-3, -5, -6, WORKFLOWS §12)', () => {
  it('without a tested AI integration a run fails and says so', async () => {
    const run = runOf(await ask('INVENTORY', 'What is low?'));
    expect(run).toMatchObject({ status: 'FAILED', statusReason: 'No tested AI integration.' });
    expect((await ask('INVENTORY', 'x', billing)).statusCode).toBe(201); // Billing holds agents.use
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
  });

  it('answers with facts from tools (period and source) separate from the model suggestions', async () => {
    const res = await ask('FINANCE', 'How were sales today? [[call sales_summary {"period":"day"}]]');
    expect(res.statusCode).toBe(201);
    const run = runOf(res);
    expect(run.status).toBe('COMPLETED');
    expect(run.steps.map((s) => [s.kind, s.tool])).toEqual([
      ['MODEL', null],
      ['TOOL', 'sales_summary'],
      ['MODEL', null],
    ]);
    const net = run.answer?.facts.find((f) => f.label === 'Net sales');
    expect(net).toMatchObject({ value: '₹0.00', source: 'Sales summary report' });
    expect(net?.period).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    expect(run.answer?.suggestions).toBe('Based on your records: ₹0.00.');
    expect(run.answer?.flags).toEqual([]);
    expect(run.usage).toMatchObject({ toolCalls: 1, modelCalls: 2 });
    expect(run.usage.units).toBeGreaterThan(0);
    const calls = await sql<{ n: number }>`select count(*)::int as n from lbg.integration_calls
      where integration_id = ${llmId} and purpose = 'agent.step' and kind = 'CALL'`.execute(h.admin);
    expect(calls.rows[0]?.n).toBe(2);
    // The same idempotency key returns the same run and runs nothing again.
    const k = key();
    const first = runOf(await ask('GROWTH', 'Overview please', manager, k));
    const again = runOf(await ask('GROWTH', 'Overview please', manager, k));
    expect(again.id).toBe(first.id);
    expect(again.steps.length).toBe(first.steps.length);
  });

  it('a tool needs the user’s own permission; another business, bad arguments and other agents’ tools are refused', async () => {
    const denied = runOf(await ask('FINANCE', '[[call sales_summary {"period":"day"}]]', billing));
    expect(denied.steps.find((s) => s.kind === 'TOOL')).toMatchObject({
      tool: 'sales_summary',
      errorCode: 'FORBIDDEN',
    });
    expect(denied.answer?.facts).toEqual([]);
    const forged = runOf(await ask('INVENTORY', `[[call stock_levels {"businessId":"${other.businessId}"}]]`));
    expect(forged.steps.find((s) => s.kind === 'TOOL')?.errorCode).toBe('FOREIGN_SCOPE');
    const bad = runOf(await ask('FINANCE', '[[call sales_summary {"period":"decade"}]]'));
    expect(bad.steps.find((s) => s.kind === 'TOOL')?.errorCode).toBe('INVALID_ARGUMENTS');
    const foreign = runOf(await ask('INVENTORY', '[[call sales_summary {"period":"day"}]]'));
    expect(foreign.steps.find((s) => s.kind === 'TOOL')?.errorCode).toBe('UNKNOWN_TOOL');
  });

  it('limits stop a run as LIMIT_REACHED: tool calls, time, run budget and the daily budget', async () => {
    await useModel('mock-agent-loop');
    const loop = await startRun(deps(), managerCtx(), ALL, {
      agent: 'INVENTORY',
      question: 'loop',
      idempotencyKey: key(),
      limits: { maxToolCalls: 3 },
    });
    expect(loop).toMatchObject({ status: 'LIMIT_REACHED', statusReason: 'Tool call limit of 3 reached.' });
    expect(loop.usage.toolCalls).toBe(3);
    let t = Date.now();
    const clock = () => new Date((t += 61_000));
    const slow = await startRun({ ...deps(), now: clock }, managerCtx(), ALL, {
      agent: 'INVENTORY',
      question: 'loop',
      idempotencyKey: key(),
      limits: { timeoutSeconds: 120 },
    });
    expect(slow).toMatchObject({ status: 'LIMIT_REACHED', statusReason: 'Time limit of 120 s reached.' });
    const small = await startRun(deps(), managerCtx(), ALL, {
      agent: 'INVENTORY',
      question: 'loop',
      idempotencyKey: key(),
      limits: { budgetUnits: 5 },
    });
    expect(small).toMatchObject({ status: 'LIMIT_REACHED', statusReason: 'Run budget of 5 units reached.' });
    await sql`update lbg.business_settings set agent_daily_unit_limit = 1 where business_id = ${shop.businessId}`.execute(
      h.admin,
    );
    try {
      const daily = runOf(await ask('INVENTORY', 'anything'));
      expect(daily).toMatchObject({
        status: 'LIMIT_REACHED',
        statusReason: 'Daily assistant budget of 1 units reached.',
      });
      expect(daily.usage.modelCalls).toBe(0);
    } finally {
      await sql`update lbg.business_settings set agent_daily_unit_limit = 20000 where business_id = ${shop.businessId}`.execute(
        h.admin,
      );
    }
  });

  it('invalid model output is retried up to the limit, then the run fails; invented figures are flagged', async () => {
    await useModel('mock-agent-bad');
    const bad = runOf(await ask('INVENTORY', 'anything'));
    expect(bad).toMatchObject({
      status: 'FAILED',
      statusReason: 'The assistant gave 4 answers that were not valid steps.',
    });
    expect(bad.steps.filter((s) => s.errorCode === 'INVALID_OUTPUT').length).toBe(4);
    await useModel('mock-agent-invent');
    const invent = runOf(await ask('FINANCE', '[[call sales_summary {"period":"day"}]]'));
    expect(invent.answer?.flags).toEqual([{ kind: 'PRICE', text: '₹99,999' }]);
    await useModel('mock-agent');
  });
});

describe('proposals and approval (FR-AGT-2, -4, WORKFLOWS §11)', () => {
  const propose = (expected: string, who: Session = manager) =>
    ask(
      'INVENTORY',
      `Counted the cables. [[call propose_stock_adjustment {"variantId":"${cable}","quantity":"-1","expectedAvailableAfter":"${expected}","reason":"Shelf count found one cable less"}]]`,
      who,
    );

  it('a wrong model-supplied quantity is rejected by the tool and nothing is proposed', async () => {
    const run = runOf(await propose('10'));
    const step = run.steps.find((s) => s.tool === 'propose_stock_adjustment');
    expect(step).toMatchObject({ kind: 'TOOL', errorCode: 'VALUE_MISMATCH', approvalId: null });
    expect(run.status).toBe('COMPLETED');
    const n = await sql<{ n: number }>`select count(*)::int as n from lbg.approval_requests
      where business_id = ${shop.businessId} and action_type = 'inventory.adjustment'`.execute(h.admin);
    expect(n.rows[0]?.n).toBe(0);
  });

  it('a correct proposal waits for approval with its expected effect, then executes once', async () => {
    const run = runOf(await propose('4'));
    expect(run).toMatchObject({
      status: 'AWAITING_APPROVAL',
      statusReason: 'Available stock of Model AGT-CB goes from 5.000 to 4.000.',
    });
    const step = run.steps.find((s) => s.kind === 'PROPOSAL');
    const approvalId = step?.approvalId ?? '';
    const req = (await get(h, `${shop.base}/approvals`, shop.owner))
      .json<{
        requests: { id: string; effect: string | null; payloadSha256: string; status: string }[];
      }>()
      .requests.find((r) => r.id === approvalId);
    expect(req).toMatchObject({
      status: 'PENDING',
      effect: 'Available stock of Model AGT-CB goes from 5.000 to 4.000.',
    });
    // Nothing executed yet; continuing while pending does nothing.
    expect(await available()).toBe('5.000');
    expect(runOf(await post(h, `${shop.base}/agents/runs/${run.id}/resume`, {}, manager)).status).toBe(
      'AWAITING_APPROVAL',
    );
    const decided = await post(
      h,
      `${shop.base}/approvals/${approvalId}/decide`,
      { approve: true, payloadSha256: req?.payloadSha256 ?? '' },
      shop.owner,
    );
    expect(decided.json<{ request: { status: string } }>().request.status).toBe('EXECUTED');
    expect(await available()).toBe('4.000');
    const done = runOf(await post(h, `${shop.base}/agents/runs/${run.id}/resume`, {}, manager));
    expect(done.status).toBe('COMPLETED');
    expect(done.steps.find((s) => s.kind === 'DECISION')?.result).toMatchObject({ status: 'EXECUTED' });
    expect(done.answer?.proposals).toEqual([
      { kind: 'APPROVAL_REQUEST', id: approvalId, effect: 'Available stock of Model AGT-CB goes from 5.000 to 4.000.' },
    ]);
    // Continuing again changes nothing; the stock moved once.
    expect(runOf(await post(h, `${shop.base}/agents/runs/${run.id}/resume`, {}, manager)).steps.length).toBe(
      done.steps.length,
    );
    expect(await available()).toBe('4.000');
  });

  it('a user cancels a waiting run and its proposal is withdrawn; only the run’s user may', async () => {
    const run = runOf(await propose('3'));
    expect(run.status).toBe('AWAITING_APPROVAL');
    expect((await post(h, `${shop.base}/agents/runs/${run.id}/cancel`, {}, billing)).statusCode).toBe(404);
    const cancelled = runOf(await post(h, `${shop.base}/agents/runs/${run.id}/cancel`, {}, manager));
    expect(cancelled).toMatchObject({ status: 'CANCELLED', statusReason: 'Cancelled by the user.' });
    const approval = await sql<{ status: string }>`select status from lbg.approval_requests
      where id = ${run.steps.find((s) => s.kind === 'PROPOSAL')?.approvalId ?? ''}`.execute(h.admin);
    expect(approval.rows[0]?.status).toBe('CANCELLED');
    expect(errorCode(await post(h, `${shop.base}/agents/runs/${run.id}/cancel`, {}, manager))).toBe('INVALID_STATE');
  });
});

describe('records, redaction and access (FR-AGT-6)', () => {
  it('runs keep masked questions and no secrets or contact details', async () => {
    const run = runOf(
      await ask(
        'CRM',
        'Call Asha on +91 98765 43210 or asha.synthetic@example.test about her dues [[call receivables {}]]',
      ),
    );
    expect(run.question).toBe('Call Asha on [number] or [email] about her dues [[call receivables {}]]');
    const stored = await sql<{ t: string }>`
      select coalesce(string_agg(r::text, ' '), '') || ' ' || coalesce((select string_agg(s::text, ' ') from lbg.agent_steps s
               where s.business_id = ${shop.businessId}), '') as t
        from lbg.agent_runs r where r.business_id = ${shop.businessId}`.execute(h.admin);
    const text = stored.rows[0]?.t ?? '';
    expect(text).not.toContain('98765');
    expect(text).not.toContain('asha.synthetic');
    expect(text).not.toContain(LLM_KEY);
    const audit = await sql<{
      m: string;
    }>`select metadata::text as m from lbg.audit_events where business_id = ${shop.businessId}`.execute(h.admin);
    expect(audit.rows.some((r) => r.m.includes('SYNTHETIC'))).toBe(false);
    expect(h.logs.text).not.toContain(LLM_KEY);
  });

  it('other businesses and other users do not see runs; read-only mode cannot start one', async () => {
    const mine = runOf(await ask('GROWTH', 'Overview'));
    expect((await get(h, `${other.base}/agents/runs/${mine.id}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/agents/runs/${mine.id}`, billing)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/agents/runs/${mine.id}`, shop.owner)).statusCode).toBe(200); // audit.view
    const list = (await get(h, `${shop.base}/agents/runs`, billing)).json<{ runs: Run[] }>().runs;
    expect(list.every((r) => r.id !== mine.id)).toBe(true);
    const catalogue = (await get(h, `${shop.base}/agents`, billing)).json<{
      agents: { key: string; tools: { name: string; allowed: boolean }[] }[];
      configured: boolean;
    }>();
    expect(catalogue.agents.map((a) => a.key)).toEqual(['INVENTORY', 'FINANCE', 'CRM', 'MARKETING', 'GROWTH']);
    expect(
      catalogue.agents.find((a) => a.key === 'FINANCE')?.tools.find((t) => t.name === 'sales_summary')?.allowed,
    ).toBe(false);
    expect(catalogue.configured).toBe(true);
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    try {
      // Suspended: the owner keeps read-only access (staff have none).
      expect(errorCode(await ask('GROWTH', 'Overview', shop.owner))).toBe('TENANT_READ_ONLY');
      expect((await get(h, `${shop.base}/agents/runs`, shop.owner)).statusCode).toBe(200);
    } finally {
      await sql`update lbg.businesses set status = 'ACTIVE' where id = ${shop.businessId}`.execute(h.admin);
    }
  });

  it('the database keeps runs and steps honest', async () => {
    const run = runOf(await ask('GROWTH', 'Overview'));
    await expect(
      sql`update lbg.agent_runs set status = 'RUNNING' where id = ${run.id}`.execute(h.admin),
    ).rejects.toMatchObject({
      code: 'LB003',
    });
    await expect(sql`delete from lbg.agent_runs where id = ${run.id}`.execute(h.admin)).rejects.toMatchObject({
      code: 'LB001',
    });
    await expect(
      sql`update lbg.agent_steps set units = 0 where run_id = ${run.id}`.execute(h.admin),
    ).rejects.toMatchObject({
      code: 'LB001',
    });
    await expect(
      sql`insert into lbg.agent_runs (business_id, agent, user_id, idempotency_key, question, status)
          values (${shop.businessId}, 'GROWTH', ${managerId}, 'direct-insert-1', 'x', 'COMPLETED')`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB002' });
  });
});
