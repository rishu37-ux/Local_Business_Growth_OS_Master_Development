// Consent, suppression and messages (increment 6.2: FR-CON-1, FR-MSG-1 AC3–4,
// D-048). No messaging provider is connected: without one, a dispatched
// message ends FAILED with PROVIDER_NOT_CONFIGURED and nobody is contacted.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MESSAGE_CHANNELS, MESSAGE_PURPOSES, type MessagePurpose } from '@lbgos/domain';
import {
  approveMessage,
  cancelMessage,
  createMessage,
  customerConsents,
  dispatchDue,
  dispatchMessage,
  editDraft,
  getMessage,
  listMessages,
  listSuppressions,
  MessagingError,
  optOut,
  queueMessage,
  recordConsent,
  returnToDraft,
  submitMessage,
  type Message,
  type MessageStatus,
} from '@lbgos/modules/messaging';
import { MEMBER } from '../auth-plugin.ts';
import type { AppServices } from '../services.ts';
import { messagingProviderFor } from '../hub.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const idParams = z.strictObject({ businessId: z.uuid(), id: z.uuid() });
const channel = z.enum(MESSAGE_CHANNELS);
const purpose = z.enum(MESSAGE_PURPOSES);
const body = z.string().trim().min(1).max(1000);
const STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'QUEUED',
  'SUBMITTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
] as const satisfies readonly MessageStatus[];

const ERROR_STATUS = {
  CUSTOMER_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  NO_ADDRESS: 422,
  INVALID_STATE: 409,
  RELEASE_NEEDS_APPROVER: 403,
  MARKETING_NOT_TRANSACTIONAL: 422,
} as const satisfies Record<MessagingError['code'], number>;

