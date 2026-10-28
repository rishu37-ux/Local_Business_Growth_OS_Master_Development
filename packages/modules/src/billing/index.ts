// Platform billing invoices with manual payment (increment 10.2: FR-SUB-1
// AC3, D-068). Issued by the platform admin at the plan price of the time,
// numbered per financial year; paid only by an admin's manual record (no
// gateway exists, Q4); voided with a reason. GST is not computed (Q5).
// Every action is a platform audit event that the business can also see.
import { financialYear } from '@lbgos/domain';
import { sql } from 'kysely';
import { withoutTenant, withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordPlatformEvent } from '../audit/index.ts';

/** The platform's own financial year: Indian default, April start (D-012). */
const PLATFORM_TZ = 'Asia/Kolkata';
const PLATFORM_FY_START = 4;

export class BillingError extends Error {
  readonly code: 'NOT_FOUND' | 'NO_SUBSCRIPTION' | 'NOT_ISSUED' | 'PERIOD_INVALID' | 'PERIOD_BILLED';

  constructor(code: BillingError['code'], message: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
  }
}

export interface BillingInvoice {
  readonly id: string;
  readonly businessId: string;
  readonly number: string;
  readonly planCode: string;
  readonly planName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountPaise: number;
  readonly taxStatus: 'NOT_COMPUTED';
  readonly status: 'ISSUED' | 'PAID' | 'VOID';
  readonly issuedAt: string;
  readonly paidOn: string | null;
  readonly paymentMethod: 'MANUAL' | null;
  readonly paymentReference: string | null;
  readonly voidReason: string | null;
}

interface Row {
  id: string;
  business_id: string;
  number: string;
  plan_code: string;
  plan_name: string;
  period_start: string;
  period_end: string;
  amount_paise: string;
  tax_status: 'NOT_COMPUTED';
  status: BillingInvoice['status'];
  issued_at: Date;
  paid_on: string | null;
  payment_method: 'MANUAL' | null;
  payment_reference: string | null;
  void_reason: string | null;
}

const COLUMNS = sql`id, business_id, number, plan_code, plan_name, period_start::text as period_start,
                    period_end::text as period_end, amount_paise::text as amount_paise, tax_status, status,
                    issued_at, paid_on::text as paid_on, payment_method, payment_reference, void_reason`;

const toInvoice = (r: Row): BillingInvoice => ({
  id: r.id,
  businessId: r.business_id,
  number: r.number,
  planCode: r.plan_code,
  planName: r.plan_name,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  amountPaise: Number(r.amount_paise),
  taxStatus: r.tax_status,
  status: r.status,
  issuedAt: new Date(r.issued_at).toISOString(),
  paidOn: r.paid_on,
  paymentMethod: r.payment_method,
  paymentReference: r.payment_reference,
  voidReason: r.void_reason,
});

/** AC1: one invoice for the business's current subscription and the given period, at today's plan price. */
export async function issueBillingInvoice(
  db: Db,
  actorUserId: string,
  input: { readonly businessId: string; readonly periodStart: string; readonly periodEnd: string },
): Promise<BillingInvoice> {
  if (input.periodEnd <= input.periodStart)
    throw new BillingError('PERIOD_INVALID', 'The period must end after it starts.');
  return withoutTenant(db, async (trx) => {
    const sub = await sql<{ id: string; code: string; name: string; price_paise: string }>`
      select s.id, p.code, p.name, p.price_paise::text as price_paise
        from lbg.subscriptions s join lbg.plans p on p.id = s.plan_id
       where s.business_id = ${input.businessId}
       order by s.current_period_start desc limit 1`.execute(trx);
    const s = sub.rows[0];
    if (!s) throw new BillingError('NO_SUBSCRIPTION', 'This business has no subscription.');
    // A period is billed once (a void invoice frees it again).
    const overlap = await sql<{ n: number }>`
      select count(*)::int as n from lbg.billing_invoices
       where business_id = ${input.businessId} and status <> 'VOID'
         and daterange(period_start, period_end) && daterange(${input.periodStart}::date, ${input.periodEnd}::date)`.execute(
      trx,
    );
    if ((overlap.rows[0]?.n ?? 0) > 0)
      throw new BillingError('PERIOD_BILLED', 'An invoice already covers part of this period.');
    const fy = financialYear(new Date(`${input.periodStart}T00:00:00+05:30`), PLATFORM_TZ, PLATFORM_FY_START);
    // The series row is the lock: concurrent issues get consecutive numbers.
    const seq = await sql<{ n: number }>`
      insert into lbg.billing_number_series (financial_year, next_number) values (${fy}, 2)
      on conflict (financial_year) do update set next_number = lbg.billing_number_series.next_number + 1
      returning next_number - 1 as n`.execute(trx);
    const n = seq.rows[0]?.n ?? 0;
    const { rows } = await sql<Row>`
      insert into lbg.billing_invoices (business_id, subscription_id, financial_year, sequence_number, number,
                                        plan_code, plan_name, period_start, period_end, amount_paise, issued_by)
      values (${input.businessId}, ${s.id}, ${fy}, ${n}, ${`LBG/${fy}/${String(n)}`}, ${s.code}, ${s.name},
              ${input.periodStart}::date, ${input.periodEnd}::date, ${s.price_paise}::bigint, ${actorUserId})
      returning ${COLUMNS}`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('billing invoice not created');
    await recordPlatformEvent(trx, actorUserId, {
      action: 'billing.invoice_issued',
      businessId: input.businessId,
      targetType: 'billing_invoice',
      targetId: row.id,
      metadata: { number: row.number, amountPaise: Number(row.amount_paise) },
    });
    return toInvoice(row);
  });
}

