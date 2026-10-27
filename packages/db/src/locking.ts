// Locking rules for numbering and allocation (D-020), proven in the Phase 2
// spike (TR-0003).
import { sql } from 'kysely';
import type { TenantContext, Trx } from './tenant.ts';

/**
 * Gapless invoice numbering (D-012). The UPDATE locks the series row for the
 * rest of the transaction, so concurrent issuers queue behind it, and a
 * rollback restores the counter: no gaps, no duplicates.
 */
export async function allocateInvoiceNumber(trx: Trx, seriesId: string): Promise<number> {
  const row = await trx
    .updateTable('lbg.invoice_series')
    .set({ next_number: sql`next_number + 1` })
    .where('id', '=', seriesId)
    .returning(sql<number>`next_number - 1`.as('allocated'))
    .executeTakeFirstOrThrow();
  return row.allocated; // next_number is int4, which node-postgres returns as a JS number
}

/**
 * Payment allocation (D-014). Serialises allocations per invoice (row lock) and
 * per payment so the bounds trigger sees every committed allocation. Payments
 * are append-only and the app role lacks UPDATE, which FOR UPDATE requires, so
 * the payment is locked with a transaction-scoped advisory lock.
 */
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
