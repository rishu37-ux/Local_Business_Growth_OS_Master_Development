// Platform-admin endpoints (BR-T1…T4). Run on the platform role only.
import { BUSINESS_STATUSES } from '@lbgos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createBusinessForOwner, listPlans, updatePlan } from '@lbgos/modules/onboarding';
import { decide, DEFAULT_PLAN_CODE, listApplications, reinstate, TRIAL_DAYS } from '@lbgos/modules/tenancy';
import type { AppServices } from '../services.ts';
import { sendRuleError } from './http-errors.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const reasonBody = z.strictObject({ reason: z.string().max(2000).optional() });

export function registerPlatformRoutes(app: FastifyInstance, s: AppServices): void {
  app.get(
    '/api/platform/applications',
    {
      config: { permission: 'platform.applications.review' },
      schema: { querystring: z.strictObject({ status: z.enum(BUSINESS_STATUSES).optional() }) },
    },
    async (request) => {
      const { status } = request.query as { status?: (typeof BUSINESS_STATUSES)[number] };
      return {
        applications: await listApplications(
          s.platformDb,
          status ? [status] : ['PENDING_APPROVAL', 'CHANGES_REQUESTED'],
        ),
      };
    },
  );

  const decision = (
    path: string,
    permission: 'platform.applications.review' | 'platform.businesses.manage',
    action: 'approve' | 'request_changes' | 'reject' | 'suspend' | 'reinstate',
  ) =>
    app.post(
      `/api/platform/businesses/:businessId/${path}`,
      { config: { permission }, schema: { params: businessParams, body: reasonBody } },
      async (request, reply) => {
        const { businessId } = request.params as z.infer<typeof businessParams>;
        const { reason } = request.body as z.infer<typeof reasonBody>;
        const actor = request.principal?.userId ?? '';
        try {
          const options = { mailer: s.mailer, requestId: request.id, ...(reason === undefined ? {} : { reason }) };
          if (action === 'reinstate') await reinstate(s.platformDb, actor, businessId, options);
          else await decide(s.platformDb, actor, businessId, action, options);
          return await reply.status(204).send();
        } catch (err) {
          const handled = sendRuleError(err, request, reply);
          if (handled) return handled;
          throw err;
        }
      },
    );
  decision('approve', 'platform.applications.review', 'approve');
  decision('request-changes', 'platform.applications.review', 'request_changes');
  decision('reject', 'platform.applications.review', 'reject');
  decision('suspend', 'platform.businesses.manage', 'suspend');
  decision('reinstate', 'platform.businesses.manage', 'reinstate');

  app.post(
    '/api/platform/businesses',
    {
      config: { permission: 'platform.businesses.manage' },
      schema: {
        body: z.strictObject({
          legalName: z.string().trim().min(2).max(200),
          category: z.string().regex(/^[A-Z_]{3,40}$/),
          stateCode: z.string().regex(/^[0-9]{2}$/),
          ownerEmail: z.email(),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { legalName: string; category: string; stateCode: string; ownerEmail: string };
      const businessId = await createBusinessForOwner(s.platformDb, request.principal?.userId ?? '', body, {
        mailer: s.mailer,
        baseURL: s.baseURL,
        trialDays: TRIAL_DAYS,
        planCode: DEFAULT_PLAN_CODE,
      });
      return reply.status(201).send({ businessId, status: 'APPROVED_SETUP_PENDING' });
    },
  );

  app.get('/api/platform/plans', { config: { permission: 'platform.plans.manage' } }, async () => ({
    plans: await listPlans(s.platformDb),
  }));

  app.patch(
    '/api/platform/plans/:planId',
    {
      config: { permission: 'platform.plans.manage' },
      schema: {
        params: z.strictObject({ planId: z.uuid() }),
        body: z.strictObject({
          pricePaise: z.number().int().min(0).max(100_000_000).optional(),
          active: z.boolean().optional(),
          notes: z.string().max(500).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const body = request.body as { pricePaise?: number; active?: boolean; notes?: string };
      const ok = await updatePlan(s.platformDb, request.principal?.userId ?? '', planId, body);
      return ok
        ? reply.status(204).send()
        : reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
    },
  );
}
