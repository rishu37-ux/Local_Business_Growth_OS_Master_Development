// Increment 6.1: customer profile fields, owned units with the warranty as
// recorded at the sale, and the customer export (FR-CRM-1, FR-CRM-2, D-047).
// Synthetic data only.
import { createSaleDraft, issueSale, type SaleLineSpec } from '@lbgos/modules/sales';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  patch,
  post,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let manager: Session;
let phone: string; // serialised, 12-month warranty
let charger: string; // not serialised, 6-month warranty
let cable: string; // not serialised, no warranty
let imeiSeq = 8100;

interface OwnedItem {
  invoiceNumber: string | null;
  saleDate: string;
  description: string;
  imeis: string[];
  warrantyMonths: number | null;
  warrantyProvider: string | null;
  warrantyEnd: string | null;
}

async function seedUnit(): Promise<{ id: string; imei: string }> {
  const { rows } = await sql<{ id: string }>`
    insert into lbg.serialized_units (business_id, variant_id, status, unit_cost_paise)
    values (${shop.businessId}, ${phone}, 'IN_STOCK', 900000) returning id`.execute(h.admin);
  const id = rows[0]?.id ?? '';
  const code = imei(imeiSeq++);
  await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
            values (${shop.businessId}, ${code}, ${id}, 1)`.execute(h.admin);
  await sql`insert into lbg.stock_movements (business_id, variant_id, unit_id, movement_type, quantity_delta, unit_cost_paise)
            values (${shop.businessId}, ${phone}, ${id}, 'OPENING', 1, 900000)`.execute(h.admin);
  return { id, imei: code };
}

const ACCESS = { discount: { limits: undefined }, priceOverride: true };

/** A sale at a chosen time, through the sales module (the API always sells now). */
async function sellAt(lines: SaleLineSpec[], customerId: string, at: Date): Promise<string> {
  const ctx = { businessId: shop.businessId, userId: shop.ownerId };
  const draft = await createSaleDraft(h.appDb, ctx, ACCESS, { customerId, lines }, at);
  const total = draft.totals.totalPaise;
  await issueSale(
    h.appDb,
    ctx,
    ACCESS,
    draft.id,
    { expectedTotalPaise: total, payments: [{ method: 'CASH', amountPaise: total, reference: null }] },
    { at },
  );
  return draft.id;
}

async function sell(lines: object[], customerId: string): Promise<string> {
  const d = await post(h, `${shop.base}/sales`, { customerId, lines }, billing);
  if (d.statusCode !== 201) throw new Error(`draft failed: ${d.statusCode} ${d.body}`);
  const sale = d.json<{ sale: { id: string; totals: { totalPaise: number } } }>().sale;
  const res = await post(
    h,
    `${shop.base}/sales/${sale.id}/issue`,
    {
      expectedTotalPaise: sale.totals.totalPaise,
      payments: [{ method: 'CASH', amountPaise: sale.totals.totalPaise }],
    },
    billing,
  );
  if (res.statusCode !== 201) throw new Error(`issue failed: ${res.statusCode} ${res.body}`);
  return sale.id;
}

const owned = async (customerId: string, session: Session = billing) =>
  (await get(h, `${shop.base}/customers/${customerId}/owned-items`, session)).json<{ items: OwnedItem[] }>().items;

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'crm-a');
  other = await activeShop(h, 'crm-b');
  billing = (await staff(h, shop, 'crm-billing@example.test', 'Billing')).session;
  manager = (await staff(h, shop, 'crm-manager@example.test', 'Manager')).session;
  phone = await variant(h, shop, 'CRM-PH', { serialized: true });
  charger = await variant(h, shop, 'CRM-CH', { serialized: false });
  cable = await variant(h, shop, 'CRM-CB', { serialized: false });
  await patch(
    h,
    `${shop.base}/variants/${phone}`,
    { warrantyMonths: 12, warrantyProvider: 'Brand service' },
    shop.owner,
  );
  await patch(h, `${shop.base}/variants/${charger}`, { warrantyMonths: 6 }, shop.owner);
  for (const v of [charger, cable]) {
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta, unit_cost_paise)
              values (${shop.businessId}, ${v}, 'OPENING', 50, 10000)`.execute(h.admin);
    await sql`update lbg.product_variants set avg_cost_paise = 10000 where id = ${v}`.execute(h.admin);
  }
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('profile fields (FR-CRM-1 AC1, FR-CRM-2 AC1)', () => {
  it('only name and mobile are required; optional fields are stored normalised', async () => {
    const bare = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Bare Minimum (synthetic)', mobile: '9820000001' },
      billing,
    );
    expect(bare.statusCode).toBe(201);
    expect(bare.json<{ customer: object }>().customer).toMatchObject({
      alternateMobileE164: null,
      dob: null,
      tags: [],
      contactChannels: [],
    });
    const full = await post(
      h,
      `${shop.base}/customers`,
      {
        name: 'Full Profile (synthetic)',
        mobile: '9820000002',
        alternateMobile: '098200 00003',
        dob: '1990-02-14',
        tags: [' VIP ', 'vip', 'Repair   customer'],
        contactChannels: ['WHATSAPP', 'CALL', 'WHATSAPP'],
        notes: 'Prefers evening calls.',
      },
      billing,
    );
    expect(full.statusCode).toBe(201);
    const c = full.json<{ customer: { id: string } }>().customer;
    expect(c).toMatchObject({
      alternateMobileE164: '+919820000003',
      dob: '1990-02-14',
      tags: ['VIP', 'Repair customer'],
      contactChannels: ['WHATSAPP', 'CALL'],
    });
    const upd = await patch(h, `${shop.base}/customers/${c.id}`, { tags: ['Bulk'], dob: null }, billing);
    expect(upd.json<{ customer: object }>().customer).toMatchObject({
      tags: ['Bulk'],
      dob: null,
      contactChannels: ['WHATSAPP', 'CALL'],
    });
    const audit = await sql<{ metadata: { fields: string[] } }>`
      select metadata from lbg.audit_events where business_id = ${shop.businessId} and action = 'customer.update'
         and target_id = ${c.id}`.execute(h.admin);
    expect(audit.rows[0]?.metadata.fields).toEqual(['dob', 'tags']);
  });

  it('refuses a future date of birth, bad tags, bad channels and a bad alternate number', async () => {
    const base = { name: 'Invalid (synthetic)', mobile: '9820000009' };
    const future = await post(h, `${shop.base}/customers`, { ...base, dob: '2999-01-01' }, billing);
    expect([future.statusCode, errorCode(future)]).toEqual([422, 'DOB_INVALID']);
    const old = await post(h, `${shop.base}/customers`, { ...base, dob: '1899-12-31' }, billing);
    expect(errorCode(old)).toBe('DOB_INVALID');
    const many = Array.from({ length: 11 }, (_, i) => `tag${String(i)}`);
    expect(errorCode(await post(h, `${shop.base}/customers`, { ...base, tags: many }, billing))).toBe('TAGS_INVALID');
    expect(errorCode(await post(h, `${shop.base}/customers`, { ...base, tags: ['a,b'] }, billing))).toBe(
      'TAGS_INVALID',
    );
    expect((await post(h, `${shop.base}/customers`, { ...base, contactChannels: ['FAX'] }, billing)).statusCode).toBe(
      400,
    );
    const alt = await post(h, `${shop.base}/customers`, { ...base, alternateMobile: '12345' }, billing);
    expect(errorCode(alt)).toBe('MOBILE_INVALID');
    // Nothing half-created.
    const n = await sql<{ n: number }>`select count(*)::int as n from lbg.customers
                                         where business_id = ${shop.businessId} and mobile_e164 = '+919820000009'`.execute(
      h.admin,
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it('the database refuses more than 10 tags and unknown channels even without the API', async () => {
    const bad = [
      sql`insert into lbg.customers (business_id, name, mobile_e164, tags)
          values (${shop.businessId}, 'x', '+919820000100', array['1','2','3','4','5','6','7','8','9','10','11'])`,
      sql`insert into lbg.customers (business_id, name, mobile_e164, contact_channels)
          values (${shop.businessId}, 'x', '+919820000101', array['FAX'])`,
      sql`insert into lbg.customers (business_id, name, mobile_e164, dob)
          values (${shop.businessId}, 'x', '+919820000102', '1800-01-01')`,
    ];
    for (const q of bad) await expect(q.execute(h.admin)).rejects.toThrow(/check constraint/);
  });
});

describe('owned units and warranty as recorded (FR-CRM-1 AC2)', () => {
  it('lists units and warranty items with the end date from the sale date, less returns', async () => {
    const res = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Warranty Owner (synthetic)', mobile: '9820000201' },
      billing,
    );
    const c = res.json<{ customer: { id: string } }>().customer.id;
    const u1 = await seedUnit();
    const u2 = await seedUnit();
    await sellAt(
      [{ unitId: u1.id }, { variantId: charger, quantity: '1' }, { variantId: cable, quantity: '2' }],
      c,
      new Date('2024-01-31T06:00:00Z'), // 31 Jan 2024 in IST
    );
    const second = await sell([{ unitId: u2.id }], c);
    // A later change to the variant does not change what was promised at the sale.
    await patch(h, `${shop.base}/variants/${phone}`, { warrantyMonths: 24 }, shop.owner);
    const items = await owned(c);
    expect(items).toHaveLength(3); // the cable has no warranty and no unit
    const today = items[0];
    expect(today?.imeis).toEqual([u2.imei]);
    expect(today?.warrantyMonths).toBe(12);
    const early = items.filter((i) => i.saleDate === '2024-01-31');
    expect(early.map((i) => [i.imeis, i.warrantyMonths, i.warrantyProvider, i.warrantyEnd])).toEqual([
      [[u1.imei], 12, 'Brand service', '2025-01-31'],
      [[], 6, null, '2024-07-31'],
    ]);
    // Returning the unit on a credit note removes it from the list.
    const cn = await post(
      h,
      `${shop.base}/invoices/${second}/credit-notes`,
      { reason: 'Returned within policy (synthetic).', settlement: 'REFUND', lines: [{ lineNo: 1 }] },
      manager,
    );
    expect(cn.statusCode).toBe(201);
    expect((await owned(c)).some((i) => i.imeis.includes(u2.imei))).toBe(false);
    await patch(h, `${shop.base}/variants/${phone}`, { warrantyMonths: 12 }, shop.owner);
  });

  it('an item with no warranty shows months 0 and no end date', async () => {
    const res = await post(
      h,
      `${shop.base}/customers`,
      { name: 'No Warranty (synthetic)', mobile: '9820000202' },
      billing,
    );
    const c = res.json<{ customer: { id: string } }>().customer.id;
    await patch(h, `${shop.base}/variants/${phone}`, { warrantyMonths: 0 }, shop.owner);
    const u = await seedUnit();
    await sell([{ unitId: u.id }], c);
    expect((await owned(c)).map((i) => [i.warrantyMonths, i.warrantyEnd])).toEqual([[0, null]]);
    await patch(h, `${shop.base}/variants/${phone}`, { warrantyMonths: 12 }, shop.owner);
  });
});

describe('customer export (FR-CRM-2 AC2)', () => {
  const url = (q: string) => `${shop.base}/customers/export?${q}`;

  it('needs customers.export: managers and billing staff cannot export', async () => {
    expect((await get(h, url('fields=name'), manager)).statusCode).toBe(403);
    expect((await get(h, url('fields=name'), billing)).statusCode).toBe(403);
    expect((await get(h, url('fields=unknown'), shop.owner)).statusCode).toBe(400);
    expect((await get(h, url('fields='), shop.owner)).statusCode).toBe(400);
  });

  it('contains only the chosen fields in the chosen order, and is audited without personal data', async () => {
    const res = await get(h, url('fields=mobile,name,tags&tag=bulk'), shop.owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="customers.csv"');
    const lines = res.body.slice(1).trim().split('\r\n');
    expect(lines).toEqual(['Mobile,Name,Tags', "'+919820000002,Full Profile (synthetic),Bulk"]);
    expect(res.body).not.toContain('1990-02-14');
    const all = await get(h, url('fields=name'), shop.owner);
    expect(all.body.slice(1).trim().split('\r\n').length).toBe(1 + 4); // header + the 4 customers created above
    const audit = await sql<{ metadata: Record<string, unknown> }>`
      select metadata from lbg.audit_events where business_id = ${shop.businessId} and action = 'customer.export'
       order by created_at`.execute(h.admin);
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { fields: ['mobile', 'name', 'tags'], count: 1, tagFilter: true },
      { fields: ['name'], count: 4 },
    ]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/9820000002|Full Profile|bulk/i);
  });
});

describe('access', () => {
  it('other businesses get 404; read-only mode still allows viewing and export', async () => {
    const res = await post(
      h,
      `${shop.base}/customers`,
      { name: 'Tenant Check (synthetic)', mobile: '9820000301' },
      billing,
    );
    const c = res.json<{ customer: { id: string } }>().customer.id;
    expect((await get(h, `${other.base}/customers/${c}/owned-items`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/customers/${c}/owned-items`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/customers/export?fields=name`, other.owner)).statusCode).toBe(404);
    const theirs = await get(h, `${other.base}/customers/export?fields=name`, other.owner);
    expect(theirs.body.slice(1).trim()).toBe('Name');
    await sql`update lbg.businesses set status = 'SUSPENDED' where id = ${shop.businessId}`.execute(h.admin);
    expect((await get(h, `${shop.base}/customers/${c}/owned-items`, shop.owner)).statusCode).toBe(200);
    expect((await get(h, `${shop.base}/customers/export?fields=name`, shop.owner)).statusCode).toBe(200);
    const ro = await patch(h, `${shop.base}/customers/${c}`, { tags: ['x'] }, shop.owner);
    expect([ro.statusCode, errorCode(ro)]).toEqual([403, 'TENANT_READ_ONLY']);
  });
});
