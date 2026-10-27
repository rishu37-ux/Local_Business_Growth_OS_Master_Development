// Categories, brands, products (models) and variants (FR-INV-1, FR-INV-2).
// Cost fields are returned and accepted only when the caller holds
// catalogue.cost.view (FR-INV-2 AC4); the API passes that fact in.
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { CatalogueError, translateDbError } from './errors.ts';

export type RecordStatus = 'ACTIVE' | 'ARCHIVED';

export interface NamedRecord {
  readonly id: string;
  readonly name: string;
  readonly status: RecordStatus;
}

type NamedTable = 'categories' | 'brands';
const NAMED_TABLE: Record<NamedTable, string> = { categories: 'lbg.categories', brands: 'lbg.brands' };
const NAMED_TARGET: Record<NamedTable, string> = { categories: 'category', brands: 'brand' };

export async function listNamed(db: Db, ctx: TenantContext, table: NamedTable): Promise<NamedRecord[]> {
  return withTenant(db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom(NAMED_TABLE[table])
      .select(['id', 'name', 'status'])
      .where('business_id', '=', ctx.businessId)
      .orderBy(sql`lower(name)`)
      .$castTo<NamedRecord>()
      .execute();
    return rows;
  });
}

export async function createNamed(db: Db, ctx: TenantContext, table: NamedTable, name: string): Promise<string> {
  return withTenant(db, ctx, async (trx) => {
    try {
      const row = await trx
        .insertInto(NAMED_TABLE[table])
        .values({ business_id: ctx.businessId, name })
        .returning('id')
        .$castTo<{ id: string }>()
        .executeTakeFirstOrThrow();
      await recordTenantEvent(trx, ctx, {
        action: `catalogue.${NAMED_TARGET[table]}.create`,
        targetType: NAMED_TARGET[table],
        targetId: row.id,
      });
      return row.id;
    } catch (err) {
      return translateDbError(err, 'INVALID_REFERENCE');
    }
  });
}

export async function updateNamed(
  db: Db,
  ctx: TenantContext,
  table: NamedTable,
  id: string,
  patch: { readonly name?: string | undefined; readonly status?: RecordStatus | undefined },
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    try {
      const res = await trx
        .updateTable(NAMED_TABLE[table])
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.status ? { status: patch.status } : {}),
        })
        .where('business_id', '=', ctx.businessId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw new CatalogueError('NOT_FOUND', 'not found');
      await recordTenantEvent(trx, ctx, {
        action: `catalogue.${NAMED_TARGET[table]}.update`,
        targetType: NAMED_TARGET[table],
        targetId: id,
        metadata: { fields: Object.keys(patch) },
      });
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      translateDbError(err, 'INVALID_REFERENCE');
    }
  });
}

export async function deleteNamed(db: Db, ctx: TenantContext, table: NamedTable, id: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    try {
      const res = await trx
        .deleteFrom(NAMED_TABLE[table])
        .where('business_id', '=', ctx.businessId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw new CatalogueError('NOT_FOUND', 'not found');
      await recordTenantEvent(trx, ctx, {
        action: `catalogue.${NAMED_TARGET[table]}.delete`,
        targetType: NAMED_TARGET[table],
        targetId: id,
      });
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      translateDbError(err, 'IN_USE');
    }
  });
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export interface VariantInput {
  readonly sku: string;
  readonly barcode?: string | null;
  readonly ram?: string | null;
  readonly storage?: string | null;
  readonly colour?: string | null;
  readonly uom?: string;
  readonly sellingPricePaise: number;
  readonly minSellingPricePaise?: number | null;
  readonly purchasePricePaise?: number | null;
  readonly priceIncludesTax?: boolean;
  readonly taxRateId?: string | null;
  readonly hsnCode?: string | null;
  readonly reorderLevel?: number | null;
  readonly warrantyMonths?: number | null;
  readonly warrantyProvider?: string | null;
  readonly defaultSupplierId?: string | null;
  readonly status?: RecordStatus;
}

export interface Variant {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly ram: string | null;
  readonly storage: string | null;
  readonly colour: string | null;
  readonly uom: string;
  readonly sellingPricePaise: number;
  readonly minSellingPricePaise: number | null;
  readonly priceIncludesTax: boolean;
  readonly taxRateId: string | null;
  readonly hsnCode: string | null;
  readonly reorderLevel: number | null;
  readonly warrantyMonths: number | null;
  readonly warrantyProvider: string | null;
  readonly defaultSupplierId: string | null;
  readonly status: RecordStatus;
  /** Present only for callers with catalogue.cost.view. */
  readonly purchasePricePaise?: number | null;
  readonly avgCostPaise?: number | null;
}

