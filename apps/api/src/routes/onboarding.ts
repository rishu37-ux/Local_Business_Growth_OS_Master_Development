// Setup wizard, invitations and notifications (FR-ONB-2, FR-ONB-3, FR-AUTH-3 AC3).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listNotifications, markNotificationRead } from '@lbgos/modules/notifications';
import {
  acceptInvitation,
  createInvitation,
  getSetup,
  InvitationError,
  listInvitations,
  markStaffStepDone,
  revokeInvitation,
  savePreferences,
  saveDetails,
  saveTax,
  SetupError,
} from '@lbgos/modules/onboarding';
import { AUTHENTICATED } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });

function sendOnboardingError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  if (err instanceof SetupError) return send(422, err.code, err.message);
  if (err instanceof InvitationError) {
    if (err.code === 'NOT_FOUND') return send(404, 'NOT_FOUND', 'Not found.');
    if (err.code === 'GRANT_EXCEEDS_OWN') return send(403, err.code, err.message);
    return send(409, err.code, err.message);
  }
  if (typeof err === 'object' && err !== null && 'code' in err) {
    if (err.code === 'LB010') return send(410, 'INVITATION_INVALID', 'This invitation link is no longer valid.');
    if (err.code === 'LB011')
      return send(403, 'INVITATION_EMAIL_MISMATCH', 'Sign in with the email address the invitation was sent to.');
  }
  return undefined;
}

export function registerOnboardingRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        const handled = sendOnboardingError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    };

  app.get(
    '/api/businesses/:businessId/setup',
    { config: { permission: 'business.settings.view' }, schema: { params: businessParams } },
    async (request) => getSetup(s.appDb, ctxOf(request), request.principal?.twoFactorEnabled === true),
  );

  app.put(
    '/api/businesses/:businessId/setup/details',
    {
      config: { permission: 'business.settings.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          displayName: z.string().trim().min(2).max(120),
          timezone: z.string().min(1).max(64),
          fyStartMonth: z.number().int().min(1).max(12),
        }),
      },
    },
    guarded(async (request, reply) => {
      await saveDetails(
        s.appDb,
        ctxOf(request),
        request.body as { displayName: string; timezone: string; fyStartMonth: number },
      );
      return reply.status(204).send();
    }),
  );

  app.put(
    '/api/businesses/:businessId/setup/tax',
    {
      config: { permission: 'tax.settings.manage', freshAuth: true },
      schema: {
        params: businessParams,
        body: z.strictObject({
          registrationType: z.enum(['REGULAR', 'COMPOSITION', 'UNREGISTERED']),
          gstin: z.string().max(15).optional(),
          invoicePrefix: z.string().max(6),
        }),
      },
    },
    guarded(async (request) => {
      const body = request.body as {
        registrationType: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
        gstin?: string;
        invoicePrefix: string;
      };
      return saveTax(s.appDb, ctxOf(request), body);
    }),
  );

  app.put(
    '/api/businesses/:businessId/setup/preferences',
    {
      config: { permission: 'business.settings.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          printSize: z.enum(['A4', 'A5', '80MM', '58MM']),
          weekStart: z.number().int().min(1).max(7),
          requireStaffMfa: z.boolean(),
        }),
      },
    },
    guarded(async (request, reply) => {
      await savePreferences(
        s.appDb,
        ctxOf(request),
        request.body as { printSize: 'A4'; weekStart: number; requireStaffMfa: boolean },
      );
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/businesses/:businessId/invitations',
    {
      config: { permission: 'users.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({ email: z.email(), roleIds: z.array(z.uuid()).min(1).max(10) }),
      },
    },
    guarded(async (request, reply) => {
      const access = request.access;
      if (!access) throw new Error('missing access');
      const c = ctxOf(request);
      const id = await createInvitation(s.appDb, c, access, request.body as { email: string; roleIds: string[] }, {
        mailer: s.mailer,
        baseURL: s.baseURL,
      });
      await markStaffStepDone(s.appDb, c);
      return reply.status(201).send({ invitationId: id });
    }),
  );

  app.get(
    '/api/businesses/:businessId/invitations',
    { config: { permission: 'users.view' }, schema: { params: businessParams } },
    async (request) => ({ invitations: await listInvitations(s.appDb, ctxOf(request)) }),
  );

  app.post(
    '/api/businesses/:businessId/invitations/:invitationId/revoke',
    {
      config: { permission: 'users.manage' },
      schema: { params: z.strictObject({ businessId: z.uuid(), invitationId: z.uuid() }) },
    },
    guarded(async (request, reply) => {
      await revokeInvitation(s.appDb, ctxOf(request), (request.params as { invitationId: string }).invitationId);
      return reply.status(204).send();
    }),
  );

  app.post(
    '/api/invitations/accept',
    { config: { permission: AUTHENTICATED }, schema: { body: z.strictObject({ token: z.string().min(20).max(100) }) } },
    guarded(async (request) => {
      const businessId = await acceptInvitation(
        s.appDb,
        request.principal?.userId ?? '',
        (request.body as { token: string }).token,
      );
      return { businessId };
    }),
  );

  app.get('/api/notifications', { config: { permission: AUTHENTICATED, allowWithoutMfa: true } }, async (request) => ({
    notifications: await listNotifications(s.appDb, request.principal?.userId ?? ''),
  }));

  app.post(
    '/api/notifications/:notificationId/read',
    {
      config: { permission: AUTHENTICATED, allowWithoutMfa: true },
      schema: { params: z.strictObject({ notificationId: z.uuid() }) },
    },
    async (request, reply) => {
      const ok = await markNotificationRead(
        s.appDb,
        request.principal?.userId ?? '',
        (request.params as { notificationId: string }).notificationId,
      );
      return ok
        ? reply.status(204).send()
        : reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
    },
  );
}
