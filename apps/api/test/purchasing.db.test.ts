// Increment 4.2: suppliers and purchases (FR-INV-3, FR-INV-5, FR-INV-8, D-033).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  post,
  put,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop; // UNREGISTERED, Maharashtra
let regular: Shop; // REGULAR GST registrant, Maharashtra
let other: Shop;
let inventory: Session;
let billing: Session;
let phoneId: string;
let cableId: string;
let gst18: string;
let supplierId: string; // Maharashtra supplier
let karnatakaSupplier: string;

const IMEI_A = imei(1);
const IMEI_B = imei(2);

interface Problem {
  code: string;
  severity: string;
  lineNo?: number;
  position?: number;
  field?: string;
  existingUnitId?: string;
  differencePaise?: number;
}
interface Purchase {
  id: string;
  status: string;
  isInterState: boolean;
  totals: { taxable: number; cgst: number; sgst: number; igst: number; tax: number; total: number };
  lines: { lineNo: number; taxable: number; ratePercent: string; units: { unitId: string | null }[] }[];
  problems: Problem[];
  duplicateOverrideReason: string | null;
}

const draft = (lines: object[], extra: object = {}) => ({
  supplierId,
  supplierInvoiceNo: 'SUP/001',
  supplierInvoiceDate: '2026-10-20',
  lines,
  ...extra,
});
const phoneLine = (imeis: { imei1: string; imei2?: string }[], unitCostPaise = 1_500_000) => ({
  variantId: phoneId,
  quantity: String(imeis.length),
  unitCostPaise,
  taxRateId: gst18,
  units: imeis,
});
const cableLine = (quantity: string, unitCostPaise: number) => ({
  variantId: cableId,
  quantity,
  unitCostPaise,
  taxRateId: gst18,
});

async function createDraft(body: object, who: Session = shop.owner, s: Shop = shop): Promise<string> {
  const res = await post(h, `${s.base}/purchases`, body, who);
  if (res.statusCode !== 201) throw new Error(`draft failed: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}
const fetchPurchase = async (id: string, who: Session = shop.owner, s: Shop = shop) =>
  (await get(h, `${s.base}/purchases/${id}`, who)).json<{ purchase: Purchase }>().purchase;
const movementsOf = async (purchaseId: string) =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from lbg.stock_movements where reference_id = ${purchaseId}`.execute(h.admin)
  ).rows[0]?.n ?? 0;
const level = async (variantId: string, bucket = 'AVAILABLE') =>
  (
    await sql<{ q: string | null }>`
      select (select quantity::text from lbg.stock_levels where variant_id = ${variantId} and bucket = ${bucket}) as q`.execute(
      h.admin,
    )
  ).rows[0]?.q ?? null;
const avgCost = async (variantId: string) =>
  (
    await sql<{
      avg: string | null;
    }>`select avg_cost_paise::text as avg from lbg.product_variants where id = ${variantId}`.execute(h.admin)
  ).rows[0]?.avg;

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'pur-a');
  regular = await activeShop(h, 'pur-r', { gstin: '27AAPFU0939F1ZV' });
  other = await activeShop(h, 'pur-b');
  inventory = (await staff(h, shop, 'pur-inventory@example.test', 'Inventory')).session;
  billing = (await staff(h, shop, 'pur-billing@example.test', 'Billing')).session;
  gst18 = (
    await post(
      h,
      `${shop.base}/tax-rates`,
      { name: 'GST 18 (test)', ratePercent: '18', effectiveFrom: '2025-04-01' },
      shop.owner,
    )
  ).json<{ id: string }>().id;
  phoneId = await variant(h, shop, 'PH-1', { serialized: true });
  cableId = await variant(h, shop, 'CB-1', { serialized: false });
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('suppliers (FR-INV-8 AC1)', () => {
  it('validates the GSTIN checksum and takes the state from the GSTIN', async () => {
    const bad = await post(
      h,
      `${shop.base}/suppliers`,
      { name: 'Bad GSTIN Traders', gstin: '27AAPFU0939F1ZW' },
      shop.owner,
    );
    expect(bad.statusCode).toBe(422);
    expect(errorCode(bad)).toBe('GSTIN_INVALID');
    const res = await post(
      h,
      `${shop.base}/suppliers`,
      {
        name: 'Sai Distributors (synthetic)',
        gstin: '27aapfu0939f1zv',
        mobileE164: '+919800000001',
        paymentTerms: '30 days',
      },
      shop.owner,
    );
    expect(res.statusCode).toBe(201);
    supplierId = res.json<{ id: string }>().id;
    const s = (await get(h, `${shop.base}/suppliers/${supplierId}`, shop.owner)).json<{
      supplier: { gstin: string; stateCode: string };
    }>().supplier;
    expect(s).toMatchObject({ gstin: '27AAPFU0939F1ZV', stateCode: '27' });
    karnatakaSupplier = (
      await post(
        h,
        `${shop.base}/suppliers`,
        { name: 'Bengaluru Wholesale (synthetic)', gstin: '29AAGCB7383J1Z4' },
        shop.owner,
      )
    ).json<{ id: string }>().id;
    const mismatch = await post(
      h,
      `${shop.base}/suppliers`,
      { name: 'Mismatch', gstin: '29AAGCB7383J1Z4', stateCode: '27' },
      shop.owner,
    );
    expect(errorCode(mismatch)).toBe('GSTIN_INVALID');
  });
});

