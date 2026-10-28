// Increment 9.1: tenant-isolation sweep (NFR-4, T1, PHASE9_PLAN). Every
// registered route is taken from the running app's route table (not a
// hand-kept list) and called (1) by the owner of another business with this
// business's ID, (2) by that owner under their own business but with this
// business's record IDs, (3) signed out; platform routes by a shop owner.
// No call may return this business's data, and none may fail with 5xx.
// The database check: every tenant table has forced row-level security.
// Synthetic data only.
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshIp, startHarness, type Harness } from './auth-harness.ts';
import { activeShop, post, resetFixture, variant, type Session, type Shop } from './shop-fixture.ts';

const MARK = 'ISOSWEEP-A';
let h: Harness;
let a: Shop;
let b: Shop;
/** Path segment before `:id` → IDs of business A's records of that kind. */
const idsBySegment = new Map<string, string[]>();
let allIds: string[] = [];

const TABLE_FOR_SEGMENT: Readonly<Record<string, string>> = {
  customers: 'customers',
  products: 'products',
  variants: 'product_variants',
  suppliers: 'suppliers',
  purchases: 'purchases',
  invoices: 'invoices',
  sales: 'invoices',
  payments: 'payments',
  messages: 'messages',
  campaigns: 'campaigns',
  offers: 'offers',
  drafts: 'creative_drafts',
  integrations: 'integrations',
  secrets: 'integration_secrets',
  runs: 'agent_runs',
  approvals: 'approval_requests',
  units: 'serialized_units',
  expenses: 'expenses',
  members: 'memberships',
  roles: 'roles',
  scans: 'ocr_jobs',
  uploads: 'uploads',
  'tax-rates': 'tax_rates',
  movements: 'stock_movements',
  reminders: 'reminders',
  channels: 'sales_channels',
  'channel-orders': 'channel_orders',
  grants: 'support_grants',
};

function fill(url: string, businessId: string): string {
  const parts = url.split('/');
  return parts
    .map((p, i) => {
      if (p === ':businessId') return businessId;
      if (!p.startsWith(':')) return p;
      if (p === ':report') return 'sales-summary';
      if (p === ':type') return 'customers';
      const seg = parts[i - 1] ?? '';
      const ids = idsBySegment.get(seg) ?? allIds;
      return ids[0] ?? '00000000-0000-4000-8000-000000000000';
    })
    .join('/');
}

