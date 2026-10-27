// Increment 4.3: stock reads, reconciliation, adjustments and approval
// requests (FR-INV-4, FR-INV-5 AC3, WORKFLOWS §11, rule R3).
import { withTenant } from '@lbgos/db';
import { createApprovalRequest, decideApproval } from '@lbgos/modules/approvals';
import { ADJUSTMENT_ACTION, adjustmentExecutor } from '@lbgos/modules/inventory';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './auth-harness.ts';
import {
  activeShop,
  errorCode,
  get,
  imei,
  post,
  resetFixture,
  staff,
  variant,
  type Session,
  type Shop,
} from './shop-fixture.ts';

let h: Harness;
let shop: Shop;
let other: Shop;
let manager: { id: string; session: Session };
let inventory: { id: string; session: Session };
let billing: Session;
let cableId: string;
let phoneId: string;
let unitIds: string[] = [];

interface Outcome {
  status: string;
  movementIds?: string[];
  approvalRequestId?: string;
  payloadSha256?: string;
}
interface StockRow {
  variantId: string;
  available: string;
  availableValuePaise?: number;
  low: boolean;
}

const adjust = (body: object, who: Session = shop.owner) => post(h, `${shop.base}/stock/adjustments`, body, who);
const available = async (variantId: string) =>
  (await get(h, `${shop.base}/stock`, shop.owner))
    .json<{ stock: StockRow[] }>()
    .stock.find((r) => r.variantId === variantId)?.available;
const decide = (id: string, body: object, who: Session) => post(h, `${shop.base}/approvals/${id}/decide`, body, who);

beforeAll(async () => {
  h = await startHarness();
  resetFixture();
  shop = await activeShop(h, 'inv-a');
  other = await activeShop(h, 'inv-b');
  manager = await staff(h, shop, 'inv-manager@example.test', 'Manager');
  inventory = await staff(h, shop, 'inv-staff@example.test', 'Inventory');
  billing = (await staff(h, shop, 'inv-billing@example.test', 'Billing')).session;
  cableId = await variant(h, shop, 'INV-CB', { serialized: false });
  phoneId = await variant(h, shop, 'INV-PH', { serialized: true });
  const supplierId = (await post(h, `${shop.base}/suppliers`, { name: 'Stock Supplier' }, shop.owner)).json<{
    id: string;
  }>().id;
  const draft = await post(
    h,
    `${shop.base}/purchases`,
    {
      supplierId,
      supplierInvoiceNo: 'INV-1',
      supplierInvoiceDate: '2026-10-20',
      lines: [
        { variantId: cableId, quantity: '5', unitCostPaise: 1000, taxRateId: null },
        {
          variantId: phoneId,
          quantity: '3',
          unitCostPaise: 900_000,
          taxRateId: null,
          units: [{ imei1: imei(101) }, { imei1: imei(102) }, { imei1: imei(103) }],
        },
      ],
    },
    shop.owner,
  );
  const id = draft.json<{ id: string }>().id;
  const posted = await post(h, `${shop.base}/purchases/${id}/post`, {}, shop.owner);
  if (posted.statusCode !== 200) throw new Error(posted.body);
  unitIds = (
    await sql<{
      id: string;
    }>`select id from lbg.serialized_units where purchase_id = ${id} order by created_at`.execute(h.admin)
  ).rows.map((r) => r.id);
}, 180_000);
afterAll(async () => {
  await h.close();
});

