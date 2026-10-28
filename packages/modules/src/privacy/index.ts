// Privacy requests and tenant export (increment 6.6: FR-PRV-1 AC2, FR-PRV-2,
// D-052). Erasure anonymises a customer and stops all communication while
// issued invoices keep their party snapshot; the export gives the owner every
// business table as CSV in one ZIP.
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { suppressCustomerIn } from '../messaging/index.ts';
import { toCsv, zip } from '../reports/index.ts';

export class PrivacyError extends Error {
  readonly code: 'NOT_FOUND' | 'ALREADY_ERASED' | 'EXPORT_TOO_LARGE';

  constructor(code: PrivacyError['code'], message: string) {
    super(message);
    this.name = 'PrivacyError';
    this.code = code;
  }
}

export const ERASED_NAME = 'Erased customer';

export interface ErasureResult {
  readonly requestId: string;
  readonly customerId: string;
  readonly cancelledMessages: number;
  readonly redactedMessages: number;
  readonly consentsWithdrawn: number;
}

/**
 * FR-PRV-1 AC2 (the caller checks owner and fresh sign-in): in one
 * transaction, suppress the contact's addresses (before they are removed),
 * withdraw every consent, cancel pending messages, redact past messages and
 * anonymise the profile. Invoices, payments and ledger entries stay.
 */
