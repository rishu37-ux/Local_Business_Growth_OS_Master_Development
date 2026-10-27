// Scans: upload → queue → isolated OCR + parsing → review → draft purchase
// (FR-OCR-1…6, WORKFLOWS §7). Nothing is created from a scan until the user
// presses "Create" with every flagged field confirmed (FR-OCR-4 AC1–2).
import { createHash, randomUUID } from 'node:crypto';
import {
  checkUpload,
  permittedInMode,
  type ExtractedField,
  type FileProblem,
  type ProductLabelExtraction,
  type SupplierInvoiceExtraction,
  type UploadLimits,
} from '@lbgos/domain';
import { sql, type RawBuilder } from 'kysely';
import { withTenant, withoutTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { createPurchaseDraftIn, type PurchaseDraftInput } from '../purchasing/index.ts';
import { loadBusinessAccess } from '../tenancy/index.ts';
import { runIsolated, type IsolationOptions } from './isolate.ts';
import type { StorageAdapter } from './storage.ts';
import { applyStructured } from './structuring.ts';

export type ScanType = 'PRODUCT_LABEL' | 'SUPPLIER_INVOICE';
export type ScanStatus = 'UPLOADED' | 'QUEUED' | 'PROCESSING' | 'NEEDS_REVIEW' | 'COMPLETED' | 'DISCARDED' | 'FAILED';
export type Extraction = ProductLabelExtraction | SupplierInvoiceExtraction;

export const MAX_RETRIES = 3;

export interface OcrConfig {
  readonly storage: StorageAdapter;
  readonly limits: UploadLimits;
  readonly isolation: Omit<IsolationOptions, 'limits'>;
  /** Jobs PROCESSING longer than this are failed as ABANDONED by the next claim. */
  readonly staleSeconds: number;
}

export class OcrError extends Error {
  readonly code: FileProblem | 'NOT_FOUND' | 'NOT_REVIEWABLE' | 'NOT_RETRYABLE' | 'RETRY_LIMIT' | 'UNCONFIRMED_FIELDS';
  readonly fields: readonly string[];

  constructor(code: OcrError['code'], message: string, fields: readonly string[] = []) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
    this.fields = fields;
  }
}

/** Display name only; never used for storage or type decisions. */
function cleanName(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.\- ()]/g, '_').slice(0, 200);
  return clean || null;
}

export async function uploadScan(
  db: Db,
  cfg: OcrConfig,
  ctx: TenantContext,
  input: { readonly bytes: Uint8Array; readonly scanType: ScanType; readonly originalName?: string | undefined },
  requestId?: string,
): Promise<{ jobId: string; uploadId: string }> {
  const check = checkUpload(input.bytes, cfg.limits);
  if (!check.ok) throw new OcrError(check.problem, `file rejected: ${check.problem.toLowerCase().replace(/_/g, ' ')}`);
  const key = `${ctx.businessId}/${randomUUID()}`;
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await cfg.storage.put(key, input.bytes);
  return withTenant(db, ctx, async (trx) => {
    const upload = await sql<{ id: string }>`
      insert into lbg.uploads (business_id, storage_key, content_type, byte_size, sha256, original_name, width, height,
                               page_count, uploaded_by)
      values (${ctx.businessId}, ${key}, ${check.type}, ${input.bytes.length}, ${sha256}, ${cleanName(input.originalName)},
              ${check.width ?? null}, ${check.height ?? null}, ${check.pages ?? null}, ${ctx.userId})
      returning id`.execute(trx);
    const uploadId = upload.rows[0]?.id ?? '';
    const job = await sql<{ id: string }>`
      insert into lbg.ocr_jobs (business_id, upload_id, scan_type, status, requested_by)
      values (${ctx.businessId}, ${uploadId}, ${input.scanType}, 'QUEUED', ${ctx.userId}) returning id`.execute(trx);
    const jobId = job.rows[0]?.id ?? '';
    await recordTenantEvent(trx, ctx, {
      action: 'ocr.upload',
      targetType: 'ocr_job',
      targetId: jobId,
      metadata: { scanType: input.scanType, contentType: check.type, bytes: input.bytes.length },
      ...(requestId ? { requestId } : {}),
    });
    return { jobId, uploadId };
  });
}

/**
 * Claims and processes one queued job; returns null when the queue is empty.
 * ADR-08: the job carries business and requester, and the requester must
 * still hold ocr.scan in that business when the job runs.
 */
