// Consent, suppression and messages (increment 6.2: FR-CON-1, FR-MSG-1 AC3–4,
// WORKFLOWS §9, D-048). The send-time gate runs when a message is dispatched,
// so an opt-out also stops messages that were created or approved earlier.
// Statuses SENT/DELIVERED/READ come only from a provider result.
import {
  gateDecision,
  nextAllowedTime,
  type BlockReason,
  type MessageChannel,
  type MessagePurpose,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import type { MessageProvider } from './provider.ts';

export { NOT_CONFIGURED, type MessageProvider, type OutboundMessage, type ProviderResult } from './provider.ts';

export type MessageStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'QUEUED'
  | 'SUBMITTED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export class MessagingError extends Error {
  readonly code:
    | 'CUSTOMER_NOT_FOUND'
    | 'MESSAGE_NOT_FOUND'
    | 'NO_ADDRESS'
    | 'INVALID_STATE'
    | 'RELEASE_NEEDS_APPROVER'
    | 'MARKETING_NOT_TRANSACTIONAL';

  constructor(code: MessagingError['code'], message: string) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}

/** E.164 mobile for WhatsApp and SMS, lower-case email for email. */
const addressColumn = (channel: MessageChannel) => (channel === 'EMAIL' ? sql`lower(email::text)` : sql`mobile_e164`);

