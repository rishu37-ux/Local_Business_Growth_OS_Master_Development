// Platform-admin endpoints (BR-T1…T4). Run on the platform role only.
import { BUSINESS_STATUSES } from '@lbgos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decide, listApplications, reinstate } from '@lbgos/modules/tenancy';
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
          if (action === 'reinstate') await reinstate(s.platformDb, actor, businessId, reason ?? '', request.id);
          else await decide(s.platformDb, actor, businessId, action, reason, request.id);
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
}