async function change(
  db: Db,
  actorUserId: string,
  invoiceId: string,
  apply: (trx: Trx) => Promise<Row | undefined>,
  action: string,
  metadata: Record<string, unknown>,
): Promise<BillingInvoice> {
  return withoutTenant(db, async (trx) => {
    const current = await sql<{ status: string; business_id: string }>`
      select status, business_id from lbg.billing_invoices where id = ${invoiceId} for update`.execute(trx);
    const c = current.rows[0];
    if (!c) throw new BillingError('NOT_FOUND', 'Not found.');
    if (c.status !== 'ISSUED')
      throw new BillingError('NOT_ISSUED', `This invoice is already ${c.status.toLowerCase()}.`);
    const row = await apply(trx);
    if (!row) throw new BillingError('NOT_FOUND', 'Not found.');
    await recordPlatformEvent(trx, actorUserId, {
      action,
      businessId: c.business_id,
      targetType: 'billing_invoice',
      targetId: invoiceId,
      metadata,
    });
    return toInvoice(row);
  });
}

/** AC2: a payment is only ever an admin's manual record, with a reference. */
export function recordManualPayment(
  db: Db,
  actorUserId: string,
  invoiceId: string,
  input: { readonly paidOn: string; readonly reference: string },
): Promise<BillingInvoice> {
  return change(
    db,
    actorUserId,
    invoiceId,
    async (trx) =>
      (
        await sql<Row>`update lbg.billing_invoices
                          set status = 'PAID', paid_on = ${input.paidOn}::date, payment_method = 'MANUAL',
                              payment_reference = ${input.reference}, payment_recorded_by = ${actorUserId}
                        where id = ${invoiceId} returning ${COLUMNS}`.execute(trx)
      ).rows[0],
    'billing.payment_recorded',
    { method: 'MANUAL', paidOn: input.paidOn },
  );
}

export function voidBillingInvoice(
  db: Db,
  actorUserId: string,
  invoiceId: string,
  reason: string,
): Promise<BillingInvoice> {
  return change(
    db,
    actorUserId,
    invoiceId,
    async (trx) =>
      (
        await sql<Row>`update lbg.billing_invoices set status = 'VOID', void_reason = ${reason}, voided_by = ${actorUserId}
                        where id = ${invoiceId} returning ${COLUMNS}`.execute(trx)
      ).rows[0],
    'billing.invoice_voided',
    {},
  );
}

/** Platform view: all invoices, or one business's. */
export async function listBillingInvoices(db: Db, businessId?: string): Promise<BillingInvoice[]> {
  return withoutTenant(db, async (trx) => {
    const { rows } = await sql<Row>`select ${COLUMNS} from lbg.billing_invoices
      where ${businessId ?? null}::uuid is null or business_id = ${businessId ?? null}::uuid
      order by issued_at desc, number desc limit 200`.execute(trx);
    return rows.map(toInvoice);
  });
}

/** AC3: the business's own invoices (tenant role, RLS). */
export async function businessBillingInvoices(db: Db, ctx: TenantContext): Promise<BillingInvoice[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<Row>`select ${COLUMNS} from lbg.billing_invoices
      order by issued_at desc, number desc limit 200`.execute(trx);
    return rows.map(toInvoice);
  });
}