describe('stock reads and reconciliation (FR-INV-4 AC3)', () => {
  it('shows levels per bucket; costs only with catalogue.cost.view', async () => {
    const owner = (await get(h, `${shop.base}/stock`, shop.owner)).json<{ stock: StockRow[] }>().stock;
    expect(owner.find((r) => r.variantId === cableId)).toMatchObject({ available: '5.000', availableValuePaise: 5000 });
    expect(owner.find((r) => r.variantId === phoneId)).toMatchObject({
      available: '3.000',
      availableValuePaise: 2_700_000,
    });
    const asBilling = (await get(h, `${shop.base}/stock`, billing)).json<{ stock: StockRow[] }>().stock;
    expect(asBilling.length).toBeGreaterThan(0);
    for (const r of asBilling) expect(r).not.toHaveProperty('availableValuePaise');
  });

  it('lists units by IMEI and the movement history', async () => {
    const units = (await get(h, `${shop.base}/stock/units?imei=${imei(102)}`, shop.owner)).json<{
      units: { id: string; status: string; imei1: string }[];
    }>().units;
    expect(units).toEqual([expect.objectContaining({ id: unitIds[1], status: 'IN_STOCK', imei1: imei(102) })]);
    const moves = (await get(h, `${shop.base}/stock/movements?variantId=${phoneId}`, shop.owner)).json<{
      movements: { type: string }[];
    }>().movements;
    expect(moves.map((m) => m.type)).toEqual(['PURCHASE', 'PURCHASE', 'PURCHASE']);
  });

  it('reconciliation is clean, and detects a projection that was tampered with', async () => {
    const clean = (await get(h, `${shop.base}/stock/reconciliation`, shop.owner)).json<{ consistent: boolean }>();
    expect(clean.consistent).toBe(true);
    // The app role cannot write the projection at all.
    await expect(
      withTenant(h.appDb, { businessId: shop.businessId, userId: shop.ownerId }, (trx) =>
        sql`update lbg.stock_levels set quantity = 99`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await sql`update lbg.stock_levels set quantity = quantity + 1 where variant_id = ${cableId}`.execute(h.admin);
    const bad = (await get(h, `${shop.base}/stock/reconciliation`, shop.owner)).json<{
      consistent: boolean;
      mismatches: { variantId: string; projected: string; ledger: string }[];
    }>();
    expect(bad.consistent).toBe(false);
    expect(bad.mismatches).toEqual([{ variantId: cableId, bucket: 'AVAILABLE', projected: '6.000', ledger: '5.000' }]);
    await sql`update lbg.stock_levels set quantity = quantity - 1 where variant_id = ${cableId}`.execute(h.admin);
  });
});

describe('direct adjustments by approvers (FR-INV-4 AC2, AC4)', () => {
  let adjustmentMovement = '';

  it('needs a reason; writes an ADJUSTMENT movement and an audit event', async () => {
    expect((await adjust({ kind: 'QUANTITY', variantId: cableId, quantity: '-2', reason: 'short' })).statusCode).toBe(
      400,
    );
    const res = await adjust({
      kind: 'QUANTITY',
      variantId: cableId,
      quantity: '-2',
      reason: 'Stock count found two fewer.',
    });
    expect(res.statusCode).toBe(201);
    const out = res.json<Outcome>();
    expect(out.status).toBe('EXECUTED');
    adjustmentMovement = out.movementIds?.[0] ?? '';
    expect(await available(cableId)).toBe('3.000');
    const audit = await sql<{ n: number }>`
      select count(*)::int as n from lbg.audit_events where business_id = ${shop.businessId} and action = 'inventory.adjust'`.execute(
      h.admin,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('refuses negative stock unless the business allows it; serialized stock is adjusted per unit', async () => {
    const short = await adjust({
      kind: 'QUANTITY',
      variantId: cableId,
      quantity: '-10',
      reason: 'Testing negative stock.',
    });
    expect(short.statusCode).toBe(409);
    expect(errorCode(short)).toBe('INSUFFICIENT_STOCK');
    await sql`insert into lbg.business_settings (business_id, allow_negative_stock) values (${shop.businessId}, true)
              on conflict (business_id) do update set allow_negative_stock = true`.execute(h.admin);
    const allowed = await adjust({
      kind: 'QUANTITY',
      variantId: cableId,
      quantity: '-4',
      reason: 'Testing negative stock.',
    });
    expect(allowed.statusCode).toBe(201);
    expect(await available(cableId)).toBe('-1.000');
    await adjust({ kind: 'QUANTITY', variantId: cableId, quantity: '4', reason: 'Undo the negative stock test.' });
    await sql`update lbg.business_settings set allow_negative_stock = false where business_id = ${shop.businessId}`.execute(
      h.admin,
    );
    const serialized = await adjust({
      kind: 'QUANTITY',
      variantId: phoneId,
      quantity: '1',
      reason: 'Testing serialized adjust.',
    });
    expect(serialized.statusCode).toBe(422);
    expect(errorCode(serialized)).toBe('NOT_ALLOWED');
  });

  it('writes off a unit once; a second write-off is an invalid transition', async () => {
    const res = await adjust({ kind: 'UNIT_WRITE_OFF', unitId: unitIds[2], reason: 'Screen cracked in storage.' });
    expect(res.statusCode).toBe(201);
    expect(await available(phoneId)).toBe('2.000');
    const again = await adjust({ kind: 'UNIT_WRITE_OFF', unitId: unitIds[2], reason: 'Screen cracked in storage.' });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('INVALID_UNIT_TRANSITION');
  });

  it('corrects an adjustment with a REVERSAL once; purchase movements are not corrected here', async () => {
    const res = await adjust({
      kind: 'CORRECTION',
      movementId: adjustmentMovement,
      reason: 'The count was wrong after all.',
    });
    expect(res.statusCode).toBe(201);
    expect(await available(cableId)).toBe('5.000');
    const twice = await adjust({
      kind: 'CORRECTION',
      movementId: adjustmentMovement,
      reason: 'The count was wrong after all.',
    });
    expect(errorCode(twice)).toBe('ALREADY_REVERSED');
    const purchaseMove = (
      await sql<{
        id: string;
      }>`select id from lbg.stock_movements where variant_id = ${cableId} and movement_type = 'PURCHASE'`.execute(
        h.admin,
      )
    ).rows[0]?.id;
    const doc = await adjust({
      kind: 'CORRECTION',
      movementId: purchaseMove,
      reason: 'Trying to undo a purchase line.',
    });
    expect(errorCode(doc)).toBe('NOT_ALLOWED');
  });

  it('concurrent decrements of the last item and concurrent write-offs of one unit: exactly one succeeds (AC5)', async () => {
    await adjust({ kind: 'QUANTITY', variantId: cableId, quantity: '-4', reason: 'Leave exactly one in stock.' });
    expect(await available(cableId)).toBe('1.000');
    const both = await Promise.all(
      [shop.owner, manager.session].map((who) =>
        adjust({ kind: 'QUANTITY', variantId: cableId, quantity: '-1', reason: 'Parallel decrement test.' }, who),
      ),
    );
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await available(cableId)).toBe('0.000');
    const writeOffs = await Promise.all(
      [shop.owner, manager.session].map((who) =>
        adjust({ kind: 'UNIT_WRITE_OFF', unitId: unitIds[1], reason: 'Parallel write-off test.' }, who),
      ),
    );
    expect(writeOffs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await available(phoneId)).toBe('1.000');
    await adjust({ kind: 'QUANTITY', variantId: cableId, quantity: '10', reason: 'Restock for approval tests.' });
  });
});

describe('approval requests (WORKFLOWS §11, FR-INV-4 AC4)', () => {
  let requestId = '';
  let hash = '';

  it('staff without approve permission raise a request; nothing changes until it is approved', async () => {
    const res = await adjust(
      { kind: 'DAMAGE', variantId: cableId, quantity: '2', reason: 'Two cables arrived with cut wires.' },
      inventory.session,
    );
    expect(res.statusCode).toBe(202);
    const out = res.json<Outcome>();
    expect(out.status).toBe('PENDING_APPROVAL');
    requestId = out.approvalRequestId ?? '';
    hash = out.payloadSha256 ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await available(cableId)).toBe('10.000');
    const mine = (await get(h, `${shop.base}/stock/adjustment-requests`, inventory.session)).json<{
      requests: { id: string; status: string }[];
    }>().requests;
    expect(mine).toEqual([expect.objectContaining({ id: requestId, status: 'PENDING' })]);
  });

  it('only approvers decide, and only on the exact payload they reviewed', async () => {
    expect((await decide(requestId, { approve: true, payloadSha256: hash }, inventory.session)).statusCode).toBe(403);
    const changed = await decide(requestId, { approve: true, payloadSha256: '0'.repeat(64) }, manager.session);
    expect(changed.statusCode).toBe(409);
    expect(errorCode(changed)).toBe('PAYLOAD_CHANGED');
    const ok = await decide(requestId, { approve: true, payloadSha256: hash }, manager.session);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ request: { status: string; decidedBy: string } }>().request).toMatchObject({
      status: 'EXECUTED',
      decidedBy: manager.id,
    });
    expect(await available(cableId)).toBe('8.000');
    const moves = await sql<{ n: number }>`
      select count(*)::int as n from lbg.stock_movements where reference_type = 'APPROVAL' and reference_id = ${requestId}`.execute(
      h.admin,
    );
    expect(moves.rows[0]?.n).toBe(1);
    // Executed once: deciding again is refused and writes nothing more.
    expect((await decide(requestId, { approve: true, payloadSha256: hash }, shop.owner)).statusCode).toBe(409);
    // The stored request cannot be edited, even by the database owner role.
    await expect(
      sql`update lbg.approval_requests set payload = '{}'::jsonb where id = ${requestId}`.execute(h.admin),
    ).rejects.toMatchObject({ code: 'LB017' });
  });

  it('rejection needs a note; the requester (only) can cancel a pending request', async () => {
    const make = async () =>
      (
        await adjust(
          { kind: 'DAMAGE', variantId: cableId, quantity: '1', reason: 'One more damaged cable.' },
          inventory.session,
        )
      ).json<Outcome>();
    const a = await make();
    expect(
      (await decide(a.approvalRequestId ?? '', { approve: false, payloadSha256: a.payloadSha256 }, manager.session))
        .statusCode,
    ).toBe(422);
    const rejected = await decide(
      a.approvalRequestId ?? '',
      { approve: false, payloadSha256: a.payloadSha256, note: 'Not damaged; it was the other box.' },
      manager.session,
    );
    expect(rejected.json<{ request: { status: string } }>().request.status).toBe('REJECTED');
    const b = await make();
    expect(
      (await post(h, `${shop.base}/approvals/${b.approvalRequestId ?? ''}/cancel`, {}, manager.session)).statusCode,
    ).toBe(403);
    expect(
      (await post(h, `${shop.base}/approvals/${b.approvalRequestId ?? ''}/cancel`, {}, inventory.session)).statusCode,
    ).toBe(204);
    expect(await available(cableId)).toBe('8.000');
  });

  it('an approval whose execution fails is recorded as EXECUTION_FAILED and writes no stock', async () => {
    const r = (
      await adjust(
        { kind: 'DAMAGE', variantId: cableId, quantity: '8', reason: 'Whole box water-damaged.' },
        inventory.session,
      )
    ).json<Outcome>();
    await adjust({ kind: 'QUANTITY', variantId: cableId, quantity: '-1', reason: 'One sold off the books.' });
    const res = await decide(
      r.approvalRequestId ?? '',
      { approve: true, payloadSha256: r.payloadSha256 },
      manager.session,
    );
    expect(res.json<{ request: { status: string; errorCode: string } }>().request).toMatchObject({
      status: 'EXECUTION_FAILED',
      errorCode: 'INSUFFICIENT_STOCK',
    });
    expect(await available(cableId)).toBe('7.000');
  });

  it('expired requests cannot be approved', async () => {
    const { rows } = await sql<{ id: string }>`
      insert into lbg.approval_requests (business_id, requested_by, action_type, payload, payload_sha256,
                                         required_permission, reason, expires_at, created_at)
      values (${shop.businessId}, ${inventory.id}, ${ADJUSTMENT_ACTION}, '{}'::jsonb, ${'a'.repeat(64)},
              'inventory.adjust.approve', 'An old request from last week.', now() - interval '1 hour',
              now() - interval '73 hours')
      returning id`.execute(h.admin);
    const res = await decide(rows[0]?.id ?? '', { approve: true, payloadSha256: 'a'.repeat(64) }, manager.session);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('EXPIRED');
  });

  it('R3: no self-approval while another member could approve; a sole owner may, and it is audited', async () => {
    const ctx = { businessId: shop.businessId, userId: manager.id };
    const action = { kind: 'DAMAGE', variantId: cableId, quantity: '1', reason: 'Manager raises own request.' };
    const req = await withTenant(h.appDb, ctx, (trx) =>
      createApprovalRequest(trx, ctx, {
        actionType: ADJUSTMENT_ACTION,
        payload: action,
        requiredPermission: 'inventory.adjust.approve',
        reason: action.reason,
      }),
    );
    const perms = new Set(['approvals.decide', 'inventory.adjust.approve']);
    const executors = { [ADJUSTMENT_ACTION]: adjustmentExecutor };
    await expect(
      decideApproval(h.appDb, ctx, perms, req.id, { approve: true, payloadSha256: req.payloadSha256 }, executors),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });

    // `other` has a single member (its owner), who is therefore the only possible approver.
    const otherCable = await variant(h, other, 'SOLE-CB', { serialized: false });
    await sql`insert into lbg.stock_movements (business_id, variant_id, movement_type, quantity_delta)
              values (${other.businessId}, ${otherCable}, 'OPENING', 3)`.execute(h.admin);
    const sole = { businessId: other.businessId, userId: other.ownerId };
    const soleAction = { kind: 'DAMAGE', variantId: otherCable, quantity: '1', reason: 'Sole owner request test.' };
    const soleReq = await withTenant(h.appDb, sole, (trx) =>
      createApprovalRequest(trx, sole, {
        actionType: ADJUSTMENT_ACTION,
        payload: soleAction,
        requiredPermission: 'inventory.adjust.approve',
        reason: soleAction.reason,
      }),
    );
    const done = await decideApproval(
      h.appDb,
      sole,
      perms,
      soleReq.id,
      { approve: true, payloadSha256: soleReq.payloadSha256 },
      executors,
    );
    expect(done.status).toBe('EXECUTED');
    const audit = await sql<{ self: boolean }>`
      select (metadata->>'selfApproved')::boolean as self from lbg.audit_events
       where target_id = ${soleReq.id} and action = 'approval.approve'`.execute(h.admin);
    expect(audit.rows).toEqual([{ self: true }]);
  });
});

