// Owner endpoints for staff (FR-RBAC-1 R1/R2/R4, FR-AUTH-1 AC5, FR-AUTH-5 AC1).
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant } from '@lbgos/db';
import { recordTenantEvent } from '@lbgos/modules/audit';
import { deactivateMember, listMembers, memberUser, setMemberRoles } from '@lbgos/modules/tenancy';
import type { AppServices } from '../services.ts';
import { sendRuleError } from './http-errors.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const memberParams = z.strictObject({ businessId: z.uuid(), membershipId: z.uuid() });

export function registerMemberRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: { principal?: { userId: string }; params: unknown }) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });

  app.get(
    '/api/businesses/:businessId/members',
    { config: { permission: 'users.view' }, schema: { params: businessParams } },
    async (request) => ({
      members: await listMembers(s.appDb, ctxOf(request)),
    }),
  );

  app.get(
    '/api/businesses/:businessId/roles',
    { config: { permission: 'users.view' }, schema: { params: businessParams } },
    async (request) => {
      const c = ctxOf(request);
      return withTenant(s.appDb, c, async (trx) => {
        const { rows } =
          await sql`select id, name, is_system from lbg.roles where business_id = ${c.businessId} order by name`.execute(
            trx,
          );
        return { roles: rows };
      });
    },
  );

  app.put(
    '/api/businesses/:businessId/members/:membershipId/roles',
    {
      config: { permission: 'users.manage' },
      schema: { params: memberParams, body: z.strictObject({ roleIds: z.array(z.uuid()).max(20) }) },
    },
    async (request, reply) => {
      const access = request.access;
      if (!access?.permissions.has('roles.manage')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.', requestId: request.id },
        });
      }
      try {
        const { membershipId } = request.params as z.infer<typeof memberParams>;
        const { targetUserId } = await setMemberRoles(
          s.appDb,
          ctxOf(request),
          access,
          membershipId,
          (request.body as { roleIds: string[] }).roleIds,
        );
        // FR-AUTH-1 AC2: privileges changed, so the member signs in again with a new session.
        await s.auth.revokeAllSessions(targetUserId);
        return await reply.status(204).send();
      } catch (err) {
        const handled = sendRuleError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    },
  );

  app.post(
    '/api/businesses/:businessId/members/:membershipId/deactivate',
    { config: { permission: 'users.manage' }, schema: { params: memberParams } },
    async (request, reply) => {
      try {
        const { membershipId } = request.params as z.infer<typeof memberParams>;
        const { targetUserId } = await deactivateMember(s.appDb, ctxOf(request), membershipId);
        await s.auth.revokeAllSessions(targetUserId); // R4
        return await reply.status(204).send();
      } catch (err) {
        const handled = sendRuleError(err, request, reply);
        if (handled) return handled;
        throw err;
      }
    },
  );

  const staffAction = (path: string, action: 'member.sessions.revoke' | 'member.mfa.reset') =>
    app.post(
      `/api/businesses/:businessId/members/:membershipId/${path}`,
      { config: { permission: 'users.manage' }, schema: { params: memberParams } },
      async (request, reply) => {
        const c = ctxOf(request);
        const { membershipId } = request.params as z.infer<typeof memberParams>;
        const target = await memberUser(s.appDb, c, membershipId);
        if (!target)
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
        if (target.isOwner || target.userId === c.userId) {
          // Owner MFA recovery goes through the verified platform process (FR-AUTH-5 AC2).
          return reply
            .status(403)
            .send({ error: { code: 'OWNER_PROTECTED', message: 'Not allowed for owners.', requestId: request.id } });
        }
        if (action === 'member.mfa.reset') await s.auth.resetMfa(target.userId);
        else await s.auth.revokeAllSessions(target.userId);
        await withTenant(s.appDb, c, (trx) =>
          recordTenantEvent(trx, c, {
            action,
            targetType: 'membership',
            targetId: membershipId,
            requestId: request.id,
          }),
        );
        return reply.status(204).send();
      },
    );
  staffAction('revoke-sessions', 'member.sessions.revoke');
  staffAction('reset-mfa', 'member.mfa.reset');
}