export async function processNextOcrJob(
  db: Db,
  cfg: OcrConfig,
): Promise<{ jobId: string; status: ScanStatus; errorCode: string | null } | null> {
  const claimed = await withoutTenant(db, async (trx) => {
    const { rows } = await sql<{ job_id: string; business_id: string; requested_by: string }>`
      select * from lbg.claim_ocr_job(${cfg.staleSeconds})`.execute(trx);
    return rows[0] ?? null;
  });
  if (!claimed) return null;
  const ctx = { businessId: claimed.business_id, userId: claimed.requested_by };
  const fail = async (code: string) => {
    await withTenant(db, ctx, (trx) =>
      sql`update lbg.ocr_jobs set status = 'FAILED', error_code = ${code}, finished_at = now()
           where business_id = ${ctx.businessId} and id = ${claimed.job_id}`.execute(trx),
    );
    return { jobId: claimed.job_id, status: 'FAILED' as const, errorCode: code };
  };

  const access = await loadBusinessAccess(db, ctx.businessId, ctx.userId);
  if (!access || !access.permissions.has('ocr.scan') || !permittedInMode('ocr.scan', access.mode)) {
    return fail('PERMISSION_REVOKED');
  }
  const job = await withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ scan_type: ScanType; storage_key: string }>`
      select j.scan_type, u.storage_key from lbg.ocr_jobs j
        join lbg.uploads u on u.business_id = j.business_id and u.id = j.upload_id
       where j.business_id = ${ctx.businessId} and j.id = ${claimed.job_id}`.execute(trx);
    return rows[0];
  });
  if (!job) return fail('NOT_FOUND');
  let bytes: Uint8Array;
  try {
    bytes = await cfg.storage.get(job.storage_key);
  } catch {
    return fail('FILE_MISSING');
  }
  const result = await runIsolated(bytes, job.scan_type, { ...cfg.isolation, limits: cfg.limits });
  if (!result.ok) return fail(result.code);
  const { extraction, manualEntry } = applyStructured(result.extraction, result.structured, result.lines);
  await withTenant(db, ctx, async (trx) => {
    await sql`update lbg.ocr_jobs set status = 'NEEDS_REVIEW', provider = ${result.provider},
                extraction = ${JSON.stringify(extraction)}::jsonb, manual_entry = ${manualEntry}, finished_at = now()
               where business_id = ${ctx.businessId} and id = ${claimed.job_id}`.execute(trx);
  });
  return { jobId: claimed.job_id, status: 'NEEDS_REVIEW', errorCode: null };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface MatchProposal {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly reason: string;
}

export interface ScanView {
  readonly id: string;
  readonly scanType: ScanType;
  readonly status: ScanStatus;
  readonly attempts: number;
  readonly retriesLeft: number;
  readonly errorCode: string | null;
  readonly provider: string | null;
  readonly manualEntry: boolean;
  readonly createdPurchaseId: string | null;
  readonly createdAt: string;
  readonly file: {
    readonly contentType: string;
    readonly byteSize: number;
    readonly originalName: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly pageCount: number | null;
    readonly malwareScan: string;
  };
  readonly extraction: Extraction | null;
  /** Keys of every field the user must confirm before creating anything. */
  readonly needsConfirmation: readonly string[];
  /** IMEIs in the scan that already exist in this business (FR-OCR-3 AC2). */
  readonly existingImeis: readonly { readonly imei: string; readonly unitId?: string }[];
  readonly catalogueMatches: readonly MatchProposal[];
  readonly lineMatches: Readonly<Record<string, readonly MatchProposal[]>>;
  readonly supplierMatches: readonly { readonly supplierId: string; readonly name: string; readonly reason: string }[];
}

function allFields(e: Extraction): ExtractedField[] {
  if (e.scanType === 'PRODUCT_LABEL') return [...e.fields, ...e.imeis];
  return [
    ...e.fields,
    ...e.lines.flatMap((l) => [l.description, l.quantity, l.unitPricePaise, l.amountPaise, ...l.imeis]),
  ];
}

const value = (e: Extraction, key: string) => e.fields.find((f) => f.key === key)?.value ?? null;