/** Serialises opt-outs and dispatches for one address (no send slips past a concurrent opt-out). */
const lockAddress = (trx: Trx, channel: MessageChannel, address: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`${channel}:${address}`}, 61))`.execute(trx);

async function customerIn(trx: Trx, ctx: TenantContext, customerId: string, lock = false) {
  const { rows } = await sql<{ id: string; mobile: string | null; email: string | null; erased: boolean }>`
    select id, mobile_e164 as mobile, lower(email::text) as email, erased_at is not null as erased
      from lbg.customers where business_id = ${ctx.businessId} and id = ${customerId}
      ${lock ? sql`for update` : sql``}`.execute(trx);
  const c = rows[0];
  if (!c) throw new MessagingError('CUSTOMER_NOT_FOUND', 'Customer not found.');
  return c;
}

const addressOf = (c: { mobile: string | null; email: string | null }, channel: MessageChannel) =>
  channel === 'EMAIL' ? c.email : c.mobile;

async function suppressedIn(trx: Trx, ctx: TenantContext, channel: MessageChannel, address: string) {
  const { rows } = await sql<{ action: string }>`
    select action from lbg.contact_suppressions
     where business_id = ${ctx.businessId} and channel = ${channel} and address = ${address}
     order by recorded_at desc, id desc limit 1`.execute(trx);
  return rows[0]?.action === 'SUPPRESS';
}

async function consentIn(
  trx: Trx,
  ctx: TenantContext,
  customerId: string,
  channel: MessageChannel,
  purpose: MessagePurpose,
): Promise<'GRANTED' | 'WITHDRAWN' | null> {
  const { rows } = await sql<{ status: 'GRANTED' | 'WITHDRAWN' }>`
    select status from lbg.customer_consents
     where business_id = ${ctx.businessId} and customer_id = ${customerId} and channel = ${channel}
       and purpose = ${purpose}
     order by recorded_at desc, id desc limit 1`.execute(trx);
  return rows[0]?.status ?? null;
}

// ---------------------------------------------------------------------------
// Consent (FR-CON-1 AC1, AC4)
// ---------------------------------------------------------------------------

export interface ConsentRecord {
  readonly id: string;
  readonly channel: MessageChannel;
  readonly purpose: MessagePurpose;
  readonly status: 'GRANTED' | 'WITHDRAWN';
  readonly source: string;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

export interface ChannelState {
  readonly channel: MessageChannel;
  readonly address: string | null;
  readonly suppressed: boolean;
  readonly transactional: 'GRANTED' | 'WITHDRAWN' | null;
  readonly marketing: 'GRANTED' | 'WITHDRAWN' | null;
  /** What the gate would decide now for each purpose. */
  readonly transactionalAllowed: boolean;
  readonly marketingAllowed: boolean;
}

export interface CustomerConsents {
  readonly channels: readonly ChannelState[];
  readonly history: readonly ConsentRecord[];
}

const CHANNELS: readonly MessageChannel[] = ['WHATSAPP', 'SMS', 'EMAIL'];

export async function customerConsents(db: Db, ctx: TenantContext, customerId: string): Promise<CustomerConsents> {
  return withTenant(db, ctx, async (trx) => {
    const c = await customerIn(trx, ctx, customerId);
    const channels: ChannelState[] = [];
    for (const channel of CHANNELS) {
      const address = addressOf(c, channel);
      const suppressed = address ? await suppressedIn(trx, ctx, channel, address) : false;
      const transactional = await consentIn(trx, ctx, customerId, channel, 'TRANSACTIONAL');
      const marketing = await consentIn(trx, ctx, customerId, channel, 'MARKETING');
      const facts = { suppressed, erased: c.erased, hasAddress: address !== null };
      channels.push({
        channel,
        address,
        suppressed,
        transactional,
        marketing,
        transactionalAllowed: gateDecision({ ...facts, purpose: 'TRANSACTIONAL', consent: transactional }).allowed,
        marketingAllowed: gateDecision({ ...facts, purpose: 'MARKETING', consent: marketing }).allowed,
      });
    }
    const { rows } = await sql<{
      id: string;
      channel: MessageChannel;
      purpose: MessagePurpose;
      status: 'GRANTED' | 'WITHDRAWN';
      source: string;
      recorded_by: string | null;
      recorded_at: Date;
    }>`
      select id, channel, purpose, status, source, recorded_by, recorded_at from lbg.customer_consents
       where business_id = ${ctx.businessId} and customer_id = ${customerId}
       order by recorded_at desc, id desc limit 200`.execute(trx);
    return {
      channels,
      history: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        purpose: r.purpose,
        status: r.status,
        source: r.source,
        recordedBy: r.recorded_by,
        recordedAt: r.recorded_at.toISOString(),
      })),
    };
  });
}

export interface ConsentInput {
  readonly channel: MessageChannel;
  readonly purpose: MessagePurpose;
  readonly status: 'GRANTED' | 'WITHDRAWN';
  /** How the consent was obtained, e.g. "Asked at the counter, said yes". */
  readonly source: string;
}

/**
 * Appends a consent record. Granting on a suppressed address lifts the
 * suppression only when the caller may approve marketing (the customer asked
 * again; an opt-out is never undone by ordinary staff).
 */
export async function recordConsent(
  db: Db,
  ctx: TenantContext,
  access: { readonly canRelease: boolean },
  customerId: string,
  input: ConsentInput,
  requestId?: string,
): Promise<CustomerConsents> {
  await withTenant(db, ctx, async (trx) => {
    const c = await customerIn(trx, ctx, customerId, true);
    if (c.erased) throw new MessagingError('CUSTOMER_NOT_FOUND', 'Customer not found.');
    const address = addressOf(c, input.channel);
    let released = false;
    if (input.status === 'GRANTED' && address) {
      await lockAddress(trx, input.channel, address);
      if (await suppressedIn(trx, ctx, input.channel, address)) {
        if (!access.canRelease) {
          throw new MessagingError(
            'RELEASE_NEEDS_APPROVER',
            'This contact opted out. Only someone who can approve marketing can record new consent.',
          );
        }
        await sql`insert into lbg.contact_suppressions (business_id, channel, address, action, reason, customer_id, recorded_by)
                  values (${ctx.businessId}, ${input.channel}, ${address}, 'RELEASE', 'RECONSENT', ${customerId},
                          ${ctx.userId})`.execute(trx);
        released = true;
      }
    }
    await sql`insert into lbg.customer_consents (business_id, customer_id, channel, purpose, status, source, recorded_by)
              values (${ctx.businessId}, ${customerId}, ${input.channel}, ${input.purpose}, ${input.status},
                      ${input.source.trim()}, ${ctx.userId})`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'consent.record',
      targetType: 'customer',
      targetId: customerId,
      metadata: { channel: input.channel, purpose: input.purpose, status: input.status, released },
      ...(requestId ? { requestId } : {}),
    });
  });
  return customerConsents(db, ctx, customerId);
}

// ---------------------------------------------------------------------------
// Opt-out and suppression (FR-CON-1 AC2)
// ---------------------------------------------------------------------------

async function suppressIn(
  trx: Trx,
  ctx: TenantContext,
  channel: MessageChannel,
  address: string,
  reason: 'OWNER_OPT_OUT' | 'STOP_REPLY' | 'ERASED',
  customerId: string | null,
  note: string | null,
): Promise<boolean> {
  await lockAddress(trx, channel, address);
  if (await suppressedIn(trx, ctx, channel, address)) return false;
  await sql`insert into lbg.contact_suppressions (business_id, channel, address, action, reason, customer_id, note, recorded_by)
            values (${ctx.businessId}, ${channel}, ${address}, 'SUPPRESS', ${reason}, ${customerId}, ${note},
                    ${ctx.userId})`.execute(trx);
  return true;
}

/**
 * The customer does not want messages on `channel`: the address is suppressed
 * at once and marketing consent on that channel is withdrawn.
 */
export async function optOut(
  db: Db,
  ctx: TenantContext,
  customerId: string,
  input: {
    readonly channel: MessageChannel;
    readonly reason: 'OWNER_OPT_OUT' | 'STOP_REPLY';
    readonly note?: string | null;
  },
  requestId?: string,
): Promise<CustomerConsents> {
  await withTenant(db, ctx, async (trx) => {
    const c = await customerIn(trx, ctx, customerId, true);
    const address = addressOf(c, input.channel);
    if (!address) throw new MessagingError('NO_ADDRESS', 'The customer has no address for this channel.');
    const added = await suppressIn(trx, ctx, input.channel, address, input.reason, customerId, input.note ?? null);
    if ((await consentIn(trx, ctx, customerId, input.channel, 'MARKETING')) !== 'WITHDRAWN') {
      await sql`insert into lbg.customer_consents (business_id, customer_id, channel, purpose, status, source, recorded_by)
                values (${ctx.businessId}, ${customerId}, ${input.channel}, 'MARKETING', 'WITHDRAWN',
                        ${input.reason === 'STOP_REPLY' ? 'Opt-out reply (STOP)' : 'Opt-out recorded by staff'},
                        ${ctx.userId})`.execute(trx);
    }
    await recordTenantEvent(trx, ctx, {
      action: 'contact.suppress',
      targetType: 'customer',
      targetId: customerId,
      metadata: { channel: input.channel, reason: input.reason, added },
      ...(requestId ? { requestId } : {}),
    });
  });
  return customerConsents(db, ctx, customerId);
}

/**
 * Adapter hook for an inbound "STOP" (or equivalent) reply: suppresses the
 * address even when it belongs to no customer. Returns whether it was new.
 */
export async function handleInboundOptOut(
  db: Db,
  ctx: TenantContext,
  channel: MessageChannel,
  address: string,
): Promise<boolean> {
  const addr = channel === 'EMAIL' ? address.trim().toLowerCase() : address.trim();
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      select id from lbg.customers where business_id = ${ctx.businessId} and ${addressColumn(channel)} = ${addr}
       limit 1`.execute(trx);
    const customerId = rows[0]?.id ?? null;
    const added = await suppressIn(trx, ctx, channel, addr, 'STOP_REPLY', customerId, null);
    if (customerId && (await consentIn(trx, ctx, customerId, channel, 'MARKETING')) !== 'WITHDRAWN') {
      await sql`insert into lbg.customer_consents (business_id, customer_id, channel, purpose, status, source, recorded_by)
                values (${ctx.businessId}, ${customerId}, ${channel}, 'MARKETING', 'WITHDRAWN',
                        'Opt-out reply (STOP)', null)`.execute(trx);
    }
    await recordTenantEvent(trx, ctx, {
      action: 'contact.suppress',
      targetType: customerId ? 'customer' : 'business',
      targetId: customerId ?? ctx.businessId,
      metadata: { channel, reason: 'STOP_REPLY', added },
    });
    return added;
  });
}

