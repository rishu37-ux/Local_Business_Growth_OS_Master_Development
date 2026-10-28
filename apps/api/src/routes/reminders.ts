// Reminder settings, runs and the review list (increment 6.3: FR-REM-1, D-049).
// Drafted reminders are messages: they are reviewed, approved and sent with
// the message routes (6.2) and pass the send-time gate.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MESSAGE_CHANNELS, REMINDER_TYPES, type ReminderType } from '@lbgos/domain';
import {
  listReminders,
  ReminderError,
  reminderSettings,
  runReminders,
  saveReminderSetting,
  type ReminderSettingInput,
} from '@lbgos/modules/reminders';
import type { AppServices } from '../services.ts';
import { messagingProviderFor } from '../hub.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const type = z.enum(REMINDER_TYPES);

export function registerReminderRoutes(app: FastifyInstance, s: AppServices): void {
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
        if (!(err instanceof ReminderError)) throw err;
        return reply.status(err.code === 'AUTO_SEND_NEEDS_APPROVER' ? 403 : 422).send({
          error: { code: err.code, message: err.message, problems: err.problems, requestId: request.id },
        });
      }
    };
  const base = '/api/businesses/:businessId/reminders';

  app.get(
    `${base}/settings`,
    // Viewing the settings is allowed to anyone who sees customers (also in read-only mode).
    { config: { permission: 'customers.view' }, schema: { params: businessParams } },
    async (request) => ({ settings: await reminderSettings(s.appDb, ctxOf(request)) }),
  );

  app.put(
    `${base}/settings/:type`,
    {
      config: { permission: 'marketing.draft' },
      schema: {
        params: z.strictObject({ businessId: z.uuid(), type }),
        body: z.strictObject({
          enabled: z.boolean(),
          autoSend: z.boolean(),
          channel: z.enum(MESSAGE_CHANNELS),
          template: z.string().max(1000),
          days: z.number().int().min(0).max(730),
        }),
      },
    },
    guarded(async (request) => ({
      setting: await saveReminderSetting(
        s.appDb,
        ctxOf(request),
        { canApprove: request.access?.permissions.has('marketing.approve') === true },
        (request.params as { type: ReminderType }).type,
        request.body as ReminderSettingInput,
        request.id,
      ),
    })),
  );

  // Drafts reminders for today (until a scheduled job does this daily).
  app.post(
    `${base}/run`,
    { config: { permission: 'marketing.draft' }, schema: { params: businessParams } },
    async (request) => ({ run: await runReminders(s.appDb, ctxOf(request), await messagingProviderFor(s, request)) }),
  );

  app.get(
    base,
    {
      config: { permission: 'customers.view' },
      schema: {
        params: businessParams,
        querystring: z.strictObject({ type: type.optional(), status: z.string().max(20).optional() }),
      },
    },
    async (request) => ({
      reminders: await listReminders(
        s.appDb,
        ctxOf(request),
        request.query as { type?: ReminderType; status?: string },
      ),
    }),
  );
}