async function proposals(
  trx: Trx,
  ctx: TenantContext,
  hints: { barcode?: string | null; modelNumber?: string | null; modelName?: string | null; text?: string | null },
): Promise<MatchProposal[]> {
  const out: MatchProposal[] = [];
  const add = (rows: { variant_id: string; sku: string; model_name: string }[], reason: string) => {
    for (const r of rows) {
      if (out.some((o) => o.variantId === r.variant_id)) continue;
      out.push({ variantId: r.variant_id, sku: r.sku, productName: r.model_name, reason });
    }
  };
  const q = (where: RawBuilder<unknown>) =>
    sql<{ variant_id: string; sku: string; model_name: string }>`
      select v.id as variant_id, v.sku, p.model_name from lbg.product_variants v
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
       where v.business_id = ${ctx.businessId} and v.status = 'ACTIVE' and p.status = 'ACTIVE' and ${where}
       order by v.sku limit 5`.execute(trx);
  if (hints.barcode) add((await q(sql`v.barcode = ${hints.barcode}`)).rows, 'Barcode matches');
  if (hints.modelNumber)
    add((await q(sql`lower(p.model_number) = lower(${hints.modelNumber})`)).rows, 'Model number matches');
  if (hints.modelName) {
    add((await q(sql`lower(p.model_name) = lower(${hints.modelName})`)).rows, 'Model name matches');
  }
  if (hints.text) {
    // Proposed when the line text contains the product's model name or the variant's SKU.
    add(
      (
        await q(sql`(length(p.model_name) >= 3 and strpos(lower(${hints.text}), lower(p.model_name)) > 0)
                   or strpos(lower(${hints.text}), lower(v.sku)) > 0`)
      ).rows,
      'Description contains the model name or SKU',
    );
  }
  return out.slice(0, 5);
}

interface JobRow {
  id: string;
  scan_type: ScanType;
  status: ScanStatus;
  attempts: number;
  error_code: string | null;
  provider: string | null;
  manual_entry: boolean;
  created_purchase_id: string | null;
  created_at: Date;
  extraction: Extraction | null;
  content_type: string;
  byte_size: number;
  original_name: string | null;
  width: number | null;
  height: number | null;
  page_count: number | null;
  malware_scan: string;
  storage_key: string;
}

async function loadJob(trx: Trx, ctx: TenantContext, id: string, lock = false): Promise<JobRow | undefined> {
  const { rows } = await sql<JobRow>`
    select j.id, j.scan_type, j.status, j.attempts, j.error_code, j.provider, j.manual_entry, j.created_purchase_id,
           j.created_at, j.extraction, u.content_type, u.byte_size, u.original_name, u.width, u.height, u.page_count,
           u.malware_scan, u.storage_key
      from lbg.ocr_jobs j join lbg.uploads u on u.business_id = j.business_id and u.id = j.upload_id
     where j.business_id = ${ctx.businessId} and j.id = ${id} ${lock ? sql`for update of j` : sql``}`.execute(trx);
  return rows[0];
}

export async function getScan(
  db: Db,
  ctx: TenantContext,
  id: string,
  options: { readonly canViewInventory: boolean },
): Promise<ScanView | null> {
  return withTenant(db, ctx, async (trx) => {
    const j = await loadJob(trx, ctx, id);
    if (!j) return null;
    const e = j.extraction;
    const fields = e ? allFields(e) : [];
    const imeis = fields.filter((f) => f.key.includes('imei.') && f.value).map((f) => f.value ?? '');
    const existing = imeis.length
      ? (
          await sql<{ imei: string; unit_id: string }>`
            select imei, unit_id from lbg.serialized_unit_imeis
             where business_id = ${ctx.businessId} and imei = any(${imeis}::text[])`.execute(trx)
        ).rows
      : [];
    let catalogueMatches: MatchProposal[] = [];
    const lineMatches: Record<string, MatchProposal[]> = {};
    let supplierMatches: ScanView['supplierMatches'] = [];
    if (e?.scanType === 'PRODUCT_LABEL') {
      catalogueMatches = await proposals(trx, ctx, {
        barcode: value(e, 'barcode'),
        modelNumber: value(e, 'modelNumber'),
        modelName: value(e, 'modelName'),
      });
    } else if (e?.scanType === 'SUPPLIER_INVOICE') {
      for (const l of e.lines) lineMatches[l.key] = await proposals(trx, ctx, { text: l.description.value });
      const gstin = value(e, 'gstin');
      if (gstin) {
        const { rows } = await sql<{ id: string; name: string }>`
          select id, name from lbg.suppliers where business_id = ${ctx.businessId} and gstin = ${gstin}`.execute(trx);
        supplierMatches = rows.map((r) => ({ supplierId: r.id, name: r.name, reason: 'GSTIN matches' }));
      }
    }
    return {
      id: j.id,
      scanType: j.scan_type,
      status: j.status,
      attempts: j.attempts,
      retriesLeft: Math.max(0, MAX_RETRIES + 1 - j.attempts),
      errorCode: j.error_code,
      provider: j.provider,
      manualEntry: j.manual_entry,
      createdPurchaseId: j.created_purchase_id,
      createdAt: j.created_at.toISOString(),
      file: {
        contentType: j.content_type,
        byteSize: j.byte_size,
        originalName: j.original_name,
        width: j.width,
        height: j.height,
        pageCount: j.page_count,
        malwareScan: j.malware_scan,
      },
      extraction: e,
      needsConfirmation: fields.filter((f) => f.needsConfirmation).map((f) => f.key),
      existingImeis: existing.map((r) =>
        options.canViewInventory ? { imei: r.imei, unitId: r.unit_id } : { imei: r.imei },
      ),
      catalogueMatches,
      lineMatches,
      supplierMatches,
    };
  });
}