/** Inside the caller's transaction: suppress every address of an erased customer (6.6). */
export async function suppressCustomerIn(trx: Trx, ctx: TenantContext, customerId: string): Promise<void> {
  const c = await customerIn(trx, ctx, customerId);
  for (const channel of CHANNELS) {
    const address = addressOf(c, channel);
    if (address) await suppressIn(trx, ctx, channel, address, 'ERASED', customerId, null);
  }
}

export interface Suppression {
  readonly channel: MessageChannel;
  readonly address: string;
  readonly reason: string;
  readonly customerId: string | null;
  readonly since: string;
}

/** Addresses currently suppressed (latest event SUPPRESS). */
export async function listSuppressions(db: Db, ctx: TenantContext): Promise<Suppression[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      channel: MessageChannel;
      address: string;
      reason: string;
      customer_id: string | null;
      recorded_at: Date;
    }>`
      select channel, address, reason, customer_id, recorded_at from (
        select distinct on (channel, address) channel, address, action, reason, customer_id, recorded_at
          from lbg.contact_suppressions where business_id = ${ctx.businessId}
         order by channel, address, recorded_at desc, id desc) s
       where action = 'SUPPRESS' order by recorded_at desc limit 500`.execute(trx);
    return rows.map((r) => ({
      channel: r.channel,
      address: r.address,
      reason: r.reason,
      customerId: r.customer_id,
      since: r.recorded_at.toISOString(),
    }));
  });
}

