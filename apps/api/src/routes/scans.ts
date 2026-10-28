// Scans: upload, status, review, create draft purchase (increment 4.5:
// FR-OCR-1…6). Uploads are raw request bodies (application/octet-stream)
// with their own size limit; everything else keeps the 1 MiB JSON limit.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createDraftFromScan,
  discardScan,
  getScan,
  getScanFile,
  listScans,
  OcrError,
  productDraftFromScan,
  retryScan,
  scanLookup,
  uploadScan,
  type ScanType,
} from '@lbgos/modules/ocr';
import { PurchasingError, type PurchaseDraftInput } from '@lbgos/modules/purchasing';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';
import { purchaseBody } from './purchasing.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });

const FILE_STATUS: Readonly<Record<string, number>> = {
  EMPTY: 400,
  TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  HEIC_UNSUPPORTED: 415,
  MALFORMED: 422,
  TOO_MANY_PAGES: 422,
  DIMENSIONS_TOO_LARGE: 422,
  QUOTA_EXCEEDED: 429,
  BUSY: 503,
  READ_FAILED: 422,
};

function sendScanError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, body: Record<string, unknown>) =>
    reply.status(status).send({ error: { ...body, requestId: request.id } });
  if (err instanceof OcrError) {
    if (err.code === 'NOT_FOUND') return send(404, { code: 'NOT_FOUND', message: 'Not found.' });
    const fileStatus = FILE_STATUS[err.code];
    if (fileStatus) {
      const message =
        err.code === 'HEIC_UNSUPPORTED'
          ? 'HEIC photos cannot be read yet. Take the photo as JPEG, or change the camera setting to "Most compatible".'
          : err.message;
      return send(fileStatus, { code: err.code, message });
    }
    if (err.code === 'UNCONFIRMED_FIELDS') {
      return send(422, { code: err.code, message: err.message, fields: err.fields });
    }
    return send(409, { code: err.code, message: err.message });
  }
  if (err instanceof PurchasingError) {
    return send(err.code === 'NOT_FOUND' ? 404 : 422, {
      code: err.code,
      message: err.message,
      ...(err.field ? { field: err.field } : {}),
    });
  }
  return undefined;
}

export function registerScanRoutes(app: FastifyInstance, s: AppServices): void {
  const ocr = s.ocr;
  if (!ocr) return;
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const handled = sendScanError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };

  // Raw bodies only for this content type; JSON routes are unaffected.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post(
    '/api/businesses/:businessId/scans',
    {
      config: { permission: 'ocr.scan' },
      // Room for the configured limit; the module enforces the exact one with a clear error.
      bodyLimit: ocr.limits.maxBytes + 1024,
      schema: {
        params: businessParams,
        querystring: z.strictObject({
          type: z.enum(['PRODUCT_LABEL', 'SUPPLIER_INVOICE']),
          name: z.string().max(200).optional(),
        }),
        body: z.instanceof(Buffer),
      },
    },
    guarded(async (request, reply) => {
      const q = request.query as { type: ScanType; name?: string };
      const result = await uploadScan(
        s.appDb,
        ocr,
        ctxOf(request),
        { bytes: request.body as Buffer, scanType: q.type, originalName: q.name },
        request.id,
      );
      return reply.status(202).send(result);
    }),
  );

  // 12.2: read a photo now and say what it matches (sale and stock). The photo is not stored.
  app.post(
    '/api/businesses/:businessId/scan-lookup',
    {
      config: { permission: MEMBER },
      bodyLimit: ocr.limits.maxBytes + 1024,
      schema: { params: businessParams, body: z.instanceof(Buffer) },
    },
    guarded(async (request, reply) => {
      const p = request.access?.permissions;
      if (p?.has('pos.sell') !== true && p?.has('inventory.view') !== true) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.', requestId: request.id },
        });
      }
      return { lookup: await scanLookup(s.appDb, ocr, ctxOf(request), request.body as Buffer) };
    }),
  );

  // 12.3: a product form pre-filled from a product-label scan (saving uses the normal product route).
  app.get(
    '/api/businesses/:businessId/scans/:id/product-draft',
    { config: { permission: 'ocr.scan' }, schema: { params: idParams } },
    async (request, reply) => {
      const draft = await productDraftFromScan(s.appDb, ctxOf(request), idOf(request));
      if (!draft)
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
      return { draft };
    },
  );

  app.get(
    '/api/businesses/:businessId/scans',
    { config: { permission: 'ocr.scan' }, schema: { params: businessParams } },
    async (request) => ({ scans: await listScans(s.appDb, ctxOf(request)) }),
  );

  app.get(
    '/api/businesses/:businessId/scans/:id',
    { config: { permission: 'ocr.scan' }, schema: { params: idParams } },
    async (request, reply) => {
      const scan = await getScan(s.appDb, ctxOf(request), idOf(request), {
        canViewInventory: request.access?.permissions.has('inventory.view') === true,
      });
      if (!scan)
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
      return { scan };
    },
  );

  // Authenticated proxy (FR-OCR-6 AC2): images inline for the review screen,
  // PDFs as downloads; sandboxed and never sniffed into another type.
  app.get(
    '/api/businesses/:businessId/scans/:id/file',
    { config: { permission: 'ocr.scan' }, schema: { params: idParams } },
    async (request, reply) => {
      const file = await getScanFile(s.appDb, ocr, ctxOf(request), idOf(request));
      if (!file)
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
      const inline = file.contentType.startsWith('image/');
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', inline ? 'inline' : 'attachment; filename="scan.pdf"')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(file.bytes));
    },
  );

  app.post(
    '/api/businesses/:businessId/scans/:id/retry',
    { config: { permission: 'ocr.scan' }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      await retryScan(s.appDb, ctxOf(request), idOf(request));
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/businesses/:businessId/scans/:id/discard',
    { config: { permission: 'ocr.scan' }, schema: { params: idParams } },
    guarded(async (request, reply) => {
      await discardScan(s.appDb, ctxOf(request), idOf(request));
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/businesses/:businessId/scans/:id/create',
    {
      config: { permission: 'ocr.scan' },
      schema: {
        params: idParams,
        body: z.strictObject({ purchase: purchaseBody, confirmed: z.array(z.string().max(80)).max(2000) }),
      },
    },
    guarded(async (request, reply) => {
      // Creating a draft purchase also needs purchases.create (FR-OCR-4 AC3).
      if (request.access?.permissions.has('purchases.create') !== true) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.', requestId: request.id },
        });
      }
      const body = request.body as { purchase: PurchaseDraftInput; confirmed: string[] };
      const result = await createDraftFromScan(s.appDb, ctxOf(request), idOf(request), body, request.id);
      return reply.status(201).send(result);
    }),
  );
}
