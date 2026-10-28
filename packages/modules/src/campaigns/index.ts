// Campaigns (increment 7.5: FR-AIC-3 AC1, FR-AIC-4 AC2, WORKFLOWS §9, D-058).
// A campaign is one text on one channel to a tag segment. It is approved by a
// marketing.approve holder in its exact version (the DB hashes channel, text
// and segment); any edit is a new version back in DRAFT. Launching creates one
// QUEUED marketing message per eligible recipient; each still passes the 6.2
// send-time gate (consent, suppression, quiet hours) when dispatched, so a
// later opt-out still stops it. Counts are read from the messages themselves.
import { PLATFORM_LIMITS, type MessageChannel } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { dispatchMessage, type DispatchOutcome, type MessageProvider } from '../messaging/index.ts';
import { approvedContentIn } from '../studio/index.ts';

export type CampaignStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'PARTIALLY_FAILED' | 'CANCELLED';

export class CampaignError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'INVALID_STATE'
    | 'DRAFT_NOT_APPROVED'
    | 'DRAFT_CHANGED'
    | 'TOO_LONG'
    | 'SELF_APPROVAL'
    | 'SCHEDULE_INVALID'
    | 'PROVIDER_NOT_CONFIGURED'
    | 'AUDIENCE_EMPTY'
    | 'AUDIENCE_TOO_LARGE';

  constructor(code: CampaignError['code'], message: string) {
    super(message);
    this.name = 'CampaignError';
    this.code = code;
  }
}

/** One campaign is created in one transaction; larger sends wait for a queued job runner. */
export const MAX_RECIPIENTS = 2000;
/** Scheduling horizon. */
export const MAX_SCHEDULE_DAYS = 90;

const LIMITS: Record<MessageChannel, number> = {
  WHATSAPP: PLATFORM_LIMITS.WHATSAPP,
  SMS: PLATFORM_LIMITS.SMS,
  EMAIL: 1000,
};

export interface CampaignCounts {
  readonly recipients: number;
  /** Waiting for dispatch (including quiet hours) or handed to the provider. */
  readonly pending: number;
  /** Accepted by the provider (SENT, DELIVERED or READ). */
  readonly sent: number;
  readonly delivered: number;
  readonly read: number;
  readonly blocked: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly channel: MessageChannel;
  readonly body: string;
  readonly draftId: string | null;
  readonly segmentTags: readonly string[];
  readonly segmentMatch: 'ANY' | 'ALL';
  readonly version: number;
  readonly contentSha256: string;
  readonly status: CampaignStatus;
  readonly statusReason: string | null;
  readonly scheduledAt: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly audienceCount: number | null;
  readonly excludedCount: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly counts: CampaignCounts;
}

interface Row {
  id: string;
  name: string;
  channel: MessageChannel;
  body: string;
  draft_id: string | null;
  segment_tags: string[];
  segment_match: 'ANY' | 'ALL';
  version: number;
  content_sha256: string;
  status: CampaignStatus;
  status_reason: string | null;
  scheduled_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  approved_sha256: string | null;
  audience_count: number | null;
  excluded_count: number | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_by: string;
  created_at: Date;
}
const COLUMNS = sql`id, name, channel, body, draft_id, segment_tags, segment_match, version, content_sha256, status,
                    status_reason, scheduled_at, approved_by, approved_at, approved_sha256, audience_count,
                    excluded_count, started_at, finished_at, created_by, created_at`;

async function rowIn(trx: Trx, ctx: TenantContext, id: string, lock = false): Promise<Row> {
  const { rows } = await sql<Row>`
    select ${COLUMNS} from lbg.campaigns where business_id = ${ctx.businessId} and id = ${id}
    ${lock ? sql`for update` : sql``}`.execute(trx);
  const r = rows[0];
  if (!r) throw new CampaignError('NOT_FOUND', 'Campaign not found.');
  return r;
}

