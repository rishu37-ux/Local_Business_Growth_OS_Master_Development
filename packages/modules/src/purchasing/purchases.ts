// Purchases: draft → post → reverse (FR-INV-5, FR-INV-8, WORKFLOWS §5).
// Drafts never touch stock. Posting writes units, IMEIs, stock movements,
// weighted-average costs and the supplier payable in one transaction.
import {
  lineCost,
  milliToQuantity,
  purchaseTotals,
  quantityToMilli,
  rateToBasisPoints,
  splitAmount,
  unitCostFromLine,
  weightedAverageCost,
  type PurchaseLineAmounts,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { lockUnit, setUnitStatus, writeMovement } from '../inventory/index.ts';
import { PurchasingError } from './errors.ts';
import { checkPurchase, type CheckedLine, type PurchaseProblem } from './problems.ts';

export type PurchaseStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'DISCARDED';

export interface UnitInput {
  readonly imei1?: string | null | undefined;
  readonly imei2?: string | null | undefined;
  readonly serialNumber?: string | null | undefined;
}

export interface LineInput {
  readonly variantId: string;
  /** Exact decimal text, e.g. "2" or "1.5". */
  readonly quantity: string;
  readonly unitCostPaise: number;
  /** Omitted: the variant's default rate. null: no rate. */
  readonly taxRateId?: string | null | undefined;
  readonly units?: readonly UnitInput[] | undefined;
}

export interface PurchaseDraftInput {
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  /** yyyy-mm-dd */
  readonly supplierInvoiceDate: string;
  readonly supplierTotalPaise?: number | null | undefined;
  readonly notes?: string | null | undefined;
  readonly lines: readonly LineInput[];
}

export interface PurchaseLineView extends PurchaseLineAmounts {
  readonly id: string;
  readonly lineNo: number;
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly serialized: boolean;
  readonly quantity: string;
  readonly unitCostPaise: number;
  readonly taxRateId: string | null;
  readonly ratePercent: string;
  readonly units: readonly {
    readonly position: number;
    readonly imei1: string | null;
    readonly imei2: string | null;
    readonly serialNumber: string | null;
    readonly unitId: string | null;
  }[];
}

export interface PurchaseView {
  readonly id: string;
  readonly status: PurchaseStatus;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly supplierInvoiceNo: string;
  readonly supplierInvoiceDate: string;
  readonly supplierTotalPaise: number | null;
  readonly notes: string | null;
  readonly isInterState: boolean;
  readonly totals: PurchaseLineAmounts;
  readonly lines: readonly PurchaseLineView[];
  /** Deterministic checks; empty once posted. */
  readonly problems: readonly PurchaseProblem[];
  readonly postedAt: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
  readonly duplicateOverrideReason: string | null;
}

// ---------------------------------------------------------------------------
// Loading and computing
// ---------------------------------------------------------------------------

interface HeaderRow {
  id: string;
  status: PurchaseStatus;
  supplier_id: string;
  supplier_name: string;
  supplier_state: string | null;
  business_state: string | null;
  supplier_invoice_no: string;
  supplier_invoice_date: string;
  supplier_total_paise: string | null;
  notes: string | null;
  is_inter_state: boolean;
  taxable_paise: string;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
  cess_paise: string;
  tax_paise: string;
  total_paise: string;
  posted_at: Date | null;
  reversed_at: Date | null;
  reversal_reason: string | null;
  duplicate_override_reason: string | null;
}

interface LineRow {
  id: string;
  line_no: number;
  variant_id: string;
  sku: string;
  product_name: string;
  is_serialized: boolean;
  variant_status: string;
  quantity: string;
  unit_cost_paise: string;
  tax_rate_id: string | null;
  // Version in force on the invoice date, resolved now (drafts) — or the stored snapshot.
  effective_rate_id: string | null;
  effective_rate: string | null;
  effective_cess: string | null;
  rate_percent: string;
  cess_percent: string;
  taxable_paise: string;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
  cess_paise: string;
}

interface UnitRow {
  line_id: string;
  position: number;
  imei1: string | null;
  imei2: string | null;
  serial_number: string | null;
  unit_id: string | null;
}

interface Loaded {
  header: HeaderRow;
  lines: LineRow[];
  units: Map<string, UnitRow[]>;
}

async function load(trx: Trx, ctx: TenantContext, id: string, lock: boolean): Promise<Loaded | null> {
  const header = (
    await sql<HeaderRow>`
      select p.id, p.status, p.supplier_id, s.name as supplier_name, s.state_code as supplier_state,
             b.state_code as business_state, p.supplier_invoice_no, p.supplier_invoice_date::text as supplier_invoice_date,
             p.supplier_total_paise, p.notes, p.is_inter_state, p.taxable_paise, p.cgst_paise, p.sgst_paise,
             p.igst_paise, p.cess_paise, p.tax_paise, p.total_paise, p.posted_at, p.reversed_at, p.reversal_reason,
             p.duplicate_override_reason
        from lbg.purchases p
        join lbg.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
        join lbg.businesses b on b.id = p.business_id
       where p.business_id = ${ctx.businessId} and p.id = ${id}
       ${lock ? sql`for update of p` : sql``}`.execute(trx)
  ).rows[0];
  if (!header) return null;
  const lines = (
    await sql<LineRow>`
      select l.id, l.line_no, l.variant_id, v.sku, p.model_name as product_name, p.is_serialized,
             v.status as variant_status, l.quantity::text as quantity, l.unit_cost_paise, l.tax_rate_id,
             r.id as effective_rate_id, r.rate_percent::text as effective_rate, r.cess_percent::text as effective_cess,
             l.rate_percent::text as rate_percent, l.cess_percent::text as cess_percent, l.taxable_paise,
             l.cgst_paise, l.sgst_paise, l.igst_paise, l.cess_paise
        from lbg.purchase_lines l
        join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
        left join lbg.tax_rates r
          on r.id = lbg.effective_tax_rate(l.tax_rate_id, ${header.supplier_invoice_date}::date)
       where l.business_id = ${ctx.businessId} and l.purchase_id = ${id}
       order by l.line_no`.execute(trx)
  ).rows;
  const unitRows = (
    await sql<UnitRow>`
      select u.line_id, u.position, u.imei1, u.imei2, u.serial_number, u.unit_id
        from lbg.purchase_line_units u
        join lbg.purchase_lines l on l.business_id = u.business_id and l.id = u.line_id
       where u.business_id = ${ctx.businessId} and l.purchase_id = ${id}
       order by u.line_id, u.position`.execute(trx)
  ).rows;
  const units = new Map<string, UnitRow[]>();
  for (const u of unitRows) units.set(u.line_id, [...(units.get(u.line_id) ?? []), u]);
  return { header, lines, units };
}

const isInterState = (h: HeaderRow) =>
  h.supplier_state !== null && h.business_state !== null && h.supplier_state !== h.business_state;

/** Amounts for each line from current inputs (drafts) — the same code that posting uses. */
function compute(l: Loaded) {
  const inter = isInterState(l.header);
  return purchaseTotals(
    l.lines.map((line) => ({
      qtyMilli: quantityToMilli(line.quantity),
      unitCostPaise: Number(line.unit_cost_paise),
      rateBp: line.effective_rate === null ? 0 : rateToBasisPoints(line.effective_rate),
      cessBp: line.effective_cess === null ? 0 : rateToBasisPoints(line.effective_cess),
    })),
    inter,
  );
}

async function problemsFor(
  trx: Trx,
  ctx: TenantContext,
  l: Loaded,
  canViewInventory: boolean,
): Promise<PurchaseProblem[]> {
  const totals = compute(l);
  const all = [...l.units.values()].flat();
  const imeis = all.flatMap((u) => [u.imei1, u.imei2]).filter((x): x is string => x !== null);
  const existing = new Map<string, string>();
  const otherDrafts = new Set<string>();
  const serials = new Set<string>();
  if (imeis.length > 0) {
    const ex = await sql<{ imei: string; unit_id: string }>`
      select imei, unit_id from lbg.serialized_unit_imeis
       where business_id = ${ctx.businessId} and imei = any(${imeis}::text[])`.execute(trx);
    for (const r of ex.rows) existing.set(r.imei, r.unit_id);
    const drafts = await sql<{ imei: string }>`
      select x.imei from lbg.purchase_line_units u
        join lbg.purchase_lines l on l.business_id = u.business_id and l.id = u.line_id
        join lbg.purchases p on p.business_id = l.business_id and p.id = l.purchase_id
        cross join lateral (values (u.imei1), (u.imei2)) as x(imei)
       where u.business_id = ${ctx.businessId} and p.status = 'DRAFT' and p.id <> ${l.header.id}
         and x.imei = any(${imeis}::text[])`.execute(trx);
    for (const r of drafts.rows) otherDrafts.add(r.imei);
  }
  const serialKeys = l.lines.flatMap((line) =>
    (l.units.get(line.id) ?? []).flatMap((u) => (u.serial_number ? [`${line.variant_id}|${u.serial_number}`] : [])),
  );
  if (serialKeys.length > 0) {
    const ex = await sql<{ key: string }>`
      select variant_id || '|' || serial_number as key from lbg.serialized_units
       where business_id = ${ctx.businessId} and serial_number is not null
         and variant_id || '|' || serial_number = any(${serialKeys}::text[])`.execute(trx);
    for (const r of ex.rows) serials.add(r.key);
  }
  const dup = await sql<{ n: number }>`
    select count(*)::int as n from lbg.purchases
     where business_id = ${ctx.businessId} and supplier_id = ${l.header.supplier_id} and status = 'POSTED'
       and lower(supplier_invoice_no) = lower(${l.header.supplier_invoice_no}) and id <> ${l.header.id}`.execute(trx);
  const lines: CheckedLine[] = l.lines.map((line) => ({
    lineNo: line.line_no,
    variantId: line.variant_id,
    serialized: line.is_serialized,
    archived: line.variant_status === 'ARCHIVED',
    qtyMilli: quantityToMilli(line.quantity),
    hasRate: line.tax_rate_id !== null,
    rateNotEffective: line.tax_rate_id !== null && line.effective_rate_id === null,
    units: (l.units.get(line.id) ?? []).map((u) => ({
      position: u.position,
      imei1: u.imei1,
      imei2: u.imei2,
      serialNumber: u.serial_number,
    })),
  }));
  return checkPurchase({
    lines,
    existingImeis: existing,
    otherDraftImeis: otherDrafts,
    existingSerials: serials,
    computedTotalPaise: totals.total,
    supplierTotalPaise: l.header.supplier_total_paise === null ? null : Number(l.header.supplier_total_paise),
    duplicateSupplierInvoice: (dup.rows[0]?.n ?? 0) > 0,
    canViewInventory,
  });
}

const n = (v: string | null) => (v === null ? null : Number(v));

function view(l: Loaded, problems: PurchaseProblem[]): PurchaseView {
  const draft = l.header.status === 'DRAFT';
  const computed = draft ? compute(l) : undefined;
  const lines = l.lines.map((line, i): PurchaseLineView => {
    const tax = Number(line.cgst_paise) + Number(line.sgst_paise) + Number(line.igst_paise) + Number(line.cess_paise);
    const amounts: PurchaseLineAmounts = computed?.lines[i] ?? {
      taxable: Number(line.taxable_paise),
      cgst: Number(line.cgst_paise),
      sgst: Number(line.sgst_paise),
      igst: Number(line.igst_paise),
      cess: Number(line.cess_paise),
      tax,
      total: Number(line.taxable_paise) + tax,
    };
    return {
      ...amounts,
      id: line.id,
      lineNo: line.line_no,
      variantId: line.variant_id,
      sku: line.sku,
      productName: line.product_name,
      serialized: line.is_serialized,
      quantity: line.quantity,
      unitCostPaise: Number(line.unit_cost_paise),
      taxRateId: draft ? (line.effective_rate_id ?? line.tax_rate_id) : line.tax_rate_id,
      ratePercent: draft ? (line.effective_rate ?? '0.00') : line.rate_percent,
      units: (l.units.get(line.id) ?? []).map((u) => ({
        position: u.position,
        imei1: u.imei1,
        imei2: u.imei2,
        serialNumber: u.serial_number,
        unitId: u.unit_id,
      })),
    };
  });
  const h = l.header;
  const totals = computed
    ? {
        taxable: computed.taxable,
        cgst: computed.cgst,
        sgst: computed.sgst,
        igst: computed.igst,
        cess: computed.cess,
        tax: computed.tax,
        total: computed.total,
      }
    : {
        taxable: Number(h.taxable_paise),
        cgst: Number(h.cgst_paise),
        sgst: Number(h.sgst_paise),
        igst: Number(h.igst_paise),
        cess: Number(h.cess_paise),
        tax: Number(h.tax_paise),
        total: Number(h.total_paise),
      };
  return {
    id: h.id,
    status: h.status,
    supplierId: h.supplier_id,
    supplierName: h.supplier_name,
    supplierInvoiceNo: h.supplier_invoice_no,
    supplierInvoiceDate: h.supplier_invoice_date,
    supplierTotalPaise: n(h.supplier_total_paise),
    notes: h.notes,
    isInterState: draft ? isInterState(h) : h.is_inter_state,
    totals,
    lines,
    problems,
    postedAt: h.posted_at?.toISOString() ?? null,
    reversedAt: h.reversed_at?.toISOString() ?? null,
    reversalReason: h.reversal_reason,
    duplicateOverrideReason: h.duplicate_override_reason,
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function cleanUnit(u: UnitInput) {
  const t = (v: string | null | undefined) => {
    const s = v?.trim();
    return s ? s : null;
  };
  return { imei1: t(u.imei1), imei2: t(u.imei2), serialNumber: t(u.serialNumber) };
}

async function writeLines(trx: Trx, ctx: TenantContext, purchaseId: string, lines: readonly LineInput[]) {
  await sql`delete from lbg.purchase_line_units u using lbg.purchase_lines l
             where l.business_id = u.business_id and l.id = u.line_id
               and u.business_id = ${ctx.businessId} and l.purchase_id = ${purchaseId}`.execute(trx);
  await sql`delete from lbg.purchase_lines where business_id = ${ctx.businessId} and purchase_id = ${purchaseId}`.execute(
    trx,
  );
  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1;
    const variant = (
      await sql<{ tax_rate_id: string | null }>`
        select tax_rate_id from lbg.product_variants where business_id = ${ctx.businessId} and id = ${line.variantId}`.execute(
        trx,
      )
    ).rows[0];
    if (!variant) throw new PurchasingError('INVALID_LINE', `line ${String(lineNo)}: variant not found`, 'variantId');
    const rateId = line.taxRateId === undefined ? variant.tax_rate_id : line.taxRateId;
    let qty: string;
    try {
      qty = milliToQuantity(quantityToMilli(line.quantity));
    } catch {
      throw new PurchasingError('INVALID_LINE', `line ${String(lineNo)}: invalid quantity`, 'quantity');
    }
    if (qty === '0.000')
      throw new PurchasingError('INVALID_LINE', `line ${String(lineNo)}: quantity must be positive`, 'quantity');
    let lineId: string;
    try {
      lineId =
        (
          await sql<{ id: string }>`
            insert into lbg.purchase_lines (business_id, purchase_id, line_no, variant_id, quantity, unit_cost_paise,
                                            tax_rate_id, taxable_paise)
            values (${ctx.businessId}, ${purchaseId}, ${lineNo}, ${line.variantId}, ${qty}::numeric, ${line.unitCostPaise},
                    ${rateId}, 0)
            returning id`.execute(trx)
        ).rows[0]?.id ?? '';
    } catch (err) {
      if ((err as { code?: string }).code === '23503')
        throw new PurchasingError('INVALID_LINE', `line ${String(lineNo)}: tax rate not found`, 'taxRateId');
      throw err;
    }
    for (const [j, raw] of (line.units ?? []).entries()) {
      const u = cleanUnit(raw);
      if (u.imei1 === null && u.serialNumber === null) {
        throw new PurchasingError(
          'INVALID_LINE',
          `line ${String(lineNo)} unit ${String(j + 1)}: IMEI 1 or serial number is required`,
          'imei1',
        );
      }
      if ((u.imei1 && !/^\d{1,20}$/.test(u.imei1)) || (u.imei2 && !/^\d{1,20}$/.test(u.imei2))) {
        throw new PurchasingError(
          'INVALID_LINE',
          `line ${String(lineNo)} unit ${String(j + 1)}: IMEIs are digits only`,
          'imei1',
        );
      }
      await sql`insert into lbg.purchase_line_units (business_id, line_id, position, imei1, imei2, serial_number)
                values (${ctx.businessId}, ${lineId}, ${j + 1}, ${u.imei1}, ${u.imei2}, ${u.serialNumber})`.execute(
        trx,
      );
    }
  }
}

/** Stores computed line amounts and totals on a draft, so lists show current figures. */
async function persistAmounts(trx: Trx, ctx: TenantContext, l: Loaded): Promise<void> {
  const t = compute(l);
  for (const [i, line] of l.lines.entries()) {
    const a = t.lines[i];
    if (!a) continue;
    await sql`update lbg.purchase_lines set taxable_paise = ${a.taxable}, cgst_paise = ${a.cgst}, sgst_paise = ${a.sgst},
                igst_paise = ${a.igst}, cess_paise = ${a.cess},
                rate_percent = ${line.effective_rate ?? '0'}::numeric, cess_percent = ${line.effective_cess ?? '0'}::numeric,
                tax_rate_id = coalesce(${line.effective_rate_id}::uuid, tax_rate_id)
               where business_id = ${ctx.businessId} and id = ${line.id}`.execute(trx);
  }
  await sql`update lbg.purchases set is_inter_state = ${isInterState(l.header)}, taxable_paise = ${t.taxable},
              cgst_paise = ${t.cgst}, sgst_paise = ${t.sgst}, igst_paise = ${t.igst}, cess_paise = ${t.cess},
              tax_paise = ${t.tax}, total_paise = ${t.total}
             where business_id = ${ctx.businessId} and id = ${l.header.id}`.execute(trx);
}

async function saveDraftIn(trx: Trx, ctx: TenantContext, id: string, input: PurchaseDraftInput) {
  await writeLines(trx, ctx, id, input.lines);
  const l = await load(trx, ctx, id, false);
  if (l) await persistAmounts(trx, ctx, l);
}

const translateHeaderError = (err: unknown): never => {
  if ((err as { code?: string }).code === '23503') {
    throw new PurchasingError('INVALID_LINE', 'supplier not found', 'supplierId');
  }
  throw err;
};

export async function createPurchaseDraft(db: Db, ctx: TenantContext, input: PurchaseDraftInput): Promise<string> {
  return withTenant(db, ctx, (trx) => createPurchaseDraftIn(trx, ctx, input));
}

/** As createPurchaseDraft, inside the caller's tenant transaction (e.g. creating a draft from a scan). */
export async function createPurchaseDraftIn(trx: Trx, ctx: TenantContext, input: PurchaseDraftInput): Promise<string> {
  let id: string;
  try {
    id =
      (
        await sql<{ id: string }>`
          insert into lbg.purchases (business_id, supplier_id, supplier_invoice_no, supplier_invoice_date,
                                     supplier_total_paise, notes, created_by)
          values (${ctx.businessId}, ${input.supplierId}, ${input.supplierInvoiceNo.trim()},
                  ${input.supplierInvoiceDate}::date, ${input.supplierTotalPaise ?? null}, ${input.notes ?? null},
                  ${ctx.userId})
          returning id`.execute(trx)
      ).rows[0]?.id ?? '';
  } catch (err) {
    return translateHeaderError(err);
  }
  await saveDraftIn(trx, ctx, id, input);
  await recordTenantEvent(trx, ctx, { action: 'purchase.draft.create', targetType: 'purchase', targetId: id });
  return id;
}

async function lockDraft(trx: Trx, ctx: TenantContext, id: string): Promise<void> {
  const { rows } = await sql<{ status: PurchaseStatus }>`
    select status from lbg.purchases where business_id = ${ctx.businessId} and id = ${id} for update`.execute(trx);
  const status = rows[0]?.status;
  if (!status) throw new PurchasingError('NOT_FOUND', 'purchase not found');
  if (status !== 'DRAFT')
    throw new PurchasingError('NOT_DRAFT', `This purchase is ${status.toLowerCase()} and cannot be edited.`);
}

export async function updatePurchaseDraft(
  db: Db,
  ctx: TenantContext,
  id: string,
  input: PurchaseDraftInput,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await lockDraft(trx, ctx, id);
    try {
      await sql`update lbg.purchases set supplier_id = ${input.supplierId}, supplier_invoice_no = ${input.supplierInvoiceNo.trim()},
                  supplier_invoice_date = ${input.supplierInvoiceDate}::date,
                  supplier_total_paise = ${input.supplierTotalPaise ?? null}, notes = ${input.notes ?? null}
                 where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    } catch (err) {
      translateHeaderError(err);
    }
    await saveDraftIn(trx, ctx, id, input);
    await recordTenantEvent(trx, ctx, { action: 'purchase.draft.update', targetType: 'purchase', targetId: id });
  });
}

export async function discardPurchase(db: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    await lockDraft(trx, ctx, id);
    await sql`update lbg.purchases set status = 'DISCARDED' where business_id = ${ctx.businessId} and id = ${id}`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, { action: 'purchase.discard', targetType: 'purchase', targetId: id });
  });
}

export async function getPurchase(
  db: Db,
  ctx: TenantContext,
  id: string,
  canViewInventory: boolean,
): Promise<PurchaseView | null> {
  return withTenant(db, ctx, async (trx) => {
    const l = await load(trx, ctx, id, false);
    if (!l) return null;
    const problems = l.header.status === 'DRAFT' ? await problemsFor(trx, ctx, l, canViewInventory) : [];
    return view(l, problems);
  });
}

export interface PurchaseSummary {
  readonly id: string;
  readonly status: PurchaseStatus;
  readonly supplierName: string;
  readonly supplierInvoiceNo: string;
  readonly supplierInvoiceDate: string;
  readonly totalPaise: number;
  readonly lineCount: number;
}

export async function listPurchases(
  db: Db,
  ctx: TenantContext,
  filter: { readonly status?: PurchaseStatus | undefined; readonly supplierId?: string | undefined } = {},
): Promise<PurchaseSummary[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      status: PurchaseStatus;
      supplier_name: string;
      supplier_invoice_no: string;
      supplier_invoice_date: string;
      total_paise: string;
      line_count: number;
    }>`
      select p.id, p.status, s.name as supplier_name, p.supplier_invoice_no,
             p.supplier_invoice_date::text as supplier_invoice_date, p.total_paise,
             (select count(*)::int from lbg.purchase_lines l where l.business_id = p.business_id and l.purchase_id = p.id) as line_count
        from lbg.purchases p join lbg.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
       where p.business_id = ${ctx.businessId}
         ${filter.status ? sql`and p.status = ${filter.status}` : sql``}
         ${filter.supplierId ? sql`and p.supplier_id = ${filter.supplierId}` : sql``}
       order by p.created_at desc limit 500`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      supplierName: r.supplier_name,
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierInvoiceDate: r.supplier_invoice_date,
      totalPaise: Number(r.total_paise),
      lineCount: r.line_count,
    }));
  });
}

// ---------------------------------------------------------------------------
// Posting and reversal
// ---------------------------------------------------------------------------

const pgCode = (err: unknown) => (err as { code?: string }).code;

/** D-033: only regular GST registrants exclude (creditable) tax from inventory cost. */
async function taxIsCost(trx: Trx, ctx: TenantContext): Promise<boolean> {
  const { rows } = await sql<{ registration_type: string }>`
    select registration_type from lbg.tax_profiles where business_id = ${ctx.businessId}`.execute(trx);
  return rows[0]?.registration_type !== 'REGULAR';
}

export async function postPurchase(
  db: Db,
  ctx: TenantContext,
  id: string,
  options: { readonly overrideReason?: string | undefined; readonly requestId?: string | undefined } = {},
): Promise<PurchaseView> {
  return withTenant(db, ctx, async (trx) => {
    await lockDraft(trx, ctx, id);
    const loaded = await load(trx, ctx, id, true);
    if (!loaded) throw new PurchasingError('NOT_FOUND', 'purchase not found');
    const override = options.overrideReason?.trim();
    const problems = await problemsFor(trx, ctx, loaded, true);
    const blocking = problems.filter(
      (p) =>
        p.severity === 'BLOCKING' && !(p.code === 'DUPLICATE_SUPPLIER_INVOICE' && override && override.length >= 10),
    );
    if (blocking.length > 0) {
      const code = blocking.every((p) => p.code === 'DUPLICATE_SUPPLIER_INVOICE')
        ? 'DUPLICATE_SUPPLIER_INVOICE'
        : 'BLOCKING_PROBLEMS';
      // The reasons are in the message too, so the person sees what to fix where the error is shown.
      const reasons = blocking
        .slice(0, 5)
        .map((p) => `${p.lineNo ? `Line ${String(p.lineNo)}: ` : ''}${p.message}`)
        .join(' ');
      throw new PurchasingError(
        code,
        `This purchase cannot be posted yet. Must fix: ${reasons}${blocking.length > 5 ? ` (and ${String(blocking.length - 5)} more)` : ''}`,
        undefined,
        blocking,
      );
    }
    const isDuplicate = problems.some((p) => p.code === 'DUPLICATE_SUPPLIER_INVOICE');
    await persistAmounts(trx, ctx, loaded);
    const totals = compute(loaded);
    const costIncludesTax = await taxIsCost(trx, ctx);

    for (const [i, line] of loaded.lines.entries()) {
      const amounts = totals.lines[i];
      if (!amounts) continue;
      const qtyMilli = quantityToMilli(line.quantity);
      const cost = lineCost(amounts, costIncludesTax);
      const unitCostPaise = Number(line.unit_cost_paise);
      const variant = (
        await sql<{ avg_cost_paise: string | null; on_hand_milli: string }>`
          select v.avg_cost_paise,
                 (coalesce((select sum(quantity) from lbg.stock_levels s
                             where s.business_id = v.business_id and s.variant_id = v.id), 0) * 1000)::bigint
                   as on_hand_milli
            from lbg.product_variants v where v.business_id = ${ctx.businessId} and v.id = ${line.variant_id}
             for update of v`.execute(trx)
      ).rows[0];
      if (!variant) throw new PurchasingError('INVALID_LINE', 'variant not found');

      if (line.is_serialized) {
        const units = loaded.units.get(line.id) ?? [];
        const costs = splitAmount(cost, units.length);
        for (const [j, u] of units.entries()) {
          const unitCost = costs[j] ?? 0;
          const unitId =
            (
              await sql<{ id: string }>`
                insert into lbg.serialized_units (business_id, variant_id, serial_number, status, unit_cost_paise, purchase_id)
                values (${ctx.businessId}, ${line.variant_id}, ${u.serial_number}, 'IN_STOCK', ${unitCost}, ${id})
                returning id`.execute(trx)
            ).rows[0]?.id ?? '';
          try {
            for (const [slot, imei] of [
              [1, u.imei1],
              [2, u.imei2],
            ] as const) {
              if (imei === null) continue;
              await sql`insert into lbg.serialized_unit_imeis (business_id, imei, unit_id, slot)
                        values (${ctx.businessId}, ${imei}, ${unitId}, ${slot})`.execute(trx);
            }
          } catch (err) {
            // A concurrent posting took the IMEI after our checks ran (FR-INV-3 AC3).
            if (pgCode(err) === '23505')
              throw new PurchasingError('IMEI_TAKEN', 'An IMEI on this purchase was just recorded elsewhere.');
            throw err;
          }
          await writeMovement(trx, ctx, {
            variantId: line.variant_id,
            unitId,
            type: 'PURCHASE',
            quantity: '1',
            unitCostPaise: unitCost,
            referenceType: 'PURCHASE',
            referenceId: id,
          });
          await sql`update lbg.purchase_line_units set unit_id = ${unitId}
                     where business_id = ${ctx.businessId} and line_id = ${line.id} and position = ${u.position}`.execute(
            trx,
          );
        }
        await sql`update lbg.product_variants set purchase_price_paise = ${unitCostPaise}
                   where business_id = ${ctx.businessId} and id = ${line.variant_id}`.execute(trx);
      } else {
        const perUnit = unitCostFromLine(cost, qtyMilli);
        const avg = weightedAverageCost({
          onHandMilli: Number(variant.on_hand_milli),
          currentAvgPaise: variant.avg_cost_paise === null ? null : Number(variant.avg_cost_paise),
          addedMilli: qtyMilli,
          addedUnitPaise: perUnit,
        });
        await writeMovement(trx, ctx, {
          variantId: line.variant_id,
          type: 'PURCHASE',
          quantity: line.quantity,
          unitCostPaise: perUnit,
          referenceType: 'PURCHASE',
          referenceId: id,
        });
        await sql`update lbg.product_variants set avg_cost_paise = ${avg}, purchase_price_paise = ${unitCostPaise}
                   where business_id = ${ctx.businessId} and id = ${line.variant_id}`.execute(trx);
      }
    }

    try {
      await sql`update lbg.purchases set status = 'POSTED', posted_at = now(),
                  duplicate_override_reason = ${isDuplicate ? (override ?? null) : null}
                 where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    } catch (err) {
      // Another posting of the same supplier invoice committed first.
      if (pgCode(err) === '23505')
        throw new PurchasingError('DUPLICATE_SUPPLIER_INVOICE', 'This supplier invoice was just posted.');
      throw err;
    }
    if (totals.total > 0) {
      await sql`insert into lbg.supplier_ledger_entries (business_id, supplier_id, entry_type, amount_paise, purchase_id, created_by)
                values (${ctx.businessId}, ${loaded.header.supplier_id}, 'PURCHASE', ${totals.total}, ${id}, ${ctx.userId})`.execute(
        trx,
      );
    }
    await recordTenantEvent(trx, ctx, {
      action: 'purchase.post',
      targetType: 'purchase',
      targetId: id,
      metadata: { totalPaise: totals.total, lines: loaded.lines.length, duplicateOverride: isDuplicate },
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    const after = await load(trx, ctx, id, false);
    if (!after) throw new PurchasingError('NOT_FOUND', 'purchase not found');
    return view(after, []);
  });
}

/**
 * Reverses a posted purchase (WORKFLOWS §5 step 5): allowed only while every
 * unit is still IN_STOCK and non-serialized stock suffices. Units become
 * REVERSED and their IMEIs are released (D-033); average costs are unchanged.
 */
export async function reversePurchase(
  db: Db,
  ctx: TenantContext,
  id: string,
  reason: string,
  requestId?: string,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ status: PurchaseStatus; supplier_id: string; total_paise: string }>`
      select status, supplier_id, total_paise from lbg.purchases
       where business_id = ${ctx.businessId} and id = ${id} for update`.execute(trx);
    const p = rows[0];
    if (!p) throw new PurchasingError('NOT_FOUND', 'purchase not found');
    if (p.status !== 'POSTED') throw new PurchasingError('NOT_POSTED', 'Only a posted purchase can be reversed.');
    const movements = await sql<{
      id: string;
      variant_id: string;
      unit_id: string | null;
      quantity_delta: string;
      unit_cost_paise: string | null;
    }>`
      select m.id, m.variant_id, m.unit_id, m.quantity_delta::text as quantity_delta, m.unit_cost_paise
        from lbg.stock_movements m
       where m.business_id = ${ctx.businessId} and m.reference_type = 'PURCHASE' and m.reference_id = ${id}
         and m.movement_type = 'PURCHASE'
       order by m.created_at, m.id`.execute(trx);
    for (const m of movements.rows) {
      if (m.unit_id) {
        const unit = await lockUnit(trx, ctx, m.unit_id);
        if (unit.status !== 'IN_STOCK') {
          throw new PurchasingError(
            'REVERSAL_BLOCKED',
            'A unit from this purchase is no longer in stock; use a purchase return or correction instead.',
          );
        }
        await setUnitStatus(trx, ctx, unit, 'REVERSED');
        await sql`delete from lbg.serialized_unit_imeis where business_id = ${ctx.businessId} and unit_id = ${m.unit_id}`.execute(
          trx,
        );
      }
      try {
        await writeMovement(trx, ctx, {
          variantId: m.variant_id,
          unitId: m.unit_id,
          type: 'REVERSAL',
          quantity: m.quantity_delta.startsWith('-') ? m.quantity_delta.slice(1) : `-${m.quantity_delta}`,
          unitCostPaise: m.unit_cost_paise === null ? null : Number(m.unit_cost_paise),
          referenceType: 'PURCHASE',
          referenceId: id,
          reversesMovementId: m.id,
          reason,
        });
      } catch (err) {
        if (pgCode(err) === 'LB015') {
          throw new PurchasingError('INSUFFICIENT_STOCK', 'Not enough stock is left to reverse this purchase.');
        }
        throw err;
      }
    }
    await sql`update lbg.purchases set status = 'REVERSED', reversed_at = now(), reversal_reason = ${reason}
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    const total = Number(p.total_paise);
    if (total > 0) {
      await sql`insert into lbg.supplier_ledger_entries (business_id, supplier_id, entry_type, amount_paise, purchase_id, created_by)
                values (${ctx.businessId}, ${p.supplier_id}, 'PURCHASE_REVERSAL', ${-total}, ${id}, ${ctx.userId})`.execute(
        trx,
      );
    }
    await recordTenantEvent(trx, ctx, {
      action: 'purchase.reverse',
      targetType: 'purchase',
      targetId: id,
      metadata: { totalPaise: total },
      ...(requestId ? { requestId } : {}),
    });
  });
}
