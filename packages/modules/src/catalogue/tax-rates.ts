// Versioned tax rates (FR-TAX-2). Rates are entered by the business; nothing
// is seeded, because rates must be checked by a tax professional (AC3).
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { CatalogueError } from './errors.ts';

export interface TaxRate {
  readonly id: string;
  readonly name: string;
  /** Percent as exact decimal text, e.g. "18.00". */
  readonly ratePercent: string;
  readonly cessPercent: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

interface TaxRateRow {
  id: string;
  name: string;
  rate_percent: string;
  cess_percent: string;
  effective_from: string;
  effective_to: string | null;
}

const toTaxRate = (r: TaxRateRow): TaxRate => ({
  id: r.id,
  name: r.name,
  ratePercent: r.rate_percent,
  cessPercent: r.cess_percent,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
});

// Dates as ISO text so no timezone conversion can shift them.
const COLUMNS = sql`id, name, rate_percent, cess_percent, effective_from::text as effective_from,
                    effective_to::text as effective_to`;

export async function listTaxRates(db: Db, ctx: TenantContext): Promise<TaxRate[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<TaxRateRow>`select ${COLUMNS} from lbg.tax_rates where business_id = ${ctx.businessId}
                                            order by lower(name), effective_from`.execute(trx);
    return rows.map(toTaxRate);
  });
}

export async function createTaxRate(
  db: Db,
  ctx: TenantContext,
  input: {
    readonly name: string;
    readonly ratePercent: string;
    readonly cessPercent?: string | undefined;
    readonly effectiveFrom: string;
    readonly effectiveTo?: string | null | undefined;
  },
  requestId?: string,
): Promise<string> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      insert into lbg.tax_rates (business_id, name, rate_percent, cess_percent, effective_from, effective_to)
      values (${ctx.businessId}, ${input.name}, ${input.ratePercent}::numeric, ${input.cessPercent ?? '0'}::numeric,
              ${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date)
      returning id`.execute(trx);
    const id = rows[0]?.id ?? '';
    await recordTenantEvent(trx, ctx, {
      action: 'tax.rate.create',
      targetType: 'tax_rate',
      targetId: id,
      metadata: { name: input.name, ratePercent: input.ratePercent, effectiveFrom: input.effectiveFrom },
      ...(requestId ? { requestId } : {}),
    });
    return id;
  });
}

/** Ends a version's validity; earlier invoices keep their snapshot (FR-TAX-2 AC2). */
export async function closeTaxRate(
  db: Db,
  ctx: TenantContext,
  id: string,
  effectiveTo: string,
  requestId?: string,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const { numAffectedRows } = await sql`update lbg.tax_rates set effective_to = ${effectiveTo}::date
                                           where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    if (numAffectedRows === 0n) throw new CatalogueError('NOT_FOUND', 'tax rate not found');
    await recordTenantEvent(trx, ctx, {
      action: 'tax.rate.close',
      targetType: 'tax_rate',
      targetId: id,
      metadata: { effectiveTo },
      ...(requestId ? { requestId } : {}),
    });
  });
}

/** The version of the referenced rate in force on `on` (yyyy-mm-dd), or null. */
export async function effectiveTaxRate(
  db: Db,
  ctx: TenantContext,
  rateId: string,
  on: string,
): Promise<TaxRate | null> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<TaxRateRow>`select ${COLUMNS} from lbg.tax_rates
                                            where id = lbg.effective_tax_rate(${rateId}::uuid, ${on}::date)`.execute(
      trx,
    );
    const row = rows[0];
    return row ? toTaxRate(row) : null;
  });
}