async function countsIn(trx: Trx, ctx: TenantContext, ids: readonly string[]) {
  const { rows } = await sql<{ campaign_id: string; status: string; n: number }>`
    select campaign_id, status, count(*)::int as n from lbg.messages
     where business_id = ${ctx.businessId} and campaign_id = any(${ids}::uuid[])
     group by campaign_id, status`.execute(trx);
  const out = new Map<string, CampaignCounts>();
  for (const id of ids) {
    const by = (s: readonly string[]) =>
      rows.filter((r) => r.campaign_id === id && s.includes(r.status)).reduce((a, r) => a + r.n, 0);
    out.set(id, {
      recipients: by(['QUEUED', 'SUBMITTED', 'SENT', 'DELIVERED', 'READ', 'BLOCKED', 'FAILED', 'CANCELLED']),
      pending: by(['QUEUED', 'SUBMITTED']),
      sent: by(['SENT', 'DELIVERED', 'READ']),
      delivered: by(['DELIVERED', 'READ']),
      read: by(['READ']),
      blocked: by(['BLOCKED']),
      failed: by(['FAILED']),
      cancelled: by(['CANCELLED']),
    });
  }
  return out;
}

const EMPTY: CampaignCounts = {
  recipients: 0,
  pending: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  blocked: 0,
  failed: 0,
  cancelled: 0,
};

const toCampaign = (r: Row, counts: CampaignCounts | undefined): Campaign => ({
  id: r.id,
  name: r.name,
  channel: r.channel,
  body: r.body,
  draftId: r.draft_id,
  segmentTags: r.segment_tags,
  segmentMatch: r.segment_match,
  version: r.version,
  contentSha256: r.content_sha256,
  status: r.status,
  statusReason: r.status_reason,
  scheduledAt: r.scheduled_at?.toISOString() ?? null,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at?.toISOString() ?? null,
  audienceCount: r.audience_count,
  excludedCount: r.excluded_count,
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  counts: counts ?? EMPTY,
});

async function campaignIn(trx: Trx, ctx: TenantContext, id: string): Promise<Campaign> {
  const r = await rowIn(trx, ctx, id);
  return toCampaign(r, (await countsIn(trx, ctx, [id])).get(id));
}

export const getCampaign = (db: Db, ctx: TenantContext, id: string) =>
  withTenant(db, ctx, (trx) => campaignIn(trx, ctx, id));

export async function listCampaigns(db: Db, ctx: TenantContext): Promise<Campaign[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<Row>`
      select ${COLUMNS} from lbg.campaigns where business_id = ${ctx.businessId}
       order by created_at desc, id desc limit 200`.execute(trx);
    const counts = await countsIn(
      trx,
      ctx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toCampaign(r, counts.get(r.id)));
  });
}

// ---------------------------------------------------------------------------
// Audience (segment and eligibility)
// ---------------------------------------------------------------------------

export interface Audience {
  /** Customers matching the segment (not erased). */
  readonly members: number;
  /** Would be sent to now: an address, marketing consent for the channel, not suppressed. */
  readonly eligible: number;
  readonly noAddress: number;
  readonly noConsent: number;
  readonly suppressed: number;
}

interface AudienceRow {
  id: string;
  address: string | null;
  consent: string | null;
  suppressed: boolean;
}

async function audienceRows(trx: Trx, ctx: TenantContext, r: Pick<Row, 'channel' | 'segment_tags' | 'segment_match'>) {
  const address = r.channel === 'EMAIL' ? sql`lower(c.email::text)` : sql`c.mobile_e164`;
  // Tags are matched without regard to case (customer tags keep the case they were typed in).
  const tags = r.segment_tags;
  const matching = sql`(select count(distinct lower(t)) from unnest(c.tags) t where lower(t) = any(${tags}::text[]))`;
  const segment =
    tags.length === 0
      ? sql``
      : r.segment_match === 'ALL'
        ? sql`and ${matching} = ${tags.length}`
        : sql`and ${matching} > 0`;
  const { rows } = await sql<AudienceRow>`
    select c.id, ${address} as address,
           (select cc.status from lbg.customer_consents cc
             where cc.business_id = c.business_id and cc.customer_id = c.id and cc.channel = ${r.channel}
               and cc.purpose = 'MARKETING' order by cc.recorded_at desc, cc.id desc limit 1) as consent,
           coalesce((select s.action = 'SUPPRESS' from lbg.contact_suppressions s
             where s.business_id = c.business_id and s.channel = ${r.channel} and s.address = ${address}
             order by s.recorded_at desc, s.id desc limit 1), false) as suppressed
      from lbg.customers c
     where c.business_id = ${ctx.businessId} and c.erased_at is null ${segment}
     order by c.created_at, c.id
     limit ${MAX_RECIPIENTS + 1}`.execute(trx);
  return rows;
}

