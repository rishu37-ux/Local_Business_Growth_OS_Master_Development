// Increment 8.5: advanced analytics (FR-RPT-1 remainder, FR-RPT-2, FR-RPT-4,
// D-063) with exact values on a seeded dataset. A recording test adapter
// stands in for a messaging provider. Synthetic data only.
import { launchCampaign } from '@lbgos/modules/campaigns';
import { recordProviderStatus, type MessageProvider, type OutboundMessage } from '@lbgos/modules/messaging';
import { createSaleDraft, issueSale } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import { activeShop, get, post, resetFixture, staff, variant, type Session, type Shop } from './shop-fixture.ts';

class RecordingProvider implements MessageProvider {
  readonly name = 'analytics-adapter';
  readonly configured = true;
  send(m: OutboundMessage) {
    return Promise.resolve({ ok: true as const, providerMessageId: `an-${m.messageId}` });
  }
}

const ACCESS = { discount: { limits: undefined }, priceOverride: true };
let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let cable = '';
const ids: Record<string, string> = {};
const ctx = () => ({ businessId: shop.businessId, userId: shop.ownerId });
const SEPT = 'period=custom&from=2026-09-01&to=2026-09-30';

async function sellOn(date: string, customerId: string | null) {
  const at = new Date(`${date}T06:30:00Z`);
  const draft = await createSaleDraft(
    h.appDb,
    ctx(),
    ACCESS,
    { ...(customerId ? { customerId } : {}), lines: [{ variantId: cable, quantity: '1' }] },
    at,
  );
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
}

