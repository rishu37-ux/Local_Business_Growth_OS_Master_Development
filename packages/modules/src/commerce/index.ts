// Sales channels: the shop's website and marketplace connectors (increments
// 11.2–11.3, D-069, D-070).
//
// Stock stays in one place, the stock ledger. A channel only sees
// available-to-sell = AVAILABLE stock − reservations of open, unbilled channel
// orders (all channels) − the channel's buffer, floored at 0. Orders from a
// channel reserve stock until they are billed through the normal sale (whose
// SALE movement takes the stock) or cancelled. Every change of stock queues a
// push to the marketplace listings of that variant (a database trigger, in
// the same transaction); the job runner sends the queue through the
// channel's connector.
import { normalizeMobile } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { createCustomerIn } from '../customers/index.ts';
import {
  callIntegration,
  IntegrationError,
  type FeedAddress,
  type FeedOrder,
  type FeedOrderDetails,
  type HubDeps,
  type InventoryItem,
} from '../integrations/index.ts';
import { createSaleDraft, type SellerAccess } from '../sales/index.ts';

export class CommerceError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'NOT_A_MARKETPLACE_CONNECTOR'
    | 'CHANNEL_EXISTS'
    | 'SKU_TAKEN'
    | 'NOT_ENOUGH_STOCK'
    | 'ORDER_CLOSED'
    | 'ORDER_BILLED'
    | 'NEEDS_ATTENTION'
    | 'MOBILE_INVALID'
    | 'PINCODE_INVALID'
    | 'EMAIL_INVALID'
    | 'ALREADY_ERASED';
  readonly available?: number;

  constructor(code: CommerceError['code'], message: string, available?: number) {
    super(message);
    this.name = 'CommerceError';
    this.code = code;
    if (available !== undefined) this.available = available;
  }
}

export interface Channel {
  readonly id: string;
  readonly kind: 'WEBSITE' | 'MARKETPLACE';
  readonly name: string;
  readonly integrationId: string | null;
  readonly status: 'ACTIVE' | 'PAUSED';
  readonly stockBuffer: number;
  readonly lastSyncAt: string | null;
  readonly lastSyncError: string | null;
  readonly listings: number;
  readonly pendingPushes: number;
  readonly openOrders: number;
}

export interface Listing {
  readonly id: string;
  readonly channelId: string;
  readonly variantId: string;
  readonly productName: string;
  readonly sku: string;
  readonly externalSku: string;
  readonly pricePaise: number;
  readonly channelPricePaise: number | null;
  readonly published: boolean;
  readonly available: number;
  readonly reserved: number;
  readonly availableToSell: number;
  readonly lastPushedQuantity: number | null;
  readonly lastPushedAt: string | null;
  readonly pushPending: boolean;
}

