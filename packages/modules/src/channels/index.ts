// Messaging channels through the hub (increment 7.6: FR-MSG-1, -2, -4, -5 AC3,
// NFR-18, D-059). A business's tested WhatsApp or SMS integration becomes the
// message provider: every business-initiated message goes out as a matching
// approved template (WhatsApp) or DLT-registered template (SMS), or not at all.
// Provider webhooks are verified (signature, 5-minute replay window), applied
// once per event, and feed delivery statuses and STOP opt-outs.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { matchTemplate, type MessageChannel } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type TenantContext } from '@lbgos/db';
import {
  activeIntegration,
  approvedTemplatesIn,
  callProvider,
  IntegrationError,
  markVerified,
  secretFields,
  webhookTarget,
  type HubDeps,
  type Integration,
  type WebhookTarget,
} from '../integrations/index.ts';
import {
  handleInboundOptOut,
  NOT_CONFIGURED,
  recordProviderStatus,
  type MessageProvider,
  type OutboundMessage,
  type ProviderResult,
} from '../messaging/index.ts';

const CHANNEL_CATEGORY = { WHATSAPP: 'MESSAGING', SMS: 'SMS' } as const;

/** One channel's provider: its integration, matching templates, the hub's quota, retries and usage. */
function channelProvider(
  deps: HubDeps,
  ctx: TenantContext,
  integration: Integration,
  channel: 'WHATSAPP' | 'SMS',
): MessageProvider {
  return {
    name: integration.provider,
    configured: true,
    async send(m: OutboundMessage): Promise<ProviderResult> {
      const templates = await withTenant(deps.appDb, ctx, (trx) => approvedTemplatesIn(trx, ctx, integration.id));
      const match = matchTemplate(m.body, templates, { channel, purpose: m.purpose });
      if (!match) return { ok: false, code: channel === 'SMS' ? 'NO_DLT_TEMPLATE' : 'NO_APPROVED_TEMPLATE' };
      try {
        const { result } = await callProvider<{ readonly providerMessageId: string }>(
          deps,
          ctx,
          CHANNEL_CATEGORY[channel],
          `message.${m.purpose.toLowerCase()}`,
          (adapter, call) =>
            adapter.sendMessage?.(call, {
              messageId: m.messageId,
              to: m.to,
              purpose: m.purpose,
              template: {
                name: match.template.name,
                language: match.template.language,
                params: match.params,
                dltTemplateId: match.template.dltTemplateId,
                text: m.body,
              },
            }) ?? null,
          { units: 1, costPaise: null },
        );
        return result.ok
          ? { ok: true, providerMessageId: result.value.providerMessageId }
          : { ok: false, code: result.code };
      } catch (err) {
        if (err instanceof IntegrationError) return { ok: false, code: err.code };
        throw err;
      }
    },
  };
}

/**
 * The business's message provider: per channel, its tested WhatsApp (category
 * MESSAGING) or SMS integration with a send operation; NOT_CONFIGURED otherwise.
 */
export async function hubMessagingProvider(deps: HubDeps, ctx: TenantContext): Promise<MessageProvider> {
  const byChannel = new Map<MessageChannel, MessageProvider>();
  for (const channel of ['WHATSAPP', 'SMS'] as const) {
    const i = await activeIntegration(deps.appDb, ctx, CHANNEL_CATEGORY[channel]);
    if (i && (i.provider === 'whatsapp_cloud' || i.provider === 'sms_dlt_json')) {
      byChannel.set(channel, channelProvider(deps, ctx, i, channel));
    }
  }
  return {
    name: 'hub',
    configured: byChannel.size > 0,
    select: (channel) => byChannel.get(channel) ?? NOT_CONFIGURED,
    send: (m) => (byChannel.get(m.channel) ?? NOT_CONFIGURED).send(m),
  };
}

// ---------------------------------------------------------------------------
// Webhooks (NFR-18, FR-MSG-1 AC4, FR-MSG-5 AC3)
// ---------------------------------------------------------------------------

/** Events older than this are not applied (NFR-18). */
export const REPLAY_WINDOW_SECONDS = 300;
/** Inbound replies that opt the sender out (case-insensitive, whole message). */
export const OPT_OUT_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'STOP ALL', 'OPT OUT'] as const;

