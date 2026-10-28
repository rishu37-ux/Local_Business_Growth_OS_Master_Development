// Usage against the plan, monitoring and the job runner's record (increment
// 8.4: FR-SUB-3 AC2, NFR-5, NFR-10, D-062). Viewing needs
// business.settings.view; the AI overage cap needs business.settings.manage
// and a recent sign-in. The platform view shows counts only (D-015).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessMonitoring, platformMonitoring } from '@lbgos/modules/jobs';
import { setAiOverageCap, usageView } from '@lbgos/modules/quotas';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });

export function registerMonitoringRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const base = '/api/businesses/:businessId';

  app.get(
    `${base}/usage`,
    { config: { permission: 'business.settings.view' }, schema: { params: businessParams } },
    async (request) => usageView(s.appDb, ctxOf(request)),
  );

  app.put(
    `${base}/usage/overage`,
    {
      config: { permission: 'business.settings.manage', freshAuth: true },
      schema: {
        params: businessParams,
        body: z.strictObject({ aiOverageCapUnits: z.number().int().min(0).max(10_000_000) }),
      },
    },
    async (request) => ({
      aiOverageCapUnits: await setAiOverageCap(
        s.appDb,
        ctxOf(request),
        (request.body as { aiOverageCapUnits: number }).aiOverageCapUnits,
      ),
    }),
  );

  app.get(
    `${base}/monitoring`,
    { config: { permission: 'business.settings.view' }, schema: { params: businessParams } },
    async (request) => ({ monitoring: await businessMonitoring(s.appDb, ctxOf(request)) }),
  );

  app.get('/api/platform/monitoring', { config: { permission: 'platform.businesses.manage' } }, async () => ({
    counts: await platformMonitoring(s.platformDb),
  }));
}