describe('permissions and tenancy', () => {
  it('every staff member can open the business overview, which lists their usable permissions', async () => {
    const view = await get(h, shop.base, inventory.session);
    expect(view.statusCode).toBe(200);
    const permissions = view.json<{ access: { permissions: string[] } }>().access.permissions;
    expect(permissions).toEqual(expect.arrayContaining(['inventory.adjust.request', 'ocr.scan']));
    expect(permissions).not.toContain('inventory.adjust.approve');
    expect((await get(h, shop.base, billing)).statusCode).toBe(200);
    expect((await get(h, shop.base, other.owner)).statusCode).toBe(404);
  });

  it('Billing staff can view stock but cannot adjust or decide', async () => {
    expect((await get(h, `${shop.base}/stock`, billing)).statusCode).toBe(200);
    expect(
      (
        await adjust(
          { kind: 'QUANTITY', variantId: cableId, quantity: '1', reason: 'Billing should not adjust.' },
          billing,
        )
      ).statusCode,
    ).toBe(403);
    expect((await get(h, `${shop.base}/approvals`, billing)).statusCode).toBe(403);
  });

  it('other tenants get 404, and cannot adjust our variants or units through their own business', async () => {
    for (const path of ['stock', 'stock/units', 'stock/movements', 'stock/reconciliation', 'approvals']) {
      expect((await get(h, `${shop.base}/${path}`, other.owner)).statusCode).toBe(404);
    }
    const viaOwn = await post(
      h,
      `${other.base}/stock/adjustments`,
      { kind: 'QUANTITY', variantId: cableId, quantity: '-1', reason: 'Cross-tenant adjustment attempt.' },
      other.owner,
    );
    expect(viaOwn.statusCode).toBe(404);
    const unit = await post(
      h,
      `${other.base}/stock/adjustments`,
      { kind: 'UNIT_WRITE_OFF', unitId: unitIds[0], reason: 'Cross-tenant write-off attempt.' },
      other.owner,
    );
    expect(unit.statusCode).toBe(404);
    expect(await available(cableId)).toBe('7.000');
  });

  it('the ledger and the projection still agree after everything above', async () => {
    expect(
      (await get(h, `${shop.base}/stock/reconciliation`, shop.owner)).json<{ consistent: boolean }>().consistent,
    ).toBe(true);
    expect(
      (await get(h, `${other.base}/stock/reconciliation`, other.owner)).json<{ consistent: boolean }>().consistent,
    ).toBe(true);
  });
});
