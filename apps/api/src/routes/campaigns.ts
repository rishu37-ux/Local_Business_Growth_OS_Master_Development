// Campaigns (increment 7.5: FR-AIC-3 AC1, FR-AIC-4 AC2, WORKFLOWS §9, D-058).
// Drafting needs marketing.draft, approving the exact version
// marketing.approve, and sending or scheduling an approved campaign
// marketing.send. No messaging provider is connected yet: sending is refused
// with PROVIDER_NOT_CONFIGURED rather than pretending to run.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  approveCampaign,
  CampaignError,
  cancelCampaign,
  createCampaign,
  dispatchCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  previewAudience,
  returnCampaign,
  runDueCampaigns,
  scheduleCampaign,
  submitCampaign,
  unscheduleCampaign,
  updateCampaign,
  type CampaignInput,
} from '@lbgos/modules/campaigns';
import { NOT_CONFIGURED } from '@lbgos/modules/messaging';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });

const STATUS = {
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  DRAFT_NOT_APPROVED: 409,
  DRAFT_CHANGED: 409,
  TOO_LONG: 422,
  SELF_APPROVAL: 403,
  SCHEDULE_INVALID: 422,
  PROVIDER_NOT_CONFIGURED: 409,
  AUDIENCE_EMPTY: 422,
  AUDIENCE_TOO_LARGE: 422,
} as const satisfies Record<CampaignError['code'], number>;

const tag = z.string().trim().min(1).max(30);
const fields = {
  name: z.string().trim().min(1).max(80),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  body: z.string().trim().min(1).max(1000).optional(),
  draftId: z.uuid().optional(),
  segmentTags: z.array(tag).max(10).optional(),
  segmentMatch: z.enum(['ANY', 'ALL']).optional(),
};

export function registerCampaignRoutes(app: FastifyInstance, s: AppServices): void {
  const provider = s.messaging ?? NOT_CONFIGURED;
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
        if (!(err instanceof CampaignError)) throw err;
        const nf = err.code === 'NOT_FOUND';
        return reply.status(STATUS[err.code]).send({
          error: { code: err.code, message: nf ? 'Not found.' : err.message, requestId: request.id },
        });
      }
    };
  const base = '/api/businesses/:businessId/campaigns';
  /** Reading campaigns needs marketing.draft but stays possible in read-only mode (D-009). */
  const canRead = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.access?.permissions.has('marketing.draft') === true) return true;
    void reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.', requestId: request.id },
    });
    return false;
  };

  app.get(base, { config: { permission: MEMBER }, schema: { params: businessParams } }, async (request, reply) =>
    canRead(request, reply)
      ? { campaigns: await listCampaigns(s.appDb, ctxOf(request)), provider: { configured: provider.configured } }
      : reply,
  );
  app.get(
    `${base}/:id`,
    { config: { permission: MEMBER }, schema: { params: idParams } },
    guarded(async (request, reply) =>
      canRead(request, reply)
        ? {
            campaign: await getCampaign(s.appDb, ctxOf(request), idOf(request)),
            audience: await previewAudience(s.appDb, ctxOf(request), idOf(request)),
            provider: { configured: provider.configured },
          }
        : reply,
    ),
  );
  app.post(
    base,
    {
      config: { permission: 'marketing.draft' },
      schema: {
        params: businessParams,
        body: z.strictObject(fields).refine((b) => !!b.body !== !!b.draftId, 'give either body or draftId'),
      },
    },
    guarded(async (request, reply) =>
      reply
        .status(201)
        .send({ campaign: await createCampaign(s.appDb, ctxOf(request), request.body as CampaignInput) }),
    ),
  );
  app.patch(
    `${base}/:id`,
    {
      config: { permission: 'marketing.draft' },
      schema: {
        params: idParams,
        body: z
          .strictObject({
            name: fields.name.optional(),
            channel: fields.channel.optional(),
            body: fields.body,
            draftId: fields.draftId,
            segmentTags: fields.segmentTags,
            segmentMatch: fields.segmentMatch,
          })
          .refine((b) => !(b.body && b.draftId), 'give either body or draftId'),
      },
    },
    guarded(async (request) => ({
      campaign: await updateCampaign(s.appDb, ctxOf(request), idOf(request), request.body as Partial<CampaignInput>),
    })),
  );
  app.post(
    `${base}/:id/submit`,
    { config: { permission: 'marketing.draft' }, schema: { params: idParams } },
    guarded(async (request) => ({ campaign: await submitCampaign(s.appDb, ctxOf(request), idOf(request)) })),
  );
  app.post(
    `${base}/:id/approve`,
    {
      config: { permission: 'marketing.approve' },
      schema: { params: idParams, body: z.strictObject({ contentSha256: z.string().regex(/^[0-9a-f]{64}$/) }) },
    },
    guarded(async (request) => ({
      campaign: await approveCampaign(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.body as { contentSha256: string }).contentSha256,
      ),
    })),
  );
  app.post(
    `${base}/:id/return`,
    {
      config: { permission: 'marketing.approve' },
      schema: { params: idParams, body: z.strictObject({ reason: z.string().trim().min(3).max(200) }) },
    },
    guarded(async (request) => ({
      campaign: await returnCampaign(
        s.appDb,
        ctxOf(request),
        idOf(request),
        (request.body as { reason: string }).reason,
      ),
    })),
  );
  app.post(
    `${base}/:id/schedule`,
    {
      config: { permission: 'marketing.send' },
      schema: { params: idParams, body: z.strictObject({ at: z.iso.datetime({ offset: true }) }) },
    },
    guarded(async (request) => ({
      campaign: await scheduleCampaign(
        s.appDb,
        ctxOf(request),
        idOf(request),
        new Date((request.body as { at: string }).at),
      ),
    })),
  );
  app.post(
    `${base}/:id/unschedule`,
    { config: { permission: 'marketing.send' }, schema: { params: idParams } },
    guarded(async (request) => ({ campaign: await unscheduleCampaign(s.appDb, ctxOf(request), idOf(request)) })),
  );
  app.post(
    `${base}/:id/send`,
    { config: { permission: 'marketing.send' }, schema: { params: idParams } },
    guarded(async (request) => ({
      campaign: await launchCampaign(s.appDb, ctxOf(request), provider, idOf(request)),
    })),
  );
  app.post(
    `${base}/:id/dispatch`,
    { config: { permission: 'marketing.send' }, schema: { params: idParams } },
    guarded(async (request) => {
      const results = await dispatchCampaign(s.appDb, ctxOf(request), provider, idOf(request));
      return { campaign: await getCampaign(s.appDb, ctxOf(request), idOf(request)), results };
    }),
  );
  // Draft, pending, approved, scheduled and running campaigns can be cancelled by whoever may draft or send.
  app.post(
    `${base}/:id/cancel`,
    { config: { permission: 'marketing.draft' }, schema: { params: idParams } },
    guarded(async (request) => ({ campaign: await cancelCampaign(s.appDb, ctxOf(request), idOf(request)) })),
  );
  // The job runner's step, callable by the owner until a scheduler runs it (Phase 8).
  app.post(
    `${base}/run-due`,
    { config: { permission: 'marketing.send' }, schema: { params: businessParams } },
    async (request) => runDueCampaigns(s.appDb, ctxOf(request), provider),
  );
}