export async function eraseCustomer(
  db: Db,
  ctx: TenantContext,
  customerId: string,
  reason: string,
  requestId?: string,
): Promise<ErasureResult> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ erased: boolean }>`
      select erased_at is not null as erased from lbg.customers
       where business_id = ${ctx.businessId} and id = ${customerId} for update`.execute(trx);
    const c = rows[0];
    if (!c) throw new PrivacyError('NOT_FOUND', 'Customer not found.');
    if (c.erased) throw new PrivacyError('ALREADY_ERASED', "This customer's personal data has already been erased.");

    await suppressCustomerIn(trx, ctx, customerId);
    const withdrawn = await sql`
      insert into lbg.customer_consents (business_id, customer_id, channel, purpose, status, source, recorded_by)
      select ${ctx.businessId}, ${customerId}, ch, pu, 'WITHDRAWN', 'Personal data erased', ${ctx.userId}::uuid
        from unnest(array['WHATSAPP', 'SMS', 'EMAIL']) ch cross join unnest(array['TRANSACTIONAL', 'MARKETING']) pu
       where coalesce((select k.status from lbg.customer_consents k
                        where k.business_id = ${ctx.businessId} and k.customer_id = ${customerId}
                          and k.channel = ch and k.purpose = pu
                        order by k.recorded_at desc, k.id desc limit 1), 'NONE') <> 'WITHDRAWN'`.execute(trx);
    const cancelled = await sql`
      update lbg.messages set status = 'CANCELLED', status_reason = 'CUSTOMER_ERASED'
       where business_id = ${ctx.businessId} and customer_id = ${customerId}
         and status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED')`.execute(trx);
    const redacted = await sql`
      update lbg.messages set body = '[erased]', to_address = '[erased]', redacted_at = now()
       where business_id = ${ctx.businessId} and customer_id = ${customerId} and redacted_at is null`.execute(trx);
    await sql`
      update lbg.customers
         set name = ${ERASED_NAME}, mobile_e164 = null, alternate_mobile_e164 = null, email = null, address = null,
             dob = null, gstin = null, notes = null, tags = '{}', contact_channels = '{}', erased_at = now(),
             updated_at = now()
       where business_id = ${ctx.businessId} and id = ${customerId}`.execute(trx);
    const { rows: req } = await sql<{ id: string }>`
      insert into lbg.privacy_requests (business_id, customer_id, kind, reason, requested_by)
      values (${ctx.businessId}, ${customerId}, 'ERASE', ${reason.trim()}, ${ctx.userId}) returning id`.execute(trx);
    const result: ErasureResult = {
      requestId: req[0]?.id ?? '',
      customerId,
      cancelledMessages: Number(cancelled.numAffectedRows ?? 0),
      redactedMessages: Number(redacted.numAffectedRows ?? 0),
      consentsWithdrawn: Number(withdrawn.numAffectedRows ?? 0),
    };
    // No personal data and not the reason text (it is kept in privacy_requests).
    await recordTenantEvent(trx, ctx, {
      action: 'customer.erase',
      targetType: 'customer',
      targetId: customerId,
      metadata: {
        privacyRequestId: result.requestId,
        cancelledMessages: result.cancelledMessages,
        redactedMessages: result.redactedMessages,
        consentsWithdrawn: result.consentsWithdrawn,
      },
      ...(requestId ? { requestId } : {}),
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Tenant export (FR-PRV-2)
// ---------------------------------------------------------------------------

/** Business tables in the export, in a readable order. Internal and auth tables are not included. */
export const EXPORT_TABLES = [
  'categories',
  'brands',
  'tax_rates',
  'products',
  'product_variants',
  'suppliers',
  'purchases',
  'purchase_lines',
  'serialized_units',
  'serialized_unit_imeis',
  'stock_movements',
  'stock_levels',
  'customers',
  'customer_consents',
  'invoices',
  'invoice_lines',
  'payments',
  'payment_allocations',
  'payment_refunds',
  'customer_ledger_entries',
  'expenses',
  'messages',
  'offers',
  'creative_drafts',
  'campaigns',
] as const;

/** Rows per table above which the export is refused (a background export is needed then). */
export const MAX_EXPORT_ROWS = 200_000;

export interface TenantExport {
  readonly zip: Buffer;
  readonly files: readonly { readonly name: string; readonly rows: number }[];
}

export async function exportBusinessData(db: Db, ctx: TenantContext, requestId?: string): Promise<TenantExport> {
  return withTenant(db, ctx, async (trx) => {
    const files: { name: string; data: Buffer }[] = [];
    const counts: { name: string; rows: number }[] = [];
    for (const table of EXPORT_TABLES) {
      const { rows: cols } = await sql<{ name: string }>`
        select column_name as name from information_schema.columns
         where table_schema = 'lbg' and table_name = ${table} and column_name <> 'business_id'
         order by ordinal_position`.execute(trx);
      const names = cols.map((c) => c.name);
      if (names.length === 0) throw new Error(`export: table ${table} not found`);
      const { rows: n } = await sql<{ n: number }>`
        select count(*)::int as n from ${sql.table(`lbg.${table}`)} where business_id = ${ctx.businessId}`.execute(trx);
      if ((n[0]?.n ?? 0) > MAX_EXPORT_ROWS) {
        throw new PrivacyError('EXPORT_TOO_LARGE', `The ${table} table is too large to export at once.`);
      }
      const order = names.includes('created_at') ? sql`created_at, 1` : sql`1`;
      const { rows } = await sql<Record<string, string | null>>`
        select ${sql.join(names.map((c) => sql`${sql.ref(c)}::text as ${sql.ref(c)}`))}
          from ${sql.table(`lbg.${table}`)} where business_id = ${ctx.businessId}
         order by ${order}`.execute(trx);
      const csv = toCsv({
        title: table,
        subtitle: '',
        columns: names.map((c) => ({ key: c, label: c, kind: 'text' as const })),
        rows,
      });
      files.push({ name: `${table}.csv`, data: Buffer.from(csv, 'utf8') });
      counts.push({ name: `${table}.csv`, rows: rows.length });
    }
    const { rows: b } = await sql<{ name: string; today: string }>`
      select coalesce(display_name, legal_name) as name, (now() at time zone timezone)::date::text as today
        from lbg.businesses where id = ${ctx.businessId}`.execute(trx);
    const readme = [
      `Business data export — ${b[0]?.name ?? ''} — ${b[0]?.today ?? ''}`,
      '',
      'One CSV file per table (UTF-8 with byte-order mark). Money columns ending in _paise are in paise',
      '(divide by 100 for rupees). Quantities are decimal. Times are UTC. Text that looks like a',
      "spreadsheet formula starts with an apostrophe (') so it stays text.",
      'Erased customers appear anonymised; issued invoices keep the details printed on them.',
      '',
      ...counts.map((c) => `${c.name}: ${String(c.rows)} rows`),
      '',
    ].join('\r\n');
    files.unshift({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
    await recordTenantEvent(trx, ctx, {
      action: 'business.export',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { files: counts.length, rows: Object.fromEntries(counts.map((c) => [c.name, c.rows])) },
      ...(requestId ? { requestId } : {}),
    });
    return { zip: zip(files), files: counts };
  });
}
