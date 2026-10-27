// Applicant and business-owner endpoints for the lifecycle (BR-T1…T4, FR-ONB-1, FR-ONB-3, FR-AUD-1).
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { permittedInMode } from '@lbgos/domain';
import { z } from 'zod';
import { withTenant } from '@lbgos/db';
import {
  activateBusiness,
  myBusinesses,
  resubmitApplication,
  statusHistory,
  submitApplication,
  updateApplication,
} from '@lbgos/modules/tenancy';
import { AUTHENTICATED, MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const application = z.strictObject({
  legalName: z.string().trim().min(2).max(200),
  category: z.string().regex(/^[A-Z_]{3,40}$/),
  stateCode: z.string().regex(/^[0-9]{2}$/),
});
const businessParams = z.strictObject({ businessId: z.uuid() });

export function registerTenancyRoutes(app: FastifyInstance, s: AppServices): void {
  const ctx = (request: { principal?: { userId: string }; params: unknown }) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });

  app.post(
    '/api/applications',
    { config: { permission: AUTHENTICATED }, schema: { body: application } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof application>;
      const businessId = await submitApplication(s.appDb, request.principal?.userId ?? '', body);
      return reply.status(201).send({ businessId, status: 'PENDING_APPROVAL' });
    },
  );

  // Reachable before MFA enrolment: a newly approved owner must still see their business (and the prompt to enrol).
  app.get('/api/businesses', { config: { permission: AUTHENTICATED, allowWithoutMfa: true } }, async (request) => ({
    businesses: await myBusinesses(s.appDb, request.principal?.userId ?? ''),
  }));

  app.get(
    '/api/businesses/:businessId/application',
    { config: { permission: 'application.view' }, schema: { params: businessParams } },
    async (request) => {
      const c = ctx(request);
      const details = await withTenant(s.appDb, c, async (trx) => {
        const { rows } = await sql<{ legal_name: string; category: string; state_code: string | null; status: string }>`
          select legal_name, category, state_code, status from lbg.businesses where id = ${c.businessId}`.execute(trx);
        return rows[0];
      });
      return { ...details, history: await statusHistory(s.appDb, c) };
    },
  );

  app.put(
    '/api/businesses/:businessId/application',
    { config: { permission: 'application.edit' }, schema: { params: businessParams, body: application } },
    async (request, reply) => {
      await updateApplication(s.appDb, ctx(request), request.body as z.infer<typeof application>);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/businesses/:businessId/application/resubmit',
    { config: { permission: 'application.edit' }, schema: { params: businessParams } },
    async (request, reply) => {
      await resubmitApplication(s.appDb, ctx(request));
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/businesses/:businessId/activate',
    { config: { permission: 'business.settings.manage' }, schema: { params: businessParams } },
    async (request, reply) => {
      // FR-ONB-2 AC3: the owner must have MFA before the business goes live (D-011).
      if (request.principal?.twoFactorEnabled !== true) {
        return reply.status(403).send({
          error: {
            code: 'MFA_ENROLMENT_REQUIRED',
            message: 'Set up two-step verification first.',
            requestId: request.id,
          },
        });
      }
      await activateBusiness(s.appDb, ctx(request));
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/businesses/:businessId',
    // Every active member needs the overview; it holds no settings beyond name and status.
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    async (request) => {
      const c = ctx(request);
      return withTenant(s.appDb, c, async (trx) => {
        const { rows } = await sql`
          select id, legal_name, display_name, category, status, state_code, timezone, fy_start_month, currency
            from lbg.businesses where id = ${c.businessId}`.execute(trx);
        const access = request.access;
        // For showing the right screens only; every route still checks permissions itself.
        const permissions = access
          ? [...access.permissions.keys()].filter((k) => permittedInMode(k, access.mode)).sort()
          : [];
        return { business: rows[0], access: { mode: access?.mode, roles: access?.roles, permissions } };
      });
    },
  );

  app.get(
    '/api/businesses/:businessId/audit',
    { config: { permission: 'audit.view' }, schema: { params: businessParams } },
    async (request) => {
      const c = ctx(request);
      return withTenant(s.appDb, c, async (trx) => {
        const { rows } = await sql`
          select scope, actor_type, actor_user_id, action, target_type, target_id, metadata, created_at
            from lbg.audit_events where business_id = ${c.businessId} order by created_at desc limit 100`.execute(trx);
        return { events: rows };
      });
    },
  );
}
