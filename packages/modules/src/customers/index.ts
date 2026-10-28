// Customers (FR-POS-5, FR-CRM-1, FR-CRM-2). Only name and mobile are
// required; the mobile is normalised to E.164 and unique per business.
import { gstinProblem, normalizeMobile, normalizeTags, warrantyEnd, type ContactChannel } from '@lbgos/domain';
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
  readonly alternateMobile?: string | null | undefined;
  /** yyyy-mm-dd; not in the future. */
  readonly dob?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly contactChannels?: readonly ContactChannel[] | undefined;
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
  readonly alternateMobileE164: string | null;
  readonly dob: string | null;
  readonly tags: readonly string[];
  readonly contactChannels: readonly ContactChannel[];
  readonly erased: boolean;
  readonly createdAt: string;
}

export class CustomerError extends Error {
  readonly code: 'NOT_FOUND' | 'MOBILE_INVALID' | 'GSTIN_INVALID' | 'DUPLICATE_MOBILE' | 'DOB_INVALID' | 'TAGS_INVALID';
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
  alternate_mobile_e164: string | null;
  dob: string | null;
  tags: string[];
  contact_channels: ContactChannel[];
  erased_at: Date | null;
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
  alternateMobileE164: r.alternate_mobile_e164,
  dob: r.dob,
  tags: r.tags,
  contactChannels: r.contact_channels,
  erased: r.erased_at !== null,
  createdAt: r.created_at.toISOString(),
});

const COLUMNS = sql`id, name, mobile_e164, email, address, gstin, state_code, notes, alternate_mobile_e164,
                    dob::text as dob, tags, contact_channels, erased_at, created_at`;

function mobileOrThrow(mobile: string): string {
  const e164 = normalizeMobile(mobile);
  if (!e164) throw new CustomerError('MOBILE_INVALID', 'Enter a valid mobile number.');
  return e164;
}

function optionalMobile(mobile: string | null | undefined): string | null {
  return mobile?.trim() ? mobileOrThrow(mobile) : null;
}

/** A date of birth from 1900 up to the business's today. */
async function dobOrThrow(trx: Trx, ctx: TenantContext, dob: string | null | undefined): Promise<string | null> {
  if (!dob) return null;
  const { rows } = await sql<{ ok: boolean }>`
    select (${dob}::date between date '1900-01-01' and (now() at time zone b.timezone)::date) as ok
      from lbg.businesses b where b.id = ${ctx.businessId}`.execute(trx);
  if (!rows[0]?.ok) throw new CustomerError('DOB_INVALID', 'Enter a date of birth that is not in the future.');
  return dob;
}

function tagsOrThrow(tags: readonly string[] | undefined): string[] {
  const t = normalizeTags(tags ?? []);
  if (!t) throw new CustomerError('TAGS_INVALID', 'Use up to 10 tags of at most 30 characters, without commas.');
  return t;
}

const channels = (c: readonly ContactChannel[] | undefined): ContactChannel[] => [...new Set(c ?? [])];

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
  const alt = optionalMobile(input.alternateMobile);
  const dob = await dobOrThrow(trx, ctx, input.dob);
  const tags = tagsOrThrow(input.tags);
  const { rows } = await sql<Row>`
    insert into lbg.customers (business_id, name, mobile_e164, email, address, gstin, state_code, notes,
                               alternate_mobile_e164, dob, tags, contact_channels)
    values (${ctx.businessId}, ${input.name.trim()}, ${e164}, ${input.email ?? null}, ${input.address ?? null},
            ${g.gstin}, ${g.stateCode}, ${input.notes ?? null}, ${alt}, ${dob}::date, ${tags}::text[],
            ${channels(input.contactChannels)}::text[])
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
    // An erased customer stays erased (FR-PRV-1).
    if (!current || current.erased_at) throw new CustomerError('NOT_FOUND', 'customer not found');
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
    const pick = (k: 'name' | 'email' | 'address' | 'notes', fallback: string | null): string | null => {
      const v = patch[k];
      return v === undefined ? fallback : v;
    };
    const alt =
      patch.alternateMobile === undefined ? current.alternate_mobile_e164 : optionalMobile(patch.alternateMobile);
    const dob = patch.dob === undefined ? current.dob : await dobOrThrow(trx, ctx, patch.dob);
    const tags = patch.tags === undefined ? current.tags : tagsOrThrow(patch.tags);
    const chans = patch.contactChannels === undefined ? current.contact_channels : channels(patch.contactChannels);
    const { rows } = await sql<Row>`
      update lbg.customers set name = ${pick('name', current.name)}, mobile_e164 = ${e164},
             email = ${pick('email', current.email)}, address = ${pick('address', current.address)},
             gstin = ${g.gstin}, state_code = ${g.stateCode}, notes = ${pick('notes', current.notes)},
             alternate_mobile_e164 = ${alt}, dob = ${dob}::date, tags = ${tags}::text[],
             contact_channels = ${chans}::text[], updated_at = now()
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

// ---------------------------------------------------------------------------
// Owned items and warranty (FR-CRM-1 AC2)
// ---------------------------------------------------------------------------

export interface OwnedItem {
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly saleDate: string;
  readonly description: string;
  readonly unitId: string | null;
  readonly imeis: readonly string[];
  readonly serialNumber: string | null;
  /** As recorded at the sale: 0 = no warranty, null = not recorded (sold before warranty recording). */
  readonly warrantyMonths: number | null;
  readonly warrantyProvider: string | null;
  readonly warrantyEnd: string | null;
}