export interface ChannelOrder {
  readonly id: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelKind: Channel['kind'];
  readonly externalOrderId: string;
  readonly status: 'NEW' | 'ACCEPTED' | 'CANCELLED';
  /** BILLED once the sale from it is issued (the reservation has ended). */
  readonly state: 'OPEN' | 'BILLING' | 'BILLED' | 'CANCELLED';
  /** Buyer details (D-072); masked unless the reader may see customer details. */
  readonly customerName: string | null;
  readonly customerMobile: string | null;
  readonly buyerEmail: string | null;
  readonly buyerGstin: string | null;
  readonly shipTo: FeedAddress | null;
  readonly billTo: FeedAddress | null;
  readonly buyerErased: boolean;
  readonly masked: boolean;
  readonly paymentMethod: FeedOrderDetails['paymentMethod'];
  readonly paymentStatus: FeedOrderDetails['paymentStatus'];
  readonly fulfilledBy: FeedOrderDetails['fulfilledBy'];
  readonly platformStatus: string | null;
  readonly shipBy: string | null;
  readonly deliverBy: string | null;
  readonly carrier: string | null;
  readonly trackingId: string | null;
  readonly totals: {
    readonly itemsPaise: number | null;
    readonly shippingPaise: number | null;
    readonly discountPaise: number | null;
    readonly taxPaise: number | null;
    readonly totalPaise: number | null;
    readonly marketplaceFeesPaise: number | null;
  };
  readonly droppedFields: readonly string[];
  readonly detailsUpdatedAt: string | null;
  readonly note: string | null;
  readonly oversold: boolean;
  readonly needsAttention: boolean;
  readonly saleId: string | null;
  readonly invoiceNumber: string | null;
  readonly placedAt: string;
  readonly cancelledReason: string | null;
  readonly lines: readonly {
    readonly variantId: string | null;
    readonly externalSku: string;
    readonly productName: string | null;
    readonly title: string | null;
    readonly quantity: number;
    readonly unitPricePaise: number | null;
  }[];
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const num = (v: string | null) => (v === null ? null : Number(v));

const NO_DETAILS: FeedOrderDetails = {
  buyerName: null,
  buyerPhone: null,
  buyerEmail: null,
  buyerGstin: null,
  shipTo: null,
  billTo: null,
  paymentMethod: null,
  paymentStatus: null,
  fulfilledBy: null,
  platformStatus: null,
  shipBy: null,
  deliverBy: null,
  carrier: null,
  trackingId: null,
  itemsPaise: null,
  shippingPaise: null,
  discountPaise: null,
  taxPaise: null,
  totalPaise: null,
  marketplaceFeesPaise: null,
};

/** Serialises everything that reads or changes available-to-sell of one variant (until commit). */
const lockVariant = (trx: Trx, variantId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`lbgos:ats:${variantId}`}, 0))`.execute(trx);

/** AVAILABLE stock (whole units) and open reservations of one variant. */
async function stockOf(
  trx: Trx,
  ctx: TenantContext,
  variantId: string,
): Promise<{ available: number; reserved: number }> {
  const { rows } = await sql<{ available: number; reserved: number }>`
    select coalesce((select floor(quantity)::int from lbg.stock_levels
                      where business_id = ${ctx.businessId} and variant_id = ${variantId} and bucket = 'AVAILABLE'), 0) as available,
           lbg.channel_reserved(${variantId}) as reserved`.execute(trx);
  return rows[0] ?? { available: 0, reserved: 0 };
}

/** AC3: what a channel with this buffer may sell of the variant. */
export const availableToSell = (s: { available: number; reserved: number }, buffer: number): number =>
  Math.max(0, s.available - s.reserved - buffer);

const queueVariant = (trx: Trx, ctx: TenantContext, variantId: string) =>
  sql`select lbg.queue_channel_sync(${ctx.businessId}, ${variantId})`.execute(trx);

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** The business's website channel, created on first use. */
export async function websiteChannelIn(trx: Trx, ctx: TenantContext): Promise<string> {
  await sql`insert into lbg.sales_channels (business_id, kind, name) values (${ctx.businessId}, 'WEBSITE', 'Website')
            on conflict (business_id) where kind = 'WEBSITE' do nothing`.execute(trx);
  const { rows } = await sql<{ id: string }>`
    select id from lbg.sales_channels where business_id = ${ctx.businessId} and kind = 'WEBSITE'`.execute(trx);
  return rows[0]?.id ?? '';
}

export async function listChannels(db: Db, ctx: TenantContext): Promise<Channel[]> {
  return withTenant(db, ctx, async (trx) => {
    await websiteChannelIn(trx, ctx);
    const { rows } = await sql<{
      id: string;
      kind: Channel['kind'];
      name: string;
      integration_id: string | null;
      status: Channel['status'];
      stock_buffer: number;
      last_sync_at: Date | null;
      last_sync_error: string | null;
      listings: number;
      pending: number;
      open_orders: number;
    }>`
      select c.id, c.kind, c.name, c.integration_id, c.status, c.stock_buffer, c.last_sync_at, c.last_sync_error,
             (select count(*)::int from lbg.channel_listings l where l.business_id = c.business_id and l.channel_id = c.id) as listings,
             (select count(*)::int from lbg.channel_sync_queue q join lbg.channel_listings l
                 on l.business_id = q.business_id and l.id = q.listing_id where l.channel_id = c.id) as pending,
             (select count(*)::int from lbg.channel_orders o where o.business_id = c.business_id and o.channel_id = c.id
                 and o.status <> 'CANCELLED' and o.sale_id is null) as open_orders
        from lbg.sales_channels c where c.business_id = ${ctx.businessId}
       order by (c.kind = 'WEBSITE') desc, c.created_at, c.id`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      integrationId: r.integration_id,
      status: r.status,
      stockBuffer: r.stock_buffer,
      lastSyncAt: iso(r.last_sync_at),
      lastSyncError: r.last_sync_error,
      listings: r.listings,
      pendingPushes: r.pending,
      openOrders: r.open_orders,
    }));
  });
}

export async function createMarketplaceChannel(
  db: Db,
  ctx: TenantContext,
  input: { readonly name: string; readonly integrationId: string; readonly stockBuffer?: number },
  requestId?: string,
): Promise<string> {
  return withTenant(db, ctx, async (trx) => {
    const { rows: integ } = await sql<{ category: string }>`
      select category from lbg.integrations where business_id = ${ctx.businessId} and id = ${input.integrationId}`.execute(
      trx,
    );
    if (!integ[0]) throw new CommerceError('NOT_FOUND', 'Not found.');
    if (integ[0].category !== 'MARKETPLACE')
      throw new CommerceError('NOT_A_MARKETPLACE_CONNECTOR', 'Choose an integration of the Marketplace category.');
    const { rows } = await sql<{ id: string }>`
      insert into lbg.sales_channels (business_id, kind, name, integration_id, stock_buffer)
      values (${ctx.businessId}, 'MARKETPLACE', ${input.name}, ${input.integrationId}, ${input.stockBuffer ?? 0})
      on conflict do nothing returning id`.execute(trx);
    const id = rows[0]?.id;
    if (!id) throw new CommerceError('CHANNEL_EXISTS', 'This connector already has a channel.');
    await recordTenantEvent(trx, ctx, {
      action: 'channel.create',
      targetType: 'sales_channel',
      targetId: id,
      metadata: { kind: 'MARKETPLACE' },
      ...(requestId ? { requestId } : {}),
    });
    return id;
  });
}

export async function updateChannel(
  db: Db,
  ctx: TenantContext,
  channelId: string,
  input: { readonly name?: string; readonly status?: Channel['status']; readonly stockBuffer?: number },
  requestId?: string,
): Promise<void> {
  await withTenant(db, ctx, async (trx) => {
    const res = await sql`update lbg.sales_channels
                             set name = coalesce(${input.name ?? null}, name),
                                 status = coalesce(${input.status ?? null}, status),
                                 stock_buffer = coalesce(${input.stockBuffer ?? null}::int, stock_buffer)
                           where business_id = ${ctx.businessId} and id = ${channelId}`.execute(trx);
    if (Number(res.numAffectedRows ?? 0) === 0) throw new CommerceError('NOT_FOUND', 'Not found.');
    // A new buffer or status changes what every listing of the channel may sell.
    await sql`insert into lbg.channel_sync_queue (business_id, listing_id)
              select l.business_id, l.id from lbg.channel_listings l join lbg.sales_channels c
                on c.business_id = l.business_id and c.id = l.channel_id
               where l.business_id = ${ctx.businessId} and l.channel_id = ${channelId} and c.kind = 'MARKETPLACE'
              on conflict (listing_id) do update set queued_at = now(), attempts = 0, next_attempt_at = now()`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, {
      action: 'channel.update',
      targetType: 'sales_channel',
      targetId: channelId,
      metadata: { ...input },
      ...(requestId ? { requestId } : {}),
    });
  });
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export interface ListingInput {
  readonly channelId: string;
  readonly variantId: string;
  readonly externalSku?: string | undefined;
  readonly pricePaise?: number | null | undefined;
  readonly published?: boolean | undefined;
}

/** AC2: adds or changes the listing of a variant on a channel (one per channel and variant). */
export async function upsertListing(
  db: Db,
  ctx: TenantContext,
  input: ListingInput,
  requestId?: string,
): Promise<string> {
  try {
    return await withTenant(db, ctx, async (trx) => {
      const { rows: ch } = await sql<{ id: string }>`
        select id from lbg.sales_channels where business_id = ${ctx.businessId} and id = ${input.channelId}`.execute(
        trx,
      );
      const { rows: v } = await sql<{ sku: string }>`
        select sku from lbg.product_variants where business_id = ${ctx.businessId} and id = ${input.variantId}`.execute(
        trx,
      );
      if (!ch[0] || !v[0]) throw new CommerceError('NOT_FOUND', 'Not found.');
      const sku = input.externalSku ?? v[0].sku;
      const { rows } = await sql<{ id: string }>`
        insert into lbg.channel_listings (business_id, channel_id, variant_id, external_sku, price_paise, published)
        values (${ctx.businessId}, ${input.channelId}, ${input.variantId}, ${sku}, ${input.pricePaise ?? null},
                ${input.published ?? true})
        on conflict (channel_id, variant_id) do update set
          external_sku = case when ${input.externalSku !== undefined} then excluded.external_sku
                              else lbg.channel_listings.external_sku end,
          price_paise = case when ${input.pricePaise !== undefined} then excluded.price_paise
                             else lbg.channel_listings.price_paise end,
          published = case when ${input.published !== undefined} then excluded.published
                           else lbg.channel_listings.published end
        returning id`.execute(trx);
      const id = rows[0]?.id ?? '';
      await queueVariant(trx, ctx, input.variantId);
      await recordTenantEvent(trx, ctx, {
        action: 'channel.listing',
        targetType: 'channel_listing',
        targetId: id,
        metadata: { channelId: input.channelId, published: input.published ?? null },
        ...(requestId ? { requestId } : {}),
      });
      return id;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw new CommerceError('SKU_TAKEN', 'Another product already uses this SKU on this channel.');
    throw err;
  }
}

export async function listListings(db: Db, ctx: TenantContext, channelId?: string): Promise<Listing[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      channel_id: string;
      variant_id: string;
      product_name: string;
      sku: string;
      external_sku: string;
      selling_price_paise: string;
      price_paise: string | null;
      published: boolean;
      available: number;
      reserved: number;
      stock_buffer: number;
      last_pushed_quantity: number | null;
      last_pushed_at: Date | null;
      pending: boolean;
    }>`
      select l.id, l.channel_id, l.variant_id,
             concat_ws(' ', p.model_name, nullif(concat_ws(' · ', v.ram, v.storage, v.colour), '')) as product_name,
             v.sku, l.external_sku, v.selling_price_paise::text as selling_price_paise, l.price_paise::text as price_paise,
             l.published,
             coalesce(floor(sl.quantity)::int, 0) as available, lbg.channel_reserved(l.variant_id) as reserved,
             c.stock_buffer, l.last_pushed_quantity, l.last_pushed_at,
             exists (select 1 from lbg.channel_sync_queue q where q.listing_id = l.id) as pending
        from lbg.channel_listings l
        join lbg.sales_channels c on c.business_id = l.business_id and c.id = l.channel_id
        join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
        join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
        left join lbg.stock_levels sl on sl.business_id = v.business_id and sl.variant_id = v.id and sl.bucket = 'AVAILABLE'
       where l.business_id = ${ctx.businessId} and (${channelId ?? null}::uuid is null or l.channel_id = ${channelId ?? null}::uuid)
       order by p.model_name, v.sku, c.created_at limit 1000`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      variantId: r.variant_id,
      productName: r.product_name,
      sku: r.sku,
      externalSku: r.external_sku,
      pricePaise: Number(r.price_paise ?? r.selling_price_paise),
      channelPricePaise: r.price_paise === null ? null : Number(r.price_paise),
      published: r.published,
      available: r.available,
      reserved: r.reserved,
      availableToSell: availableToSell(r, r.stock_buffer),
      lastPushedQuantity: r.last_pushed_quantity,
      lastPushedAt: iso(r.last_pushed_at),
      pushPending: r.pending,
    }));
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * AC3 (D-072): an order sent again updates only its progress (platform
 * status, payment status, dates, carrier, tracking). Lines, prices and buyer
 * details stay as first received; an erased buyer is never filled in again.
 */
async function updateProgress(trx: Trx, ctx: TenantContext, orderId: string, d: FeedOrderDetails) {
  const r = await sql`
    update lbg.channel_orders
       set payment_status = coalesce(${d.paymentStatus}, payment_status),
           platform_status = coalesce(${d.platformStatus}, platform_status),
           ship_by = coalesce(${d.shipBy}::timestamptz, ship_by),
           deliver_by = coalesce(${d.deliverBy}::timestamptz, deliver_by),
           carrier = coalesce(${d.carrier}, carrier),
           tracking_id = coalesce(${d.trackingId}, tracking_id),
           details_updated_at = now()
     where business_id = ${ctx.businessId} and id = ${orderId}
       and (payment_status, platform_status, ship_by, deliver_by, carrier, tracking_id) is distinct from
           (coalesce(${d.paymentStatus}, payment_status), coalesce(${d.platformStatus}, platform_status),
            coalesce(${d.shipBy}::timestamptz, ship_by), coalesce(${d.deliverBy}::timestamptz, deliver_by),
            coalesce(${d.carrier}, carrier), coalesce(${d.trackingId}, tracking_id))`.execute(trx);
  if (Number(r.numAffectedRows ?? 0) > 0) {
    await recordTenantEvent(trx, ctx, {
      action: 'channel.order_updated',
      targetType: 'channel_order',
      targetId: orderId,
      metadata: { platformStatus: d.platformStatus, paymentStatus: d.paymentStatus },
    });
  }
}

async function insertOrder(
  trx: Trx,
  ctx: TenantContext,
  channelId: string,
  order: {
    readonly externalOrderId: string;
    readonly placedAt: string;
    readonly customerName?: string | null;
    readonly customerMobile?: string | null;
    readonly note?: string | null;
    readonly details?: FeedOrderDetails | undefined;
    readonly dropped?: readonly string[] | undefined;
    readonly lines: readonly {
      readonly sku: string;
      readonly quantity: number;
      readonly unitPricePaise: number | null;
      readonly title?: string | null | undefined;
    }[];
  },
): Promise<{ id: string; created: boolean }> {
  const { rows: existing } = await sql<{ id: string }>`
    select id from lbg.channel_orders where business_id = ${ctx.businessId} and channel_id = ${channelId}
       and external_order_id = ${order.externalOrderId}`.execute(trx);
  if (existing[0]) {
    if (order.details) await updateProgress(trx, ctx, existing[0].id, order.details);
    return { id: existing[0].id, created: false };
  }
  const { rows: buf } = await sql<{ stock_buffer: number }>`
    select stock_buffer from lbg.sales_channels where business_id = ${ctx.businessId} and id = ${channelId}`.execute(
    trx,
  );
  const buffer = buf[0]?.stock_buffer ?? 0;
  // Match lines to listings by the channel's SKU; check stock before the order reserves anything.
  const matched: {
    sku: string;
    quantity: number;
    unitPricePaise: number | null;
    title?: string | null | undefined;
    variantId: string | null;
  }[] = [];
  let oversold = false;
  const needed = new Map<string, number>();
  for (const l of order.lines) {
    const { rows } = await sql<{ variant_id: string }>`
      select variant_id from lbg.channel_listings where business_id = ${ctx.businessId} and channel_id = ${channelId}
         and external_sku = ${l.sku}`.execute(trx);
    const variantId = rows[0]?.variant_id ?? null;
    matched.push({ ...l, variantId });
    if (variantId) needed.set(variantId, (needed.get(variantId) ?? 0) + l.quantity);
  }
  for (const [variantId, qty] of [...needed.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    await lockVariant(trx, variantId);
    if (availableToSell(await stockOf(trx, ctx, variantId), buffer) < qty) oversold = true;
  }
  const d = order.details;
  const dropped = [...(order.dropped ?? [])];
  // The order's own column takes Indian mobiles only; another country's number stays in the addresses.
  let mobile = order.customerMobile ?? d?.buyerPhone ?? d?.shipTo?.phone ?? null;
  if (mobile !== null && !/^\+91[6-9][0-9]{9}$/.test(mobile)) {
    if (order.customerMobile === undefined && d?.buyerPhone) dropped.push('buyer.phone');
    mobile = null;
  }
  const name = order.customerName ?? d?.buyerName ?? d?.shipTo?.name ?? null;
  const json = (a: FeedAddress | null | undefined) => (a ? JSON.stringify(a) : null);
  const { rows } = await sql<{ id: string }>`
    insert into lbg.channel_orders (business_id, channel_id, external_order_id, customer_name, customer_mobile, note,
                                    oversold, needs_attention, placed_at, buyer_email, buyer_gstin, ship_to, bill_to,
                                    payment_method, payment_status, fulfilled_by, platform_status, ship_by, deliver_by,
                                    carrier, tracking_id, items_paise, shipping_paise, discount_paise, tax_paise,
                                    total_paise, marketplace_fees_paise, dropped_fields)
    values (${ctx.businessId}, ${channelId}, ${order.externalOrderId}, ${name}, ${mobile}, ${order.note ?? null},
            ${oversold}, ${matched.some((m) => m.variantId === null)}, ${order.placedAt}, ${d?.buyerEmail ?? null},
            ${d?.buyerGstin ?? null}, ${json(d?.shipTo)}::jsonb, ${json(d?.billTo)}::jsonb, ${d?.paymentMethod ?? null},
            ${d?.paymentStatus ?? null}, ${d?.fulfilledBy ?? null}, ${d?.platformStatus ?? null}, ${d?.shipBy ?? null},
            ${d?.deliverBy ?? null}, ${d?.carrier ?? null}, ${d?.trackingId ?? null}, ${d?.itemsPaise ?? null},
            ${d?.shippingPaise ?? null}, ${d?.discountPaise ?? null}, ${d?.taxPaise ?? null}, ${d?.totalPaise ?? null},
            ${d?.marketplaceFeesPaise ?? null}, ${dropped.slice(0, 40)}::text[])
    returning id`.execute(trx);
  const id = rows[0]?.id ?? '';
  for (const m of matched) {
    await sql`insert into lbg.channel_order_lines (business_id, order_id, variant_id, external_sku, quantity,
                                                   unit_price_paise, title)
              values (${ctx.businessId}, ${id}, ${m.variantId}, ${m.sku}, ${m.quantity}, ${m.unitPricePaise},
                      ${m.title ?? null})`.execute(trx);
  }
  for (const variantId of needed.keys()) await queueVariant(trx, ctx, variantId);
  await recordTenantEvent(trx, ctx, {
    action: 'channel.order_received',
    targetType: 'channel_order',
    targetId: id,
    metadata: { channelId, oversold, lines: matched.length },
  });
  return { id, created: true };
}

/**
 * AC1/AC2 (website): an order request from the public store. Refused when the
 * website may not sell that many; idempotent per form token.
 */
export async function createWebsiteOrder(
  db: Db,
  ctx: TenantContext,
  input: {
    readonly listingId: string;
    readonly quantity: number;
    readonly name: string;
    readonly mobile: string;
    readonly token: string;
    /** Optional (D-072): email and a delivery address. */
    readonly email?: string | undefined;
    readonly address?: { readonly line1: string; readonly city: string; readonly pincode: string } | undefined;
  },
): Promise<{ orderId: string; created: boolean }> {
  const mobile = normalizeMobile(input.mobile);
  if (!mobile?.startsWith('+91')) throw new CommerceError('MOBILE_INVALID', 'Enter a 10-digit Indian mobile number.');
  const email = input.email?.trim().toLowerCase() ?? '';
  if (email !== '' && !(email.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)))
    throw new CommerceError('EMAIL_INVALID', 'Please check the email address.');
  const pincode = input.address?.pincode.replace(/\s/g, '') ?? '';
  if (input.address && !/^[1-9][0-9]{5}$/.test(pincode))
    throw new CommerceError('PINCODE_INVALID', 'Enter a 6-digit PIN code.');
  const shipTo: FeedAddress | null = input.address
    ? {
        name: input.name.trim(),
        phone: mobile,
        line1: input.address.line1.trim(),
        line2: null,
        landmark: null,
        city: input.address.city.trim(),
        state: null,
        pincode,
        country: 'IN',
      }
    : null;
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      channel_id: string;
      variant_id: string;
      external_sku: string;
      price: string;
      stock_buffer: number;
    }>`
      select l.channel_id, l.variant_id, l.external_sku, coalesce(l.price_paise, v.selling_price_paise)::text as price,
             c.stock_buffer
        from lbg.channel_listings l
        join lbg.sales_channels c on c.business_id = l.business_id and c.id = l.channel_id
        join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
       where l.business_id = ${ctx.businessId} and l.id = ${input.listingId} and l.published
         and c.kind = 'WEBSITE' and c.status = 'ACTIVE' and v.status = 'ACTIVE'`.execute(trx);
    const l = rows[0];
    if (!l) throw new CommerceError('NOT_FOUND', 'Not found.');
    const externalOrderId = `web-${input.token}`;
    const { rows: prior } = await sql<{ id: string }>`
      select id from lbg.channel_orders where business_id = ${ctx.businessId} and channel_id = ${l.channel_id}
         and external_order_id = ${externalOrderId}`.execute(trx);
    if (prior[0]) return { orderId: prior[0].id, created: false };
    await lockVariant(trx, l.variant_id);
    const ats = availableToSell(await stockOf(trx, ctx, l.variant_id), l.stock_buffer);
    if (ats < input.quantity)
      throw new CommerceError('NOT_ENOUGH_STOCK', `Only ${String(ats)} available right now.`, ats);
    const order = await insertOrder(trx, ctx, l.channel_id, {
      externalOrderId,
      placedAt: new Date().toISOString(),
      customerName: input.name,
      customerMobile: mobile,
      details: {
        ...NO_DETAILS,
        buyerName: input.name,
        buyerPhone: mobile,
        buyerEmail: email === '' ? null : email,
        shipTo,
        // No online payment on the website: the buyer pays the shop.
        paymentStatus: 'PENDING',
        fulfilledBy: 'SELLER',
      },
      lines: [{ sku: l.external_sku, quantity: input.quantity, unitPricePaise: Number(l.price) }],
    });
    return { orderId: order.id, created: order.created };
  });
}

interface OrderRow {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: Channel['kind'];
  external_order_id: string;
  status: ChannelOrder['status'];
  customer_name: string | null;
  customer_mobile: string | null;
  note: string | null;
  oversold: boolean;
  needs_attention: boolean;
  sale_id: string | null;
  invoice_status: string | null;
  invoice_number: string | null;
  placed_at: Date;
  cancelled_reason: string | null;
  buyer_email: string | null;
  buyer_gstin: string | null;
  ship_to: FeedAddress | null;
  bill_to: FeedAddress | null;
  buyer_erased_at: Date | null;
  payment_method: ChannelOrder['paymentMethod'];
  payment_status: ChannelOrder['paymentStatus'];
  fulfilled_by: ChannelOrder['fulfilledBy'];
  platform_status: string | null;
  ship_by: Date | null;
  deliver_by: Date | null;
  carrier: string | null;
  tracking_id: string | null;
  items_paise: string | null;
  shipping_paise: string | null;
  discount_paise: string | null;
  tax_paise: string | null;
  total_paise: string | null;
  marketplace_fees_paise: string | null;
  dropped_fields: string[];
  details_updated_at: Date | null;
}

async function ordersIn(trx: Trx, ctx: TenantContext, where: { id?: string; open?: boolean }): Promise<ChannelOrder[]> {
  const { rows } = await sql<OrderRow>`
    select o.id, o.channel_id, c.name as channel_name, c.kind as channel_kind, o.external_order_id, o.status,
           o.customer_name, o.customer_mobile, o.note, o.oversold, o.needs_attention, o.sale_id,
           i.status as invoice_status, i.invoice_number, o.placed_at, o.cancelled_reason,
           o.buyer_email, o.buyer_gstin, o.ship_to, o.bill_to, o.buyer_erased_at, o.payment_method,
           o.payment_status, o.fulfilled_by, o.platform_status, o.ship_by, o.deliver_by, o.carrier, o.tracking_id,
           o.items_paise::text, o.shipping_paise::text, o.discount_paise::text, o.tax_paise::text,
           o.total_paise::text, o.marketplace_fees_paise::text, o.dropped_fields, o.details_updated_at
      from lbg.channel_orders o
      join lbg.sales_channels c on c.business_id = o.business_id and c.id = o.channel_id
      left join lbg.invoices i on i.business_id = o.business_id and i.id = o.sale_id
     where o.business_id = ${ctx.businessId}
       and (${where.id ?? null}::uuid is null or o.id = ${where.id ?? null}::uuid)
       and (${where.open === true} = false or (o.status <> 'CANCELLED' and (o.sale_id is null or i.status in ('DRAFT', 'DISCARDED'))))
     order by o.placed_at desc, o.id limit 200`.execute(trx);
  if (rows.length === 0) return [];
  const { rows: lines } = await sql<{
    order_id: string;
    variant_id: string | null;
    external_sku: string;
    product_name: string | null;
    title: string | null;
    quantity: number;
    unit_price_paise: string | null;
  }>`
    select l.order_id, l.variant_id, l.external_sku, l.title,
           concat_ws(' ', p.model_name, nullif(concat_ws(' · ', v.ram, v.storage, v.colour), '')) as product_name,
           l.quantity, l.unit_price_paise::text as unit_price_paise
      from lbg.channel_order_lines l
      left join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
      left join lbg.products p on p.business_id = v.business_id and p.id = v.product_id
     where l.business_id = ${ctx.businessId} and l.order_id = any(${rows.map((r) => r.id)}::uuid[])
     order by l.id`.execute(trx);
  return rows.map((r) => {
    const billed = r.invoice_status === 'ISSUED' || r.invoice_status === 'CANCELLED';
    return {
      id: r.id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      channelKind: r.channel_kind,
      externalOrderId: r.external_order_id,
      status: r.status,
      state:
        r.status === 'CANCELLED'
          ? 'CANCELLED'
          : billed
            ? 'BILLED'
            : r.sale_id && r.invoice_status === 'DRAFT'
              ? 'BILLING'
              : 'OPEN',
      customerName: r.customer_name,
      customerMobile: r.customer_mobile,
      buyerEmail: r.buyer_email,
      buyerGstin: r.buyer_gstin,
      shipTo: r.ship_to,
      billTo: r.bill_to,
      buyerErased: r.buyer_erased_at !== null,
      masked: false,
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      fulfilledBy: r.fulfilled_by,
      platformStatus: r.platform_status,
      shipBy: iso(r.ship_by),
      deliverBy: iso(r.deliver_by),
      carrier: r.carrier,
      trackingId: r.tracking_id,
      totals: {
        itemsPaise: num(r.items_paise),
        shippingPaise: num(r.shipping_paise),
        discountPaise: num(r.discount_paise),
        taxPaise: num(r.tax_paise),
        totalPaise: num(r.total_paise),
        marketplaceFeesPaise: num(r.marketplace_fees_paise),
      },
      droppedFields: r.dropped_fields,
      detailsUpdatedAt: iso(r.details_updated_at),
      note: r.note,
      oversold: r.oversold,
      needsAttention: r.needs_attention,
      saleId: r.sale_id,
      invoiceNumber: billed ? r.invoice_number : null,
      placedAt: new Date(r.placed_at).toISOString(),
      cancelledReason: r.cancelled_reason,
      lines: lines
        .filter((l) => l.order_id === r.id)
        .map((l) => ({
          variantId: l.variant_id,
          externalSku: l.external_sku,
          productName: l.variant_id ? l.product_name : null,
          title: l.title,
          quantity: l.quantity,
          unitPricePaise: l.unit_price_paise === null ? null : Number(l.unit_price_paise),
        })),
    };
  });
}

/**
 * AC4 (D-072): what a reader without customers.view sees of the buyer — the
 * name's first letter, the phone's last 4 digits and only the city, state and
 * PIN code of the addresses (enough to pack and dispatch, not to contact).
 */
export function maskBuyer(o: ChannelOrder): ChannelOrder {
  const place = (a: FeedAddress | null): FeedAddress | null =>
    a
      ? {
          name: null,
          phone: null,
          line1: null,
          line2: null,
          landmark: null,
          city: a.city,
          state: a.state,
          pincode: a.pincode,
          country: a.country,
        }
      : null;
  return {
    ...o,
    masked: true,
    customerName: o.customerName ? `${o.customerName.slice(0, 1)}…` : null,
    customerMobile: o.customerMobile ? `••••••${o.customerMobile.slice(-4)}` : null,
    buyerEmail: null,
    buyerGstin: null,
    shipTo: place(o.shipTo),
    billTo: place(o.billTo),
  };
}

export async function listOrders(
  db: Db,
  ctx: TenantContext,
  open = false,
  view: { readonly buyer: boolean } = { buyer: true },
): Promise<ChannelOrder[]> {
  const orders = await withTenant(db, ctx, (trx) => ordersIn(trx, ctx, { open }));
  return view.buyer ? orders : orders.map(maskBuyer);
}

export async function getOrder(
  db: Db,
  ctx: TenantContext,
  id: string,
  view: { readonly buyer: boolean } = { buyer: true },
): Promise<ChannelOrder | null> {
  const order = (await withTenant(db, ctx, (trx) => ordersIn(trx, ctx, { id })))[0] ?? null;
  return order && !view.buyer ? maskBuyer(order) : order;
}

/** The address as one text line for the customer record (≤ 500 characters). */
export const addressText = (a: FeedAddress | null): string | null => {
  if (!a) return null;
  const parts = [
    a.line1,
    a.line2,
    a.landmark,
    a.city,
    a.state && a.pincode ? `${a.state} ${a.pincode}` : (a.state ?? a.pincode),
  ].filter((p): p is string => p !== null && p !== '');
  return parts.length ? parts.join(', ').slice(0, 500) : null;
};

const BUYER_ERASED = sql`customer_name = null, customer_mobile = null, buyer_email = null, buyer_gstin = null,
                         ship_to = null, bill_to = null, buyer_erased_at = now()`;

/**
 * 13.2 AC2 (the caller checks owner and fresh sign-in): removes the buyer's
 * personal data from one order; lines, totals and the invoice stay.
 */
export async function eraseOrderBuyer(
  db: Db,
  ctx: TenantContext,
  orderId: string,
  reason: string,
  requestId?: string,
): Promise<{ requestId: string }> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ erased: boolean }>`
      select buyer_erased_at is not null as erased from lbg.channel_orders
       where business_id = ${ctx.businessId} and id = ${orderId} for update`.execute(trx);
    if (!rows[0]) throw new CommerceError('NOT_FOUND', 'Not found.');
    if (rows[0].erased) throw new CommerceError('ALREADY_ERASED', "This buyer's details have already been erased.");
    await sql`update lbg.channel_orders set ${BUYER_ERASED} where business_id = ${ctx.businessId} and id = ${orderId}`.execute(
      trx,
    );
    const { rows: req } = await sql<{ id: string }>`
      insert into lbg.privacy_requests (business_id, channel_order_id, kind, reason, requested_by)
      values (${ctx.businessId}, ${orderId}, 'ERASE_ORDER_BUYER', ${reason.trim()}, ${ctx.userId}) returning id`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, {
      action: 'channel.order_buyer_erased',
      targetType: 'channel_order',
      targetId: orderId,
      metadata: { privacyRequestId: req[0]?.id ?? '' },
      ...(requestId ? { requestId } : {}),
    });
    return { requestId: req[0]?.id ?? '' };
  });
}

/** 13.2 AC1: with a customer's erasure, the buyer details of orders billed to them or with their mobile. */
export async function eraseCustomerOrderBuyersIn(
  trx: Trx,
  ctx: TenantContext,
  customerId: string,
  mobile: string | null,
): Promise<number> {
  const r = await sql`
    update lbg.channel_orders o set ${BUYER_ERASED}
     where o.business_id = ${ctx.businessId} and o.buyer_erased_at is null
       and ((${mobile}::text is not null and o.customer_mobile = ${mobile}::text)
            or exists (select 1 from lbg.invoices i where i.business_id = o.business_id and i.id = o.sale_id
                          and i.customer_id = ${customerId}))`.execute(trx);
  return Number(r.numAffectedRows ?? 0);
}

/**
 * AC3: a sale draft with the order's lines, prices and customer; the cashier
 * issues it in Point of sale (serialized items get their IMEI there). The
 * order keeps its reservation until the invoice is issued.
 */
export async function billOrder(
  db: Db,
  ctx: TenantContext,
  access: SellerAccess,
  orderId: string,
  requestId?: string,
): Promise<{ saleId: string }> {
  const order = await getOrder(db, ctx, orderId);
  if (!order) throw new CommerceError('NOT_FOUND', 'Not found.');
  if (order.state === 'CANCELLED' || order.state === 'BILLED')
    throw new CommerceError('ORDER_CLOSED', 'This order is already closed.');
  if (order.state === 'BILLING' && order.saleId) return { saleId: order.saleId };
  if (order.lines.some((l) => l.variantId === null))
    throw new CommerceError('NEEDS_ATTENTION', 'A line of this order matches no product: list its SKU first.');
  let customerId: string | null = null;
  if (order.customerMobile && order.customerName) {
    customerId = await withTenant(db, ctx, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select id from lbg.customers where business_id = ${ctx.businessId} and mobile_e164 = ${order.customerMobile}
         order by created_at limit 1`.execute(trx);
      if (rows[0]) return rows[0].id;
      // The buyer's details from the order (D-072); a GSTIN only when it is valid for its own state.
      return (
        await createCustomerIn(trx, ctx, {
          name: order.customerName ?? '',
          mobile: order.customerMobile ?? '',
          email: order.buyerEmail,
          address: addressText(order.billTo ?? order.shipTo),
          gstin: order.buyerGstin,
        })
      ).id;
    });
  }
  const draft = await createSaleDraft(db, ctx, access, {
    customerId,
    lines: order.lines.map((l) => ({
      variantId: l.variantId ?? '',
      quantity: String(l.quantity),
      ...(l.unitPricePaise === null ? {} : { unitPricePaise: l.unitPricePaise }),
    })),
    notes: `${order.channelName} order ${order.externalOrderId}`.slice(0, 200),
  });
  await withTenant(db, ctx, async (trx) => {
    await sql`update lbg.channel_orders set sale_id = ${draft.id}, status = 'ACCEPTED'
               where business_id = ${ctx.businessId} and id = ${orderId}`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'channel.order_billing',
      targetType: 'channel_order',
      targetId: orderId,
      metadata: { saleId: draft.id },
      ...(requestId ? { requestId } : {}),
    });
  });
  return { saleId: draft.id };
}

