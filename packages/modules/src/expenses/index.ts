// Expenses (increment 6.4: FR-EXP-1, D-050). Optional module, off by default.
// Entries are append-only; a correction is a reversal (reason, audited) and,
// if needed, a new entry. Receipts use the private upload storage.
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export const EXPENSE_CATEGORIES = [
  'RENT',
  'SALARIES',
  'ELECTRICITY',
  'INTERNET_PHONE',
  'TRANSPORT',
  'REPAIRS_MAINTENANCE',
  'MARKETING',
  'SUPPLIES',
  'BANK_CHARGES',
  'TAXES_FEES',
  'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type ExpenseMethod = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';

export class ExpenseError extends Error {
  readonly code:
    'MODULE_DISABLED' | 'NOT_FOUND' | 'DATE_INVALID' | 'ATTACHMENT_INVALID' | 'ALREADY_REVERSED' | 'NOT_REVERSIBLE';

  constructor(code: ExpenseError['code'], message: string) {
    super(message);
    this.name = 'ExpenseError';
    this.code = code;
  }
}

export interface Expense {
  readonly id: string;
  readonly date: string;
  readonly category: ExpenseCategory;
  readonly amountPaise: number;
  readonly method: ExpenseMethod;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly uploadId: string | null;
  readonly reversesExpenseId: string | null;
  readonly reversedBy: string | null;
  readonly reason: string | null;
  readonly recordedBy: string;
  readonly createdAt: string;
}

interface Row {
  id: string;
  expense_date: string;
  category: ExpenseCategory;
  amount_paise: string;
  method: ExpenseMethod;
  reference: string | null;
  notes: string | null;
  upload_id: string | null;
  reverses_expense_id: string | null;
  reversed_by: string | null;
  reason: string | null;
  recorded_by: string;
  created_at: Date;
}

const COLUMNS = sql`e.id, e.expense_date::text as expense_date, e.category, e.amount_paise, e.method, e.reference,
                    e.notes, e.upload_id, e.reverses_expense_id,
                    (select r.id from lbg.expenses r where r.business_id = e.business_id
                        and r.reverses_expense_id = e.id) as reversed_by,
                    e.reason, e.recorded_by, e.created_at`;

const toExpense = (r: Row): Expense => ({
  id: r.id,
  date: r.expense_date,
  category: r.category,
  amountPaise: Number(r.amount_paise),
  method: r.method,
  reference: r.reference,
  notes: r.notes,
  uploadId: r.upload_id,
  reversesExpenseId: r.reverses_expense_id,
  reversedBy: r.reversed_by,
  reason: r.reason,
  recordedBy: r.recorded_by,
  createdAt: r.created_at.toISOString(),
});

async function enabledIn(trx: Trx, ctx: TenantContext): Promise<boolean> {
  const { rows } = await sql<{ enabled: boolean }>`
    select expenses_enabled as enabled from lbg.business_settings where business_id = ${ctx.businessId}`.execute(trx);
  return rows[0]?.enabled ?? false;
}

async function requireEnabled(trx: Trx, ctx: TenantContext): Promise<void> {
  if (!(await enabledIn(trx, ctx))) {
    throw new ExpenseError('MODULE_DISABLED', 'Expenses are not enabled for this shop. The owner can turn them on.');
  }
}

export async function expenseSettings(db: Db, ctx: TenantContext): Promise<{ readonly enabled: boolean }> {
  return withTenant(db, ctx, async (trx) => ({ enabled: await enabledIn(trx, ctx) }));
}

export async function setExpensesEnabled(
  db: Db,
  ctx: TenantContext,
  enabled: boolean,
  requestId?: string,
): Promise<{ readonly enabled: boolean }> {
  return withTenant(db, ctx, async (trx) => {
    const { numAffectedRows } =
      await sql`update lbg.business_settings set expenses_enabled = ${enabled}, updated_at = now()
                                            where business_id = ${ctx.businessId}`.execute(trx);
    if (numAffectedRows === 0n) {
      await sql`insert into lbg.business_settings (business_id, expenses_enabled) values (${ctx.businessId}, ${enabled})`.execute(
        trx,
      );
    }
    await recordTenantEvent(trx, ctx, {
      action: 'expenses.settings',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { enabled },
      ...(requestId ? { requestId } : {}),
    });
    return { enabled };
  });
}

export interface ExpenseInput {
  readonly date: string;
  readonly category: ExpenseCategory;
  readonly amountPaise: number;
  readonly method: ExpenseMethod;
  readonly reference?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly uploadId?: string | null | undefined;
}

async function byId(trx: Trx, ctx: TenantContext, id: string): Promise<Expense | null> {
  const { rows } = await sql<Row>`select ${COLUMNS} from lbg.expenses e
                                   where e.business_id = ${ctx.businessId} and e.id = ${id}`.execute(trx);
  const r = rows[0];
  return r ? toExpense(r) : null;
}

export async function recordExpense(
  db: Db,
  ctx: TenantContext,
  input: ExpenseInput,
  requestId?: string,
): Promise<Expense> {
  return withTenant(db, ctx, async (trx) => {
    await requireEnabled(trx, ctx);
    const { rows: d } = await sql<{ ok: boolean }>`
      select ${input.date}::date between date '2000-01-01' and (now() at time zone timezone)::date as ok
        from lbg.businesses where id = ${ctx.businessId}`.execute(trx);
    if (!d[0]?.ok) throw new ExpenseError('DATE_INVALID', 'The expense date cannot be in the future.');
    if (input.uploadId) {
      // A receipt of this business, not a scan and not attached to another expense.
      const { rows: u } = await sql<{ free: boolean }>`
        select not exists (select 1 from lbg.ocr_jobs j where j.business_id = u.business_id and j.upload_id = u.id)
               and not exists (select 1 from lbg.expenses x where x.business_id = u.business_id and x.upload_id = u.id)
               as free
          from lbg.uploads u where u.business_id = ${ctx.businessId} and u.id = ${input.uploadId}`.execute(trx);
      if (!u[0]?.free) throw new ExpenseError('ATTACHMENT_INVALID', 'The attachment cannot be used for this expense.');
    }
    const { rows } = await sql<{ id: string }>`
      insert into lbg.expenses (business_id, expense_date, category, amount_paise, method, reference, notes, upload_id,
                                recorded_by)
      values (${ctx.businessId}, ${input.date}::date, ${input.category}, ${input.amountPaise}, ${input.method},
              ${input.reference ?? null}, ${input.notes ?? null}, ${input.uploadId ?? null}, ${ctx.userId})
      returning id`.execute(trx);
    const id = rows[0]?.id ?? '';
    await recordTenantEvent(trx, ctx, {
      action: 'expense.record',
      targetType: 'expense',
      targetId: id,
      metadata: { category: input.category, amountPaise: input.amountPaise, attachment: Boolean(input.uploadId) },
      ...(requestId ? { requestId } : {}),
    });
    const e = await byId(trx, ctx, id);
    if (!e) throw new Error('expense insert returned nothing');
    return e;
  });
}

/** Reverses an expense in full (same date, category and method; negated amount). */
export async function reverseExpense(
  db: Db,
  ctx: TenantContext,
  id: string,
  reason: string,
  requestId?: string,
): Promise<Expense> {
  return withTenant(db, ctx, async (trx) => {
    await requireEnabled(trx, ctx);
    // Expenses are append-only (no UPDATE grant, so no row lock): serialise reversals of one
    // expense with an advisory lock; the unique index on reverses_expense_id is the backstop.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`expense:${id}`}, 61))`.execute(trx);
    const o = await byId(trx, ctx, id);
    if (!o) throw new ExpenseError('NOT_FOUND', 'Expense not found.');
    if (o.reversesExpenseId) throw new ExpenseError('NOT_REVERSIBLE', 'A reversal cannot be reversed.');
    if (o.reversedBy) throw new ExpenseError('ALREADY_REVERSED', 'This expense has already been reversed.');
    const { rows } = await sql<{ id: string }>`
      insert into lbg.expenses (business_id, expense_date, category, amount_paise, method, reverses_expense_id, reason,
                                recorded_by)
      values (${ctx.businessId}, ${o.date}::date, ${o.category}, ${-o.amountPaise}, ${o.method}, ${id},
              ${reason.trim()}, ${ctx.userId})
      returning id`.execute(trx);
    const rid = rows[0]?.id ?? '';
    await recordTenantEvent(trx, ctx, {
      action: 'expense.reverse',
      targetType: 'expense',
      targetId: id,
      metadata: { reversalId: rid, amountPaise: o.amountPaise },
      ...(requestId ? { requestId } : {}),
    });
    const e = await byId(trx, ctx, rid);
    if (!e) throw new Error('reversal insert returned nothing');
    return e;
  });
}

export async function getExpense(db: Db, ctx: TenantContext, id: string): Promise<Expense | null> {
  return withTenant(db, ctx, (trx) => byId(trx, ctx, id));
}

export async function listExpenses(
  db: Db,
  ctx: TenantContext,
  range: { readonly from: string; readonly to: string },
): Promise<Expense[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<Row>`
      select ${COLUMNS} from lbg.expenses e
       where e.business_id = ${ctx.businessId} and e.expense_date between ${range.from}::date and ${range.to}::date
       order by e.expense_date desc, e.created_at desc, e.id limit 1000`.execute(trx);
    return rows.map(toExpense);
  });
}