/**
 * Units (serialised) and warranty-carrying items the customer bought on issued
 * invoices, less those returned on a credit note. The warranty end date is the
 * sale date plus the months recorded on the invoice line.
 */
export async function customerOwnedItems(db: Db, ctx: TenantContext, customerId: string): Promise<OwnedItem[]> {
  return withTenant(db, ctx, async (trx) => {
    const exists =
      await sql`select 1 from lbg.customers where business_id = ${ctx.businessId} and id = ${customerId}`.execute(trx);
    if (exists.rows.length === 0) throw new CustomerError('NOT_FOUND', 'customer not found');
    const { rows } = await sql<{
      invoice_id: string;
      invoice_number: string | null;
      invoice_date: string;
      description: string;
      unit_id: string | null;
      imeis: string[] | null;
      serial_number: string | null;
      warranty_months: number | null;
      warranty_provider: string | null;
    }>`
      select i.id as invoice_id, i.invoice_number, i.invoice_date::text as invoice_date, l.description, l.unit_id,
             (select array_agg(m.imei order by m.slot) from lbg.serialized_unit_imeis m
               where m.business_id = l.business_id and m.unit_id = l.unit_id) as imeis,
             u.serial_number, l.warranty_months, l.warranty_provider
        from lbg.invoice_lines l
        join lbg.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
        left join lbg.serialized_units u on u.business_id = l.business_id and u.id = l.unit_id
       where l.business_id = ${ctx.businessId} and i.customer_id = ${customerId} and i.status = 'ISSUED'
         and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY')
         and (l.unit_id is not null or l.warranty_months > 0)
         and l.quantity > coalesce((select sum(c.quantity) from lbg.invoice_lines c
                                      join lbg.invoices n on n.business_id = c.business_id and n.id = c.invoice_id
                                     where c.business_id = l.business_id and c.original_line_id = l.id
                                       and n.document_type = 'CREDIT_NOTE' and n.status = 'ISSUED'), 0)
       order by i.invoice_date desc, i.invoice_number desc, l.line_no limit 500`.execute(trx);
    return rows.map((r) => ({
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      saleDate: r.invoice_date,
      description: r.description,
      unitId: r.unit_id,
      imeis: r.imeis ?? [],
      serialNumber: r.serial_number,
      warrantyMonths: r.warranty_months,
      warrantyProvider: r.warranty_provider,
      warrantyEnd: warrantyEnd(r.invoice_date, r.warranty_months),
    }));
  });
}

// ---------------------------------------------------------------------------
// Customer export (FR-CRM-2 AC2)
// ---------------------------------------------------------------------------

export const CUSTOMER_EXPORT_FIELDS = {
  name: { label: 'Name', column: sql`name` },
  mobile: { label: 'Mobile', column: sql`mobile_e164` },
  alternateMobile: { label: 'Alternate mobile', column: sql`alternate_mobile_e164` },
  email: { label: 'Email', column: sql`email::text` },
  address: { label: 'Address', column: sql`address` },
  gstin: { label: 'GSTIN', column: sql`gstin` },
  stateCode: { label: 'State code', column: sql`state_code::text` },
  dob: { label: 'Date of birth', column: sql`dob::text` },
  tags: { label: 'Tags', column: sql`array_to_string(tags, '; ')` },
  contactChannels: { label: 'Preferred channels', column: sql`array_to_string(contact_channels, '; ')` },
  notes: { label: 'Notes', column: sql`notes` },
  createdAt: { label: 'Customer since', column: sql`(created_at at time zone b.timezone)::date::text` },
} as const;
export type CustomerExportField = keyof typeof CUSTOMER_EXPORT_FIELDS;

export interface CustomerExport {
  readonly fields: readonly CustomerExportField[];
  readonly labels: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * Only the chosen fields, in the order chosen, for customers not erased
 * (optionally those with a tag). Audited with the field names, the row count
 * and the tag filter — no personal data.
 */
export async function exportCustomers(
  db: Db,
  ctx: TenantContext,
  opts: { readonly fields: readonly CustomerExportField[]; readonly tag?: string | undefined },
  requestId?: string,
): Promise<CustomerExport> {
  const fields = [...new Set(opts.fields)];
  if (fields.length === 0) throw new RangeError('choose at least one field');
  return withTenant(db, ctx, async (trx) => {
    const cols = sql.join(fields.map((f) => sql`${CUSTOMER_EXPORT_FIELDS[f].column} as ${sql.ref(f)}`));
    const { rows } = await sql<Record<string, string | null>>`
      select ${cols} from lbg.customers c join lbg.businesses b on b.id = c.business_id
       where c.business_id = ${ctx.businessId} and c.erased_at is null
         ${opts.tag ? sql`and lower(${opts.tag}) = any(select lower(t) from unnest(c.tags) t)` : sql``}
       order by lower(c.name), c.id`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'customer.export',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { fields, count: rows.length, ...(opts.tag ? { tagFilter: true } : {}) },
      ...(requestId ? { requestId } : {}),
    });
    return {
      fields,
      labels: fields.map((f) => CUSTOMER_EXPORT_FIELDS[f].label),
      rows: rows.map((r) => fields.map((f) => r[f] ?? null)),
    };
  });
}