/** AC3: cancelling ends the reservation; a billed order follows the invoice rules instead. */
export async function cancelOrder(
  db: Db,
  ctx: TenantContext,
  orderId: string,
  reason: string,
  requestId?: string,
): Promise<void> {
  await withTenant(db, ctx, (trx) => cancelIn(trx, ctx, orderId, reason, requestId));
}

async function cancelIn(trx: Trx, ctx: TenantContext, orderId: string, reason: string, requestId?: string) {
  const [order] = await ordersIn(trx, ctx, { id: orderId });
  if (!order) throw new CommerceError('NOT_FOUND', 'Not found.');
  if (order.state === 'BILLED')
    throw new CommerceError('ORDER_BILLED', 'This order is billed: cancel the invoice or issue a credit note.');
  if (order.state === 'CANCELLED') throw new CommerceError('ORDER_CLOSED', 'This order is already cancelled.');
  await sql`update lbg.channel_orders set status = 'CANCELLED', cancelled_reason = ${reason}
             where business_id = ${ctx.businessId} and id = ${orderId}`.execute(trx);
  for (const l of order.lines) if (l.variantId) await queueVariant(trx, ctx, l.variantId);
  await recordTenantEvent(trx, ctx, {
    action: 'channel.order_cancelled',
    targetType: 'channel_order',
    targetId: orderId,
    ...(requestId ? { requestId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Jobs: order import and stock pushes (job runner, as the system actor)
// ---------------------------------------------------------------------------

const marketplaces = async (db: Db, ctx: TenantContext) =>
  (
    await withTenant(db, ctx, (trx) =>
      sql<{ id: string; integration_id: string; order_cursor: string | null; stock_buffer: number }>`
        select id, integration_id, order_cursor, stock_buffer from lbg.sales_channels
         where business_id = ${ctx.businessId} and kind = 'MARKETPLACE' and status = 'ACTIVE'
         order by created_at, id`.execute(trx),
    )
  ).rows;

const failureCode = (err: unknown) =>
  err instanceof IntegrationError || err instanceof CommerceError
    ? err.code
    : (typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'SYNC_ERROR')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 40);

const recordSync = (db: Db, ctx: TenantContext, channelId: string, error: string | null) =>
  withTenant(db, ctx, (trx) =>
    sql`update lbg.sales_channels set last_sync_at = now(), last_sync_error = ${error}
         where business_id = ${ctx.businessId} and id = ${channelId}`.execute(trx),
  );

/** AC1: new and cancelled orders from every active marketplace channel. Returns how many changed. */
export async function importChannelOrders(deps: HubDeps, ctx: TenantContext): Promise<number> {
  let changed = 0;
  for (const ch of await marketplaces(deps.appDb, ctx)) {
    try {
      const { result } = await callIntegration<{ orders: readonly FeedOrder[]; cursor: string | null }>(
        deps,
        ctx,
        ch.integration_id,
        'channel.orders',
        (adapter, call) => adapter.fetchOrders?.(call, ch.order_cursor) ?? null,
      );
      if (!result.ok) {
        await recordSync(deps.appDb, ctx, ch.id, result.code.slice(0, 40).replace(/[^A-Z0-9_]/g, '_'));
        continue;
      }
      await withTenant(deps.appDb, ctx, async (trx) => {
        for (const o of result.value.orders) {
          const placed = await insertOrder(trx, ctx, ch.id, {
            externalOrderId: o.id,
            placedAt: o.placedAt,
            details: o.details,
            dropped: o.dropped,
            lines: o.status === 'CANCELLED' ? [] : o.lines,
          });
          if (placed.created) changed++;
          if (o.status === 'CANCELLED') {
            const [cur] = await ordersIn(trx, ctx, { id: placed.id });
            if (cur && cur.state !== 'CANCELLED' && cur.state !== 'BILLED') {
              await cancelIn(trx, ctx, placed.id, 'Cancelled on the marketplace');
              changed++;
            } else if (cur?.state === 'BILLED') {
              await sql`update lbg.channel_orders set needs_attention = true
                         where business_id = ${ctx.businessId} and id = ${placed.id}`.execute(trx);
            }
          }
        }
        await sql`update lbg.sales_channels set order_cursor = ${result.value.cursor}, last_sync_at = now(),
                                                last_sync_error = null
                   where business_id = ${ctx.businessId} and id = ${ch.id}`.execute(trx);
      });
    } catch (err) {
      await recordSync(deps.appDb, ctx, ch.id, failureCode(err));
    }
  }
  return changed;
}

/** AC4: sends due pushes, one batch per marketplace channel. Returns how many listings were sent. */
export async function pushChannelStock(deps: HubDeps, ctx: TenantContext, now: Date = new Date()): Promise<number> {
  let sent = 0;
  for (const ch of await marketplaces(deps.appDb, ctx)) {
    const due = await withTenant(deps.appDb, ctx, async (trx) => {
      const { rows } = await sql<{
        listing_id: string;
        variant_id: string;
        external_sku: string;
        published: boolean;
        price: string;
        attempts: number;
      }>`
        select q.listing_id, l.variant_id, l.external_sku, l.published,
               coalesce(l.price_paise, v.selling_price_paise)::text as price, q.attempts
          from lbg.channel_sync_queue q
          join lbg.channel_listings l on l.business_id = q.business_id and l.id = q.listing_id
          join lbg.product_variants v on v.business_id = l.business_id and v.id = l.variant_id
         where q.business_id = ${ctx.businessId} and l.channel_id = ${ch.id} and q.next_attempt_at <= ${now}
         order by q.queued_at limit 200`.execute(trx);
      const items: (InventoryItem & { listingId: string; attempts: number })[] = [];
      for (const r of rows) {
        // An unpublished listing is sent as 0, so the marketplace stops selling it.
        const quantity = r.published ? availableToSell(await stockOf(trx, ctx, r.variant_id), ch.stock_buffer) : 0;
        items.push({
          listingId: r.listing_id,
          attempts: r.attempts,
          sku: r.external_sku,
          quantity,
          pricePaise: Number(r.price),
        });
      }
      return items;
    });
    if (due.length === 0) continue;
    let code: string | null = null;
    let rejected: readonly { sku: string; code: string }[] = [];
    try {
      const { result } = await callIntegration<{ rejected: readonly { sku: string; code: string }[] }>(
        deps,
        ctx,
        ch.integration_id,
        'channel.inventory',
        (adapter, call) =>
          adapter.pushInventory?.(
            call,
            due.map(({ sku, quantity, pricePaise }) => ({ sku, quantity, pricePaise })),
          ) ?? null,
      );
      if (result.ok) rejected = result.value.rejected;
      else code = result.code.slice(0, 40).replace(/[^A-Z0-9_]/g, '_');
    } catch (err) {
      code = failureCode(err);
    }
    await withTenant(deps.appDb, ctx, async (trx) => {
      for (const item of due) {
        const bad = code ?? rejected.find((r) => r.sku === item.sku)?.code ?? null;
        if (bad) {
          // Retry later with backoff (1, 2, 4 … minutes, at most an hour); a newer change resets it.
          const wait = Math.min(60, 2 ** Math.min(item.attempts, 6));
          await sql`update lbg.channel_sync_queue set attempts = attempts + 1, last_error = ${bad},
                           next_attempt_at = ${now}::timestamptz + make_interval(mins => ${wait})
                     where listing_id = ${item.listingId}`.execute(trx);
        } else {
          await sql`delete from lbg.channel_sync_queue where listing_id = ${item.listingId}`.execute(trx);
          await sql`update lbg.channel_listings set last_pushed_quantity = ${item.quantity}, last_pushed_at = now()
                     where business_id = ${ctx.businessId} and id = ${item.listingId}`.execute(trx);
          sent++;
        }
      }
      await sql`update lbg.sales_channels set last_sync_at = now(), last_sync_error = ${code}
                 where business_id = ${ctx.businessId} and id = ${ch.id}`.execute(trx);
    });
  }
  return sent;
}
