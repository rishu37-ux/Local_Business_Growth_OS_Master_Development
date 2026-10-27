// Customers (FR-POS-5, FR-CRM-1 core fields, FR-CRM-2). Only name and mobile
// are required; the mobile is normalised to E.164 and unique per business.
import { gstinProblem, normalizeMobile } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';

export interface CustomerInput {
  readonly name: string;
  readonly mobile: string;
  readonly email?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly gstin?: string | null | undefined;
  readonly stateCode?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly mobileE164: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
}

export class CustomerError extends Error {
  readonly code: 'NOT_FOUND' | 'MOBILE_INVALID' | 'GSTIN_INVALID' | 'DUPLICATE_MOBILE';
  readonly existingCustomerId: string | undefined;

  constructor(code: CustomerError['code'], message: string, existingCustomerId?: string) {
    super(message);
    this.name = 'CustomerError';
    this.code = code;
    this.existingCustomerId = existingCustomerId;
  }
}

interface Row {
  id: string;
  name: string;
  mobile_e164: string | null;
  email: string | null;
  address: string | null;
  gstin: string | null;
  state_code: string | null;
  notes: string | null;
  created_at: Date;
}

const toCustomer = (r: Row): Customer => ({
  id: r.id,
  name: r.name,
  mobileE164: r.mobile_e164,
  email: r.email,
  address: r.address,
  gstin: r.gstin,
  stateCode: r.state_code,
  notes: r.notes,
  createdAt: r.created_at.toISOString(),
});

const COLUMNS = sql`id, name, mobile_e164, email, address, gstin, state_code, notes, created_at`;

function mobileOrThrow(mobile: string): string {
  const e164 = normalizeMobile(mobile);
  if (!e164) throw new CustomerError('MOBILE_INVALID', 'Enter a valid mobile number.');
  return e164;
}

/** GSTIN upper-cased and checksum-checked; its state becomes the customer's state. */
function gstinAndState(gstin: string | null | undefined, stateCode: string | null | undefined) {
  const g = gstin?.trim() ? gstin.trim().toUpperCase() : null;
  if (g === null) return { gstin: null, stateCode: stateCode ?? null };
  const state = stateCode ?? g.slice(0, 2);
  if (gstinProblem(g, state)) throw new CustomerError('GSTIN_INVALID', 'The GSTIN is not valid.');
  return { gstin: g, stateCode: state };
}

async function byMobileIn(trx: Trx, ctx: TenantContext, e164: string): Promise<Customer | null> {
  const { rows } = await sql<Row>`select ${COLUMNS} from lbg.customers
                                   where business_id = ${ctx.businessId} and mobile_e164 = ${e164}`.execute(trx);
  const row = rows[0];
  return row ? toCustomer(row) : null;
}

export async function findCustomerByMobile(db: Db, ctx: TenantContext, mobile: string): Promise<Customer | null> {
  const e164 = normalizeMobile(mobile);
  if (!e164) return null;
  return withTenant(db, ctx, (trx) => byMobileIn(trx, ctx, e164));
}

export async function searchCustomers(db: Db, ctx: TenantContext, query: string): Promise<Customer[]> {
  return withTenant(db, ctx, async (trx) => {
    const q = query.trim();
    const digits = q.replace(/\D/g, '');
    const pattern = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { rows } = await sql<Row>`
      select ${COLUMNS} from lbg.customers
       where business_id = ${ctx.businessId} and erased_at is null
         and (name ilike ${pattern} ${digits.length >= 4 ? sql`or mobile_e164 like ${'%' + digits + '%'}` : sql``})
       order by lower(name) limit 50`.execute(trx);
    return rows.map(toCustomer);
  });
}

export async function getCustomer(db: Db, ctx: TenantContext, id: string): Promise<Customer | null> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<Row>`select ${COLUMNS} from lbg.customers
                                     where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    const row = rows[0];
    return row ? toCustomer(row) : null;
  });
}

/** Inside the caller's transaction (also used by checkout). */
export async function createCustomerIn(trx: Trx, ctx: TenantContext, input: CustomerInput): Promise<Customer> {
  const e164 = mobileOrThrow(input.mobile);
  const existing = await byMobileIn(trx, ctx, e164);
  if (existing) {
    throw new CustomerError('DUPLICATE_MOBILE', 'A customer with this mobile number already exists.', existing.id);
  }
  const g = gstinAndState(input.gstin, input.stateCode);
  const { rows } = await sql<Row>`
    insert into lbg.customers (business_id, name, mobile_e164, email, address, gstin, state_code, notes)
    values (${ctx.businessId}, ${input.name.trim()}, ${e164}, ${input.email ?? null}, ${input.address ?? null},
            ${g.gstin}, ${g.stateCode}, ${input.notes ?? null})
    returning ${COLUMNS}`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error('customer insert returned nothing');
  await recordTenantEvent(trx, ctx, { action: 'customer.create', targetType: 'customer', targetId: row.id });
  return toCustomer(row);
}

export async function createCustomer(db: Db, ctx: TenantContext, input: CustomerInput): Promise<Customer> {
  try {
    return await withTenant(db, ctx, (trx) => createCustomerIn(trx, ctx, input));
  } catch (err) {
    // Two checkouts creating the same mobile at once: the unique index decides.
    if ((err as { code?: string }).code === '23505') {
      const existing = await findCustomerByMobile(db, ctx, input.mobile);
      throw new CustomerError('DUPLICATE_MOBILE', 'A customer with this mobile number already exists.', existing?.id);
    }
    throw err;
  }
}

export async function updateCustomer(
  db: Db,
  ctx: TenantContext,
  id: string,
  patch: Partial<CustomerInput>,
): Promise<Customer> {
  return withTenant(db, ctx, async (trx) => {
    const { rows: cur } = await sql<Row>`select ${COLUMNS} from lbg.customers
                                          where business_id = ${ctx.businessId} and id = ${id} for update`.execute(trx);
    const current = cur[0];
    if (!current) throw new CustomerError('NOT_FOUND', 'customer not found');
    const e164 = patch.mobile === undefined ? current.mobile_e164 : mobileOrThrow(patch.mobile);
    if (e164 && e164 !== current.mobile_e164) {
      const other = await byMobileIn(trx, ctx, e164);
      if (other)
        throw new CustomerError('DUPLICATE_MOBILE', 'A customer with this mobile number already exists.', other.id);
    }
    const g = gstinAndState(
      patch.gstin === undefined ? current.gstin : patch.gstin,
      patch.stateCode === undefined ? (patch.gstin ? undefined : current.state_code) : patch.stateCode,
    );
    const pick = (k: keyof CustomerInput, fallback: string | null): string | null => {
      const v = patch[k];
      return v === undefined ? fallback : v;
    };
    const { rows } = await sql<Row>`
      update lbg.customers set name = ${pick('name', current.name)}, mobile_e164 = ${e164},
             email = ${pick('email', current.email)}, address = ${pick('address', current.address)},
             gstin = ${g.gstin}, state_code = ${g.stateCode}, notes = ${pick('notes', current.notes)}, updated_at = now()
       where business_id = ${ctx.businessId} and id = ${id}
      returning ${COLUMNS}`.execute(trx);
    const row = rows[0];
    if (!row) throw new CustomerError('NOT_FOUND', 'customer not found');
    // FR-PRV-1 AC1: corrections are audited (field names only, no personal data).
    await recordTenantEvent(trx, ctx, {
      action: 'customer.update',
      targetType: 'customer',
      targetId: id,
      metadata: { fields: Object.keys(patch) },
    });
    return toCustomer(row);
  });
}