export function registerMessagingRoutes(app: FastifyInstance, s: AppServices): void {
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const has = (request: FastifyRequest, key: string) => request.access?.permissions.has(key) === true;
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });

  /** For routes whose permission depends on the message: the key, and no changes in read-only mode. */
  const allowed = (request: FastifyRequest, reply: FastifyReply, key: string) => {
    if (!has(request, key)) {
      void fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
      return false;
    }
    if (request.access?.mode === 'READ_ONLY') {
      void fail(request, reply, 403, 'TENANT_READ_ONLY', 'This action is not available for this business right now.');
      return false;
    }
    return true;
  };
  /** Marketing is drafted with marketing.draft; transactional messages belong to customer service. */
  const draftKey = (p: MessagePurpose) => (p === 'MARKETING' ? 'marketing.draft' : 'customers.manage');
  const sendKey = (p: MessagePurpose) => (p === 'MARKETING' ? 'marketing.send' : 'customers.manage');

  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (!(err instanceof MessagingError)) throw err;
        const notFound = ERROR_STATUS[err.code] === 404;
        return fail(
          request,
          reply,
          ERROR_STATUS[err.code],
          notFound ? 'NOT_FOUND' : err.code,
          notFound ? 'Not found.' : err.message,
        );
      }
    };

  const customer = '/api/businesses/:businessId/customers/:id';
  app.get(
    `${customer}/consents`,
    { config: { permission: 'customers.view' }, schema: { params: idParams } },
    guarded(async (request) => ({ consents: await customerConsents(s.appDb, ctxOf(request), idOf(request)) })),
  );

  app.post(
    `${customer}/consents`,
    {
      config: { permission: 'customers.manage' },
      schema: {
        params: idParams,
        body: z.strictObject({
          channel,
          purpose,
          status: z.enum(['GRANTED', 'WITHDRAWN']),
          source: z.string().trim().min(3).max(200),
        }),
      },
    },
    guarded(async (request, reply) => {
      const input = request.body as Parameters<typeof recordConsent>[4];
      const consents = await recordConsent(
        s.appDb,
        ctxOf(request),
        { canRelease: has(request, 'marketing.approve') },
        idOf(request),
        input,
        request.id,
      );
      return reply.status(201).send({ consents });
    }),
  );

  app.post(
    `${customer}/opt-out`,
    {
      config: { permission: 'customers.manage' },
      schema: {
        params: idParams,
        body: z.strictObject({
          channel,
          reason: z.enum(['OWNER_OPT_OUT', 'STOP_REPLY']).default('OWNER_OPT_OUT'),
          note: z.string().trim().min(1).max(500).nullable().optional(),
        }),
      },
    },
    guarded(async (request) => ({
      consents: await optOut(
        s.appDb,
        ctxOf(request),
        idOf(request),
        request.body as Parameters<typeof optOut>[3],
        request.id,
      ),
    })),
  );

  app.get(
    '/api/businesses/:businessId/suppressions',
    { config: { permission: 'customers.view' }, schema: { params: businessParams } },
    async (request) => ({ suppressions: await listSuppressions(s.appDb, ctxOf(request)) }),
  );

  const messages = '/api/businesses/:businessId/messages';
  app.get(
    messages,
    {
      config: { permission: 'customers.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({ customerId: z.uuid().optional(), status: z.enum(STATUSES).optional() }),
      },
    },
    async (request) => {
      const q = request.query as { customerId?: string; status?: MessageStatus };
      return {
        messages: await listMessages(s.appDb, ctxOf(request), q),
        provider: { configured: (await messagingProviderFor(s, request)).configured },
      };
    },
  );

  app.get(
    `${messages}/:id`,
    { config: { permission: 'customers.view' }, schema: { params: idParams } },
    guarded(async (request) => ({ message: await getMessage(s.appDb, ctxOf(request), idOf(request)) })),
  );

  // A transactional message with `send: true` is queued and dispatched at once;
  // everything else starts as a draft.
  app.post(
    messages,
    {
      config: { permission: MEMBER },
      schema: {
        params: businessParams,
        body: z.strictObject({ customerId: z.uuid(), channel, purpose, body, send: z.boolean().default(false) }),
      },
    },
    guarded(async (request, reply) => {
      const b = request.body as {
        customerId: string;
        channel: Message['channel'];
        purpose: MessagePurpose;
        body: string;
        send: boolean;
      };
      if (!allowed(request, reply, draftKey(b.purpose))) return reply;
      const ctx = ctxOf(request);
      const message = await createMessage(s.appDb, ctx, b, { queue: b.send });
      if (!b.send) return reply.status(201).send({ message });
      const dispatch = await dispatchMessage(s.appDb, ctx, await messagingProviderFor(s, request), message.id);
      return reply.status(201).send({ message: await getMessage(s.appDb, ctx, message.id), dispatch });
    }),
  );

  /** Loads the message, checks the purpose-dependent permission, then runs `fn`. */
  const onMessage = (
    key: (m: Message) => string,
    fn: (request: FastifyRequest, m: Message) => Promise<unknown>,
    bodySchema?: z.ZodType,
  ) =>
    [
      { config: { permission: MEMBER }, schema: { params: idParams, ...(bodySchema ? { body: bodySchema } : {}) } },
      guarded(async (request, reply) => {
        const m = await getMessage(s.appDb, ctxOf(request), idOf(request));
        if (!allowed(request, reply, key(m))) return reply;
        return fn(request, m);
      }),
    ] as const;

  app.patch(
    `${messages}/:id`,
    ...onMessage(
      (m) => draftKey(m.purpose),
      async (request) => ({
        message: await editDraft(s.appDb, ctxOf(request), idOf(request), (request.body as { body: string }).body),
      }),
      z.strictObject({ body }),
    ),
  );

  app.post(
    `${messages}/:id/submit`,
    ...onMessage(
      (m) => draftKey(m.purpose),
      async (request) => ({ message: await submitMessage(s.appDb, ctxOf(request), idOf(request)) }),
    ),
  );

  // Approving marketing needs marketing.approve; a transactional draft is approved by customer service.
  app.post(
    `${messages}/:id/approve`,
    ...onMessage(
      (m) => (m.purpose === 'MARKETING' ? 'marketing.approve' : 'customers.manage'),
      async (request) => ({ message: await approveMessage(s.appDb, ctxOf(request), idOf(request)) }),
    ),
  );

  app.post(
    `${messages}/:id/return`,
    ...onMessage(
      (m) => (m.purpose === 'MARKETING' ? 'marketing.approve' : 'customers.manage'),
      async (request) => ({
        message: await returnToDraft(
          s.appDb,
          ctxOf(request),
          idOf(request),
          (request.body as { reason: string }).reason,
        ),
      }),
      z.strictObject({ reason: z.string().trim().min(3).max(200) }),
    ),
  );

  app.post(
    `${messages}/:id/send`,
    ...onMessage(
      (m) => sendKey(m.purpose),
      async (request) => {
        const ctx = ctxOf(request);
        await queueMessage(s.appDb, ctx, idOf(request));
        const dispatch = await dispatchMessage(s.appDb, ctx, await messagingProviderFor(s, request), idOf(request));
        return { message: await getMessage(s.appDb, ctx, idOf(request)), dispatch };
      },
    ),
  );

  app.post(
    `${messages}/:id/cancel`,
    ...onMessage(
      (m) => draftKey(m.purpose),
      async (request) => ({ message: await cancelMessage(s.appDb, ctxOf(request), idOf(request)) }),
    ),
  );

  // Queued messages whose quiet-hours wait is over (until a job runner does this).
  app.post(
    `${messages}/dispatch-due`,
    { config: { permission: 'marketing.send' }, schema: { params: businessParams } },
    async (request) => ({
      results: await dispatchDue(s.appDb, ctxOf(request), await messagingProviderFor(s, request)),
    }),
  );
}