function summarise(rows: readonly AudienceRow[]): Audience & { readonly ids: string[] } {
  let noAddress = 0;
  let noConsent = 0;
  let suppressed = 0;
  const ids: string[] = [];
  for (const r of rows) {
    if (!r.address) noAddress++;
    else if (r.suppressed) suppressed++;
    else if (r.consent !== 'GRANTED') noConsent++;
    else ids.push(r.id);
  }
  return { members: rows.length, eligible: ids.length, noAddress, noConsent, suppressed, ids };
}

/** Who the campaign would reach now (the gate checks each message again at dispatch). */
export async function previewAudience(db: Db, ctx: TenantContext, id: string): Promise<Audience> {
  return withTenant(db, ctx, async (trx) => {
    const a = summarise(await audienceRows(trx, ctx, await rowIn(trx, ctx, id)));
    return {
      members: a.members,
      eligible: a.eligible,
      noAddress: a.noAddress,
      noConsent: a.noConsent,
      suppressed: a.suppressed,
    };
  });
}

// ---------------------------------------------------------------------------
// Drafting and approval
// ---------------------------------------------------------------------------

export interface CampaignInput {
  readonly name: string;
  readonly channel: MessageChannel;
  /** Typed text, or taken from an approved Studio caption draft. */
  readonly body?: string | undefined;
  readonly draftId?: string | undefined;
  readonly segmentTags?: readonly string[] | undefined;
  readonly segmentMatch?: 'ANY' | 'ALL' | undefined;
}

const normTags = (tags: readonly string[]) => [
  ...new Set(tags.map((t) => t.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean)),
];

async function bodyFor(trx: Trx, ctx: TenantContext, input: Pick<CampaignInput, 'body' | 'draftId'>) {
  if (input.draftId) {
    const d = await approvedContentIn(trx, ctx, input.draftId).catch(() => {
      throw new CampaignError('DRAFT_NOT_APPROVED', 'The Studio draft is not approved in its current version.');
    });
    if (d.kind !== 'CAPTION' || !d.body) throw new CampaignError('DRAFT_NOT_APPROVED', 'Only a caption can be sent.');
    return d.body;
  }
  const body = input.body?.trim() ?? '';
  if (!body) throw new CampaignError('INVALID_STATE', 'Give the text or an approved Studio draft.');
  return body;
}

export async function createCampaign(db: Db, ctx: TenantContext, input: CampaignInput): Promise<Campaign> {
  const id = await withTenant(db, ctx, async (trx) => {
    const body = await bodyFor(trx, ctx, input);
    const { rows } = await sql<{ id: string }>`
      insert into lbg.campaigns (business_id, name, channel, body, draft_id, segment_tags, segment_match, created_by)
      values (${ctx.businessId}, ${input.name.trim()}, ${input.channel}, ${body}, ${input.draftId ?? null},
              ${normTags(input.segmentTags ?? [])}::text[], ${input.segmentMatch ?? 'ANY'}, ${ctx.userId})
      returning id`.execute(trx);
    const created = rows[0]?.id;
    if (!created) throw new Error('campaign insert returned nothing');
    await recordTenantEvent(trx, ctx, {
      action: 'campaign.create',
      targetType: 'campaign',
      targetId: created,
      metadata: { channel: input.channel },
    });
    return created;
  });
  return getCampaign(db, ctx, id);
}

