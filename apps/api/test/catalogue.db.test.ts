// Increment 4.1: catalogue and tax rates (FR-INV-1, FR-INV-2, FR-TAX-2).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  del,
  errorCode,
  get,
  patch,
  post,
  resetFixture,
  staff,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop;
let other: Shop;
let billing: Session;
let inventory: Session;

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'cat-a');
  other = await activeShop(h, 'cat-b');
  billing = (await staff(h, shop, 'cat-billing@example.test', 'Billing')).session;
  inventory = (await staff(h, shop, 'cat-inventory@example.test', 'Inventory')).session;
}, 120_000);
afterAll(async () => {
  await h.close();
});

const phone = (sku: string, extra: object = {}) => ({
  sku,
  ram: '8 GB',
  storage: '128 GB',
  colour: 'Black',
  sellingPricePaise: 2_499_900,
  purchasePricePaise: 2_100_000,
  hsnCode: '851713',
  warrantyMonths: 12,
  warrantyProvider: 'Manufacturer (as printed on the box)',
  ...extra,
});

describe('hierarchy and fields (FR-INV-1, FR-INV-2)', () => {
  let categoryId = '';
  let brandId = '';
  let productId = '';

  it('creates category → brand → product → variants; phones are serialized in pieces', async () => {
    categoryId = (await post(h, `${shop.base}/categories`, { name: 'Smartphones' }, shop.owner)).json<{ id: string }>()
      .id;
    brandId = (await post(h, `${shop.base}/brands`, { name: 'Acme' }, shop.owner)).json<{ id: string }>().id;
    const res = await post(
      h,
      `${shop.base}/products`,
      {
        categoryId,
        brandId,
        modelName: 'Acme X1',
        modelNumber: 'AX1-2026',
        description: 'Synthetic test phone',
        isSerialized: true,
        variants: [
          phone('AX1-8-128-BLK', { barcode: '8901234567890' }),
          phone('AX1-8-256-BLU', { storage: '256 GB', colour: 'Blue' }),
        ],
      },
      shop.owner,
    );
    expect(res.statusCode).toBe(201);
    productId = res.json<{ productId: string }>().productId;
    const product = (await get(h, `${shop.base}/products/${productId}`, shop.owner)).json<{
      product: { brandName: string; categoryName: string; variants: { uom: string; warrantyProvider: string }[] };
    }>().product;
    expect(product.brandName).toBe('Acme');
    expect(product.categoryName).toBe('Smartphones');
    expect(product.variants.map((v) => v.uom)).toEqual(['pcs', 'pcs']);
    // AC3: warranty text stored exactly as entered.
    expect(product.variants[0]?.warrantyProvider).toBe('Manufacturer (as printed on the box)');
  });

  it('serialized variants must count in pieces', async () => {
    const res = await post(
      h,
      `${shop.base}/products/${productId}/variants`,
      phone('AX1-BAD', { uom: 'box' }),
      shop.owner,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { field: string } }>().error.field).toBe('uom');
  });

  it('SKU and barcode are unique per business, with the field named', async () => {
    const dupSku = await post(h, `${shop.base}/products/${productId}/variants`, phone('AX1-8-128-BLK'), shop.owner);
    expect(dupSku.statusCode).toBe(409);
    expect(dupSku.json<{ error: { code: string; field: string } }>().error).toMatchObject({
      code: 'DUPLICATE',
      field: 'sku',
    });
    const dupBarcode = await post(
      h,
      `${shop.base}/products/${productId}/variants`,
      phone('AX1-OTHER', { barcode: '8901234567890' }),
      shop.owner,
    );
    expect(dupBarcode.json<{ error: { field: string } }>().error.field).toBe('barcode');
    // The same SKU and barcode are fine in another business.
    const elsewhere = await post(
      h,
      `${other.base}/products`,
      { modelName: 'Other', isSerialized: true, variants: [phone('AX1-8-128-BLK', { barcode: '8901234567890' })] },
      other.owner,
    );
    expect(elsewhere.statusCode).toBe(201);
  });

  it('validates fields strictly (unknown fields, HSN format, min price above selling price)', async () => {
    const unknown = await post(
      h,
      `${shop.base}/products/${productId}/variants`,
      phone('AX1-U', { margin: 5 }),
      shop.owner,
    );
    expect(unknown.statusCode).toBe(400);
    const hsn = await post(
      h,
      `${shop.base}/products/${productId}/variants`,
      phone('AX1-H', { hsnCode: '12' }),
      shop.owner,
    );
    expect(hsn.statusCode).toBe(400);
    const minPrice = await post(
      h,
      `${shop.base}/products/${productId}/variants`,
      phone('AX1-M', { minSellingPricePaise: 9_999_999 }),
      shop.owner,
    );
    expect(minPrice.statusCode).toBe(422);
  });

  it('cannot reference another business’s category or brand (composite FK)', async () => {
    const res = await post(
      h,
      `${other.base}/products`,
      { modelName: 'Sneaky', categoryId, isSerialized: false },
      other.owner,
    );
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('INVALID_REFERENCE');
  });

  it('search finds products by model, SKU and exact barcode', async () => {
    const names = async (q: string) =>
      (await get(h, `${shop.base}/products?q=${encodeURIComponent(q)}`, shop.owner))
        .json<{ products: { modelName: string }[] }>()
        .products.map((p) => p.modelName);
    expect(await names('acme x')).toEqual(['Acme X1']);
    expect(await names('8-256')).toEqual(['Acme X1']);
    expect(await names('8901234567890')).toEqual(['Acme X1']);
    expect(await names('%')).toEqual([]);
  });

  it('archiving hides a product from the default list; deleting unused records works', async () => {
    const temp = (
      await post(
        h,
        `${shop.base}/products`,
        {
          modelName: 'Temp Cable',
          isSerialized: false,
          variants: [{ sku: 'CBL-1', sellingPricePaise: 19_900, uom: 'pcs' }],
        },
        shop.owner,
      )
    ).json<{ productId: string }>().productId;
    expect((await patch(h, `${shop.base}/products/${temp}`, { status: 'ARCHIVED' }, shop.owner)).statusCode).toBe(204);
    const listed = (await get(h, `${shop.base}/products`, shop.owner)).json<{ products: { id: string }[] }>().products;
    expect(listed.map((p) => p.id)).not.toContain(temp);
    const all = (await get(h, `${shop.base}/products?includeArchived=true`, shop.owner)).json<{
      products: { id: string }[];
    }>().products;
    expect(all.map((p) => p.id)).toContain(temp);
    expect((await del(h, `${shop.base}/products/${temp}`, shop.owner)).statusCode).toBe(204);
    expect((await get(h, `${shop.base}/products/${temp}`, shop.owner)).statusCode).toBe(404);
  });

  it('deleting a product with stock movements is refused with IN_USE; the serialized flag is locked (FR-INV-1 AC3)', async () => {
    const product = (await get(h, `${shop.base}/products/${productId}`, shop.owner)).json<{
      product: { variants: { id: string }[] };
    }>().product;
    const variantId = product.variants[0]?.id ?? '';
    // Stock movements arrive with purchases (4.2); seed one directly as the DB owner.
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta)
              values (${shop.businessId}, ${variantId}, 'OPENING', 1)`.execute(h.admin);
    const res = await del(h, `${shop.base}/products/${productId}`, shop.owner);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('IN_USE');
    expect((await del(h, `${shop.base}/variants/${variantId}`, shop.owner)).statusCode).toBe(409);
    const flip = await patch(h, `${shop.base}/products/${productId}`, { isSerialized: false }, shop.owner);
    expect(flip.statusCode).toBe(409);
    expect(errorCode(flip)).toBe('SERIALIZED_LOCKED');
    // Category and brand in use by the product cannot be deleted either.
    expect((await del(h, `${shop.base}/categories/${categoryId}`, shop.owner)).statusCode).toBe(409);
    expect((await get(h, `${shop.base}/products/${productId}`, shop.owner)).statusCode).toBe(200);
  });

  it('cost prices are hidden without catalogue.cost.view and cannot be written (FR-INV-2 AC4)', async () => {
    const asBilling = (await get(h, `${shop.base}/products/${productId}`, billing)).json<{
      product: { variants: Record<string, unknown>[] };
    }>().product;
    for (const v of asBilling.variants) {
      expect(v).not.toHaveProperty('purchasePricePaise');
      expect(v).not.toHaveProperty('avgCostPaise');
    }
    const asOwner = (await get(h, `${shop.base}/products/${productId}`, shop.owner)).json<{
      product: { variants: Record<string, unknown>[] };
    }>().product;
    expect(asOwner.variants[0]?.purchasePricePaise).toBe(2_100_000);
    // Inventory staff manage the catalogue but do not see costs.
    const write = await post(h, `${shop.base}/products/${productId}/variants`, phone('AX1-INV'), inventory);
    expect(write.statusCode).toBe(403);
    expect(errorCode(write)).toBe('COST_FORBIDDEN');
    const withoutCost: Record<string, unknown> = phone('AX1-INV');
    delete withoutCost.purchasePricePaise;
    expect((await post(h, `${shop.base}/products/${productId}/variants`, withoutCost, inventory)).statusCode).toBe(201);
  });

  it('enforces permissions and tenancy on every catalogue route', async () => {
    expect((await post(h, `${shop.base}/brands`, { name: 'Nope' }, billing)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/products`, billing)).statusCode).toBe(200);
    // Members of another business get 404 for everything here.
    expect((await get(h, `${shop.base}/products`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${shop.base}/products/${productId}`, other.owner)).statusCode).toBe(404);
    expect((await patch(h, `${shop.base}/products/${productId}`, { modelName: 'x' }, other.owner)).statusCode).toBe(
      404,
    );
    // Using our own business ID with another business's product ID finds nothing.
    expect((await get(h, `${other.base}/products/${productId}`, other.owner)).statusCode).toBe(404);
    expect((await patch(h, `${other.base}/products/${productId}`, { modelName: 'x' }, other.owner)).statusCode).toBe(
      404,
    );
    expect((await del(h, `${other.base}/products/${productId}`, other.owner)).statusCode).toBe(404);
  });

  it('writes audit events for catalogue changes', async () => {
    const { rows } = await sql<{ action: string }>`
      select distinct action from lbg.audit_events where business_id = ${shop.businessId} and action like 'catalogue.%'`.execute(
      h.admin,
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'catalogue.category.create',
        'catalogue.product.create',
        'catalogue.variant.create',
        'catalogue.product.delete',
      ]),
    );
  });
});

describe('versioned tax rates (FR-TAX-2)', () => {
  it('nothing is seeded: a new business has no tax rates', async () => {
    expect((await get(h, `${other.base}/tax-rates`, other.owner)).json<{ taxRates: unknown[] }>().taxRates).toEqual([]);
  });

  it('creates versions, rejects overlaps, and resolves the version in force on a date', async () => {
    const v1 = await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST test rate', ratePercent: '18', effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31' },
      shop.owner,
    );
    expect(v1.statusCode).toBe(201);
    const overlap = await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'gst TEST rate', ratePercent: '12', effectiveFrom: '2026-03-31' },
      shop.owner,
    );
    expect(overlap.statusCode).toBe(409);
    expect(errorCode(overlap)).toBe('TAX_RATE_OVERLAP');
    const v2 = await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST test rate', ratePercent: '12.50', effectiveFrom: '2026-04-01' },
      shop.owner,
    );
    expect(v2.statusCode).toBe(201);
    const v1Id = v1.json<{ id: string }>().id;
    const at = async (date: string) =>
      (
        await sql<{ rate: string | null }>`
          select (select rate_percent::text from lbg.tax_rates where id = lbg.effective_tax_rate(${v1Id}::uuid, ${date}::date)) as rate`.execute(
          h.admin,
        )
      ).rows[0]?.rate;
    expect(await at('2026-03-31')).toBe('18.00');
    expect(await at('2026-04-01')).toBe('12.50');
    expect(await at('2025-03-31')).toBeNull();
  });

  it('a version is immutable except for closing it (app role cannot change the rate)', async () => {
    const id = (
      await post(
        h,
        `${shop.base}/tax-rates`,
        { name: 'Cess test', ratePercent: '1', effectiveFrom: '2025-01-01' },
        shop.owner,
      )
    ).json<{ id: string }>().id;
    expect(
      (await post(h, `${shop.base}/tax-rates/${id}/close`, { effectiveTo: '2025-12-31' }, shop.owner)).statusCode,
    ).toBe(204);
    const app = h.appDb;
    await expect(
      app.transaction().execute(async (trx) => {
        await sql`select set_config('app.business_id', ${shop.businessId}, true)`.execute(trx);
        await sql`update lbg.tax_rates set rate_percent = 0 where id = ${id}`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql`update lbg.tax_rates set rate_percent = 0 where id = ${id}`.execute(h.admin),
    ).rejects.toMatchObject({
      code: 'LB013',
    });
  });

  it('managing rates needs tax.settings.manage, is audited, and validates input', async () => {
    const body = { name: 'Staff rate', ratePercent: '5', effectiveFrom: '2025-04-01' };
    expect((await post(h, `${shop.base}/tax-rates`, body, inventory)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/tax-rates`, inventory)).statusCode).toBe(200);
    expect((await post(h, `${shop.base}/tax-rates`, { ...body, ratePercent: '101' }, shop.owner)).statusCode).toBe(400);
    expect((await post(h, `${shop.base}/tax-rates`, { ...body, ratePercent: '5.125' }, shop.owner)).statusCode).toBe(
      400,
    );
    expect(
      (await post(h, `${shop.base}/tax-rates`, { ...body, effectiveTo: '2025-01-01' }, shop.owner)).statusCode,
    ).toBe(400);
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from lbg.audit_events where business_id = ${shop.businessId} and action = 'tax.rate.create'`.execute(
      h.admin,
    );
    expect(rows[0]?.n).toBe(3);
  });
});