export interface WebhookResult {
  readonly status: 200 | 401 | 404;
  readonly applied: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly ignored: number;
}

const deny = (status: 401 | 404): WebhookResult => ({ status, applied: 0, duplicates: 0, stale: 0, ignored: 0 });

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (key: string, data: Buffer | string) => createHmac('sha256', key).update(data).digest('hex');

type Event =
  | {
      readonly key: string;
      readonly kind: 'STATUS';
      readonly at: number;
      readonly ref: string;
      readonly status: string;
      readonly reason?: string;
    }
  | {
      readonly key: string;
      readonly kind: 'INBOUND';
      readonly at: number;
      readonly from: string;
      readonly text: string;
    };

async function apply(
  deps: HubDeps,
  t: WebhookTarget,
  channel: 'WHATSAPP' | 'SMS',
  events: readonly Event[],
  nowSec: number,
) {
  let applied = 0;
  let duplicates = 0;
  let stale = 0;
  let ignored = 0;
  for (const e of events) {
    if (!Number.isFinite(e.at) || nowSec - e.at > REPLAY_WINDOW_SECONDS || e.at - nowSec > REPLAY_WINDOW_SECONDS) {
      stale++;
      continue;
    }
    const seen = await withTenant(deps.appDb, t.ctx, async (trx) => {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from lbg.webhook_events
         where business_id = ${t.ctx.businessId} and integration_id = ${t.integrationId} and event_key = ${e.key}`.execute(
        trx,
      );
      return (rows[0]?.n ?? 0) > 0;
    });
    if (seen) {
      duplicates++;
      continue;
    }
    let outcome = 'IGNORED';
    if (e.kind === 'STATUS') {
      const s = e.status.toUpperCase();
      const status = s === 'DELIVERED' ? 'DELIVERED' : s === 'READ' ? 'READ' : s === 'FAILED' ? 'FAILED' : null;
      if (status) {
        const found = await recordProviderStatus(deps.appDb, t.ctx, t.provider, e.ref, status, e.reason);
        outcome = found ? status : 'UNKNOWN_MESSAGE';
        if (found && status !== 'FAILED') await markVerified(deps.appDb, t.ctx, t.integrationId);
      }
    } else {
      const word = e.text.trim().replace(/\s+/g, ' ').toUpperCase();
      if ((OPT_OUT_KEYWORDS as readonly string[]).includes(word)) {
        const from = e.from.startsWith('+') ? e.from : `+${e.from}`;
        await handleInboundOptOut(deps.appDb, t.ctx, channel, from);
        outcome = 'OPT_OUT';
      }
    }
    // Applying is idempotent (statuses and opt-outs), so a concurrent duplicate does no harm; the key is recorded once.
    await withTenant(deps.appDb, t.ctx, (trx) =>
      sql`insert into lbg.webhook_events (business_id, integration_id, event_key, kind, outcome)
          values (${t.ctx.businessId}, ${t.integrationId}, ${e.key.slice(0, 300)}, ${e.kind}, ${outcome})
          on conflict (business_id, integration_id, event_key) do nothing`.execute(trx),
    );
    if (outcome === 'IGNORED' || outcome === 'UNKNOWN_MESSAGE') ignored++;
    else applied++;
  }
  return { status: 200 as const, applied, duplicates, stale, ignored };
}

/** WhatsApp subscription check (GET): echoes the challenge only for the configured verify token. */
export async function verifyWhatsAppSubscription(
  deps: HubDeps,
  integrationId: string,
  query: {
    readonly mode?: string | undefined;
    readonly token?: string | undefined;
    readonly challenge?: string | undefined;
  },
): Promise<string | null> {
  const t = await webhookTarget(deps, integrationId);
  if (t?.provider !== 'whatsapp_cloud') return null;
  const s = secretFields(t.secret, ['verifyToken']);
  if (!s || query.mode !== 'subscribe' || !query.token || !query.challenge) return null;
  if (!safeEqual(query.token, s.verifyToken) || !/^[\w-]{1,200}$/.test(query.challenge)) return null;
  return query.challenge;
}

interface WaPayload {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id?: unknown; status?: unknown; timestamp?: unknown; errors?: { code?: unknown }[] }[];
        messages?: { id?: unknown; from?: unknown; timestamp?: unknown; type?: unknown; text?: { body?: unknown } }[];
      };
    }[];
  }[];
}

/**
 * WhatsApp Cloud API webhook (POST): X-Hub-Signature-256 is the HMAC-SHA256
 * of the raw body with the app secret. Each status or message carries its
 * own timestamp, which the replay window applies to.
 */
export async function handleWhatsAppWebhook(
  deps: HubDeps,
  integrationId: string,
  raw: Buffer,
  signature: string | undefined,
  now: Date = new Date(),
): Promise<WebhookResult> {
  const t = await webhookTarget(deps, integrationId);
  if (t?.provider !== 'whatsapp_cloud') return deny(404);
  const s = secretFields(t.secret, ['appSecret']);
  if (!s || !signature || !safeEqual(signature, `sha256=${hmac(s.appSecret, raw)}`)) return deny(401);
  let body: WaPayload;
  try {
    body = JSON.parse(raw.toString('utf8')) as WaPayload;
  } catch {
    return deny(401);
  }
  const events: Event[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const st of change.value?.statuses ?? []) {
        if (typeof st.id !== 'string' || typeof st.status !== 'string') continue;
        const code = st.errors?.[0]?.code;
        events.push({
          key: `status:${st.id}:${st.status}`,
          kind: 'STATUS',
          at: Number(st.timestamp),
          ref: st.id,
          status: st.status,
          ...(typeof code === 'number' ? { reason: `WA_${String(code)}` } : {}),
        });
      }
      for (const msg of change.value?.messages ?? []) {
        if (typeof msg.id !== 'string' || typeof msg.from !== 'string') continue;
        events.push({
          key: `inbound:${msg.id}`,
          kind: 'INBOUND',
          at: Number(msg.timestamp),
          from: msg.from,
          text: msg.type === 'text' && typeof msg.text?.body === 'string' ? msg.text.body : '',
        });
      }
    }
  }
  return apply(deps, t, 'WHATSAPP', events, Math.floor(now.getTime() / 1000));
}

interface SmsPayload {
  events?: {
    id?: unknown;
    type?: unknown;
    messageId?: unknown;
    status?: unknown;
    reason?: unknown;
    from?: unknown;
    text?: unknown;
    at?: unknown;
  }[];
}

/**
 * SMS gateway webhook (platform JSON contract, D-059): header
 * `x-lbgos-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` with
 * the webhook secret; the signed timestamp must be within the replay window.
 */
export async function handleSmsWebhook(
  deps: HubDeps,
  integrationId: string,
  raw: Buffer,
  signature: string | undefined,
  now: Date = new Date(),
): Promise<WebhookResult> {
  const t = await webhookTarget(deps, integrationId);
  if (t?.provider !== 'sms_dlt_json') return deny(404);
  const s = secretFields(t.secret, ['webhookSecret']);
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(signature ?? '');
  if (!s || !m) return deny(401);
  const signedAt = Number(m[1]);
  const nowSec = Math.floor(now.getTime() / 1000);
  if (!safeEqual(String(m[2]), hmac(s.webhookSecret, `${String(m[1])}.${raw.toString('utf8')}`))) return deny(401);
  if (Math.abs(nowSec - signedAt) > REPLAY_WINDOW_SECONDS) return deny(401);
  let body: SmsPayload;
  try {
    body = JSON.parse(raw.toString('utf8')) as SmsPayload;
  } catch {
    return deny(401);
  }
  const events: Event[] = [];
  for (const e of body.events ?? []) {
    if (typeof e.id !== 'string' || e.id === '') continue;
    const at = typeof e.at === 'number' ? e.at : signedAt;
    if (e.type === 'status' && typeof e.messageId === 'string' && typeof e.status === 'string') {
      events.push({
        key: `event:${e.id}`,
        kind: 'STATUS',
        at,
        ref: e.messageId,
        status: e.status,
        ...(typeof e.reason === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.reason) ? { reason: `SMS_${e.reason}` } : {}),
      });
    } else if (e.type === 'inbound' && typeof e.from === 'string' && typeof e.text === 'string') {
      events.push({ key: `event:${e.id}`, kind: 'INBOUND', at, from: e.from, text: e.text });
    }
  }
  return apply(deps, t, 'SMS', events, nowSec);
}
