// Suppliers (FR-INV-8 AC1). GSTIN format and checksum are validated; that a
// GSTIN is registered is not verified (no GST portal integration).
import { gstinProblem } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { PurchasingError } from './errors.ts';

export interface SupplierInput {
  readonly name: string;
  readonly gstin?: string | null | undefined;
  readonly mobileE164?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly stateCode?: string | null | undefined;
  readonly paymentTerms?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined;
}

export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly mobileE164: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly stateCode: string | null;
  readonly paymentTerms: string | null;
  readonly notes: string | null;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

const COLUMNS: Readonly<Record<keyof SupplierInput, string>> = {
  name: 'name',
  gstin: 'gstin',
  mobileE164: 'mobile_e164',
  email: 'email',
  address: 'address',
  stateCode: 'state_code',
  paymentTerms: 'payment_terms',
  notes: 'notes',
  status: 'status',
};

/** Normalises GSTIN and state: the state defaults to the GSTIN's first two digits. */
function normalise(input: Partial<SupplierInput>): Partial<SupplierInput> {
  const gstin = input.gstin?.trim().toUpperCase() ?? input.gstin;
  if (!gstin) return input;
  const stateCode = input.stateCode ?? gstin.slice(0, 2);
  const problem = gstinProblem(gstin, stateCode);
  if (problem) throw new PurchasingError('GSTIN_INVALID', `GSTIN ${problem.toLowerCase().replace('_', ' ')}`, 'gstin');
  return { ...input, gstin, stateCode };
}

function columns(input: Partial<SupplierInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = input[key as keyof SupplierInput];
    if (value !== undefined) out[column] = value;
  }
  return out;
}

interface SupplierRow {
  id: string;
  name: string;
  gstin: string | null;
  mobile_e164: string | null;
  email: string | null;
  address: string | null;
  state_code: string | null;
  payment_terms: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

const toSupplier = (r: SupplierRow): Supplier => ({
  id: r.id,
  name: r.name,
  gstin: r.gstin,
  mobileE164: r.mobile_e164,
  email: r.email,
  address: r.address,
  stateCode: r.state_code,
  paymentTerms: r.payment_terms,
  notes: r.notes,
  status: r.status,
});

export async function listSuppliers(db: Db, ctx: TenantContext, includeArchived = false): Promise<Supplier[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<SupplierRow>`
      select id, name, gstin, mobile_e164, email, address, state_code, payment_terms, notes, status
        from lbg.suppliers where business_id = ${ctx.businessId} ${includeArchived ? sql`` : sql`and status = 'ACTIVE'`}
       order by lower(name)`.execute(trx);
    return rows.map(toSupplier);
  });
}

export async function getSupplier(db: Db, ctx: TenantContext, id: string): Promise<Supplier | null> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<SupplierRow>`
      select id, name, gstin, mobile_e164, email, address, state_code, payment_terms, notes, status
        from lbg.suppliers where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    const row = rows[0];
    return row ? toSupplier(row) : null;
  });
}

export async function createSupplier(db: Db, ctx: TenantContext, input: SupplierInput): Promise<string> {
  const values = columns(normalise(input));
  return withTenant(db, ctx, async (trx) => {
    const row = await trx
      .insertInto('lbg.suppliers')
      .values({ business_id: ctx.businessId, ...values })
      .returning('id')
      .$castTo<{ id: string }>()
      .executeTakeFirstOrThrow();
    await recordTenantEvent(trx, ctx, { action: 'supplier.create', targetType: 'supplier', targetId: row.id });
    return row.id;
  });
}

export async function updateSupplier(
  db: Db,
  ctx: TenantContext,
  id: string,
  patch: Partial<SupplierInput>,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const current = await getSupplierIn(trx, ctx, id);
    // Re-validate the GSTIN against the resulting state code.
    // A new GSTIN without an explicit state takes its state from the GSTIN.
    const gstin = patch.gstin === undefined ? current.gstin : patch.gstin;
    const stateCode = patch.stateCode !== undefined ? patch.stateCode : patch.gstin ? undefined : current.state_code;
    const merged = normalise({ gstin, stateCode });
    const values = columns({ ...patch, gstin: merged.gstin ?? null, stateCode: merged.stateCode ?? null });
    await trx
      .updateTable('lbg.suppliers')
      .set(values)
      .where('business_id', '=', ctx.businessId)
      .where('id', '=', id)
      .execute();
    await recordTenantEvent(trx, ctx, {
      action: 'supplier.update',
      targetType: 'supplier',
      targetId: id,
      metadata: { fields: Object.keys(patch) },
    });
  });
}

async function getSupplierIn(
  trx: Trx,
  ctx: TenantContext,
  id: string,
): Promise<{ gstin: string | null; state_code: string | null }> {
  const { rows } = await sql<{ gstin: string | null; state_code: string | null }>`
    select gstin, state_code from lbg.suppliers where business_id = ${ctx.businessId} and id = ${id} for update`.execute(
    trx,
  );
  const row = rows[0];
  if (!row) throw new PurchasingError('NOT_FOUND', 'supplier not found');
  return row;
}

export interface SupplierLedgerEntry {
  readonly id: string;
  readonly entryType: 'PURCHASE' | 'PURCHASE_REVERSAL';
  readonly amountPaise: number;
  readonly purchaseId: string | null;
  readonly createdAt: string;
}

/** Entries and running balance owed to a supplier (positive = we owe). */
export async function supplierLedger(
  db: Db,
  ctx: TenantContext,
  supplierId: string,
): Promise<{ entries: SupplierLedgerEntry[]; balancePaise: number } | null> {
  return withTenant(db, ctx, async (trx) => {
    const exists =
      await sql`select 1 from lbg.suppliers where business_id = ${ctx.businessId} and id = ${supplierId}`.execute(trx);
    if (exists.rows.length === 0) return null;
    const { rows } = await sql<{
      id: string;
      entry_type: SupplierLedgerEntry['entryType'];
      amount_paise: string;
      purchase_id: string | null;
      created_at: Date;
    }>`select id, entry_type, amount_paise, purchase_id, created_at from lbg.supplier_ledger_entries
        where business_id = ${ctx.businessId} and supplier_id = ${supplierId} order by created_at, id`.execute(trx);
    const entries = rows.map((r) => ({
      id: r.id,
      entryType: r.entry_type,
      amountPaise: Number(r.amount_paise),
      purchaseId: r.purchase_id,
      createdAt: r.created_at.toISOString(),
    }));
    return { entries, balancePaise: entries.reduce((s, e) => s + e.amountPaise, 0) };
  });
}