beforeAll(async () => {
  h = await startHarness({ messaging: new RecordingProvider() });
  resetFixture();
  shop = await activeShop(h, 'ana-a');
  other = await activeShop(h, 'ana-b');
  billing = (await staff(h, shop, 'ana-billing@example.test', 'Billing')).session;
  await sql`update lbg.business_settings set quiet_start_minute = 0, quiet_end_minute = 1440
             where business_id = ${shop.businessId}`.execute(h.admin);
  cable = await variant(h, shop, 'ANA-CB', { serialized: false }); // ₹1,000, no tax rate
  await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${cable}, 'OPENING', 20, 40000)`.execute(h.admin);
  for (const [key, mobile] of [
    ['asha', '9862000001'],
    ['bilal', '9862000002'],
  ] as const) {
    const res = await post(
      h,
      `${shop.base}/customers`,
      { name: `${key} (synthetic)`, mobile, tags: ['VIP'] },
      shop.owner,
    );
    ids[key] = res.json<{ customer: { id: string } }>().customer.id;
  }
  // September 2026: Asha twice, Bilal once, one walk-in sale; Bilal again in October.
  await sellOn('2026-09-02', ids.asha ?? '');
  await sellOn('2026-09-10', ids.bilal ?? '');
  await sellOn('2026-09-15', null);
  await sellOn('2026-09-20', ids.asha ?? '');
  await sellOn('2026-10-05', ids.bilal ?? '');
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('advanced analytics (FR-RPT-1)', () => {
  it('weekly net sales over the shop’s weeks (Monday start)', async () => {
    const r = (await get(h, `${shop.base}/reports/sales-trend?weeks=3&date=2026-09-20`, shop.owner)).json<{
      report: {
        period: { from: string; to: string };
        weeks: { weekStart: string; weekEnd: string; invoiceCount: number; netSalesPaise: number }[];
        definitions: Record<string, { label: string }>;
      };
    }>().report;
    expect(r.period).toEqual({ from: '2026-08-31', to: '2026-09-20' });
    expect(r.weeks).toEqual([
      { weekStart: '2026-08-31', weekEnd: '2026-09-06', invoiceCount: 1, netSalesPaise: 100_000 },
      { weekStart: '2026-09-07', weekEnd: '2026-09-13', invoiceCount: 1, netSalesPaise: 100_000 },
      { weekStart: '2026-09-14', weekEnd: '2026-09-20', invoiceCount: 2, netSalesPaise: 200_000 },
    ]);
    expect(r.definitions.salesTrend?.label).toBe('Weekly net sales');
  });

  it('repeat-customer rate counts named customers only', async () => {
    const r = (await get(h, `${shop.base}/reports/repeat-customers?${SEPT}`, shop.owner)).json<{
      report: {
        buyers: number;
        repeatBuyers: number;
        repeatRateBp: number | null;
        definitions: Record<string, { definition: string }>;
      };
    }>().report;
    expect(r).toMatchObject({ buyers: 2, repeatBuyers: 1, repeatRateBp: 5000 });
    expect(r.definitions.repeatCustomerRate?.definition).toMatch(/Walk-in sales without a customer are not counted/);
    const oct = (
      await get(h, `${shop.base}/reports/repeat-customers?period=custom&from=2026-10-01&to=2026-10-31`, shop.owner)
    ).json<{
      report: { buyers: number; repeatRateBp: number | null };
    }>().report;
    expect(oct).toMatchObject({ buyers: 1, repeatRateBp: 0 });
    const empty = (await get(h, `${other.base}/reports/repeat-customers?${SEPT}`, other.owner)).json<{
      report: { buyers: number; repeatRateBp: number | null };
    }>().report;
    expect(empty).toEqual(expect.objectContaining({ buyers: 0, repeatRateBp: null }));
  });

  it('campaign results show provider-confirmed outcomes per campaign', async () => {
    await post(
      h,
      `${shop.base}/customers/${ids.asha ?? ''}/consents`,
      { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'GRANTED', source: 'Asked at the counter, said yes' },
      shop.owner,
    );
    const c = (
      await post(
        h,
        `${shop.base}/campaigns`,
        { name: 'VIP covers', channel: 'WHATSAPP', body: 'Covers 10% off (synthetic).', segmentTags: ['VIP'] },
        shop.owner,
      )
    ).json<{ campaign: { id: string; contentSha256: string } }>().campaign;
    await post(h, `${shop.base}/campaigns/${c.id}/submit`, {}, shop.owner);
    await post(h, `${shop.base}/campaigns/${c.id}/approve`, { contentSha256: c.contentSha256 }, shop.owner);
    await launchCampaign(h.appDb, ctx(), new RecordingProvider(), c.id);
    const msg = await sql<{
      ref: string;
    }>`select provider_message_id as ref from lbg.messages where campaign_id = ${c.id}`.execute(h.admin);
    expect(await recordProviderStatus(h.appDb, ctx(), 'analytics-adapter', msg.rows[0]?.ref ?? '', 'DELIVERED')).toBe(
      true,
    );
    const r = (await get(h, `${shop.base}/reports/campaign-results?period=month`, shop.owner)).json<{
      report: {
        rows: {
          name: string;
          messages: number;
          sent: number;
          delivered: number;
          read: number;
          blocked: number;
          failed: number;
        }[];
      };
    }>().report;
    expect(r.rows).toEqual([
      expect.objectContaining({
        name: 'VIP covers',
        messages: 1,
        sent: 1,
        delivered: 1,
        read: 0,
        blocked: 0,
        failed: 0,
      }),
    ]);
  });

  it('exports are CSV with definitions, audited, and need the report permission', async () => {
    const res = await get(h, `${shop.base}/reports/repeat-customers/export?${SEPT}&format=csv`, shop.owner);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Repeat-customer rate');
    expect(res.body).toContain('50.0%');
    const trend = await get(
      h,
      `${shop.base}/reports/sales-trend/export?weeks=3&date=2026-09-20&format=csv`,
      shop.owner,
    );
    expect(trend.body).toContain('2026-09-14');
    const audit = await sql<{ n: number }>`select count(*)::int as n from lbg.audit_events
      where business_id = ${shop.businessId} and action = 'report.export'`.execute(h.admin);
    expect(audit.rows[0]?.n).toBe(2);
    expect((await get(h, `${shop.base}/reports/sales-trend`, billing)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/reports/repeat-customers?${SEPT}`, other.owner)).statusCode).toBe(404);
  });
});