async function call(method: string, url: string, who: Session | null) {
  return h.app.inject({
    method: method as 'GET',
    url,
    // A new address per call: the per-IP auth rate limit must not turn the sweep into a wall of
    // 401s that proves nothing (found while building this test).
    remoteAddress: freshIp(),
    headers: {
      origin: h.origin,
      ...(who
        ? {
            cookie: Object.entries(who)
              .map(([k, v]) => `${k}=${v}`)
              .join('; '),
          }
        : {}),
      ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' || method === 'DELETE' ? {} : { payload: '{}' }),
  });
}

const businessRoutes = () =>
  h.app.routeIndex.filter(
    (r) => r.url.startsWith('/api/businesses/:businessId') && r.method !== 'HEAD' && r.method !== 'OPTIONS',
  );

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  a = await activeShop(h, 'iso-a');
  b = await activeShop(h, 'iso-b');
  // Business A gets records of many kinds, each carrying the marker where text is free.
  const ctx = { businessId: a.businessId, userId: a.ownerId };
  const cust = await post(
    h,
    `${a.base}/customers`,
    { name: `${MARK} customer`, mobile: '9864000001', tags: ['VIP'] },
    a.owner,
  );
  const customerId = cust.json<{ customer: { id: string } }>().customer.id;
  const v = await variant(h, a, 'ISO-CB', { serialized: false });
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${a.businessId}, ${v}, 'OPENING', 5, 20000)`.execute(h.admin);
  const access = { discount: { limits: undefined }, priceOverride: true };
  const draft = await createSaleDraft(h.appDb, ctx, access, { customerId, lines: [{ variantId: v, quantity: '1' }] });
  await issueSale(h.appDb, ctx, access, draft.id, {
    expectedTotalPaise: draft.totals.totalPaise,
    payments: [{ method: 'CASH', amountPaise: draft.totals.totalPaise, reference: null }],
  });
  await post(h, `${a.base}/suppliers`, { name: `${MARK} supplier` }, a.owner);
  await post(
    h,
    `${a.base}/messages`,
    { customerId, channel: 'WHATSAPP', purpose: 'MARKETING', body: `${MARK} message` },
    a.owner,
  );
  await post(
    h,
    `${a.base}/campaigns`,
    { name: `${MARK} campaign`, channel: 'WHATSAPP', body: `${MARK} text`, segmentTags: ['VIP'] },
    a.owner,
  );
  await post(
    h,
    `${a.base}/offers`,
    {
      title: `${MARK} offer`,
      discountKind: 'PERCENT',
      discountValue: 1000,
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    },
    a.owner,
  );
  await post(
    h,
    `${a.base}/integrations`,
    {
      category: 'LLM',
      provider: 'mock',
      label: `${MARK} integration`,
      authMethod: 'API_KEY',
      secret: 'iso-key-SYNTHETIC-0000',
    },
    a.owner,
  );
  await post(
    h,
    `${a.base}/agents/runs`,
    { agent: 'GROWTH', question: `${MARK} question`, idempotencyKey: 'iso-run-0001' },
    a.owner,
  );
  const integ = await post(
    h,
    `${a.base}/integrations`,
    { category: 'MARKETPLACE', provider: 'mock', label: `${MARK} marketplace`, authMethod: 'NONE' },
    a.owner,
  );
  const integId = integ.json<{ integration: { id: string } }>().integration.id;
  await post(h, `${a.base}/integrations/${integId}/test`, {}, a.owner);
  await post(h, `${a.base}/channels`, { name: `${MARK} channel`, integrationId: integId }, a.owner);
  const site = (
    await h.app.inject({
      method: 'GET',
      url: `${a.base}/channels`,
      remoteAddress: freshIp(),
      headers: {
        cookie: Object.entries(a.owner)
          .map(([k, val]) => `${k}=${val}`)
          .join('; '),
      },
    })
  )
    .json<{ channels: { id: string; kind: string }[] }>()
    .channels.find((c) => c.kind === 'WEBSITE');
  await sql`insert into lbg.channel_listings (business_id, channel_id, variant_id, external_sku)
            values (${a.businessId}, ${site?.id ?? ''}, ${v}, 'ISO-WEB-1')`.execute(h.admin);
  await sql`insert into lbg.channel_orders (business_id, channel_id, external_order_id, customer_name)
            values (${a.businessId}, ${site?.id ?? ''}, 'ISO-ORDER-1', ${`${MARK} buyer`})`.execute(h.admin);
  await post(h, `${a.base}/support/grants`, { purpose: `${MARK} support check`, hours: 1 }, a.owner);
  const all: string[] = [];
  for (const [seg, table] of Object.entries(TABLE_FOR_SEGMENT)) {
    const { rows } = await sql<{ id: string }>`select id::text as id from ${sql.table(`lbg.${table}`)}
       where business_id = ${a.businessId} order by id limit 5`.execute(h.admin);
    idsBySegment.set(
      seg,
      rows.map((r) => r.id),
    );
    all.push(...rows.map((r) => r.id));
  }
  allIds = [...new Set(all)];
}, 240_000);
afterAll(async () => {
  await h.close();
});

describe('tenant-isolation sweep (NFR-4, T1)', () => {
  it('covers every business route of the app', () => {
    const routes = businessRoutes();
    expect(routes.length).toBeGreaterThan(150);
    expect(allIds.length).toBeGreaterThan(15);
  });

  it("another business's owner gets no 2xx and no data on this business's URLs", async () => {
    const leaks: string[] = [];
    for (const r of businessRoutes()) {
      const res = await call(r.method, fill(r.url, a.businessId), b.owner);
      // A 401 would mean the session was not checked at all; the gate must answer the signed-in user.
      if (res.statusCode < 400 || res.statusCode === 401 || res.statusCode >= 500 || res.body.includes(MARK)) {
        leaks.push(`${r.method} ${r.url} → ${String(res.statusCode)}`);
      }
    }
    expect(leaks).toEqual([]);
  }, 300_000);

  it("this business's record IDs under another business's URL reveal nothing and never fail with 5xx", async () => {
    const leaks: string[] = [];
    for (const r of businessRoutes()) {
      const res = await call(r.method, fill(r.url, b.businessId), b.owner);
      const leaked = res.body.includes(MARK) || allIds.some((id) => res.body.includes(id));
      if (leaked || res.statusCode === 401 || res.statusCode >= 500)
        leaks.push(`${r.method} ${r.url} → ${String(res.statusCode)}${leaked ? ' (data)' : ''}`);
    }
    expect(leaks).toEqual([]);
  }, 300_000);

  it('signed out, every non-public route answers 401; a shop owner cannot use platform routes', async () => {
    const open: string[] = [];
    const publicPrefixes = ['/healthz', '/readyz', '/api/webhooks/', '/api/auth/'];
    for (const r of h.app.routeIndex) {
      if (r.method === 'HEAD' || r.method === 'OPTIONS' || !r.url.startsWith('/api/')) continue;
      if (publicPrefixes.some((p) => r.url.startsWith(p))) continue;
      const res = await call(r.method, fill(r.url, a.businessId), null);
      if (res.statusCode !== 401) open.push(`${r.method} ${r.url} → ${String(res.statusCode)}`);
    }
    const platform: string[] = [];
    for (const r of h.app.routeIndex.filter((x) => x.url.startsWith('/api/platform/') && x.method !== 'HEAD')) {
      const res = await call(r.method, fill(r.url, a.businessId), a.owner);
      if (res.statusCode !== 403) platform.push(`${r.method} ${r.url} → ${String(res.statusCode)}`);
    }
    expect({ open, platform }).toEqual({ open: [], platform: [] });
  }, 300_000);

  it('every tenant table has row-level security enabled and forced, with a policy', async () => {
    const { rows } = await sql<{ t: string }>`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'lbg' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped)
         and (not c.relrowsecurity or not c.relforcerowsecurity
              or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
       order by 1`.execute(h.admin);
    expect(rows.map((r) => r.t)).toEqual([]);
    const counted = await sql<{ n: number }>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'lbg' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id')`.execute(
      h.admin,
    );
    expect(counted.rows[0]?.n).toBeGreaterThanOrEqual(60);
  });
});