const VARIANT_COLUMNS: Readonly<Record<keyof VariantInput, string>> = {
  sku: 'sku',
  barcode: 'barcode',
  ram: 'ram',
  storage: 'storage',
  colour: 'colour',
  uom: 'uom',
  sellingPricePaise: 'selling_price_paise',
  minSellingPricePaise: 'min_selling_price_paise',
  purchasePricePaise: 'purchase_price_paise',
  priceIncludesTax: 'price_includes_tax',
  taxRateId: 'tax_rate_id',
  hsnCode: 'hsn_code',
  reorderLevel: 'reorder_level',
  warrantyMonths: 'warranty_months',
  warrantyProvider: 'warranty_provider',
  defaultSupplierId: 'default_supplier_id',
  status: 'status',
};

function variantColumns(input: Partial<VariantInput>, canSeeCost: boolean): Record<string, unknown> {
  if (!canSeeCost && input.purchasePricePaise !== undefined) {
    throw new CatalogueError('COST_FORBIDDEN', 'Purchase prices need the cost-view permission.', 'purchasePricePaise');
  }
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(VARIANT_COLUMNS)) {
    const value = input[key as keyof VariantInput];
    if (value !== undefined) out[column] = value;
  }
  return out;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  ram: string | null;
  storage: string | null;
  colour: string | null;
  uom: string;
  selling_price_paise: string;
  min_selling_price_paise: string | null;
  purchase_price_paise: string | null;
  avg_cost_paise: string | null;
  price_includes_tax: boolean;
  tax_rate_id: string | null;
  hsn_code: string | null;
  reorder_level: number | null;
  warranty_months: number | null;
  warranty_provider: string | null;
  default_supplier_id: string | null;
  status: RecordStatus;
}

// bigint columns arrive as strings from node-postgres; paise fit in a safe integer.
const money = (v: string | null): number | null => (v === null ? null : Number(v));

function toVariant(r: VariantRow, canSeeCost: boolean): Variant {
  const base: Variant = {
    id: r.id,
    productId: r.product_id,
    sku: r.sku,
    barcode: r.barcode,
    ram: r.ram,
    storage: r.storage,
    colour: r.colour,
    uom: r.uom,
    sellingPricePaise: Number(r.selling_price_paise),
    minSellingPricePaise: money(r.min_selling_price_paise),
    priceIncludesTax: r.price_includes_tax,
    taxRateId: r.tax_rate_id,
    hsnCode: r.hsn_code,
    reorderLevel: r.reorder_level,
    warrantyMonths: r.warranty_months,
    warrantyProvider: r.warranty_provider,
    defaultSupplierId: r.default_supplier_id,
    status: r.status,
  };
  return canSeeCost
    ? { ...base, purchasePricePaise: money(r.purchase_price_paise), avgCostPaise: money(r.avg_cost_paise) }
    : base;
}

async function productSerialized(trx: Trx, ctx: TenantContext, productId: string): Promise<boolean> {
  const row = (await trx
    .selectFrom('lbg.products')
    .select('is_serialized')
    .where('business_id', '=', ctx.businessId)
    .where('id', '=', productId)
    .executeTakeFirst()) as { is_serialized: boolean } | undefined;
  if (!row) throw new CatalogueError('NOT_FOUND', 'product not found');
  return row.is_serialized;
}

function checkUom(serialized: boolean, uom: string | undefined) {
  // Serialized products are counted one unit at a time (stock_movements ±1).
  if (serialized && uom !== undefined && uom !== 'pcs') {
    throw new CatalogueError('INVALID_INPUT', 'Serialized products are counted in pieces.', 'uom');
  }
}

async function insertVariant(
  trx: Trx,
  ctx: TenantContext,
  productId: string,
  serialized: boolean,
  input: VariantInput,
  canSeeCost: boolean,
): Promise<string> {
  checkUom(serialized, input.uom);
  const row = await trx
    .insertInto('lbg.product_variants')
    .values({ business_id: ctx.businessId, product_id: productId, ...variantColumns(input, canSeeCost) })
    .returning('id')
    .$castTo<{ id: string }>()
    .executeTakeFirstOrThrow();
  await recordTenantEvent(trx, ctx, {
    action: 'catalogue.variant.create',
    targetType: 'variant',
    targetId: row.id,
    metadata: { productId },
  });
  return row.id;
}

export async function createVariant(
  db: Db,
  ctx: TenantContext,
  productId: string,
  input: VariantInput,
  canSeeCost: boolean,
): Promise<string> {
  return withTenant(db, ctx, async (trx) => {
    try {
      return await insertVariant(trx, ctx, productId, await productSerialized(trx, ctx, productId), input, canSeeCost);
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      return translateDbError(err, 'INVALID_REFERENCE');
    }
  });
}