// ---------------------------------------------------------------------------
// Messages (WORKFLOWS §9)
// ---------------------------------------------------------------------------

export interface MessageEvent {
  readonly status: MessageStatus;
  readonly reason: string | null;
  readonly actorId: string | null;
  readonly provider: string | null;
  readonly at: string;
}

export interface Message {
  readonly id: string;
  readonly customerId: string | null;
  readonly channel: MessageChannel;
  readonly purpose: MessagePurpose;
  readonly origin: 'MANUAL' | 'REMINDER' | 'DOCUMENT' | 'CAMPAIGN';
  readonly toAddress: string;
  readonly body: string;
  readonly status: MessageStatus;
  readonly statusReason: string | null;
  readonly notBefore: string | null;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
  readonly createdAt: string;
  readonly events: readonly MessageEvent[];
}

interface MessageRow {
  id: string;
  customer_id: string | null;
  channel: MessageChannel;
  purpose: MessagePurpose;
  origin: Message['origin'];
  to_address: string;
  body: string;
  status: MessageStatus;
  status_reason: string | null;
  not_before: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: Date;
}

const MESSAGE_COLUMNS = sql`id, customer_id, channel, purpose, origin, to_address, body, status, status_reason,
                            not_before, provider, provider_message_id, created_by, approved_by, created_at`;

async function messagesWithEvents(trx: Trx, ctx: TenantContext, rows: MessageRow[]): Promise<Message[]> {
  const { rows: ev } = await sql<{
    message_id: string;
    status: MessageStatus;
    reason: string | null;
    actor_id: string | null;
    provider: string | null;
    at: Date;
  }>`
    select message_id, status, reason, actor_id, provider, at from lbg.message_events
     where business_id = ${ctx.businessId} and message_id = any(${rows.map((r) => r.id)}::uuid[])
     order by seq`.execute(trx);
  const byMessage = new Map<string, MessageEvent[]>();
  for (const e of ev) {
    const list = byMessage.get(e.message_id) ?? [];
    list.push({
      status: e.status,
      reason: e.reason,
      actorId: e.actor_id,
      provider: e.provider,
      at: e.at.toISOString(),
    });
    byMessage.set(e.message_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    channel: r.channel,
    purpose: r.purpose,
    origin: r.origin,
    toAddress: r.to_address,
    body: r.body,
    status: r.status,
    statusReason: r.status_reason,
    notBefore: r.not_before?.toISOString() ?? null,
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    createdAt: r.created_at.toISOString(),
    events: byMessage.get(r.id) ?? [],
  }));
}

async function messageIn(trx: Trx, ctx: TenantContext, id: string, lock = false): Promise<MessageRow> {
  const { rows } = await sql<MessageRow>`
    select ${MESSAGE_COLUMNS} from lbg.messages where business_id = ${ctx.businessId} and id = ${id}
    ${lock ? sql`for update` : sql``}`.execute(trx);
  const m = rows[0];
  if (!m) throw new MessagingError('MESSAGE_NOT_FOUND', 'Message not found.');
  return m;
}

