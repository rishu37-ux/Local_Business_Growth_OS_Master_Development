// Sales channels, listings and channel orders (increments 11.2–11.3: D-070).
// Reading works in read-only mode with the view permission; changes need
// integrations.manage (channels), catalogue.manage (listings) or pos.sell
// (billing and cancelling orders). Buyer details are shown in full only with
// customers.view (D-072); erasing them is owner-only with a recent sign-in.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  billOrder,
  cancelOrder,
  CommerceError,
  createMarketplaceChannel,
  eraseOrderBuyer,
  getOrder,
  importChannelOrders,
  listChannels,
  listListings,
  listOrders,
  pushChannelStock,
  updateChannel,
  upsertListing,
} from '@lbgos/modules/commerce';
import { IntegrationError } from '@lbgos/modules/integrations';
import { MEMBER } from '../auth-plugin.ts';
import { hubDepsOf } from '../hub.ts';
import type { AppServices } from '../services.ts';

const businessParams = z.strictObject({ businessId: z.uuid() });
const channelParams = z.strictObject({ businessId: z.uuid(), channelId: z.uuid() });
const orderParams = z.strictObject({ businessId: z.uuid(), orderId: z.uuid() });
const STATUS = {
  NOT_FOUND: 404,
  NOT_A_MARKETPLACE_CONNECTOR: 422,
  CHANNEL_EXISTS: 409,
  SKU_TAKEN: 409,
  NOT_ENOUGH_STOCK: 409,
  ORDER_CLOSED: 409,
  ORDER_BILLED: 409,
  NEEDS_ATTENTION: 409,
  MOBILE_INVALID: 422,
  PINCODE_INVALID: 422,
  EMAIL_INVALID: 422,
  ALREADY_ERASED: 409,
} as const satisfies Record<CommerceError['code'], number>;