/** An edit is a new version back in DRAFT; an approval or schedule is cleared (FR-AIC-3 AC1). */
export async function updateCampaign(
  db: Db,
  ctx: TenantContext,
  id: string,
  patch: Partial<CampaignInput>,
): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED'].includes(r.status)) {
      throw new CampaignError('INVALID_STATE', `A ${r.status.toLowerCase()} campaign cannot be edited.`);
    }
    const textChanged = patch.body !== undefined || patch.draftId !== undefined;
    const body = textChanged ? await bodyFor(trx, ctx, patch) : r.body;
    const draftId = textChanged ? (patch.draftId ?? null) : r.draft_id;
    const name = patch.name?.trim() ?? r.name;
    const channel = patch.channel ?? r.channel;
    const tags = patch.segmentTags ? normTags(patch.segmentTags) : r.segment_tags;
    const match = patch.segmentMatch ?? r.segment_match;
    const contentChanged =
      body !== r.body ||
      draftId !== r.draft_id ||
      channel !== r.channel ||
      match !== r.segment_match ||
      tags.join('\u001e') !== r.segment_tags.join('\u001e');
    if (!contentChanged) {
      if (name !== r.name) {
        await sql`update lbg.campaigns set name = ${name} where business_id = ${ctx.businessId} and id = ${id}`.execute(
          trx,
        );
      }
      return;
    }
    await sql`update lbg.campaigns
                 set name = ${name}, channel = ${channel}, body = ${body}, draft_id = ${draftId},
                     segment_tags = ${tags}::text[], segment_match = ${match}, version = version + 1,
                     status = 'DRAFT', status_reason = null, scheduled_at = null,
                     approved_by = null, approved_at = null, approved_sha256 = null
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'campaign.edit',
      targetType: 'campaign',
      targetId: id,
      metadata: { version: r.version + 1, wasApproved: r.approved_sha256 !== null },
    });
  });
  return getCampaign(db, ctx, id);
}

function checkLength(r: Pick<Row, 'channel' | 'body'>) {
  const limit = LIMITS[r.channel];
  if (r.body.length > limit) {
    throw new CampaignError(
      'TOO_LONG',
      `The text has ${String(r.body.length)} characters; ${r.channel} allows ${String(limit)}.`,
    );
  }
}

export async function submitCampaign(db: Db, ctx: TenantContext, id: string): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (r.status !== 'DRAFT') throw new CampaignError('INVALID_STATE', 'Only a draft can be sent for approval.');
    checkLength(r);
    await sql`update lbg.campaigns set status = 'PENDING_APPROVAL', status_reason = null
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
  });
  return getCampaign(db, ctx, id);
}

/**
 * Approval of the exact version the approver reviewed (`contentSha256`). The
 * linked Studio draft must still be approved with the same text. Rule R3: no
 * self-approval while another member could approve.
 */
export async function approveCampaign(
  db: Db,
  ctx: TenantContext,
  id: string,
  contentSha256: string,
): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (r.status !== 'PENDING_APPROVAL')
      throw new CampaignError('INVALID_STATE', 'The campaign is not awaiting approval.');
    if (contentSha256 !== r.content_sha256) {
      throw new CampaignError('DRAFT_CHANGED', 'The campaign differs from what you reviewed. Reload it.');
    }
    checkLength(r);
    if (r.draft_id) {
      const body = await bodyFor(trx, ctx, { draftId: r.draft_id });
      if (body !== r.body) throw new CampaignError('DRAFT_CHANGED', 'The Studio draft changed since it was added.');
    }
    let selfApproved = false;
    if (r.created_by === ctx.userId) {
      const { rows } = await sql<{ id: string }>`
        select lbg.members_with_permission('marketing.approve') as id`.execute(trx);
      if (rows.some((h) => h.id !== ctx.userId)) {
        throw new CampaignError('SELF_APPROVAL', 'Another member must approve your own campaign.');
      }
      selfApproved = true;
    }
    await sql`update lbg.campaigns set status = 'APPROVED', approved_by = ${ctx.userId}, approved_at = now(),
                     approved_sha256 = content_sha256
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'campaign.approve',
      targetType: 'campaign',
      targetId: id,
      metadata: { version: r.version, contentSha256: r.content_sha256, selfApproved },
    });
  });
  return getCampaign(db, ctx, id);
}

export async function returnCampaign(db: Db, ctx: TenantContext, id: string, reason: string): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (r.status !== 'PENDING_APPROVAL')
      throw new CampaignError('INVALID_STATE', 'The campaign is not awaiting approval.');
    await sql`update lbg.campaigns set status = 'DRAFT', status_reason = ${reason.trim().slice(0, 200)}
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
  });
  return getCampaign(db, ctx, id);
}

// ---------------------------------------------------------------------------
// Scheduling, launch, dispatch and completion (FR-AIC-4 AC2)
// ---------------------------------------------------------------------------

