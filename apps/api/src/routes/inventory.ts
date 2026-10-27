// Stock reads, adjustments and approval requests (increment 4.3: FR-INV-4,
// FR-INV-7 AC1, WORKFLOWS §11).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UNIT_STATUSES, type UnitStatus } from '@lbgos/domain';
import { z } from 'zod';
import {
  ApprovalError,
  cancelApproval,
  decideApproval,
  listApprovals,
  type ApprovalStatus,
} from '@lbgos/modules/approvals';
import {
  adjustStock,
  agedStock,
  inspectionQueue,
  InventoryError,
  lookupCode,
  recordInspection,
  reorderReport,
  listMovements,
  listUnits,
  reconcileStock,
  stockOverview,
  type AdjustmentAction,
  type InspectionInput,
} from '@lbgos/modules/inventory';
import { APPROVAL_ACTIONS } from '../approval-actions.ts';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const reason = z.string().trim().min(10).max(500);
const signedQty = z.string().regex(/^-?\d{1,9}(\.\d{1,3})?$/, 'a quantity with up to 3 decimals');

const adjustmentBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('QUANTITY'), variantId: z.uuid(), quantity: signedQty, reason }),
  z.strictObject({
    kind: z.literal('DAMAGE'),
    variantId: z.uuid(),
    quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
    reason,
  }),
  z.strictObject({ kind: z.literal('UNIT_WRITE_OFF'), unitId: z.uuid(), reason }),
  z.strictObject({ kind: z.literal('CORRECTION'), movementId: z.uuid(), reason }),
]);

const outcome = z.enum(['RESTOCK', 'DAMAGED', 'REPAIR', 'RETURN_TO_SUPPLIER', 'REPAIRED']);
const notes = z.string().trim().max(1000).optional();
const inspectionBody = z.union([
  z.strictObject({ unitId: z.uuid(), outcome, notes }),
  z.strictObject({
    variantId: z.uuid(),
    quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
    outcome,
    notes,
  }),
]);
const days = (fallback: number) => z.coerce.number().int().min(1).max(3650).default(fallback);

const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'EXECUTED',
  'EXECUTION_FAILED',
] as const;

function sendInventoryError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  if (err instanceof InventoryError) {
    const status = {
      NOT_FOUND: 404,
      NOT_ALLOWED: 422,
      INVALID_QUANTITY: 422,
      ALREADY_REVERSED: 409,
      INSUFFICIENT_STOCK: 409,
      INVALID_UNIT_TRANSITION: 409,
    }[err.code];
    return send(status, err.code, err.code === 'NOT_FOUND' ? 'Not found.' : err.message);
  }
  if (err instanceof ApprovalError) {
    const status = {
      NOT_FOUND: 404,
      NOT_PENDING: 409,
      EXPIRED: 409,
      PAYLOAD_CHANGED: 409,
      SELF_APPROVAL: 403,
      FORBIDDEN: 403,
      NOTE_REQUIRED: 422,
      NOT_REQUESTER: 403,
      UNKNOWN_ACTION: 422,
    }[err.code];
    return send(status, err.code, err.code === 'NOT_FOUND' ? 'Not found.' : err.message);
  }
  return undefined;
}

