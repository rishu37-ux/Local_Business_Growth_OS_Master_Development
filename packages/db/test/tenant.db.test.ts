// Tenant-context, numbering and allocation tests against the migrated database.
// Ported from the Phase 2 spike (TR-0003). Uses its own synthetic businesses
// (…c1, …d1) so it does not collide with test/schema-checks.sql data.
import { sql } from 'kysely';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  allocateInvoiceNumber,
  allocatePayment,
  withTenant,
  type Db,
  type TenantContext,
  type Trx,
} from '../src/index.ts';
import { openAs, openSuperuser } from './helpers.ts';

const C: TenantContext = {
  businessId: '00000000-0000-0000-0000-0000000000c1',
  userId: '00000000-0000-0000-0000-0000000000c9',
};
const D: TenantContext = {
  businessId: '00000000-0000-0000-0000-0000000000d1',
  userId: '00000000-0000-0000-0000-0000000000d9',
};
const PRODUCT_C = '00000000-0000-0000-0000-00000000c0b1';
const VARIANT_C = '00000000-0000-0000-0000-00000000c0c1';
const SERIES_C = '00000000-0000-0000-0000-00000000c5e1';
const PAY = (n: number) => `00000000-0000-0000-0000-0000000c20${String(n).padStart(2, '0')}`;
const INV = (n: number) => `00000000-0000-0000-0000-0000000c11${String(n).padStart(2, '0')}`;

let admin: Db;
let app: Db;

const sleepRandom = (trx: Trx) => sql`select pg_sleep(random() * 0.01)`.execute(trx);

async function insertIssuedInvoice(db: Db, id: string, number: string, totalPaise: number, seriesId?: string) {
  await sql`insert into lbg.invoices (business_id, id, series_id, document_type, financial_year, invoice_date,
                                      place_of_supply_state, taxable_paise, total_paise)
            values (${C.businessId}, ${id}, ${seriesId ?? null}, 'TAX_INVOICE', '2026-27', '2026-10-27', '09',
                    ${totalPaise}, ${totalPaise})`.execute(db);
  await sql`insert into lbg.invoice_lines (business_id, invoice_id, line_no, variant_id, description, quantity,
                                           unit_price_paise, tax_rate_percent, taxable_paise, line_total_paise)
            values (${C.businessId}, ${id}, 1, ${VARIANT_C}, 'Accessory (synthetic)', 1, ${totalPaise}, 0,
                    ${totalPaise}, ${totalPaise})`.execute(db);
  await sql`update lbg.invoices set status = 'ISSUED', invoice_number = ${number}, issued_at = now()
             where id = ${id}`.execute(db);
}

beforeAll(async () => {
  admin = openSuperuser();
  app = openAs('lbgos_app', 3);
  const steps = [
    sql`insert into lbg.businesses (id, legal_name, category, state_code, status) values
          (${C.businessId}, 'Gamma (synthetic)', 'MOBILE_ELECTRONICS', '09', 'APPROVED_SETUP_PENDING'),
          (${D.businessId}, 'Delta (synthetic)', 'MOBILE_ELECTRONICS', '27', 'APPROVED_SETUP_PENDING')`,
    sql`insert into lbg.products (business_id, model_name)
          select ${C.businessId}::uuid, 'C product ' || g from generate_series(1, 3) g
          union all
          select ${D.businessId}::uuid, 'D product ' || g from generate_series(1, 5) g`,
    sql`insert into lbg.products (business_id, id, model_name) values (${C.businessId}, ${PRODUCT_C}, 'Accessory')`,
    sql`insert into lbg.product_variants (business_id, id, product_id, sku, selling_price_paise)
          values (${C.businessId}, ${VARIANT_C}, ${PRODUCT_C}, 'ACC-1', 100)`,
    sql`insert into lbg.invoice_series (business_id, id, document_type, financial_year, prefix)
          values (${C.businessId}, ${SERIES_C}, 'TAX_INVOICE', '2026-27', 'C/')`,
  ];
  for (const step of steps) await step.execute(admin);
});