export async function scheduleCampaign(
  db: Db,
  ctx: TenantContext,
  id: string,
  at: Date,
  now: Date = new Date(),
): Promise<Campaign> {
  if (at.getTime() <= now.getTime() || at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new CampaignError('SCHEDULE_INVALID', `Choose a time in the next ${String(MAX_SCHEDULE_DAYS)} days.`);
  }
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (r.status !== 'APPROVED' && r.status !== 'SCHEDULED') {
      throw new CampaignError('INVALID_STATE', 'Only an approved campaign can be scheduled.');
    }
    await sql`update lbg.campaigns set status = 'SCHEDULED', scheduled_at = ${at}
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'campaign.schedule',
      targetType: 'campaign',
      targetId: id,
      metadata: { at: at.toISOString() },
    });
  });
  return getCampaign(db, ctx, id);
}

export async function unscheduleCampaign(db: Db, ctx: TenantContext, id: string): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (r.status !== 'SCHEDULED') throw new CampaignError('INVALID_STATE', 'The campaign is not scheduled.');
    await sql`update lbg.campaigns set status = 'APPROVED', scheduled_at = null
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
  });
  return getCampaign(db, ctx, id);
}

/** Cancels a campaign that has not finished; queued messages not yet handed to a provider are cancelled too. */
export async function cancelCampaign(db: Db, ctx: TenantContext, id: string): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (['COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED'].includes(r.status)) {
      throw new CampaignError('INVALID_STATE', `A ${r.status.toLowerCase()} campaign cannot be cancelled.`);
    }
    // Lock order: the campaign, then its messages (dispatch locks a message, then reads nothing of the campaign).
    const { rows } = await sql<{ n: number }>`
      with c as (
        update lbg.messages set status = 'CANCELLED', status_reason = 'CAMPAIGN_CANCELLED'
         where business_id = ${ctx.businessId} and campaign_id = ${id} and status = 'QUEUED' returning 1)
      select count(*)::int as n from c`.execute(trx);
    await sql`update lbg.campaigns set status = 'CANCELLED', finished_at = case when started_at is null then null else now() end
               where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'campaign.cancel',
      targetType: 'campaign',
      targetId: id,
      metadata: { from: r.status, cancelledMessages: rows[0]?.n ?? 0 },
    });
  });
  return getCampaign(db, ctx, id);
}

async function launchIn(trx: Trx, ctx: TenantContext, r: Row, now: Date) {
  const rows = await audienceRows(trx, ctx, r);
  if (rows.length > MAX_RECIPIENTS) {
    throw new CampaignError(
      'AUDIENCE_TOO_LARGE',
      `A campaign can reach at most ${String(MAX_RECIPIENTS)} customers; narrow the segment.`,
    );
  }
  const a = summarise(rows);
  if (a.eligible === 0)
    throw new CampaignError('AUDIENCE_EMPTY', 'No customer in the segment can receive marketing now.');
  await sql`update lbg.campaigns set status = 'RUNNING', started_at = ${now}, audience_count = ${a.members},
                   excluded_count = ${a.members - a.eligible}
             where business_id = ${ctx.businessId} and id = ${r.id}`.execute(trx);
  const address = r.channel === 'EMAIL' ? sql`lower(c.email::text)` : sql`c.mobile_e164`;
  await sql`
    insert into lbg.messages (business_id, customer_id, channel, purpose, origin, campaign_id, to_address, body,
                              status, approved_by, created_by)
    select c.business_id, c.id, ${r.channel}, 'MARKETING', 'CAMPAIGN', ${r.id}, ${address}, ${r.body},
           'QUEUED', ${r.approved_by}, ${ctx.userId}
      from lbg.customers c
     where c.business_id = ${ctx.businessId} and c.id = any(${a.ids}::uuid[])`.execute(trx);
  await recordTenantEvent(trx, ctx, {
    action: 'campaign.launch',
    targetType: 'campaign',
    targetId: r.id,
    metadata: { version: r.version, recipients: a.eligible, excluded: a.members - a.eligible },
  });
}

/**
 * Starts an approved (or scheduled) campaign now and dispatches its messages.
 * Refused while no messaging provider is configured, so no campaign can
 * pretend to run (FR-MSG-4).
 */
export async function launchCampaign(
  db: Db,
  ctx: TenantContext,
  provider: MessageProvider,
  id: string,
  now: Date = new Date(),
): Promise<Campaign> {
  await withTenant(db, ctx, async (trx) => {
    const r = await rowIn(trx, ctx, id, true);
    if (!(provider.select?.(r.channel) ?? provider).configured) {
      throw new CampaignError(
        'PROVIDER_NOT_CONFIGURED',
        'Connect and test a messaging provider before sending a campaign.',
      );
    }
    if (r.status !== 'APPROVED' && r.status !== 'SCHEDULED') {
      throw new CampaignError('INVALID_STATE', 'Only an approved campaign can be sent.');
    }
    await launchIn(trx, ctx, r, now);
  });
  await dispatchCampaign(db, ctx, provider, id, now);
  return getCampaign(db, ctx, id);
}

/** Marks a running campaign finished once no message is waiting: PARTIALLY_FAILED when any failed. */
async function settleIn(trx: Trx, ctx: TenantContext, id: string, now: Date) {
  const r = await rowIn(trx, ctx, id, true);
  if (r.status !== 'RUNNING') return;
  const c = (await countsIn(trx, ctx, [id])).get(id) ?? EMPTY;
  if (c.pending > 0) return;
  const status = c.failed > 0 ? 'PARTIALLY_FAILED' : 'COMPLETED';
  await sql`update lbg.campaigns set status = ${status}, finished_at = ${now},
                   status_reason = ${c.failed > 0 ? `${String(c.failed)} of ${String(c.recipients)} failed` : null}
             where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
}