export async function getMessage(db: Db, ctx: TenantContext, id: string): Promise<Message> {
  return withTenant(db, ctx, async (trx) => {
    const [m] = await messagesWithEvents(trx, ctx, [await messageIn(trx, ctx, id)]);
    if (!m) throw new MessagingError('MESSAGE_NOT_FOUND', 'Message not found.');
    return m;
  });
}

/** Communication history (FR-CON-1 AC3): every message and each status it took. */
export async function listMessages(
  db: Db,
  ctx: TenantContext,
  filter: { readonly customerId?: string | undefined; readonly status?: MessageStatus | undefined } = {},
): Promise<Message[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<MessageRow>`
      select ${MESSAGE_COLUMNS} from lbg.messages
       where business_id = ${ctx.businessId}
         ${filter.customerId ? sql`and customer_id = ${filter.customerId}` : sql``}
         ${filter.status ? sql`and status = ${filter.status}` : sql``}
       order by created_at desc, id desc limit 200`.execute(trx);
    return messagesWithEvents(trx, ctx, rows);
  });
}

export interface MessageInput {
  readonly customerId: string;
  readonly channel: MessageChannel;
  readonly purpose: MessagePurpose;
  readonly body: string;
  readonly origin?: 'MANUAL' | 'REMINDER' | 'DOCUMENT' | undefined;
}

/**
 * Creates a message to a customer's current address on that channel.
 * Marketing starts as DRAFT (it needs approval); transactional starts QUEUED
 * when `queue` is set, else DRAFT. The gate runs later, at dispatch.
 */
export async function createMessageIn(
  trx: Trx,
  ctx: TenantContext,
  input: MessageInput,
  opts: { readonly queue?: boolean } = {},
): Promise<string> {
  if (opts.queue && input.purpose !== 'TRANSACTIONAL') {
    throw new MessagingError('MARKETING_NOT_TRANSACTIONAL', 'Marketing messages need approval before sending.');
  }
  const c = await customerIn(trx, ctx, input.customerId);
  const address = addressOf(c, input.channel);
  if (c.erased || !address) throw new MessagingError('NO_ADDRESS', 'The customer has no address for this channel.');
  const { rows } = await sql<{ id: string }>`
    insert into lbg.messages (business_id, customer_id, channel, purpose, origin, to_address, body, status, created_by)
    values (${ctx.businessId}, ${input.customerId}, ${input.channel}, ${input.purpose}, ${input.origin ?? 'MANUAL'},
            ${address}, ${input.body.trim()}, ${opts.queue ? 'QUEUED' : 'DRAFT'}, ${ctx.userId})
    returning id`.execute(trx);
  const id = rows[0]?.id;
  if (!id) throw new Error('message insert returned nothing');
  return id;
}

export async function createMessage(
  db: Db,
  ctx: TenantContext,
  input: MessageInput,
  opts: { readonly queue?: boolean } = {},
): Promise<Message> {
  const id = await withTenant(db, ctx, (trx) => createMessageIn(trx, ctx, input, opts));
  return getMessage(db, ctx, id);
}