export async function updateVariant(
  db: Db,
  ctx: TenantContext,
  variantId: string,
  patch: Partial<VariantInput>,
  canSeeCost: boolean,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    try {
      const existing = (await trx
        .selectFrom('lbg.product_variants')
        .select('product_id')
        .where('business_id', '=', ctx.businessId)
        .where('id', '=', variantId)
        .executeTakeFirst()) as { product_id: string } | undefined;
      if (!existing) throw new CatalogueError('NOT_FOUND', 'variant not found');
      checkUom(await productSerialized(trx, ctx, existing.product_id), patch.uom);
      const columns = variantColumns(patch, canSeeCost);
      if (Object.keys(columns).length > 0) {
        await trx
          .updateTable('lbg.product_variants')
          .set(columns)
          .where('business_id', '=', ctx.businessId)
          .where('id', '=', variantId)
          .execute();
      }
      await recordTenantEvent(trx, ctx, {
        action: 'catalogue.variant.update',
        targetType: 'variant',
        targetId: variantId,
        metadata: { fields: Object.keys(patch) },
      });
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      translateDbError(err, 'INVALID_REFERENCE');
    }
  });
}

export async function deleteVariant(db: Db, ctx: TenantContext, variantId: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    try {
      const res = await trx
        .deleteFrom('lbg.product_variants')
        .where('business_id', '=', ctx.businessId)
        .where('id', '=', variantId)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw new CatalogueError('NOT_FOUND', 'variant not found');
      await recordTenantEvent(trx, ctx, {
        action: 'catalogue.variant.delete',
        targetType: 'variant',
        targetId: variantId,
      });
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      translateDbError(err, 'IN_USE');
    }
  });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface ProductInput {
  readonly categoryId?: string | null;
  readonly brandId?: string | null;
  readonly modelName: string;
  readonly modelNumber?: string | null;
  readonly description?: string | null;
  readonly isSerialized: boolean;
  readonly status?: RecordStatus;
}

export interface ProductSummary {
  readonly id: string;
  readonly modelName: string;
  readonly modelNumber: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly brandId: string | null;
  readonly brandName: string | null;
  readonly isSerialized: boolean;
  readonly status: RecordStatus;
  readonly variantCount: number;
}

export interface Product extends ProductSummary {
  readonly description: string | null;
  readonly variants: readonly Variant[];
}

const PRODUCT_COLUMNS: Readonly<Record<keyof ProductInput, string>> = {
  categoryId: 'category_id',
  brandId: 'brand_id',
  modelName: 'model_name',
  modelNumber: 'model_number',
  description: 'description',
  isSerialized: 'is_serialized',
  status: 'status',
};

function productColumns(input: Partial<ProductInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(PRODUCT_COLUMNS)) {
    const value = input[key as keyof ProductInput];
    if (value !== undefined) out[column] = value;
  }
  return out;
}

export async function createProduct(
  db: Db,
  ctx: TenantContext,
  input: ProductInput & { readonly variants?: readonly VariantInput[] },
  canSeeCost: boolean,
): Promise<{ productId: string; variantIds: string[] }> {
  return withTenant(db, ctx, async (trx) => {
    try {
      const { variants = [], ...product } = input;
      const row = await trx
        .insertInto('lbg.products')
        .values({ business_id: ctx.businessId, ...productColumns(product) })
        .returning('id')
        .$castTo<{ id: string }>()
        .executeTakeFirstOrThrow();
      await recordTenantEvent(trx, ctx, {
        action: 'catalogue.product.create',
        targetType: 'product',
        targetId: row.id,
      });
      const variantIds: string[] = [];
      for (const v of variants)
        variantIds.push(await insertVariant(trx, ctx, row.id, input.isSerialized, v, canSeeCost));
      return { productId: row.id, variantIds };
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      return translateDbError(err, 'INVALID_REFERENCE');
    }
  });
}

export async function updateProduct(
  db: Db,
  ctx: TenantContext,
  productId: string,
  patch: Partial<ProductInput>,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    try {
      const columns = productColumns(patch);
      const res = await trx
        .updateTable('lbg.products')
        .set(Object.keys(columns).length > 0 ? columns : { status: sql`status` })
        .where('business_id', '=', ctx.businessId)
        .where('id', '=', productId)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw new CatalogueError('NOT_FOUND', 'product not found');
      if (patch.isSerialized === true) {
        // Existing variants must already count in pieces to become serialized.
        const odd = await trx
          .selectFrom('lbg.product_variants')
          .select('id')
          .where('business_id', '=', ctx.businessId)
          .where('product_id', '=', productId)
          .where('uom', '<>', 'pcs')
          .executeTakeFirst();
        if (odd)
          throw new CatalogueError('INVALID_INPUT', 'Serialized products are counted in pieces.', 'isSerialized');
      }
      await recordTenantEvent(trx, ctx, {
        action: 'catalogue.product.update',
        targetType: 'product',
        targetId: productId,
        metadata: { fields: Object.keys(patch) },
      });
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      translateDbError(err, 'INVALID_REFERENCE');
    }
  });
}