/** Dispatches the campaign's queued messages that are due (quiet hours defer them), then settles it. */
export async function dispatchCampaign(
  db: Db,
  ctx: TenantContext,
  provider: MessageProvider,
  id: string,
  now: Date = new Date(),
): Promise<{ readonly id: string; readonly result: DispatchOutcome }[]> {
  const { rows } = await withTenant(db, ctx, (trx) =>
    sql<{ id: string }>`
      select id from lbg.messages
       where business_id = ${ctx.businessId} and campaign_id = ${id} and status = 'QUEUED'
         and (not_before is null or not_before <= ${now})
       order by created_at, id`.execute(trx),
  );
  const out: { id: string; result: DispatchOutcome }[] = [];
  for (const m of rows) out.push({ id: m.id, result: await dispatchMessage(db, ctx, provider, m.id, now) });
  await withTenant(db, ctx, (trx) => settleIn(trx, ctx, id, now));
  return out;
}

/**
 * The job runner's step for one business: starts scheduled campaigns that are
 * due, dispatches every running campaign's due messages and settles them. A
 * due campaign that cannot start (no provider, nobody eligible) stays
 * scheduled with the reason recorded.
 */
export async function runDueCampaigns(
  db: Db,
  ctx: TenantContext,
  provider: MessageProvider,
  now: Date = new Date(),
): Promise<{ readonly started: string[]; readonly notStarted: { id: string; reason: string }[] }> {
  const due = await withTenant(db, ctx, (trx) =>
    sql<{ id: string }>`
      select id from lbg.campaigns
       where business_id = ${ctx.businessId} and status = 'SCHEDULED' and scheduled_at <= ${now}
       order by scheduled_at, id`.execute(trx),
  );
  const started: string[] = [];
  const notStarted: { id: string; reason: string }[] = [];
  for (const { id } of due.rows) {
    try {
      await withTenant(db, ctx, async (trx) => {
        const r = await rowIn(trx, ctx, id, true);
        if (!(provider.select?.(r.channel) ?? provider).configured) {
          throw new CampaignError('PROVIDER_NOT_CONFIGURED', 'No messaging provider is configured.');
        }
        if (r.status === 'SCHEDULED') await launchIn(trx, ctx, r, now);
      });
      started.push(id);
    } catch (e) {
      if (!(e instanceof CampaignError)) throw e;
      notStarted.push({ id, reason: e.code });
      await withTenant(db, ctx, (trx) =>
        sql`update lbg.campaigns set status_reason = ${e.code}
             where business_id = ${ctx.businessId} and id = ${id} and status = 'SCHEDULED'`.execute(trx),
      );
    }
  }
  const running = await withTenant(db, ctx, (trx) =>
    sql<{ id: string }>`
      select id from lbg.campaigns where business_id = ${ctx.businessId} and status = 'RUNNING'
       order by started_at, id`.execute(trx),
  );
  for (const { id } of running.rows) await dispatchCampaign(db, ctx, provider, id, now);
  return { started, notStarted };
}