export function registerCommerceRoutes(app: FastifyInstance, s: AppServices): void {
  const deps = hubDepsOf(s);
  const ctxOf = (request: FastifyRequest) => ({
    businessId: (request.params as { businessId: string }).businessId,
    userId: request.principal?.userId ?? '',
  });
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, requestId: request.id } });
  const can = (request: FastifyRequest, reply: FastifyReply, ...permissions: string[]) => {
    if (permissions.some((p) => request.access?.permissions.has(p) === true)) return true;
    void fail(request, reply, 403, 'FORBIDDEN', 'You do not have access to this resource.');
    return false;
  };
  const guarded =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        if (err instanceof CommerceError) {
          const nf = err.code === 'NOT_FOUND';
          return fail(request, reply, STATUS[err.code], err.code, nf ? 'Not found.' : err.message);
        }
        if (err instanceof IntegrationError && err.code === 'NOT_FOUND')
          return fail(request, reply, 404, 'NOT_FOUND', 'Not found.');
        throw err;
      }
    };
  const base = '/api/businesses/:businessId';
  const buyerView = (request: FastifyRequest) => ({
    buyer: request.access?.permissions.has('customers.view') === true,
  });

  app.get(
    `${base}/channels`,
    { config: { permission: MEMBER }, schema: { params: businessParams } },
    guarded(async (request, reply) =>
      can(request, reply, 'catalogue.view') ? { channels: await listChannels(s.appDb, ctxOf(request)) } : reply,
    ),
  );

  app.post(
    `${base}/channels`,
    {
      config: { permission: 'integrations.manage' },
      schema: {
        params: businessParams,
        body: z.strictObject({
          name: z.string().trim().min(2).max(60),
          integrationId: z.uuid(),
          stockBuffer: z.int().min(0).max(1000).optional(),
        }),
      },
    },
    guarded(async (request, reply) => {
      const id = await createMarketplaceChannel(
        s.appDb,
        ctxOf(request),
        request.body as Parameters<typeof createMarketplaceChannel>[2],
        request.id,
      );
      return reply.status(201).send({ channelId: id });
    }),
  );

  app.patch(
    `${base}/channels/:channelId`,
    {
      config: { permission: 'integrations.manage' },
      schema: {
        params: channelParams,
        body: z
          .strictObject({
            name: z.string().trim().min(2).max(60).optional(),
            status: z.enum(['ACTIVE', 'PAUSED']).optional(),
            stockBuffer: z.int().min(0).max(1000).optional(),
          })
          .refine((b) => Object.keys(b).length > 0, 'give a change'),
      },
    },
    guarded(async (request, reply) => {
      await updateChannel(
        s.appDb,
        ctxOf(request),
        (request.params as { channelId: string }).channelId,
        request.body as Parameters<typeof updateChannel>[3],
        request.id,
      );
      return reply.status(204).send();
    }),
  );

  app.post(
    `${base}/channels/sync`,
    { config: { permission: 'integrations.manage' }, schema: { params: businessParams } },
    guarded(async (request) => {
      const ctx = ctxOf(request);
      const orders = await importChannelOrders(deps, ctx);
      const pushed = await pushChannelStock(deps, ctx);
      return { orders, pushed };
    }),
  );

  app.get(
    `${base}/channel-listings`,
    {
      config: { permission: MEMBER },
      schema: { params: businessParams, querystring: z.strictObject({ channelId: z.uuid().optional() }) },
    },
    guarded(async (request, reply) =>
      can(request, reply, 'catalogue.view')
        ? {
            listings: await listListings(s.appDb, ctxOf(request), (request.query as { channelId?: string }).channelId),
          }
        : reply,
    ),
  );

  app.put(
    `${base}/channels/:channelId/listings`,
    {
      config: { permission: 'catalogue.manage' },
      schema: {
        params: channelParams,
        body: z.strictObject({
          variantId: z.uuid(),
          externalSku: z
            .string()
            .regex(/^[A-Za-z0-9._/-]{1,60}$/)
            .optional(),
          pricePaise: z.int().min(0).max(100_000_000).nullable().optional(),
          published: z.boolean().optional(),
        }),
      },
    },
    guarded(async (request) => {
      const body = request.body as {
        variantId: string;
        externalSku?: string;
        pricePaise?: number | null;
        published?: boolean;
      };
      const id = await upsertListing(
        s.appDb,
        ctxOf(request),
        { channelId: (request.params as { channelId: string }).channelId, ...body },
        request.id,
      );
      return { listingId: id };
    }),
  );

  app.get(
    `${base}/channel-orders`,
    {
      config: { permission: MEMBER },
      schema: { params: businessParams, querystring: z.strictObject({ open: z.enum(['true', 'false']).optional() }) },
    },
    guarded(async (request, reply) =>
      can(request, reply, 'pos.sell', 'inventory.view')
        ? {
            orders: await listOrders(
              s.appDb,
              ctxOf(request),
              (request.query as { open?: string }).open === 'true',
              buyerView(request),
            ),
          }
        : reply,
    ),
  );

  app.get(
    `${base}/channel-orders/:orderId`,
    { config: { permission: MEMBER }, schema: { params: orderParams } },
    guarded(async (request, reply) => {
      if (!can(request, reply, 'pos.sell', 'inventory.view')) return reply;
      const order = await getOrder(
        s.appDb,
        ctxOf(request),
        (request.params as { orderId: string }).orderId,
        buyerView(request),
      );
      return order ? { order } : fail(request, reply, 404, 'NOT_FOUND', 'Not found.');
    }),
  );

  app.post(
    `${base}/channel-orders/:orderId/bill`,
    { config: { permission: 'pos.sell' }, schema: { params: orderParams } },
    guarded(async (request) =>
      billOrder(
        s.appDb,
        ctxOf(request),
        {
          discount: request.access?.permissions.get('pos.discount'),
          priceOverride: request.access?.permissions.has('pos.price_override') === true,
        },
        (request.params as { orderId: string }).orderId,
        request.id,
      ),
    ),
  );

  app.post(
    `${base}/channel-orders/:orderId/cancel`,
    {
      config: { permission: 'pos.sell' },
      schema: { params: orderParams, body: z.strictObject({ reason: z.string().trim().min(3).max(200) }) },
    },
    guarded(async (request, reply) => {
      await cancelOrder(
        s.appDb,
        ctxOf(request),
        (request.params as { orderId: string }).orderId,
        (request.body as { reason: string }).reason,
        request.id,
      );
      return reply.status(204).send();
    }),
  );

  app.post(
    `${base}/channel-orders/:orderId/erase-buyer`,
    {
      // customers.manage keeps it out of read-only mode; the owner check and re-authentication follow (as D-052).
      config: { permission: 'customers.manage', freshAuth: true },
      schema: { params: orderParams, body: z.strictObject({ reason: z.string().trim().min(10).max(500) }) },
    },
    guarded(async (request, reply) => {
      if (request.access?.isOwner !== true)
        return fail(request, reply, 403, 'OWNER_ONLY', 'Only the owner can do this.');
      return {
        erasure: await eraseOrderBuyer(
          s.appDb,
          ctxOf(request),
          (request.params as { orderId: string }).orderId,
          (request.body as { reason: string }).reason,
          request.id,
        ),
      };
    }),
  );
}
