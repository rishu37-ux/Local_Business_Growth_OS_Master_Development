// Integration secrets (increment 7.2: FR-HUB-3, D-055). Write-only: responses
// carry metadata and a 4-character hint, never a value. Changing secrets needs
// integrations.manage and a sign-in within 10 minutes; viewing is audited.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listSecrets, revokeSecret, rotateSecret, SecretError, storeSecret } from '@lbgos/modules/secrets';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
// Not trimmed: a secret is stored exactly as entered.
const value = z.string().min(1).max(4096);

const STATUS = { NOT_FOUND: 404, REVOKED: 409, STORE_NOT_CONFIGURED: 503 } as const satisfies Record<
  SecretError['code'],
  number
>;

export function registerSecretRoutes(app: FastifyInstance, s: AppServices): void {
  const keyring = s.secrets?.keyring ?? null;
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
        if (!(err instanceof SecretError)) throw err;
        const nf = err.code === 'NOT_FOUND';
        return reply.status(STATUS[err.code]).send({
          error: { code: nf ? 'NOT_FOUND' : err.code, message: nf ? 'Not found.' : err.message, requestId: request.id },
        });
      }
    };
  const base = '/api/businesses/:businessId/secrets';

  app.get(
    base,
    { config: { permission: 'integrations.view' }, schema: { params: businessParams } },
    async (request) => ({
      secrets: await listSecrets(s.appDb, ctxOf(request), request.id),
      storeConfigured: keyring !== null,
    }),
  );

  app.post(
    base,
    {
      config: { permission: 'integrations.manage', freshAuth: true },
      schema: {
        params: businessParams,
        body: z.strictObject({
          purpose: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
          label: z.string().trim().min(1).max(80),
          value,
        }),
      },
    },
    guarded(async (request, reply) => {
      const body = request.body as { purpose: string; label: string; value: string };
      const secret = await storeSecret(s.appDb, keyring, ctxOf(request), body, { requestId: request.id });
      return reply.status(201).send({ secret });
    }),
  );

  app.post(
    `${base}/:id/rotate`,
    {
      config: { permission: 'integrations.manage', freshAuth: true },
      schema: { params: idParams, body: z.strictObject({ value }) },
    },
    guarded(async (request, reply) => {
      const secret = await rotateSecret(
        s.appDb,
        keyring,
        ctxOf(request),
        idOf(request),
        (request.body as { value: string }).value,
        request.id,
      );
      return reply.status(201).send({ secret });
    }),
  );

  app.post(
    `${base}/:id/revoke`,
    { config: { permission: 'integrations.manage', freshAuth: true }, schema: { params: idParams } },
    guarded(async (request) => ({ secret: await revokeSecret(s.appDb, ctxOf(request), idOf(request), request.id) })),
  );
}
