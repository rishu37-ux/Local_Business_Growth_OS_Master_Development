// Details printed on documents and the default paper size (FR-PRN-1 AC1–2,
// D-044). Documents copy them when issued; changing them affects later
// documents only.
import { normalizeMobile } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export type PaperSize = 'A4' | 'A5' | '80MM' | '58MM';
export const PAPER_SIZES: readonly PaperSize[] = ['A4', 'A5', '80MM', '58MM'];

export interface PrintSettings {
  readonly printSize: PaperSize;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly terms: string | null;
}

export class PrintSettingsError extends Error {
  readonly code = 'PHONE_INVALID';

  constructor() {
    super('Enter a valid phone number, e.g. +919800000000.');
    this.name = 'PrintSettingsError';
  }
}

export async function getPrintSettings(db: Db, ctx: TenantContext): Promise<PrintSettings> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      print_size: PaperSize;
      business_address: string | null;
      business_phone: string | null;
      business_email: string | null;
      invoice_terms: string | null;
    }>`select print_size, business_address, business_phone, business_email::text as business_email, invoice_terms
         from lbg.business_settings where business_id = ${ctx.businessId}`.execute(trx);
    const r = rows[0];
    return {
      printSize: r?.print_size ?? 'A4',
      address: r?.business_address ?? null,
      phone: r?.business_phone ?? null,
      email: r?.business_email ?? null,
      terms: r?.invoice_terms ?? null,
    };
  });
}

export async function savePrintSettings(
  db: Db,
  ctx: TenantContext,
  input: {
    readonly printSize: PaperSize;
    readonly address?: string | null | undefined;
    readonly phone?: string | null | undefined;
    readonly email?: string | null | undefined;
    readonly terms?: string | null | undefined;
  },
  requestId?: string,
): Promise<PrintSettings> {
  const phone = input.phone?.trim() ? normalizeMobile(input.phone) : null;
  if (input.phone?.trim() && !phone) throw new PrintSettingsError();
  const text = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  await withTenant(db, ctx, async (trx) => {
    await sql`insert into lbg.business_settings (business_id, print_size, business_address, business_phone,
                                                 business_email, invoice_terms)
              values (${ctx.businessId}, ${input.printSize}, ${text(input.address)}, ${phone}, ${text(input.email)},
                      ${text(input.terms)})
              on conflict (business_id) do update set print_size = excluded.print_size,
                business_address = excluded.business_address, business_phone = excluded.business_phone,
                business_email = excluded.business_email, invoice_terms = excluded.invoice_terms,
                updated_at = now()`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'business.print_settings.update',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { printSize: input.printSize },
      ...(requestId ? { requestId } : {}),
    });
  });
  return getPrintSettings(db, ctx);
}
