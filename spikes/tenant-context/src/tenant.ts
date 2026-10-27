// Spike: how the API will run every tenant request (D-004, threat T26).
// Each unit of work is one transaction whose first statement sets the tenant
// context with set_config(..., is_local = true), so the setting disappears at
// COMMIT/ROLLBACK and can never leak to the next user of a pooled connection.
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

export interface TenantContext {
  businessId: string;
  userId: string;
}

// Schema types are left loose in the spike; Phase 3 generates them from migrations.
export type Db = Kysely<any>;
export type Trx = Transaction<any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(user: string, maxConnections: number): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ user, max: maxConnections }); // host/port/database from PG* env
  return { db: new Kysely({ dialect: new PostgresDialect({ pool }) }), pool };
}

export async function withTenant<T>(db: Db, ctx: TenantContext, work: (trx: Trx) => Promise<T>): Promise<T> {
  // Context comes from the authenticated session, but validate anyway: a
  // malformed value must fail here rather than reach the database.
  if (!UUID.test(ctx.businessId) || !UUID.test(ctx.userId)) {
    throw new Error('invalid tenant context');
  }
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.business_id', ${ctx.businessId}, true),
                     set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
    return work(trx);
  });
}

// Gapless invoice numbering (D-012): the counter row is locked by the UPDATE
// for the rest of the transaction, so concurrent issuers queue behind it, and
// a rollback restores the counter — no gaps, no duplicates.
export async function allocateInvoiceNumber(trx: Trx, seriesId: string): Promise<number> {
  const row = await trx
    .updateTable('lbg.invoice_series')
    .set({ next_number: sql`next_number + 1` })
    .where('id', '=', seriesId)
    .returning(sql<number>`next_number - 1`.as('allocated'))
    .executeTakeFirstOrThrow();
  return Number(row.allocated);
}

// Payment allocation (D-014): serialise allocations per invoice and per payment
// so the bounds trigger sees every committed allocation (DATA_MODEL.md §5 item 2).
// The invoice row is locked with FOR UPDATE. Payments are append-only and the app
// role has no UPDATE grant, which FOR UPDATE/SHARE require, so the payment is
// locked with a transaction-scoped advisory lock keyed on its ID instead.
export async function allocatePayment(
  trx: Trx,
  ctx: TenantContext,
  paymentId: string,
  invoiceId: string,
  amountPaise: number,
): Promise<void> {
  await trx.selectFrom('lbg.invoices').select('id').where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
  await sql`select pg_advisory_xact_lock(hashtextextended(${'payment:' + paymentId}, 0))`.execute(trx);
  await trx
    .insertInto('lbg.payment_allocations')
    .values({ business_id: ctx.businessId, payment_id: paymentId, invoice_id: invoiceId, amount_paise: amountPaise })
    .execute();
}
