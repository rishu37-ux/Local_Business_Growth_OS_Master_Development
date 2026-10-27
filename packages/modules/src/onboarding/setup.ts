// Setup wizard data (FR-ONB-2). Required steps for activation: details, tax, mfa.
import { financialYear, gstinProblem } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export const SETUP_STEPS = ['details', 'tax', 'mfa', 'staff', 'products', 'integrations', 'preferences'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const REQUIRED_STEPS: readonly SetupStep[] = ['details', 'tax', 'mfa'];

export class SetupError extends Error {
  readonly code: 'GSTIN_INVALID' | 'TIMEZONE_INVALID' | 'PREFIX_INVALID';

  constructor(code: SetupError['code'], message: string) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

async function markStep(trx: Trx, businessId: string, step: SetupStep) {
  await sql`insert into lbg.business_setup (business_id, completed_steps) values (${businessId}, array[${step}]::text[])
            on conflict (business_id) do update
              set completed_steps = (select array(select distinct unnest(lbg.business_setup.completed_steps || ${step}::text) order by 1)),
                  updated_at = now()`.execute(trx);
}

export interface SetupState {
  readonly completedSteps: readonly string[];
  readonly required: readonly SetupStep[];
  readonly remainingRequired: readonly SetupStep[];
}

/** `mfaDone` comes from the auth module (the database cannot see MFA state). */
export async function getSetup(db: Db, ctx: TenantContext, mfaDone: boolean): Promise<SetupState> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ completed_steps: string[] }>`
      select completed_steps from lbg.business_setup where business_id = ${ctx.businessId}`.execute(trx);
    const completed = new Set(rows[0]?.completed_steps ?? []);
    if (mfaDone) completed.add('mfa');
    const completedSteps = SETUP_STEPS.filter((s) => completed.has(s));
    return {
      completedSteps,
      required: REQUIRED_STEPS,
      remainingRequired: REQUIRED_STEPS.filter((s) => !completed.has(s)),
    };
  });
}

// Intl.supportedValuesOf('timeZone') lists only canonical ICU names (it has
// Asia/Calcutta but not Asia/Kolkata), so validate by constructing a formatter,
// which accepts every IANA name and alias the runtime can use.
function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export async function saveDetails(
  db: Db,
  ctx: TenantContext,
  input: { readonly displayName: string; readonly timezone: string; readonly fyStartMonth: number },
): Promise<void> {
  if (!isTimeZone(input.timezone)) throw new SetupError('TIMEZONE_INVALID', 'unknown timezone');
  await withTenant(db, ctx, async (trx) => {
    await sql`update lbg.businesses set display_name = ${input.displayName}, timezone = ${input.timezone},
                                        fy_start_month = ${input.fyStartMonth} where id = ${ctx.businessId}`.execute(
      trx,
    );
    await markStep(trx, ctx.businessId, 'details');
    await recordTenantEvent(trx, ctx, { action: 'setup.details', targetType: 'business', targetId: ctx.businessId });
  });
}

export type RegistrationType = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';

/**
 * Saves the tax profile and creates invoice series for the current financial
 * year. Rates and invoice rules are configured later and remain subject to
 * tax-professional review (D-012, D-013).
 */
export async function saveTax(
  db: Db,
  ctx: TenantContext,
  input: { readonly registrationType: RegistrationType; readonly gstin?: string; readonly invoicePrefix: string },
  now: Date = new Date(),
): Promise<{ financialYear: string }> {
  if (!/^[A-Z0-9/-]{0,6}$/.test(input.invoicePrefix))
    throw new SetupError('PREFIX_INVALID', 'prefix: up to 6 of A–Z, 0–9, / or -');
  return withTenant(db, ctx, async (trx) => {
    const biz = await sql<{ state_code: string | null; timezone: string; fy_start_month: number }>`
      select state_code, timezone, fy_start_month from lbg.businesses where id = ${ctx.businessId}`.execute(trx);
    const b = biz.rows[0];
    const stateCode = b?.state_code ?? '';
    const gstin = input.registrationType === 'UNREGISTERED' ? null : (input.gstin ?? '').trim().toUpperCase();
    if (gstin !== null) {
      const problem = gstinProblem(gstin, stateCode);
      if (problem) throw new SetupError('GSTIN_INVALID', `GSTIN ${problem.toLowerCase().replace('_', ' ')}`);
    }
    await sql`insert into lbg.tax_profiles (business_id, registration_type, gstin, state_code)
              values (${ctx.businessId}, ${input.registrationType}, ${gstin}, ${stateCode})
              on conflict (business_id) do update set registration_type = excluded.registration_type,
                gstin = excluded.gstin, state_code = excluded.state_code, updated_at = now()`.execute(trx);
    const fy = financialYear(now, b?.timezone ?? 'Asia/Kolkata', b?.fy_start_month ?? 4);
    const saleDoc = input.registrationType === 'REGULAR' ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY';
    for (const doc of [saleDoc, 'CREDIT_NOTE', 'DEBIT_NOTE']) {
      await sql`insert into lbg.invoice_series (business_id, document_type, financial_year, prefix)
                values (${ctx.businessId}, ${doc}, ${fy}, ${input.invoicePrefix})
                on conflict (business_id, document_type, financial_year, prefix) do nothing`.execute(trx);
    }
    await sql`insert into lbg.business_settings (business_id, invoice_prefix) values (${ctx.businessId}, ${input.invoicePrefix})
              on conflict (business_id) do update set invoice_prefix = excluded.invoice_prefix, updated_at = now()`.execute(
      trx,
    );
    await markStep(trx, ctx.businessId, 'tax');
    await recordTenantEvent(trx, ctx, {
      action: 'setup.tax',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { registrationType: input.registrationType, financialYear: fy },
    });
    return { financialYear: fy };
  });
}

export async function savePreferences(
  db: Db,
  ctx: TenantContext,
  input: {
    readonly printSize: 'A4' | 'A5' | '80MM' | '58MM';
    readonly weekStart: number;
    readonly requireStaffMfa: boolean;
  },
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await sql`insert into lbg.business_settings (business_id, print_size, week_start, require_staff_mfa)
              values (${ctx.businessId}, ${input.printSize}, ${input.weekStart}, ${input.requireStaffMfa})
              on conflict (business_id) do update set print_size = excluded.print_size, week_start = excluded.week_start,
                require_staff_mfa = excluded.require_staff_mfa, updated_at = now()`.execute(trx);
    await markStep(trx, ctx.businessId, 'preferences');
    await recordTenantEvent(trx, ctx, {
      action: 'setup.preferences',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { requireStaffMfa: input.requireStaffMfa },
    });
  });
}

export async function markStaffStepDone(db: Db, ctx: TenantContext): Promise<void> {
  await withTenant(db, ctx, (trx) => markStep(trx, ctx.businessId, 'staff'));
}
