// Offers and the AI Creative Studio (increment 7.4: FR-AIC-1…5, D-057).
// Drafting needs marketing.draft; approving offers and content, and
// acknowledging post-check flags, need marketing.approve.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASPECTS, PLATFORM_LIMITS, type Platform } from '@lbgos/domain';
import { getUploadFile } from '@lbgos/modules/ocr';
import {
  acknowledgeFlags,
  approveDraft,
  approveOffer,
  archiveDraft,
  createOffer,
  editDraft,
  generateCaption,
  generateImage,
  getDraft,
  listDrafts,
  listOffers,
  rejectDraft,
  StudioError,
  submitDraft,
  withdrawOffer,
  type GenerateInput,
  type OfferInput,
  type StudioDeps,
} from '@lbgos/modules/studio';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const PLATFORMS = Object.keys(PLATFORM_LIMITS) as [Platform, ...Platform[]];

const STATUS = {
  NOT_FOUND: 404,
  NOT_CONFIGURED: 409,
  OFFER_NOT_USABLE: 422,
  PRODUCTS_INVALID: 422,
  GENERATION_FAILED: 502,
  INVALID_STATE: 409,
  FLAGS_OPEN: 409,
  TOO_LONG: 422,
  STORAGE_NOT_CONFIGURED: 503,
  QUOTA_EXCEEDED: 429,
} as const satisfies Record<StudioError['code'], number>;

export function registerStudioRoutes(app: FastifyInstance, s: AppServices): void {
  const deps: StudioDeps = {
    appDb: s.appDb,
    secrets: s.secrets ?? null,
    allowMocks: s.integrations?.allowMocks ?? false,
    outbound: s.integrations?.outbound,
    retryBaseMs: s.integrations?.retryBaseMs,
    storage: s.ocr,
  };
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
        if (!(err instanceof StudioError)) throw err;
        const nf = err.code === 'NOT_FOUND';
        return reply.status(STATUS[err.code]).send({
          error: { code: err.code, message: nf ? 'Not found.' : err.message, requestId: request.id },
        });
      }
    };
  const base = '/api/businesses/:businessId';
  /** Reading drafts and offers needs marketing.draft but stays possible in read-only mode (D-009). */
  const readable = { config: { permission: MEMBER } };
  const canRead = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.access?.permissions.has('marketing.draft') === true) return true;
    void reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.', requestId: request.id },
    });
    return false;
  };

  app.get(`${base}/offers`, { ...readable, schema: { params: businessParams } }, async (request, reply) =>
    canRead(request, reply) ? { offers: await listOffers(s.appDb, ctxOf(request)) } : reply,
  );
  app.post(
    `${base}/offers`,
    {
      config: { permission: 'marketing.draft' },
      schema: {
        params: businessParams,
        body: z
          .strictObject({
            title: z.string().trim().min(1).max(80),
            discountKind: z.enum(['PERCENT', 'AMOUNT']),
            discountValue: z.number().int().min(1).max(10_000_000_000),
            validFrom: z.iso.date(),
            validTo: z.iso.date(),
            terms: z.string().trim().min(1).max(500).nullable().optional(),
          })
          .refine((o) => o.validTo >= o.validFrom, 'validTo must not be before validFrom')
          .refine((o) => o.discountKind !== 'PERCENT' || o.discountValue <= 9000, 'a percentage is at most 90 %'),
      },
    },
    guarded(async (request, reply) =>
      reply.status(201).send({ offer: await createOffer(s.appDb, ctxOf(request), request.body as OfferInput) }),
    ),
  );
  app.post(
    `${base}/offers/:id/approve`,
    { config: { permission: 'marketing.approve' }, schema: { params: idParams } },
    guarded(async (request) => ({ offer: await approveOffer(s.appDb, ctxOf(request), idOf(request)) })),
  );
  app.post(
    `${base}/offers/:id/withdraw`,
    { config: { permission: 'marketing.approve' }, schema: { params: idParams } },
    guarded(async (request) => ({ offer: await withdrawOffer(s.appDb, ctxOf(request), idOf(request)) })),
  );

  const generateBody = z.strictObject({
    kind: z.enum(['CAPTION', 'IMAGE']),
    productIds: z.array(z.uuid()).min(1).max(10),
    offerId: z.uuid().nullable().optional(),
    platform: z.enum(PLATFORMS),
    tone: z.enum(['friendly', 'formal', 'festive']).optional(),
    aspect: z.enum(ASPECTS).optional(),
  });
  app.post(
    `${base}/studio/generate`,
    { config: { permission: 'marketing.draft' }, schema: { params: businessParams, body: generateBody } },
    guarded(async (request, reply) => {
      const b = request.body as GenerateInput & { kind: 'CAPTION' | 'IMAGE' };
      const out =
        b.kind === 'CAPTION'
          ? await generateCaption(deps, ctxOf(request), b)
          : await generateImage(deps, ctxOf(request), b);
      return reply.status(201).send(out);
    }),
  );
  app.get(`${base}/studio/drafts`, { ...readable, schema: { params: businessParams } }, async (request, reply) =>
    canRead(request, reply) ? { drafts: await listDrafts(s.appDb, ctxOf(request)) } : reply,
  );
  app.get(
    `${base}/studio/drafts/:id`,
    { ...readable, schema: { params: idParams } },
    guarded(async (request, reply) =>
      canRead(request, reply) ? { draft: await getDraft(s.appDb, ctxOf(request), idOf(request)) } : reply,
    ),
  );
  app.get(
    `${base}/studio/drafts/:id/image`,
    { ...readable, schema: { params: idParams } },
    guarded(async (request, reply) => {
      if (!canRead(request, reply)) return reply;
      const ctx = ctxOf(request);
      const d = await getDraft(s.appDb, ctx, idOf(request));
      const file = d.uploadId && s.ocr ? await getUploadFile(s.appDb, s.ocr, ctx, d.uploadId) : null;
      if (!file)
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
      return reply
        .header('content-type', file.contentType)
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(file.bytes));
    }),
  );
  app.patch(
    `${base}/studio/drafts/:id`,
    {
      config: { permission: 'marketing.draft' },
      schema: { params: idParams, body: z.strictObject({ body: z.string().trim().min(1).max(10_000) }) },
    },
    guarded(async (request) => ({
      draft: await editDraft(s.appDb, ctxOf(request), idOf(request), (request.body as { body: string }).body),
    })),
  );
  app.post(
    `${base}/studio/drafts/:id/acknowledge`,
    {
      config: { permission: 'marketing.approve' },
      schema: { params: idParams, body: z.strictObject({ values: z.array(z.string().max(200)).min(1).max(50) }) },
    },
    guarded(async (request) => ({
      draft: await acknowledgeFlags(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.body as { values: string[] }).values,
      ),
    })),
  );
  for (const [path, permission, fn] of [
    ['submit', 'marketing.draft', submitDraft],
    ['approve', 'marketing.approve', approveDraft],
    ['reject', 'marketing.approve', rejectDraft],
    ['archive', 'marketing.draft', archiveDraft],
  ] as const) {
    app.post(
      `${base}/studio/drafts/:id/${path}`,
      { config: { permission }, schema: { params: idParams } },
      guarded(async (request) => ({ draft: await fn(s.appDb, ctxOf(request), idOf(request)) })),
    );
  }
}