export interface ScanSummary {
  readonly id: string;
  readonly scanType: ScanType;
  readonly status: ScanStatus;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly createdPurchaseId: string | null;
}

export async function listScans(db: Db, ctx: TenantContext): Promise<ScanSummary[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      scan_type: ScanType;
      status: ScanStatus;
      error_code: string | null;
      created_at: Date;
      created_purchase_id: string | null;
    }>`select id, scan_type, status, error_code, created_at, created_purchase_id from lbg.ocr_jobs
        where business_id = ${ctx.businessId} order by created_at desc limit 200`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      scanType: r.scan_type,
      status: r.status,
      errorCode: r.error_code,
      createdAt: r.created_at.toISOString(),
      createdPurchaseId: r.created_purchase_id,
    }));
  });
}

export async function getScanFile(
  db: Db,
  cfg: OcrConfig,
  ctx: TenantContext,
  id: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const j = await withTenant(db, ctx, (trx) => loadJob(trx, ctx, id));
  if (!j) return null;
  return { bytes: await cfg.storage.get(j.storage_key), contentType: j.content_type };
}

export async function retryScan(db: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const j = await loadJob(trx, ctx, id, true);
    if (!j) throw new OcrError('NOT_FOUND', 'scan not found');
    if (j.status !== 'FAILED') throw new OcrError('NOT_RETRYABLE', 'Only a failed scan can be retried.');
    if (j.attempts > MAX_RETRIES)
      throw new OcrError('RETRY_LIMIT', 'This scan was retried the maximum number of times.');
    await sql`update lbg.ocr_jobs set status = 'QUEUED', error_code = null where id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, { action: 'ocr.retry', targetType: 'ocr_job', targetId: id });
  });
}

export async function discardScan(db: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const j = await loadJob(trx, ctx, id, true);
    if (!j) throw new OcrError('NOT_FOUND', 'scan not found');
    if (j.status !== 'NEEDS_REVIEW' && j.status !== 'FAILED') {
      throw new OcrError('NOT_REVIEWABLE', `This scan is ${j.status.toLowerCase()}.`);
    }
    await sql`update lbg.ocr_jobs set status = 'DISCARDED' where id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, { action: 'ocr.discard', targetType: 'ocr_job', targetId: id });
  });
}

/**
 * "Create" on the review screen (FR-OCR-4): makes a DRAFT purchase from the
 * values the user reviewed. Every flagged field must be listed in `confirmed`.
 * Posting stays a separate step needing purchases.post.
 */
export async function createDraftFromScan(
  db: Db,
  ctx: TenantContext,
  id: string,
  input: { readonly purchase: PurchaseDraftInput; readonly confirmed: readonly string[] },
  requestId?: string,
): Promise<{ purchaseId: string }> {
  return withTenant(db, ctx, async (trx) => {
    const j = await loadJob(trx, ctx, id, true);
    if (!j) throw new OcrError('NOT_FOUND', 'scan not found');
    if (j.status !== 'NEEDS_REVIEW' || !j.extraction) {
      throw new OcrError('NOT_REVIEWABLE', `This scan is ${j.status.toLowerCase()}.`);
    }
    const confirmed = new Set(input.confirmed);
    const missing = allFields(j.extraction)
      .filter((f) => f.needsConfirmation && !confirmed.has(f.key))
      .map((f) => f.key);
    if (missing.length > 0) {
      throw new OcrError('UNCONFIRMED_FIELDS', 'Confirm every highlighted field first.', missing);
    }
    const purchaseId = await createPurchaseDraftIn(trx, ctx, input.purchase);
    await sql`update lbg.ocr_jobs set status = 'COMPLETED', created_purchase_id = ${purchaseId} where id = ${id}`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, {
      action: 'ocr.create_draft',
      targetType: 'ocr_job',
      targetId: id,
      metadata: { purchaseId, confirmed: input.confirmed.length },
      ...(requestId ? { requestId } : {}),
    });
    return { purchaseId };
  });
}