let mainDraft = '';

describe('drafts (FR-INV-8 AC2, FR-INV-3 AC2–4, FR-INV-5 AC1)', () => {
  it('computes line and document totals; a draft changes no stock', async () => {
    mainDraft = await createDraft(
      draft([phoneLine([{ imei1: IMEI_A }, { imei1: IMEI_B }]), cableLine('10', 10_050)], {
        supplierTotalPaise: 3_659_000,
      }),
    );
    const id = mainDraft;
    const p = await fetchPurchase(id);
    // Phone: 2 × ₹15,000 = 3,000,000 paise; 18 % = 540,000. Cable: 10 × 100.50 = 100,500; 18 % = 18,090.
    expect(p.totals).toEqual({
      taxable: 3_100_500,
      cgst: 279_045,
      sgst: 279_045,
      igst: 0,
      cess: 0,
      tax: 558_090,
      total: 3_658_590,
    });
    expect(p.isInterState).toBe(false);
    expect(p.lines.map((l) => l.ratePercent)).toEqual(['18.00', '18.00']);
    // The printed total differs by ₹4.10: shown, not hidden.
    expect(p.problems).toEqual([
      expect.objectContaining({ code: 'SUPPLIER_TOTAL_MISMATCH', severity: 'WARNING', differencePaise: -410 }),
    ]);
    expect(await movementsOf(mainDraft)).toBe(0);
    expect(await level(phoneId)).toBeNull();
  });

  it('flags malformed and duplicate IMEIs per field and never corrects them', async () => {
    const wrongCheckDigit = IMEI_A.slice(0, 14) + String((Number(IMEI_A[14]) + 1) % 10);
    const bad = await createDraft(
      draft([
        phoneLine([
          { imei1: wrongCheckDigit },
          { imei1: imei(3), imei2: imei(3) },
          { imei1: imei(4) },
          { imei1: imei(4) },
        ]),
        { ...phoneLine([{ imei1: imei(5) }]), quantity: '2' },
      ]),
    );
    const p = await fetchPurchase(bad);
    const codes = p.problems.map((x) => [x.code, x.lineNo, x.position, x.field]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['IMEI_INVALID', 1, 1, 'imei1'],
        ['IMEI_DUPLICATE_IN_PURCHASE', 1, 2, 'imei2'],
        ['IMEI_SAME', 1, 2, 'imei2'],
        ['IMEI_DUPLICATE_IN_PURCHASE', 1, 4, 'imei1'],
        ['UNIT_COUNT_MISMATCH', 2, undefined, 'quantity'],
      ]),
    );
    // The stored value is exactly what was entered.
    const { rows } = await sql<{ imei1: string }>`
      select u.imei1 from lbg.purchase_line_units u join lbg.purchase_lines l on l.id = u.line_id
       where l.purchase_id = ${bad} and u.position = 1 and l.line_no = 1`.execute(h.admin);
    expect(rows[0]?.imei1).toBe(wrongCheckDigit);
    const post1 = await post(h, `${shop.base}/purchases/${bad}/post`, {}, shop.owner);
    expect(post1.statusCode).toBe(422);
    expect(errorCode(post1)).toBe('BLOCKING_PROBLEMS');
    expect(await movementsOf(bad)).toBe(0);
    expect((await post(h, `${shop.base}/purchases/${bad}/discard`, {}, shop.owner)).statusCode).toBe(204);
    expect((await post(h, `${shop.base}/purchases/${bad}/post`, {}, shop.owner)).statusCode).toBe(409);
  });

  it('IMEIs only on serialized lines; non-digit IMEIs and unknown variants are rejected', async () => {
    const withUnits = await createDraft(draft([{ ...cableLine('1', 100), units: [{ imei1: imei(6) }] }]));
    expect((await fetchPurchase(withUnits)).problems.map((p) => p.code)).toContain('UNITS_ON_NON_SERIALIZED');
    const letters = await post(h, `${shop.base}/purchases`, draft([phoneLine([{ imei1: '35990ABC' }])]), shop.owner);
    expect(letters.statusCode).toBe(422);
    const otherVariant = await variant(h, other, 'OTHER-1', { serialized: false });
    const foreign = await post(
      h,
      `${shop.base}/purchases`,
      draft([{ variantId: otherVariant, quantity: '1', unitCostPaise: 1 }]),
      shop.owner,
    );
    expect(foreign.statusCode).toBe(422);
    expect(errorCode(foreign)).toBe('INVALID_LINE');
  });

  it('edits replace the lines while the purchase is a draft', async () => {
    const res = await put(
      h,
      `${shop.base}/purchases/${mainDraft}`,
      draft([phoneLine([{ imei1: IMEI_A }, { imei1: IMEI_B }]), cableLine('10', 10_000)]),
      shop.owner,
    );
    expect(res.statusCode).toBe(204);
    const p = await fetchPurchase(mainDraft);
    expect(p.lines[1]?.taxable).toBe(100_000);
    expect(p.problems).toEqual([]);
  });
});