async function transition(
  db: Db,
  ctx: TenantContext,
  id: string,
  from: readonly MessageStatus[],
  to: MessageStatus,
  extra: { readonly approvedBy?: string; readonly reason?: string } = {},
  audit?: string,
): Promise<Message> {
  await withTenant(db, ctx, async (trx) => {
    const m = await messageIn(trx, ctx, id, true);
    if (!from.includes(m.status)) {
      throw new MessagingError('INVALID_STATE', `A ${m.status.toLowerCase()} message cannot be changed this way.`);
    }
    await sql`update lbg.messages set status = ${to}, status_reason = ${extra.reason ?? null},
                     approved_by = coalesce(${extra.approvedBy ?? null}::uuid, approved_by)
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    if (audit) {
      await recordTenantEvent(trx, ctx, {
        action: audit,
        targetType: 'message',
        targetId: id,
        metadata: { channel: m.channel, purpose: m.purpose },
      });
    }
  });
  return getMessage(db, ctx, id);
}

export async function editDraft(db: Db, ctx: TenantContext, id: string, body: string): Promise<Message> {
  await withTenant(db, ctx, async (trx) => {
    const m = await messageIn(trx, ctx, id, true);
    if (m.status !== 'DRAFT') throw new MessagingError('INVALID_STATE', 'Only a draft can be edited.');
    await sql`update lbg.messages set body = ${body.trim()} where business_id = ${ctx.businessId} and id = ${id}`.execute(
      trx,
    );
  });
  return getMessage(db, ctx, id);
}

export const submitMessage = (db: Db, ctx: TenantContext, id: string) =>
  transition(db, ctx, id, ['DRAFT'], 'PENDING_APPROVAL');

export const approveMessage = (db: Db, ctx: TenantContext, id: string) =>
  transition(db, ctx, id, ['PENDING_APPROVAL'], 'APPROVED', { approvedBy: ctx.userId }, 'message.approve');

export const returnToDraft = (db: Db, ctx: TenantContext, id: string, reason: string) =>
  transition(db, ctx, id, ['PENDING_APPROVAL'], 'DRAFT', { reason });

export const cancelMessage = (db: Db, ctx: TenantContext, id: string) =>
  transition(db, ctx, id, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED'], 'CANCELLED', {}, 'message.cancel');

/** Approved marketing (or a transactional draft) is queued for dispatch. */
export async function queueMessage(db: Db, ctx: TenantContext, id: string): Promise<Message> {
  await withTenant(db, ctx, async (trx) => {
    const m = await messageIn(trx, ctx, id, true);
    if (m.status !== 'APPROVED') {
      throw new MessagingError(
        'INVALID_STATE',
        m.purpose === 'MARKETING'
          ? 'Marketing messages must be approved first.'
          : 'Only an approved message can be sent.',
      );
    }
    await sql`update lbg.messages set status = 'QUEUED' where business_id = ${ctx.businessId} and id = ${id}`.execute(
      trx,
    );
    await recordTenantEvent(trx, ctx, {
      action: 'message.queue',
      targetType: 'message',
      targetId: id,
      metadata: { channel: m.channel, purpose: m.purpose },
    });
  });
  return getMessage(db, ctx, id);
}

// ---------------------------------------------------------------------------
// Dispatch: the send-time gate, quiet hours and the provider (FR-CON-1 AC2)
// ---------------------------------------------------------------------------

export type DispatchOutcome =
  | { readonly outcome: 'BLOCKED'; readonly reason: BlockReason }
  | { readonly outcome: 'DEFERRED'; readonly notBefore: string }
  | { readonly outcome: 'FAILED'; readonly reason: string }
  | { readonly outcome: 'SENT'; readonly providerMessageId: string }
  | { readonly outcome: 'SKIPPED'; readonly status: MessageStatus };

/**
 * Dispatches one QUEUED message. In one transaction (holding the address lock
 * that opt-outs take): the gate (erasure, suppression, consent), quiet hours
 * for marketing and reminders, and the provider check. A message passing all
 * of them is marked SUBMITTED before the provider is called; the provider's
 * answer then makes it SENT (with its reference) or FAILED.
 */
export async function dispatchMessage(
  db: Db,
  ctx: TenantContext,
  provider: MessageProvider,
  id: string,
  now: Date = new Date(),
): Promise<DispatchOutcome> {
  const step = await withTenant(db, ctx, async (trx) => {
    const m = await messageIn(trx, ctx, id, true);
    if (m.status !== 'QUEUED') return { outcome: 'SKIPPED' as const, status: m.status };
    if (m.not_before && m.not_before > now) {
      return { outcome: 'DEFERRED' as const, notBefore: m.not_before.toISOString() };
    }
    await lockAddress(trx, m.channel, m.to_address);
    const c = m.customer_id ? await customerIn(trx, ctx, m.customer_id) : null;
    const decision = gateDecision({
      purpose: m.purpose,
      consent: m.customer_id ? await consentIn(trx, ctx, m.customer_id, m.channel, m.purpose) : null,
      suppressed: await suppressedIn(trx, ctx, m.channel, m.to_address),
      erased: c?.erased ?? false,
      hasAddress: m.to_address !== '',
    });
    const set = (status: MessageStatus, reason: string | null, extra = sql``) =>
      sql`update lbg.messages set status = ${status}, status_reason = ${reason} ${extra}
           where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    if (!decision.allowed) {
      await set('BLOCKED', decision.reason);
      return { outcome: 'BLOCKED' as const, reason: decision.reason };
    }
    if (m.purpose === 'MARKETING' || m.origin === 'REMINDER') {
      const { rows } = await sql<{ timezone: string; start: number | null; end: number | null }>`
        select b.timezone, s.quiet_start_minute as start, s.quiet_end_minute as end
          from lbg.businesses b left join lbg.business_settings s on s.business_id = b.id
         where b.id = ${ctx.businessId}`.execute(trx);
      const b = rows[0];
      const next = nextAllowedTime(now, b?.timezone ?? 'Asia/Kolkata', b?.start ?? 540, b?.end ?? 1260);
      if (next.getTime() !== now.getTime()) {
        await sql`update lbg.messages set not_before = ${next} where business_id = ${ctx.businessId} and id = ${id}`.execute(
          trx,
        );
        return { outcome: 'DEFERRED' as const, notBefore: next.toISOString() };
      }
    }
    if (!provider.configured) {
      await set('FAILED', 'PROVIDER_NOT_CONFIGURED');
      return { outcome: 'FAILED' as const, reason: 'PROVIDER_NOT_CONFIGURED' };
    }
    await set('SUBMITTED', null, sql`, provider = ${provider.name}`);
    return { outcome: 'SUBMIT' as const, message: m };
  });
  if (step.outcome !== 'SUBMIT') return step;

  let result: Awaited<ReturnType<MessageProvider['send']>>;
  try {
    result = await provider.send({
      messageId: id,
      channel: step.message.channel,
      to: step.message.to_address,
      body: step.message.body,
    });
  } catch {
    result = { ok: false, code: 'PROVIDER_ERROR' };
  }
  return withTenant(db, ctx, async (trx) => {
    if (result.ok) {
      await sql`update lbg.messages set status = 'SENT', status_reason = null,
                       provider_message_id = ${result.providerMessageId}
                 where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
      return { outcome: 'SENT' as const, providerMessageId: result.providerMessageId };
    }
    const reason = result.code.slice(0, 200);
    await sql`update lbg.messages set status = 'FAILED', status_reason = ${reason}
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    return { outcome: 'FAILED' as const, reason };
  });
}

/** Dispatches queued messages that are due (job runner and tests). */
export async function dispatchDue(
  db: Db,
  ctx: TenantContext,
  provider: MessageProvider,
  now: Date = new Date(),
  limit = 100,
): Promise<{ readonly id: string; readonly result: DispatchOutcome }[]> {
  const { rows } = await withTenant(db, ctx, (trx) =>
    sql<{ id: string }>`
      select id from lbg.messages
       where business_id = ${ctx.businessId} and status = 'QUEUED' and (not_before is null or not_before <= ${now})
       order by created_at, id limit ${limit}`.execute(trx),
  );
  const out: { id: string; result: DispatchOutcome }[] = [];
  for (const r of rows) out.push({ id: r.id, result: await dispatchMessage(db, ctx, provider, r.id, now) });
  return out;
}

/**
 * A later status from the provider (delivery receipt, read receipt, failure),
 * matched by the provider's reference. Called only by a verified provider
 * callback (NFR-18); returns false when no message matches.
 */
export async function recordProviderStatus(
  db: Db,
  ctx: TenantContext,
  providerName: string,
  providerMessageId: string,
  status: 'DELIVERED' | 'READ' | 'FAILED',
  reason?: string,
): Promise<boolean> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{ id: string; status: MessageStatus }>`
      select id, status from lbg.messages
       where business_id = ${ctx.businessId} and provider = ${providerName}
         and provider_message_id = ${providerMessageId} for update`.execute(trx);
    const m = rows[0];
    if (!m) return false;
    if (m.status === status || (m.status === 'READ' && status === 'DELIVERED')) return true; // repeated or late receipt
    await sql`update lbg.messages set status = ${status},
                     status_reason = ${status === 'FAILED' ? (reason ?? 'PROVIDER_FAILED').slice(0, 200) : null}
               where business_id = ${ctx.businessId} and id = ${m.id}`.execute(trx);
    return true;
  });
}