/** Deletes a product and its variants if none of them was ever used (FR-INV-1 AC3). */
export async function deleteProduct(db: Db, ctx: TenantContext, productId: string): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    try {
      await trx
        .deleteFrom('lbg.product_variants')
        .where('business_id', '=', ctx.businessId)
        .where('product_id', '=', productId)
        .execute();
      const res = await trx
        .deleteFrom('lbg.products')
        .where('business_id', '=', ctx.businessId)
        .where('id', '=', productId)
        .executeTakeFirst();
      if (res.numDeletedRows === 0n) throw new CatalogueError('NOT_FOUND', 'product not found');
      await recordTenantEvent(trx, ctx, {
        action: 'catalogue.product.delete',
        targetType: 'product',
        targetId: productId,
      });
    } catch (err) {
      if (err instanceof CatalogueError) throw err;
      translateDbError(err, 'IN_USE');
    }
  });
}

interface ProductRow {
  id: string;
  model_name: string;
  model_number: string | null;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  is_serialized: boolean;
  status: RecordStatus;
  variant_count: number;
}

const toSummary = (r: ProductRow): ProductSummary => ({
  id: r.id,
  modelName: r.model_name,
  modelNumber: r.model_number,
  categoryId: r.category_id,
  categoryName: r.category_name,
  brandId: r.brand_id,
  brandName: r.brand_name,
  isSerialized: r.is_serialized,
  status: r.status,
  variantCount: r.variant_count,
});

function productQuery(trx: Trx, ctx: TenantContext) {
  return trx
    .selectFrom('lbg.products as p')
    .leftJoin('lbg.categories as c', (j) =>
      j.onRef('c.business_id', '=', 'p.business_id').onRef('c.id', '=', 'p.category_id'),
    )
    .leftJoin('lbg.brands as b', (j) => j.onRef('b.business_id', '=', 'p.business_id').onRef('b.id', '=', 'p.brand_id'))
    .select([
      'p.id',
      'p.model_name',
      'p.model_number',
      'p.description',
      'p.category_id',
      'c.name as category_name',
      'p.brand_id',
      'b.name as brand_name',
      'p.is_serialized',
      'p.status',
      sql<number>`(select count(*)::int from lbg.product_variants v
                    where v.business_id = p.business_id and v.product_id = p.id)`.as('variant_count'),
    ])
    .where('p.business_id', '=', ctx.businessId);
}

export async function listProducts(
  db: Db,
  ctx: TenantContext,
  options: { readonly includeArchived?: boolean; readonly search?: string } = {},
): Promise<ProductSummary[]> {
  return withTenant(db, ctx, async (trx) => {
    let q = productQuery(trx, ctx);
    if (!options.includeArchived) q = q.where('p.status', '=', 'ACTIVE');
    const search = options.search?.trim();
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      q = q.where((eb) =>
        eb.or([
          eb('p.model_name', 'ilike', pattern),
          eb('p.model_number', 'ilike', pattern),
          eb.exists(
            eb
              .selectFrom('lbg.product_variants as v')
              .select('v.id')
              .whereRef('v.business_id', '=', 'p.business_id')
              .whereRef('v.product_id', '=', 'p.id')
              .where((e) => e.or([e('v.sku', 'ilike', pattern), e('v.barcode', '=', search)])),
          ),
        ]),
      );
    }
    const rows = (await q
      .orderBy(sql`lower(p.model_name)`)
      .limit(500)
      .execute()) as ProductRow[];
    return rows.map(toSummary);
  });
}

export async function getProduct(
  db: Db,
  ctx: TenantContext,
  productId: string,
  canSeeCost: boolean,
): Promise<Product | null> {
  return withTenant(db, ctx, async (trx) => {
    const row = (await productQuery(trx, ctx).where('p.id', '=', productId).executeTakeFirst()) as
      ProductRow | undefined;
    if (!row) return null;
    const variants = (await trx
      .selectFrom('lbg.product_variants')
      .selectAll()
      .where('business_id', '=', ctx.businessId)
      .where('product_id', '=', productId)
      .orderBy('sku')
      .execute()) as VariantRow[];
    return {
      ...toSummary(row),
      description: row.description,
      variants: variants.map((v) => toVariant(v, canSeeCost)),
    };
  });
}