describe('posting (FR-INV-5 AC2, FR-INV-8 AC3–4, D-017, D-033)', () => {
  let id = '';

  it('posts atomically: units IN_STOCK with IMEIs, PURCHASE movements, levels, cost, payable, audit', async () => {
    id = mainDraft;
    const res = await post(h, `${shop.base}/purchases/${id}/post`, {}, shop.owner);
    expect(res.statusCode).toBe(200);
    const p = res.json<{ purchase: Purchase }>().purchase;
    expect(p.status).toBe('POSTED');
    expect(p.lines[0]?.units.every((u) => u.unitId !== null)).toBe(true);
    const units = await sql<{ status: string; unit_cost_paise: string; imeis: string[] }>`
      select u.status, u.unit_cost_paise::text,
             array(select i.imei from lbg.serialized_unit_imeis i where i.unit_id = u.id) as imeis
        from lbg.serialized_units u where u.purchase_id = ${id} order by u.created_at`.execute(h.admin);
    // UNREGISTERED shop: tax is part of cost (D-033): 3,540,000 split over 2 units.
    expect(units.rows).toEqual([
      { status: 'IN_STOCK', unit_cost_paise: '1770000', imeis: [IMEI_A] },
      { status: 'IN_STOCK', unit_cost_paise: '1770000', imeis: [IMEI_B] },
    ]);
    expect(await level(phoneId)).toBe('2.000');
    expect(await level(cableId)).toBe('10.000');
    expect(await avgCost(cableId)).toBe('11800'); // ₹100 + 18 %
    expect(await movementsOf(id)).toBe(3);
    const ledger = (await get(h, `${shop.base}/suppliers/${supplierId}/ledger`, shop.owner)).json<{
      balancePaise: number;
    }>();
    expect(ledger.balancePaise).toBe(3_658_000);
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from lbg.audit_events where target_id = ${id} and action = 'purchase.post'`.execute(
      h.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('a posted purchase cannot be edited or posted again', async () => {
    const edit = await put(h, `${shop.base}/purchases/${id}`, draft([cableLine('1', 1)]), shop.owner);
    expect(edit.statusCode).toBe(409);
    expect(errorCode(edit)).toBe('NOT_DRAFT');
    expect((await post(h, `${shop.base}/purchases/${id}/post`, {}, shop.owner)).statusCode).toBe(409);
    // Even the database refuses line changes on a posted purchase (LB016).
    await expect(
      sql`update lbg.purchase_lines set unit_cost_paise = 0 where purchase_id = ${id}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB016' });
  });

  it('an IMEI already in stock is a blocking problem pointing to the existing unit (FR-INV-3 AC3)', async () => {
    const again = await createDraft(draft([phoneLine([{ imei1: IMEI_A }])], { supplierInvoiceNo: 'SUP/002' }));
    const p = await fetchPurchase(again);
    const problem = p.problems.find((x) => x.code === 'IMEI_EXISTS');
    expect(problem?.existingUnitId).toMatch(/^[0-9a-f-]{36}$/);
    // The same IMEI in another business is accepted and reveals nothing (AC5).
    const otherSupplier = (await post(h, `${other.base}/suppliers`, { name: 'Other Supplier' }, other.owner)).json<{
      id: string;
    }>().id;
    const otherPhone = await variant(h, other, 'OTHER-PH', { serialized: true });
    const elsewhere = await createDraft(
      {
        supplierId: otherSupplier,
        supplierInvoiceNo: 'X1',
        supplierInvoiceDate: '2026-10-20',
        lines: [
          { variantId: otherPhone, quantity: '1', unitCostPaise: 100, taxRateId: null, units: [{ imei1: IMEI_A }] },
        ],
      },
      other.owner,
      other,
    );
    expect((await fetchPurchase(elsewhere, other.owner, other)).problems.map((x) => x.code)).toEqual(['NO_TAX_RATE']);
    expect((await post(h, `${other.base}/purchases/${elsewhere}/post`, {}, other.owner)).statusCode).toBe(200);
    expect((await post(h, `${shop.base}/purchases/${again}/discard`, {}, shop.owner)).statusCode).toBe(204);
  });

  it('a duplicate supplier invoice number blocks posting unless overridden with a reason (AC3)', async () => {
    const dup = await createDraft(draft([cableLine('1', 1000)], { supplierInvoiceNo: 'sup/001' }));
    const first = await post(h, `${shop.base}/purchases/${dup}/post`, {}, shop.owner);
    expect(first.statusCode).toBe(409);
    expect(errorCode(first)).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(
      (await post(h, `${shop.base}/purchases/${dup}/post`, { overrideReason: 'short' }, shop.owner)).statusCode,
    ).toBe(400);
    const ok = await post(
      h,
      `${shop.base}/purchases/${dup}/post`,
      { overrideReason: 'Supplier reused the number for a second delivery.' },
      shop.owner,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ purchase: Purchase }>().purchase.duplicateOverrideReason).toBe(
      'Supplier reused the number for a second delivery.',
    );
  });

  it('weighted average cost across purchases; regular registrants exclude tax from cost (D-017, D-033)', async () => {
    // Add 10 @ ₹130 + 18 % = ₹153.40 each to the 11 on hand.
    const before = Number(await avgCost(cableId));
    const id2 = await createDraft(draft([cableLine('10', 13_000)], { supplierInvoiceNo: 'SUP/003' }));
    expect((await post(h, `${shop.base}/purchases/${id2}/post`, {}, shop.owner)).statusCode).toBe(200);
    const expected = Math.floor((11 * before + 10 * 15_340) / 21 + 0.5);
    expect(Number(await avgCost(cableId))).toBe(expected);

    const rSupplier = (await post(h, `${regular.base}/suppliers`, { name: 'Regular Supplier' }, regular.owner)).json<{
      id: string;
    }>().id;
    const rRate = (
      await post(
        h,
        `${regular.base}/tax-rates`,
        { name: 'GST 18', ratePercent: '18', effectiveFrom: '2025-04-01' },
        regular.owner,
      )
    ).json<{ id: string }>().id;
    const rCable = await variant(h, regular, 'R-CB', { serialized: false });
    const rId = await createDraft(
      {
        supplierId: rSupplier,
        supplierInvoiceNo: 'R1',
        supplierInvoiceDate: '2026-10-20',
        lines: [{ variantId: rCable, quantity: '4', unitCostPaise: 2500, taxRateId: rRate }],
      },
      regular.owner,
      regular,
    );
    expect((await post(h, `${regular.base}/purchases/${rId}/post`, {}, regular.owner)).statusCode).toBe(200);
    expect(await avgCost(rCable)).toBe('2500');
  });

  it('inter-state supplier purchases use IGST', async () => {
    const id3 = await createDraft(
      draft([cableLine('2', 5000)], { supplierId: karnatakaSupplier, supplierInvoiceNo: 'KA-1' }),
    );
    const p = await fetchPurchase(id3);
    expect(p.isInterState).toBe(true);
    expect(p.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 1800, total: 11_800 });
  });

  it('concurrent postings of drafts sharing an IMEI: exactly one succeeds and the other writes nothing', async () => {
    const shared = imei(50);
    const a = await createDraft(
      draft([cableLine('1', 100), phoneLine([{ imei1: imei(51) }, { imei1: shared }])], {
        supplierInvoiceNo: 'RACE-A',
      }),
    );
    const b = await createDraft(
      draft([cableLine('1', 100), phoneLine([{ imei1: imei(52) }, { imei1: shared }])], {
        supplierInvoiceNo: 'RACE-B',
      }),
    );
    const results = await Promise.all([a, b].map((x) => post(h, `${shop.base}/purchases/${x}/post`, {}, shop.owner)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(200);
    expect([409, 422]).toContain(codes[1]);
    const loser = results[0]?.statusCode === 200 ? b : a;
    expect(await movementsOf(loser)).toBe(0);
    const left = await sql<{ n: number; status: string }>`
      select (select count(*)::int from lbg.serialized_units where purchase_id = ${loser}) as n,
             (select status from lbg.purchases where id = ${loser}) as status`.execute(h.admin);
    expect(left.rows[0]).toEqual({ n: 0, status: 'DRAFT' });
  });
});

