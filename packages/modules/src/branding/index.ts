// Shop branding and online-store settings (increments 11.1 and 11.4:
// FR-ONB-2 AC1, D-069). The logo is a PNG or JPEG of at most 1 MB and 2000 px
// a side, checked by its bytes (SVG is refused: it can carry scripts) and
// stored privately like every upload. The brand colour is an accent only.
import { checkUpload } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { getUploadFile, storeUpload, type OcrConfig } from '../ocr/index.ts';

export const LOGO_LIMITS = { maxBytes: 1024 * 1024, maxPdfPages: 0, maxImageSide: 2000 } as const;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
export const RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'assets',
  'help',
  'login',
  'platform',
  'shop',
  'sign-in',
  'store',
  'support',
  'www',
];

export class BrandingError extends Error {
  readonly code: 'LOGO_INVALID' | 'SLUG_INVALID' | 'SLUG_TAKEN' | 'STORE_NEEDS_ADDRESS';

  constructor(code: BrandingError['code'], message: string) {
    super(message);
    this.name = 'BrandingError';
    this.code = code;
  }
}

export interface Branding {
  readonly hasLogo: boolean;
  readonly logoUploadId: string | null;
  readonly brandColor: string | null;
  readonly storeSlug: string | null;
  readonly storeEnabled: boolean;
  readonly storeTagline: string | null;
}

export async function getBranding(db: Db, ctx: TenantContext): Promise<Branding> {
  const { rows } = await withTenant(db, ctx, (trx) =>
    sql<{
      logo_upload_id: string | null;
      brand_color: string | null;
      store_slug: string | null;
      store_enabled: boolean;
      store_tagline: string | null;
    }>`select logo_upload_id, brand_color, store_slug, store_enabled, store_tagline
         from lbg.business_branding where business_id = ${ctx.businessId}`.execute(trx),
  );
  const r = rows[0];
  return {
    hasLogo: Boolean(r?.logo_upload_id),
    logoUploadId: r?.logo_upload_id ?? null,
    brandColor: r?.brand_color ?? null,
    storeSlug: r?.store_slug ?? null,
    storeEnabled: r?.store_enabled ?? false,
    storeTagline: r?.store_tagline ?? null,
  };
}

/** AC1: a new logo (or null to remove it). Invoices already issued keep the logo of their snapshot. */
export async function setLogo(
  db: Db,
  ocr: Pick<OcrConfig, 'storage' | 'limits'>,
  ctx: TenantContext,
  bytes: Uint8Array | null,
  requestId?: string,
): Promise<Branding> {
  let uploadId: string | null = null;
  if (bytes) {
    const check = checkUpload(bytes, LOGO_LIMITS);
    if (!check.ok || (check.type !== 'image/png' && check.type !== 'image/jpeg')) {
      throw new BrandingError(
        'LOGO_INVALID',
        'The logo must be a PNG or JPEG image of at most 1 MB and 2000 × 2000 pixels.',
      );
    }
    uploadId = await storeUpload(db, ocr, ctx, { bytes, originalName: 'logo', purpose: 'logo' }, requestId);
  }
  await withTenant(db, ctx, async (trx) => {
    await sql`insert into lbg.business_branding (business_id, logo_upload_id) values (${ctx.businessId}, ${uploadId})
              on conflict (business_id) do update set logo_upload_id = excluded.logo_upload_id, updated_at = now()`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, {
      action: uploadId ? 'branding.logo_set' : 'branding.logo_removed',
      ...(uploadId ? { targetType: 'upload', targetId: uploadId } : {}),
      ...(requestId ? { requestId } : {}),
    });
  });
  return getBranding(db, ctx);
}

export interface BrandingInput {
  readonly brandColor?: string | null;
  readonly storeSlug?: string | null;
  readonly storeEnabled?: boolean;
  readonly storeTagline?: string | null;
}

export async function updateBranding(
  db: Db,
  ctx: TenantContext,
  input: BrandingInput,
  requestId?: string,
): Promise<Branding> {
  const slug = input.storeSlug === undefined ? undefined : input.storeSlug?.trim().toLowerCase() || null;
  if (slug && (!SLUG.test(slug) || slug.includes('--') || RESERVED_SLUGS.includes(slug))) {
    throw new BrandingError(
      'SLUG_INVALID',
      'Use 3–40 lowercase letters, digits or single hyphens, not starting or ending with a hyphen.',
    );
  }
  const color = input.brandColor === undefined ? undefined : (input.brandColor?.toLowerCase() ?? null);
  try {
    await withTenant(db, ctx, async (trx) => {
      await sql`insert into lbg.business_branding (business_id) values (${ctx.businessId})
                on conflict (business_id) do nothing`.execute(trx);
      await sql`update lbg.business_branding set
                  brand_color = case when ${color !== undefined} then ${color ?? null} else brand_color end,
                  store_slug = case when ${slug !== undefined} then ${slug ?? null} else store_slug end,
                  store_enabled = coalesce(${input.storeEnabled ?? null}::boolean, store_enabled),
                  store_tagline = case when ${input.storeTagline !== undefined}
                                       then ${input.storeTagline?.trim() || null} else store_tagline end,
                  updated_at = now()
                where business_id = ${ctx.businessId}`.execute(trx);
      await recordTenantEvent(trx, ctx, {
        action: 'branding.update',
        metadata: {
          fields: Object.keys(input).filter((k) => input[k as keyof BrandingInput] !== undefined),
          ...(input.storeEnabled !== undefined ? { storeEnabled: input.storeEnabled } : {}),
        },
        ...(requestId ? { requestId } : {}),
      });
    });
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') throw new BrandingError('SLUG_TAKEN', 'This shop address is already in use.');
    if (e.code === '23514' && e.constraint === 'store_needs_slug')
      throw new BrandingError('STORE_NEEDS_ADDRESS', 'Choose a shop address before turning the online store on.');
    throw err;
  }
  return getBranding(db, ctx);
}

/** The logo bytes, or null. `uploadId` lets a reprint use the logo of the document's snapshot. */
export async function logoFile(
  db: Db,
  ocr: Pick<OcrConfig, 'storage'>,
  ctx: TenantContext,
  uploadId?: string | null,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const id = uploadId === undefined ? (await getBranding(db, ctx)).logoUploadId : uploadId;
  return id ? getUploadFile(db, ocr, ctx, id) : null;
}

/** A data: URI for printed documents (the print page loads nothing from the network). */
export const dataUri = (file: { bytes: Uint8Array; contentType: string }): string =>
  `data:${file.contentType};base64,${Buffer.from(file.bytes).toString('base64')}`;