export function registerInventoryRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const has = (request: FastifyRequest, key: string) => request.access?.permissions.has(key) === true;
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const handled = sendInventoryError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };

  app.get(
    '/api/businesses/:businessId/stock',
    {
      config: { permission: 'inventory.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          q: z.string().max(80).optional(),
          lowOnly: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (request) => {
      const q = request.query as { q?: string; lowOnly?: string };
      return {
        stock: await stockOverview(s.appDb, ctxOf(request), {
          search: q.q,
          lowOnly: q.lowOnly === 'true',
          canSeeCost: has(request, 'catalogue.cost.view'),
        }),
      };
    },
  );

  app.get(
    '/api/businesses/:businessId/stock/units',
    {
      config: { permission: 'inventory.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          variantId: z.uuid().optional(),
          status: z.enum(UNIT_STATUSES).optional(),
          imei: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
        }),
      },
    },
    async (request) => {
      const q = request.query as { variantId?: string; status?: UnitStatus; imei?: string };
      return {
        units: await listUnits(s.appDb, ctxOf(request), { ...q, canSeeCost: has(request, 'catalogue.cost.view') }),
      };
    },
  );

  app.get(
    '/api/businesses/:businessId/stock/movements',
    {
      config: { permission: 'inventory.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({ variantId: z.uuid().optional(), unitId: z.uuid().optional() }),
      },
    },
    async (request) => {
      const q = request.query as { variantId?: string; unitId?: string };
      return {
        movements: await listMovements(s.appDb, ctxOf(request), {
          ...q,
          canSeeCost: has(request, 'catalogue.cost.view'),
        }),
      };
    },
  );

  app.get(
    '/api/businesses/:businessId/stock/reconciliation',
    { config: { permission: 'inventory.view' }, schema: { params: businessParams } },
    async (request) => {
      const mismatches = await reconcileStock(s.appDb, ctxOf(request));
      return { consistent: mismatches.length === 0, mismatches };
    },
  );

  app.post(
    '/api/businesses/:businessId/stock/adjustments',
    { config: { permission: 'inventory.adjust.request' }, schema: { params: businessParams, body: adjustmentBody } },
    guarded(async (request, reply) => {
      const outcome = await adjustStock(
        s.appDb,
        ctxOf(request),
        has(request, 'inventory.adjust.approve'),
        request.body as AdjustmentAction,
        request.id,
      );
      return reply.status(outcome.status === 'EXECUTED' ? 201 : 202).send(outcome);
    }),
  );

  app.get(
    '/api/businesses/:businessId/stock/adjustment-requests',
    { config: { permission: 'inventory.adjust.request' }, schema: { params: businessParams } },
    async (request) => {
      const c = ctxOf(request);
      return { requests: await listApprovals(s.appDb, c, { requestedBy: c.userId }) };
    },
  );

  app.get(
    '/api/businesses/:businessId/approvals/mine',
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    async (request) => {
      const c = ctxOf(request);
      return { requests: await listApprovals(s.appDb, c, { requestedBy: c.userId }) };
    },
  );

  app.get(
    '/api/businesses/:businessId/approvals',
    {
      config: { permission: 'approvals.decide' },
      schema: { params: businessParams, querystring: z.strictObject({ status: z.enum(APPROVAL_STATUSES).optional() }) },
    },
    async (request) => ({
      requests: await listApprovals(s.appDb, ctxOf(request), {
        status: (request.query as { status?: ApprovalStatus }).status,
      }),
    }),
  );

  app.post(
    '/api/businesses/:businessId/approvals/:id/decide',
    {
      config: { permission: 'approvals.decide' },
      schema: {
        params: idParams,
        body: z.strictObject({
          approve: z.boolean(),
          payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    guarded(async (request) => {
      const body = request.body as { approve: boolean; payloadSha256: string; note?: string };
      const decided = await decideApproval(
        s.appDb,
        ctxOf(request),
        request.access?.permissions ?? new Map(),
        (request.params as { id: string }).id,
        { ...body, requestId: request.id },
        APPROVAL_ACTIONS,
      );
      return { request: decided };
    }),
  );

  app.post(
    '/api/businesses/:businessId/approvals/:id/cancel',
    // Any member may withdraw their own request (the module checks the requester).
    { config: { permission: MEMBER }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      if (request.access?.mode === 'READ_ONLY') {
        return reply.status(403).send({
          error: {
            code: 'TENANT_READ_ONLY',
            message: 'This action is not available for this business right now.',
            requestId: request.id,
          },
        });
      }
      await cancelApproval(s.appDb, ctxOf(request), (request.params as { id: string }).id);
      return reply.status(204).send();
    }),
  );

  app.get(
    '/api/businesses/:businessId/stock/inspections',
    { config: { permission: 'returns.inspect' }, schema: { params: businessParams } },
    async (request) => ({ queue: await inspectionQueue(s.appDb, ctxOf(request)) }),
  );

  app.post(
    '/api/businesses/:businessId/stock/inspections',
    { config: { permission: 'returns.inspect' }, schema: { params: businessParams, body: inspectionBody } },
    guarded(async (request, reply) => {
      const result = await recordInspection(s.appDb, ctxOf(request), request.body as InspectionInput, request.id);
      return reply.status(201).send(result);
    }),
  );

  // FR-INV-7 AC2: N and M default to 60 and 120 days.
  app.get(
    '/api/businesses/:businessId/stock/reports/aged',
    {
      config: { permission: 'inventory.view' },
      schema: { params: businessParams, querystring: z.strictObject({ slowDays: days(60), deadDays: days(120) }) },
    },
    async (request, reply) => {
      const q = request.query as { slowDays: number; deadDays: number };
      if (q.deadDays < q.slowDays) {
        return reply.status(400).send({
          error: { code: 'VALIDATION', message: 'deadDays must not be less than slowDays.', requestId: request.id },
        });
      }
      return agedStock(s.appDb, ctxOf(request), q);
    },
  );

  // FR-INV-7 AC3: 30-day sales window; lead time defaults to 7 days.
  app.get(
    '/api/businesses/:businessId/stock/reports/reorder',
    {
      config: { permission: 'inventory.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          windowDays: days(30),
          leadTimeDays: z.coerce.number().int().min(0).max(365).default(7),
        }),
      },
    },
    async (request) =>
      reorderReport(s.appDb, ctxOf(request), request.query as { windowDays: number; leadTimeDays: number }),
  );

  // FR-INV-9 AC1: one field for scanner (keyboard wedge) or typed input.
  app.get(
    '/api/businesses/:businessId/lookup',
    {
      config: { permission: 'catalogue.view' },
      schema: { params: businessParams, querystring: z.strictObject({ code: z.string().trim().min(1).max(64) }) },
    },
    async (request, reply) => {
      const result = await lookupCode(s.appDb, ctxOf(request), (request.query as { code: string }).code, {
        includeUnits: has(request, 'inventory.view'),
      });
      if (!result) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No match for this code.', requestId: request.id } });
      }
      return result;
    },
  );
}