describe('withTenant', () => {
  it('isolates tenants under 200 concurrent requests sharing a 3-connection pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const ctx = i % 2 === 0 ? C : D;
        return withTenant(app, ctx, async (trx) => {
          await sleepRandom(trx);
          const rows = await trx.selectFrom('lbg.products').select(['business_id']).execute();
          return { ctx, rows };
        });
      }),
    );
    for (const { ctx, rows } of results) {
      expect(rows.every((r) => r.business_id === ctx.businessId)).toBe(true);
      expect(rows).toHaveLength(ctx === C ? 4 : 5);
    }
  });

  it('leaves no tenant context on pooled connections after commit or rollback', async () => {
    await withTenant(app, C, () => Promise.resolve());
    await expect(withTenant(app, C, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    for (let i = 0; i < 20; i++) {
      const { rows } = await sql<{ ctx: string | null; n: string }>`
        select current_setting('app.business_id', true) as ctx, (select count(*) from lbg.products) as n`.execute(app);
      expect(rows[0]?.ctx ?? '').toBe('');
      expect(Number(rows[0]?.n)).toBe(0);
    }
  });

  it('negative control: a session-level set_config does leak, so the probe above can detect leakage', async () => {
    const single = openAs('lbgos_app', 1);
    await single.transaction().execute(async (trx) => {
      await sql`select set_config('app.business_id', ${C.businessId}, false)`.execute(trx);
    });
    const { rows } = await sql<{ n: string }>`select count(*) as n from lbg.products`.execute(single);
    expect(Number(rows[0]?.n)).toBe(4);
  });

  it('rolls back all writes when the unit of work fails', async () => {
    await expect(
      withTenant(app, C, async (trx) => {
        await trx.insertInto('lbg.categories').values({ business_id: C.businessId, name: 'Will roll back' }).execute();
        throw new Error('fail after write');
      }),
    ).rejects.toThrow('fail after write');
    const { rows } = await sql<{
      n: string;
    }>`select count(*) as n from lbg.categories where name = 'Will roll back'`.execute(admin);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('rejects malformed tenant context before touching the database', async () => {
    await expect(
      withTenant(app, { businessId: "x' or '1'='1", userId: C.userId }, () => Promise.resolve()),
    ).rejects.toThrow('invalid tenant context');
  });

  it('cannot write rows for another tenant', async () => {
    await expect(
      withTenant(app, C, (trx) =>
        trx.insertInto('lbg.categories').values({ business_id: D.businessId, name: 'Injected' }).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('platform and auth role pools cannot read tenant business tables', async () => {
    await expect(openAs('lbgos_platform', 1).selectFrom('lbg.products').selectAll().execute()).rejects.toMatchObject({
      code: '42501',
    });
    await expect(openAs('lbgos_auth', 1).selectFrom('lbg.products').selectAll().execute()).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('allocateInvoiceNumber', () => {
  it('stays gapless and unique under 30 concurrent issuers with every 5th rolling back', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        withTenant(app, C, async (trx) => {
          const n = await allocateInvoiceNumber(trx, SERIES_C);
          await sleepRandom(trx);
          await insertIssuedInvoice(trx, crypto.randomUUID(), `C/${String(n).padStart(4, '0')}`, 100, SERIES_C);
          if (i % 5 === 0) throw new Error('simulated failure after number allocation');
          return n;
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(24);
    const { rows } = await sql<{ invoice_number: string }>`
      select invoice_number from lbg.invoices where series_id = ${SERIES_C} order by invoice_number`.execute(admin);
    expect(rows.map((r) => r.invoice_number)).toEqual(
      Array.from({ length: 24 }, (_, k) => `C/${String(k + 1).padStart(4, '0')}`),
    );
    const series = await sql<{ next_number: number }>`select next_number from lbg.invoice_series
      where id = ${SERIES_C}`.execute(admin);
    expect(series.rows[0]?.next_number).toBe(25);
  });
});

describe('allocatePayment', () => {
  beforeAll(async () => {
    await withTenant(app, C, async (trx) => {
      for (const n of [1, 2, 3, 4]) await insertIssuedInvoice(trx, INV(n), `R/000${n}`, 1000);
      await trx
        .insertInto('lbg.payments')
        .values(
          [1, 2, 3, 4, 5].map((n) => ({ business_id: C.businessId, id: PAY(n), method: 'CASH', amount_paise: 800 })),
        )
        .execute();
    });
  });

  // Two connections with explicit interleaving, so the outcome does not depend on timing.
  async function interleave(lock: boolean, invoiceId: string, p1: string, p2: string): Promise<string> {
    const c1 = new pg.Client({ user: 'lbgos_app' });
    const c2 = new pg.Client({ user: 'lbgos_app' });
    await c1.connect();
    await c2.connect();
    const prep = (c: pg.Client) => c.query(`begin; select set_config('app.business_id', '${C.businessId}', true)`);
    const alloc = async (c: pg.Client, p: string) => {
      if (lock) await c.query('select 1 from lbg.invoices where id = $1 for update', [invoiceId]);
      await c.query(
        'insert into lbg.payment_allocations (business_id, payment_id, invoice_id, amount_paise) values ($1, $2, $3, 800)',
        [C.businessId, p, invoiceId],
      );
    };
    try {
      await prep(c1);
      await prep(c2);
      await alloc(c1, p1);
      const second = alloc(c2, p2); // with the lock this blocks until c1 commits
      await new Promise((r) => setTimeout(r, 100));
      await c1.query('commit');
      const outcome = await second.then(
        () => 'inserted',
        (e: unknown) => (e as { code?: string }).code ?? 'error',
      );
      await c2.query(outcome === 'inserted' ? 'commit' : 'rollback');
      return outcome;
    } finally {
      await c1.end();
      await c2.end();
    }
  }

  const allocated = async (invoiceId: string) => {
    const { rows } = await sql<{ s: string | null }>`select sum(amount_paise) as s from lbg.payment_allocations
      where invoice_id = ${invoiceId}`.execute(admin);
    return Number(rows[0]?.s ?? 0);
  };

  it('with row locks, a concurrent over-allocation is rejected (LB005)', async () => {
    expect(await interleave(true, INV(1), PAY(1), PAY(2))).toBe('LB005');
    expect(await allocated(INV(1))).toBe(800);
  });

  it('characterization: WITHOUT row locks the trigger alone lets two transactions over-allocate', async () => {
    expect(await interleave(false, INV(2), PAY(3), PAY(4))).toBe('inserted');
    expect(await allocated(INV(2))).toBe(1600);
  });

  it('allocatePayment() stays within invoice bounds', async () => {
    await expect(withTenant(app, C, (trx) => allocatePayment(trx, C, PAY(2), INV(1), 201))).rejects.toMatchObject({
      code: 'LB005',
    });
    await withTenant(app, C, (trx) => allocatePayment(trx, C, PAY(2), INV(1), 200));
    expect(await allocated(INV(1))).toBe(1000);
  });

  it('allocatePayment() serialises one payment split across two invoices', async () => {
    const results = await Promise.allSettled(
      [INV(3), INV(4)].map((inv) =>
        withTenant(app, C, async (trx) => {
          await allocatePayment(trx, C, PAY(5), inv, 500);
          await sleepRandom(trx);
        }),
      ),
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'LB005' });
  });
});