describe('reversal (WORKFLOWS §5 step 5)', () => {
  it('reverses a purchase whose units are all in stock: units REVERSED, IMEIs released, stock and payable restored', async () => {
    const id = await createDraft(
      draft([phoneLine([{ imei1: imei(60) }]), cableLine('3', 1000)], { supplierInvoiceNo: 'REV-1' }),
    );
    expect((await post(h, `${shop.base}/purchases/${id}/post`, {}, shop.owner)).statusCode).toBe(200);
    const phonesBefore = await level(phoneId);
    const balanceBefore = (await get(h, `${shop.base}/suppliers/${supplierId}/ledger`, shop.owner)).json<{
      balancePaise: number;
    }>().balancePaise;
    expect((await post(h, `${shop.base}/purchases/${id}/reverse`, { reason: 'short' }, shop.owner)).statusCode).toBe(
      400,
    );
    expect(
      (
        await post(
          h,
          `${shop.base}/purchases/${id}/reverse`,
          { reason: 'Entered against the wrong supplier.' },
          shop.owner,
        )
      ).statusCode,
    ).toBe(204);
    expect(Number(await level(phoneId))).toBe(Number(phonesBefore) - 1);
    const unit = await sql<{ status: string; imeis: number }>`
      select u.status, (select count(*)::int from lbg.serialized_unit_imeis i where i.unit_id = u.id) as imeis
        from lbg.serialized_units u where u.purchase_id = ${id}`.execute(h.admin);
    expect(unit.rows).toEqual([{ status: 'REVERSED', imeis: 0 }]);
    const rev = await sql<{ n: number }>`
      select count(*)::int as n from lbg.stock_movements where reference_id = ${id} and movement_type = 'REVERSAL'`.execute(
      h.admin,
    );
    expect(rev.rows[0]?.n).toBe(2);
    const balanceAfter = (await get(h, `${shop.base}/suppliers/${supplierId}/ledger`, shop.owner)).json<{
      balancePaise: number;
    }>().balancePaise;
    expect(balanceBefore - balanceAfter).toBe(1_773_540); // phone ₹15,000 + cable 3 × ₹10, each + 18 %
    // The released IMEI can be entered again.
    const again = await createDraft(draft([phoneLine([{ imei1: imei(60) }])], { supplierInvoiceNo: 'REV-2' }));
    expect((await fetchPurchase(again)).problems.map((p) => p.code)).not.toContain('IMEI_EXISTS');
    expect(
      (
        await post(
          h,
          `${shop.base}/purchases/${id}/reverse`,
          { reason: 'Entered against the wrong supplier.' },
          shop.owner,
        )
      ).statusCode,
    ).toBe(409);
  });

  it('refuses when a unit has left stock or non-serialized stock no longer suffices', async () => {
    const id = await createDraft(draft([phoneLine([{ imei1: imei(70) }])], { supplierInvoiceNo: 'REV-3' }));
    await post(h, `${shop.base}/purchases/${id}/post`, {}, shop.owner);
    await sql`update lbg.serialized_units set status = 'SOLD' where purchase_id = ${id}`.execute(h.admin);
    const blocked = await post(
      h,
      `${shop.base}/purchases/${id}/reverse`,
      { reason: 'Testing a blocked reversal.' },
      shop.owner,
    );
    expect(blocked.statusCode).toBe(409);
    expect(errorCode(blocked)).toBe('REVERSAL_BLOCKED');

    const c = await createDraft(draft([cableLine('2', 1000)], { supplierInvoiceNo: 'REV-4' }));
    await post(h, `${shop.base}/purchases/${c}/post`, {}, shop.owner);
    const onHand = Number(await level(cableId));
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta)
              values (${shop.businessId}, ${cableId}, 'SALE', ${-(onHand - 1)})`.execute(h.admin);
    const short = await post(
      h,
      `${shop.base}/purchases/${c}/reverse`,
      { reason: 'Testing insufficient stock.' },
      shop.owner,
    );
    expect(short.statusCode).toBe(409);
    expect(errorCode(short)).toBe('INSUFFICIENT_STOCK');
    expect((await fetchPurchase(c)).status).toBe('POSTED');
  });
});

describe('permissions and tenancy', () => {
  it('Inventory staff create drafts but cannot post; Billing staff cannot see purchases', async () => {
    const id = await createDraft(draft([cableLine('1', 100)], { supplierInvoiceNo: 'INV-STAFF' }), inventory);
    expect((await post(h, `${shop.base}/purchases/${id}/post`, {}, inventory)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/purchases`, billing)).statusCode).toBe(403);
    expect((await get(h, `${shop.base}/suppliers`, billing)).statusCode).toBe(403);
  });

  it('other businesses get 404 and cannot use our supplier', async () => {
    const list = (await get(h, `${shop.base}/purchases`, shop.owner)).json<{ purchases: { id: string }[] }>().purchases;
    const id = list[0]?.id ?? '';
    expect((await get(h, `${shop.base}/purchases/${id}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/purchases/${id}`, other.owner)).statusCode).toBe(404);
    expect((await post(h, `${other.base}/purchases/${id}/post`, {}, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/suppliers/${supplierId}`, other.owner)).statusCode).toBe(404);
    expect((await get(h, `${other.base}/suppliers/${supplierId}/ledger`, other.owner)).statusCode).toBe(404);
    const steal = await post(h, `${other.base}/purchases`, { ...draft([]), supplierId }, other.owner);
    expect(steal.statusCode).toBe(422);
  });
});
