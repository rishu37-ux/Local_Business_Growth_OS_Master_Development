// Spike tests: run with `npm test` (starts a throwaway PostgreSQL via
// scripts/with-throwaway-pg.sh and applies the schema draft). Synthetic data only.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'kysely';
import pg from 'pg';
import { allocateInvoiceNumber, allocatePayment, createDb, withTenant, type Db, type TenantContext, type Trx } from '../src/tenant.ts';

const A: TenantContext = { businessId: '00000000-0000-0000-0000-0000000000a1', userId: '00000000-0000-0000-0000-000000000001' };
const B: TenantContext = { businessId: '00000000-0000-0000-0000-0000000000b1', userId: '00000000-0000-0000-0000-000000000002' };
const VARIANT_A = '00000000-0000-0000-0000-00000000a0c1';
const SERIES_A = '00000000-0000-0000-0000-00000000a5e1';

const pools: pg.Pool[] = [];
function open(user: string, max: number): Db {
  const { db, pool } = createDb(user, max);
  pools.push(pool);
  return db;
}

let admin: Db; // superuser: seeding and verification only (bypasses RLS)
let app: Db;   // lbgos_app, small pool to force connection reuse

async function seed() {
  const steps = [
    sql`insert into lbg.businesses (id, legal_name, category, state_code, status) values
          (${A.businessId}, 'Alpha (synthetic)', 'MOBILE_ELECTRONICS', '09', 'APPROVED_SETUP_PENDING'),
          (${B.businessId}, 'Beta (synthetic)',  'MOBILE_ELECTRONICS', '27', 'APPROVED_SETUP_PENDING')`,
    sql`insert into lbg.products (business_id, model_name)
          select ${A.businessId}::uuid, 'A product ' || g from generate_series(1, 3) g
          union all
          select ${B.businessId}::uuid, 'B product ' || g from generate_series(1, 5) g`,
    sql`insert into lbg.products (business_id, id, model_name)
          values (${A.businessId}, '00000000-0000-0000-0000-00000000a0b1', 'Accessory')`,
    sql`insert into lbg.product_variants (business_id, id, product_id, sku, selling_price_paise)
          values (${A.businessId}, ${VARIANT_A}, '00000000-0000-0000-0000-00000000a0b1', 'ACC-1', 100)`,
    sql`insert into lbg.invoice_series (business_id, id, document_type, financial_year, prefix)
          values (${A.businessId}, ${SERIES_A}, 'TAX_INVOICE', '2026-27', 'A/')`,
  ];
  for (const step of steps) await step.execute(admin);
}

async function insertIssuedInvoice(db: Db, id: string, number: string, totalPaise: number) {
  await sql`insert into lbg.invoices (business_id, id, document_type, financial_year, invoice_date,
                                      place_of_supply_state, taxable_paise, total_paise)
            values (${A.businessId}, ${id}, 'TAX_INVOICE', '2026-27', '2026-10-27', '09', ${totalPaise}, ${totalPaise})`
    .execute(db);
  await sql`insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, description, quantity,
                                           unit_price_paise, tax_rate_percent, taxable_paise, line_total_paise)
            values (${A.businessId}, ${id}, 1, ${VARIANT_A}, 'Accessory', 1, ${totalPaise}, 0, ${totalPaise}, ${totalPaise})`
    .execute(db);
  await sql`update lbg.invoices set status = 'ISSUED', invoice_number = ${number}, issued_at = now() where id = ${id}`
    .execute(db);
}

const sleepRandom = (trx: Trx) =>
  sql`select pg_sleep(random() * 0.01)`.execute(trx);

before(async () => {
  admin = open('postgres', 2);
  app = open('lbgos_app', 3);
  await seed();
});

