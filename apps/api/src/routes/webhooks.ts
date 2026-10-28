// Provider webhooks (increment 7.6: NFR-18, FR-MSG-1 AC4, FR-MSG-5 AC3,
// D-059). Public routes: the provider is authenticated by its signature over
// the raw body (never by a session), events outside the 5-minute window are
// not applied, and each event is applied once. Unknown or untested
// integrations answer 404; a bad signature answers 401 without detail.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { handleSmsWebhook, handleWhatsAppWebhook, verifyWhatsAppSubscription } from '@lbgos/modules/channels';
import { hubDepsOf } from '../hub.ts';
import type { AppServices } from '../services.ts';

const params = z.strictObject({ integrationId: z.uuid() });
const MAX_BODY = 256 * 1024;
/** Per source address and minute (9.4 review finding SR-01: public routes had no limit). */
export const WEBHOOK_LIMIT_PER_MINUTE = 300;

/**
 * Fixed one-minute window per address, kept in this process. Enough for the
 * single-instance deployment (ADR-03); several instances need a shared store.
 */
function windowLimiter(limit: number, now: () => number = Date.now) {
  let windowStart = 0;
  const counts = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      counts.clear();
    }
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= limit;
  };
}

export function registerWebhookRoutes(app: FastifyInstance, s: AppServices): void {
  const deps = hubDepsOf(s);
  const allow = windowLimiter(WEBHOOK_LIMIT_PER_MINUTE);
  void app.register((scope, _opts, done) => {
    scope.addHook('onRequest', async (request, reply) => {
      if (!allow(request.ip)) {
        request.log.warn('security: webhook rate limit reached');
        return reply
          .status(429)
          .header('retry-after', '60')
          .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
      }
    });
    // The signature covers the exact bytes received, so these routes keep the raw body.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, next) => {
      next(null, body);
    });

    scope.get(
      '/api/webhooks/whatsapp/:integrationId',
      {
        config: { public: true },
        schema: {
          params,
          querystring: z.object({
            'hub.mode': z.string().max(20).optional(),
            'hub.verify_token': z.string().max(200).optional(),
            'hub.challenge': z.string().max(200).optional(),
          }),
        },
      },
      async (request, reply) => {
        const q = request.query as Record<string, string | undefined>;
        const challenge = await verifyWhatsAppSubscription(
          deps,
          (request.params as { integrationId: string }).integrationId,
          {
            mode: q['hub.mode'],
            token: q['hub.verify_token'],
            challenge: q['hub.challenge'],
          },
        );
        if (challenge === null)
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
        return reply.type('text/plain; charset=utf-8').send(challenge);
      },
    );

    const post = (path: string, header: string, handle: typeof handleWhatsAppWebhook) =>
      scope.post(path, { config: { public: true }, schema: { params } }, async (request, reply) => {
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const sig = request.headers[header];
        const result = await handle(
          deps,
          (request.params as { integrationId: string }).integrationId,
          raw,
          typeof sig === 'string' ? sig : undefined,
        );
        if (result.status !== 200) {
          return reply
            .status(result.status)
            .send({ error: { code: result.status === 401 ? 'SIGNATURE_INVALID' : 'NOT_FOUND', message: 'Rejected.' } });
        }
        return result;
      });
    post('/api/webhooks/whatsapp/:integrationId', 'x-hub-signature-256', handleWhatsAppWebhook);
    post('/api/webhooks/sms/:integrationId', 'x-lbgos-signature', handleSmsWebhook);
    done();
  });
}
