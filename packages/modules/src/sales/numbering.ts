// Document numbering (FR-POS-4, D-012, D-020, D-038). One series per business,
// document type and financial year, created on first use with the business's
// current prefix and format. The number is taken inside the issuing
// transaction under the series row lock, so numbers are gapless and unique.
import {
  DEFAULT_FORMAT,
  financialYear,
  formatProblem,
  NumberingError,
  renderInvoiceNumber,
  type FormatProblem,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { allocateInvoiceNumber, withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export type DocumentType = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface NumberingSettings {
  readonly prefix: string;
  readonly numberFormat: string;
  readonly timezone: string;
  readonly fyStartMonth: number;
}

export async function numberingSettingsIn(trx: Trx, ctx: TenantContext): Promise<NumberingSettings> {
  const { rows } = await sql<{
    prefix: string | null;
    number_format: string | null;
    timezone: string;
    fy_start_month: number;
  }>`
    select s.invoice_prefix as prefix, s.number_format, b.timezone, b.fy_start_month
      from lbg.businesses b left join lbg.business_settings s on s.business_id = b.id
     where b.id = ${ctx.businessId}`.execute(trx);
  const r = rows[0];
  if (!r) throw new Error('business not found');
  return {
    prefix: r.prefix ?? '',
    numberFormat: r.number_format ?? DEFAULT_FORMAT,
    timezone: r.timezone,
    fyStartMonth: r.fy_start_month,
  };
}

export interface AllocatedNumber {
  readonly seriesId: string;
  readonly financialYear: string;
  readonly sequence: number;
  readonly number: string;
}

/** Takes the next number for `documentType` in the financial year of `at` (business timezone). */
export async function nextDocumentNumber(
  trx: Trx,
  ctx: TenantContext,
  documentType: DocumentType,
  at: Date,
): Promise<AllocatedNumber> {
  const settings = await numberingSettingsIn(trx, ctx);
  const fy = financialYear(at, settings.timezone, settings.fyStartMonth);
  const find = () =>
    sql<{ id: string; prefix: string; number_format: string }>`
      select id, prefix, number_format from lbg.invoice_series
       where business_id = ${ctx.businessId} and document_type = ${documentType} and financial_year = ${fy}
       order by next_number desc limit 1`.execute(trx);
  let series = (await find()).rows[0];
  if (!series) {
    // A new financial year (or first document of this type) starts a new series (FR-POS-4 AC4).
    await sql`insert into lbg.invoice_series (business_id, document_type, financial_year, prefix, number_format)
              values (${ctx.businessId}, ${documentType}, ${fy}, ${settings.prefix}, ${settings.numberFormat})
              on conflict (business_id, document_type, financial_year, prefix) do nothing`.execute(trx);
    series = (await find()).rows[0];
  }
  if (!series) throw new Error('invoice series could not be created');
  const sequence = await allocateInvoiceNumber(trx, series.id);
  // Throws SERIES_EXHAUSTED; the transaction then rolls back, restoring the counter.
  const number = renderInvoiceNumber(series.number_format, series.prefix, fy, sequence);
  return { seriesId: series.id, financialYear: fy, sequence, number };
}

export interface NumberingView extends NumberingSettings {
  /** What the next number of a new series would look like. */
  readonly example: string;
  readonly series: readonly {
    readonly documentType: DocumentType;
    readonly financialYear: string;
    readonly prefix: string;
    readonly numberFormat: string;
    readonly nextNumber: number;
  }[];
}

export async function getNumbering(db: Db, ctx: TenantContext, now: Date = new Date()): Promise<NumberingView> {
  return withTenant(db, ctx, async (trx) => {
    const settings = await numberingSettingsIn(trx, ctx);
    const fy = financialYear(now, settings.timezone, settings.fyStartMonth);
    const { rows } = await sql<{
      document_type: DocumentType;
      financial_year: string;
      prefix: string;
      number_format: string;
      next_number: number;
    }>`select document_type, financial_year, prefix, number_format, next_number from lbg.invoice_series
        where business_id = ${ctx.businessId} order by financial_year desc, document_type`.execute(trx);
    return {
      ...settings,
      example: renderInvoiceNumber(settings.numberFormat, settings.prefix, fy, 1),
      series: rows.map((r) => ({
        documentType: r.document_type,
        financialYear: r.financial_year,
        prefix: r.prefix,
        numberFormat: r.number_format,
        nextNumber: r.next_number,
      })),
    };
  });
}

export class NumberingSettingsError extends Error {
  readonly code: FormatProblem;

  constructor(code: FormatProblem) {
    super(`invalid number format: ${code.toLowerCase().replace(/_/g, ' ')}`);
    this.name = 'NumberingSettingsError';
    this.code = code;
  }
}

/**
 * Saves prefix and format (needs tax.settings.manage and a fresh sign-in,
 * checked by the API). Series that have not issued a number yet switch to the
 * new settings; used series keep theirs until the next financial year.
 */
export async function saveNumbering(
  db: Db,
  ctx: TenantContext,
  input: { readonly prefix: string; readonly numberFormat: string },
  requestId?: string,
): Promise<NumberingView> {
  const problem = formatProblem(input.numberFormat, input.prefix);
  if (problem) throw new NumberingSettingsError(problem);
  await withTenant(db, ctx, async (trx) => {
    await sql`insert into lbg.business_settings (business_id, invoice_prefix, number_format)
              values (${ctx.businessId}, ${input.prefix}, ${input.numberFormat})
              on conflict (business_id) do update set invoice_prefix = excluded.invoice_prefix,
                number_format = excluded.number_format, updated_at = now()`.execute(trx);
    await sql`update lbg.invoice_series set prefix = ${input.prefix}, number_format = ${input.numberFormat}
               where business_id = ${ctx.businessId} and next_number = 1
                 and not exists (select 1 from lbg.invoice_series o
                                  where o.business_id = invoice_series.business_id
                                    and o.document_type = invoice_series.document_type
                                    and o.financial_year = invoice_series.financial_year
                                    and o.prefix = ${input.prefix} and o.id <> invoice_series.id)`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'tax.numbering.update',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { prefix: input.prefix, numberFormat: input.numberFormat },
      ...(requestId ? { requestId } : {}),
    });
  });
  return getNumbering(db, ctx);
}

export { NumberingError };