after(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe('tenant context', () => {
  it('isolates tenants under 200 concurrent requests sharing a 3-connection pool', async () => {
    const tasks = Array.from({ length: 200 }, (_, i) => {
      const ctx = i % 2 === 0 ? A : B;
      return withTenant(app, ctx, async (trx) => {
        await sleepRandom(trx);
        const rows = await trx.selectFrom('lbg.products').select(['business_id']).execute();
        return { ctx, rows };
      });
    });
    for (const { ctx, rows } of await Promise.all(tasks)) {
      assert.ok(rows.every((r) => r.business_id === ctx.businessId), 'foreign-tenant row visible');
      assert.equal(rows.length, ctx === A ? 4 : 5);
    }
  });

  it('leaves no tenant context on pooled connections after commit or rollback', async () => {
    await withTenant(app, A, async () => undefined);
    await assert.rejects(withTenant(app, A, async () => { throw new Error('boom'); }), /boom/);
    for (let i = 0; i < 20; i++) {
      const { rows } = await sql<{ ctx: string | null; n: string }>`
        select current_setting('app.business_id', true) as ctx, (select count(*) from lbg.products) as n`.execute(app);
      assert.ok(rows[0].ctx === null || rows[0].ctx === '', `context leaked: ${rows[0].ctx}`);
      assert.equal(Number(rows[0].n), 0);
    }
  });

  it('negative control: a session-level set_config DOES leak, so the check above can detect leakage', async () => {
    const single = open('lbgos_app', 1);
    await single.transaction().execute(async (trx) => {
      await sql`select set_config('app.business_id', ${A.businessId}, false)`.execute(trx);
    });
    const { rows } = await sql<{ n: string }>`select count(*) as n from lbg.products`.execute(single);
    assert.equal(Number(rows[0].n), 4, 'expected the leaked session setting to expose tenant A rows');
  });

  it('rolls back all writes when the unit of work fails', async () => {
    await assert.rejects(
      withTenant(app, A, async (trx) => {
        await trx.insertInto('lbg.categories').values({ business_id: A.businessId, name: 'Will roll back' }).execute();
        throw new Error('fail after write');
      }),
      /fail after write/,
    );
    const { rows } = await sql<{ n: string }>`select count(*) as n from lbg.categories where name = 'Will roll back'`.execute(admin);
    assert.equal(Number(rows[0].n), 0);
  });

  it('rejects malformed tenant context before touching the database', async () => {
    await assert.rejects(
      withTenant(app, { businessId: "x' or '1'='1", userId: A.userId }, async () => undefined),
      /invalid tenant context/,
    );
  });

  it('cannot write rows for another tenant through the helper', async () => {
    await assert.rejects(
      withTenant(app, A, (trx) =>
        trx.insertInto('lbg.categories').values({ business_id: B.businessId, name: 'Injected' }).execute()),
      (e: { code?: string }) => e.code === '42501',
    );
  });

  it('platform role pool cannot read tenant business tables', async () => {
    const platform = open('lbgos_platform', 1);
    await assert.rejects(platform.selectFrom('lbg.products').selectAll().execute(), (e: { code?: string }) => e.code === '42501');
  });
});

describe('invoice numbering', () => {
  it('stays gapless and unique under 30 concurrent issuers with every 5th rolling back', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        withTenant(app, A, async (trx) => {
          const n = await allocateInvoiceNumber(trx, SERIES_A);
          await sleepRandom(trx);
          await insertIssuedInvoice(trx, crypto.randomUUID(), `A/${String(n).padStart(4, '0')}`, 100);
          if (i % 5 === 0) throw new Error('simulated failure after number allocation');
          return n;
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 24);
    const { rows } = await sql<{ invoice_number: string }>`
      select invoice_number from lbg.invoices where series_id is null and invoice_number like 'A/%'
       order by invoice_number`.execute(admin);
    assert.deepEqual(rows.map((r) => r.invoice_number), Array.from({ length: 24 }, (_, k) => `A/${String(k + 1).padStart(4, '0')}`));
    const series = await sql<{ next_number: number }>`select next_number from lbg.invoice_series where id = ${SERIES_A}`.execute(admin);
    assert.equal(series.rows[0].next_number, 25);
  });
});

describe('payment allocation', () => {
  const PAY = (n: number) => `00000000-0000-0000-0000-0000000a20${String(n).padStart(2, '0')}`;

  before(async () => {
    await withTenant(app, A, async (trx) => {
      await insertIssuedInvoice(trx, '00000000-0000-0000-0000-0000000a1101', 'R/0001', 1000);
      await insertIssuedInvoice(trx, '00000000-0000-0000-0000-0000000a1102', 'R/0002', 1000);
      await insertIssuedInvoice(trx, '00000000-0000-0000-0000-0000000a1103', 'R/0003', 1000);
      await insertIssuedInvoice(trx, '00000000-0000-0000-0000-0000000a1104', 'R/0004', 1000);
      await trx.insertInto('lbg.payments')
        .values([1, 2, 3, 4, 5].map((n) => ({ business_id: A.businessId, id: PAY(n), method: 'CASH', amount_paise: 800 })))
        .execute();
    });
  });

  // Two separate connections with explicit interleaving, so the outcome does not depend on timing.
  async function interleave(lock: boolean, invoiceId: string, p1: string, p2: string) {
    const c1 = new pg.Client({ user: 'lbgos_app' });
    const c2 = new pg.Client({ user: 'lbgos_app' });
    await c1.connect();
    await c2.connect();
    const prep = (c: pg.Client) => c.query(`begin; select set_config('app.business_id', '${A.businessId}', true)`);
    const alloc = async (c: pg.Client, p: string) => {
      if (lock) await c.query('select 1 from lbg.invoices where id = $1 for update', [invoiceId]);
      await c.query(
        'insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise) values ($1, $2, $3, 800)',
        [A.businessId, p, invoiceId]);
    };
    try {
      await prep(c1);
      await prep(c2);
      await alloc(c1, p1);
      const second = alloc(c2, p2); // with the lock this blocks until c1 commits
      await new Promise((r) => setTimeout(r, 100));
      await c1.query('commit');
      const outcome = await second.then(() => 'inserted', (e: { code?: string }) => e.code);
      await c2.query(outcome === 'inserted' ? 'commit' : 'rollback');
      return outcome;
    } finally {
      await c1.end();
      await c2.end();
    }
  }

  it('with row locks, a concurrent over-allocation is rejected (LB005)', async () => {
    const outcome = await interleave(true, '00000000-0000-0000-0000-0000000a1101', PAY(1), PAY(2));
    assert.equal(outcome, 'LB005');
    const { rows } = await sql<{ s: string }>`select sum(amount_paise) as s from lbg.payment_allocations
      where invoice_id = '00000000-0000-0000-0000-0000000a1101'`.execute(admin);
    assert.equal(Number(rows[0].s), 800);
  });

  it('characterization: WITHOUT row locks the trigger alone lets two transactions over-allocate', async () => {
    const outcome = await interleave(false, '00000000-0000-0000-0000-0000000a1102', PAY(3), PAY(4));
    assert.equal(outcome, 'inserted');
    const { rows } = await sql<{ s: string }>`select sum(amount_paise) as s from lbg.payment_allocations
      where invoice_id = '00000000-0000-0000-0000-0000000a1102'`.execute(admin);
    assert.equal(Number(rows[0].s), 1600, 'documents why allocatePayment() must lock rows');
  });

  it('allocatePayment() helper locks and stays within bounds', async () => {
    await assert.rejects(
      withTenant(app, A, (trx) => allocatePayment(trx, A, PAY(2), '00000000-0000-0000-0000-0000000a1101', 201)),
      (e: { code?: string }) => e.code === 'LB005',
    );
    await withTenant(app, A, (trx) => allocatePayment(trx, A, PAY(2), '00000000-0000-0000-0000-0000000a1101', 200));
  });

  it('allocatePayment() serialises one payment split across two invoices (exactly one of two 500s fits in 800)', async () => {
    const results = await Promise.allSettled(
      ['00000000-0000-0000-0000-0000000a1103', '00000000-0000-0000-0000-0000000a1104'].map((inv) =>
        withTenant(app, A, async (trx) => {
          await allocatePayment(trx, A, PAY(5), inv, 500);
          await sleepRandom(trx);
        })),
    );
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0].reason as { code?: string }).code, 'LB005');
  });
});
