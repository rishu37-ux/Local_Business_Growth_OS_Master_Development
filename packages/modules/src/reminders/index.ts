// Reminders (increment 6.3: FR-REM-1, D-049): birthday, warranty expiry,
// service due and payment due. A run drafts one message per customer and
// subject (idempotent); auto-send is an explicit, approved setting per type,
// and every message still passes the send-time gate and quiet hours (6.2).
import {
  DEFAULT_DAYS,
  DEFAULT_TEMPLATES,
  REMINDER_PURPOSE,
  REMINDER_TYPES,
  renderTemplate,
  templateProblems,
  type MessageChannel,
  type Placeholder,
  type ReminderType,
} from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import {
  createMessageIn,
  dispatchMessage,
  MessagingError,
  type DispatchOutcome,
  type MessageProvider,
} from '../messaging/index.ts';

export class ReminderError extends Error {
  readonly code: 'TEMPLATE_INVALID' | 'AUTO_SEND_NEEDS_APPROVER';
  readonly problems: readonly string[];

  constructor(code: ReminderError['code'], message: string, problems: readonly string[] = []) {
    super(message);
    this.name = 'ReminderError';
    this.code = code;
    this.problems = problems;
  }
}

export interface ReminderSetting {
  readonly type: ReminderType;
  readonly enabled: boolean;
  readonly autoSend: boolean;
  readonly channel: MessageChannel;
  readonly template: string;
  readonly days: number;
  readonly purpose: 'MARKETING' | 'TRANSACTIONAL';
}

interface SettingRow {
  reminder_type: ReminderType;
  enabled: boolean;
  auto_send: boolean;
  channel: MessageChannel;
  template: string;
  days: number;
  auto_send_approved_by: string | null;
}

const defaults = (type: ReminderType): SettingRow => ({
  reminder_type: type,
  enabled: false,
  auto_send: false,
  channel: 'WHATSAPP',
  template: DEFAULT_TEMPLATES[type],
  days: DEFAULT_DAYS[type],
  auto_send_approved_by: null,
});

async function settingsIn(trx: Trx, ctx: TenantContext): Promise<SettingRow[]> {
  const { rows } = await sql<SettingRow>`
    select reminder_type, enabled, auto_send, channel, template, days, auto_send_approved_by
      from lbg.reminder_settings where business_id = ${ctx.businessId}`.execute(trx);
  return REMINDER_TYPES.map((t) => rows.find((r) => r.reminder_type === t) ?? defaults(t));
}

const toSetting = (r: SettingRow): ReminderSetting => ({
  type: r.reminder_type,
  enabled: r.enabled,
  autoSend: r.auto_send,
  channel: r.channel,
  template: r.template,
  days: r.days,
  purpose: REMINDER_PURPOSE[r.reminder_type],
});

export async function reminderSettings(db: Db, ctx: TenantContext): Promise<ReminderSetting[]> {
  return withTenant(db, ctx, async (trx) => (await settingsIn(trx, ctx)).map(toSetting));
}

export interface ReminderSettingInput {
  readonly enabled: boolean;
  readonly autoSend: boolean;
  readonly channel: MessageChannel;
  readonly template: string;
  readonly days: number;
}

/** Saves one type's setting. Turning auto-send on needs `canApprove` (marketing.approve); turning it off does not. */
export async function saveReminderSetting(
  db: Db,
  ctx: TenantContext,
  access: { readonly canApprove: boolean },
  type: ReminderType,
  input: ReminderSettingInput,
  requestId?: string,
): Promise<ReminderSetting> {
  const template = input.template.trim();
  const problems = templateProblems(type, template);
  if (problems.length > 0) throw new ReminderError('TEMPLATE_INVALID', 'The reminder text cannot be used.', problems);
  return withTenant(db, ctx, async (trx) => {
    const current = (await settingsIn(trx, ctx)).find((r) => r.reminder_type === type) ?? defaults(type);
    if (input.autoSend && !current.auto_send && !access.canApprove) {
      throw new ReminderError(
        'AUTO_SEND_NEEDS_APPROVER',
        'Only someone who can approve marketing can turn on auto-send.',
      );
    }
    // Changing the text or channel of an auto-sending reminder also needs an approver (it is a standing approval).
    const changed = template !== current.template || input.channel !== current.channel;
    if (input.autoSend && current.auto_send && changed && !access.canApprove) {
      throw new ReminderError(
        'AUTO_SEND_NEEDS_APPROVER',
        'Only someone who can approve marketing can change an auto-sent reminder.',
      );
    }
    const approvedBy = !input.autoSend
      ? null
      : current.auto_send && !(changed && access.canApprove)
        ? current.auto_send_approved_by
        : ctx.userId;
    const { rows } = await sql<SettingRow>`
      insert into lbg.reminder_settings (business_id, reminder_type, enabled, auto_send, channel, template, days,
                                         auto_send_approved_by, updated_by)
      values (${ctx.businessId}, ${type}, ${input.enabled}, ${input.autoSend}, ${input.channel}, ${template},
              ${input.days}, ${approvedBy}, ${ctx.userId})
      on conflict (business_id, reminder_type) do update
        set enabled = excluded.enabled, auto_send = excluded.auto_send, channel = excluded.channel,
            template = excluded.template, days = excluded.days,
            auto_send_approved_by = excluded.auto_send_approved_by, updated_by = excluded.updated_by, updated_at = now()
      returning reminder_type, enabled, auto_send, channel, template, days, auto_send_approved_by`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('reminder setting upsert returned nothing');
    await recordTenantEvent(trx, ctx, {
      action: 'reminder.settings',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { type, enabled: input.enabled, autoSend: input.autoSend, channel: input.channel, days: input.days },
      ...(requestId ? { requestId } : {}),
    });
    return toSetting(row);
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Candidate {
  readonly customerId: string;
  readonly subjectKey: string;
  readonly dueDate: string;
  readonly values: Partial<Record<Placeholder, string | null>>;
  /** A reason the customer is skipped before rendering (birthday without consent). */
  readonly skip?: 'NO_CONSENT';
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupees = (paise: number) => `₹${inr.format(paise / 100)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "28 Oct 2026". */
const longDate = (d: string) =>
  `${String(Number(d.slice(8, 10)))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''} ${d.slice(0, 4)}`;

/** Not-returned quantity of a sale line (credit notes subtracted). */
const NOT_RETURNED = sql`l.quantity > coalesce((select sum(c.quantity) from lbg.invoice_lines c
                           join lbg.invoices n on n.business_id = c.business_id and n.id = c.invoice_id
                          where c.business_id = l.business_id and c.original_line_id = l.id
                            and n.document_type = 'CREDIT_NOTE' and n.status = 'ISSUED'), 0)`;
const LAST4 = sql`(select right(m.imei, 4) from lbg.serialized_unit_imeis m
                    where m.business_id = l.business_id and m.unit_id = l.unit_id order by m.slot limit 1)`;
/** Days back a run still drafts a reminder whose day has passed (a missed run catches up). */
const CATCH_UP_DAYS = 7;

async function candidates(trx: Trx, ctx: TenantContext, s: SettingRow, today: string): Promise<Candidate[]> {
  const days = s.days;
  switch (s.reminder_type) {
    case 'BIRTHDAY': {
      // Birthday this year (29 Feb → 28 Feb in other years) within [today, today + days].
      const { rows } = await sql<{ id: string; name: string; due: string; consent: string | null }>`
        with b as (
          select c.id, c.name,
                 make_date(y.y, extract(month from c.dob)::int,
                           least(extract(day from c.dob)::int,
                                 extract(day from (make_date(y.y, extract(month from c.dob)::int, 1)
                                                   + interval '1 month - 1 day'))::int)) as due
            from lbg.customers c
            cross join (values (extract(year from ${today}::date)::int), (extract(year from ${today}::date)::int + 1)) y(y)
           where c.business_id = ${ctx.businessId} and c.erased_at is null and c.dob is not null)
        select b.id, b.name, b.due::text as due,
               (select k.status from lbg.customer_consents k
                 where k.business_id = ${ctx.businessId} and k.customer_id = b.id and k.channel = ${s.channel}
                   and k.purpose = 'MARKETING' order by k.recorded_at desc, k.id desc limit 1) as consent
          from b where b.due between ${today}::date and ${today}::date + ${days}::int
         order by b.due, b.id`.execute(trx);
      return rows.map((r) => ({
        customerId: r.id,
        subjectKey: `birthday:${r.id}:${r.due.slice(0, 4)}`,
        dueDate: r.due,
        values: { name: r.name },
        // FR-REM-1 AC1: only with marketing consent.
        ...(r.consent === 'GRANTED' ? {} : { skip: 'NO_CONSENT' as const }),
      }));
    }
    case 'WARRANTY_EXPIRY': {
      const { rows } = await sql<{
        line_id: string;
        customer_id: string;
        name: string;
        model: string;
        last4: string | null;
        due: string;
      }>`
        select * from (
          select l.id as line_id, i.customer_id, c.name, l.description as model, ${LAST4} as last4,
                 (i.invoice_date + make_interval(months => l.warranty_months::int))::date::text as due
            from lbg.invoice_lines l
            join lbg.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
            join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id
           where l.business_id = ${ctx.businessId} and i.status = 'ISSUED'
             and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY') and c.erased_at is null
             and l.warranty_months > 0 and ${NOT_RETURNED}) w
         where w.due::date between ${today}::date and ${today}::date + ${days}::int
         order by w.due, w.line_id`.execute(trx);
      return rows.map((r) => ({
        customerId: r.customer_id,
        subjectKey: `warranty:${r.line_id}`,
        dueDate: r.due,
        values: { name: r.name, model: r.model, imei_last4: r.last4, warranty_end: longDate(r.due) },
      }));
    }
    case 'SERVICE_DUE': {
      const { rows } = await sql<{
        line_id: string;
        customer_id: string;
        name: string;
        model: string;
        last4: string | null;
        due: string;
      }>`
        select l.id as line_id, i.customer_id, c.name, l.description as model, ${LAST4} as last4,
               (i.invoice_date + ${days}::int)::text as due
          from lbg.invoice_lines l
          join lbg.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
          join lbg.customers c on c.business_id = i.business_id and c.id = i.customer_id
         where l.business_id = ${ctx.businessId} and i.status = 'ISSUED'
           and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY') and c.erased_at is null
           and l.unit_id is not null and ${NOT_RETURNED}
           and i.invoice_date + ${days}::int between ${today}::date - ${CATCH_UP_DAYS}::int and ${today}::date
         order by due, l.id`.execute(trx);
      return rows.map((r) => ({
        customerId: r.customer_id,
        subjectKey: `service:${r.line_id}:${String(days)}`,
        dueDate: r.due,
        values: { name: r.name, model: r.model, imei_last4: r.last4, service_date: longDate(r.due) },
      }));
    }
    case 'PAYMENT_DUE': {
      // One reminder per open invoice once it is `days` old; the amount is the customer's total open balance.
      const { rows } = await sql<{ invoice_id: string; customer_id: string; name: string; due: string; open: string }>`
        with o as (
          select i.id, i.customer_id, i.invoice_date,
                 i.total_paise
                   - coalesce((select sum(a.amount_paise) from lbg.payment_allocations a
                                where a.business_id = i.business_id and a.invoice_id = i.id), 0)
                   - coalesce((select sum(n.total_paise) from lbg.invoices n
                                where n.business_id = i.business_id and n.original_invoice_id = i.id
                                  and n.document_type = 'CREDIT_NOTE' and n.status = 'ISSUED'), 0) as outstanding
            from lbg.invoices i
           where i.business_id = ${ctx.businessId} and i.status = 'ISSUED' and i.customer_id is not null
             and i.document_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY', 'DEBIT_NOTE'))
        select o.id as invoice_id, o.customer_id, c.name, (o.invoice_date + ${days}::int)::text as due,
               (select sum(x.outstanding) from o x where x.customer_id = o.customer_id and x.outstanding > 0)::text as open
          from o join lbg.customers c on c.business_id = ${ctx.businessId} and c.id = o.customer_id
         where o.outstanding > 0 and c.erased_at is null and o.invoice_date + ${days}::int <= ${today}::date
         order by o.invoice_date, o.id`.execute(trx);
      return rows.map((r) => ({
        customerId: r.customer_id,
        subjectKey: `payment:${r.invoice_id}`,
        dueDate: r.due,
        values: { name: r.name, amount_due: rupees(Number(r.open)) },
      }));
    }
  }
}

export type SkipReason = 'NO_CONSENT' | 'MISSING_FIELD' | 'NO_ADDRESS';

export interface ReminderRun {
  readonly runId: string;
  readonly date: string;
  readonly created: readonly { readonly type: ReminderType; readonly customerId: string; readonly messageId: string }[];
  readonly skipped: readonly {
    readonly type: ReminderType;
    readonly customerId: string;
    readonly reason: SkipReason;
    readonly missing?: readonly Placeholder[];
  }[];
  readonly alreadyDrafted: number;
  readonly dispatched: readonly { readonly messageId: string; readonly result: DispatchOutcome }[];
}

/**
 * Runs the enabled reminder types for the business's today. Runs are
 * serialised per business and each subject is drafted once, so running again
 * creates nothing new. Auto-send types are approved by the setting's approver
 * and dispatched through the gate after the run commits.
 */
export async function runReminders(
  db: Db,
  ctx: TenantContext,
  provider: MessageProvider,
  now: Date = new Date(),
): Promise<ReminderRun> {
  const run = await withTenant(db, ctx, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`reminders:${ctx.businessId}`}, 61))`.execute(trx);
    const { rows: b } = await sql<{ today: string; shop: string }>`
      select (${now}::timestamptz at time zone timezone)::date::text as today,
             coalesce(display_name, legal_name) as shop
        from lbg.businesses where id = ${ctx.businessId}`.execute(trx);
    const today = b[0]?.today ?? now.toISOString().slice(0, 10);
    const shop = b[0]?.shop ?? '';
    const runId = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(trx)).rows[0]?.id ?? '';
    const created: { type: ReminderType; customerId: string; messageId: string }[] = [];
    const skipped: { type: ReminderType; customerId: string; reason: SkipReason; missing?: Placeholder[] }[] = [];
    const toDispatch: string[] = [];
    let alreadyDrafted = 0;

    for (const s of await settingsIn(trx, ctx)) {
      if (!s.enabled) continue;
      const type = s.reminder_type;
      const purpose = REMINDER_PURPOSE[type];
      for (const c of await candidates(trx, ctx, s, today)) {
        const exists = await sql`select 1 from lbg.reminders where business_id = ${ctx.businessId}
                                   and reminder_type = ${type} and subject_key = ${c.subjectKey}`.execute(trx);
        if (exists.rows.length > 0) {
          alreadyDrafted++;
          continue;
        }
        if (c.skip) {
          skipped.push({ type, customerId: c.customerId, reason: c.skip });
          continue;
        }
        const text = renderTemplate(s.template, { ...c.values, shop });
        if (!text.ok) {
          skipped.push({ type, customerId: c.customerId, reason: 'MISSING_FIELD', missing: text.missing });
          continue;
        }
        const auto = s.auto_send && s.auto_send_approved_by !== null;
        let messageId: string;
        try {
          messageId = await createMessageIn(
            trx,
            ctx,
            { customerId: c.customerId, channel: s.channel, purpose, body: text.text, origin: 'REMINDER' },
            { queue: auto && purpose === 'TRANSACTIONAL' },
          );
        } catch (err) {
          if (err instanceof MessagingError && err.code === 'NO_ADDRESS') {
            skipped.push({ type, customerId: c.customerId, reason: 'NO_ADDRESS' });
            continue;
          }
          throw err;
        }
        if (auto && purpose === 'MARKETING') {
          // The standing approval given when auto-send was turned on (WORKFLOWS §9 still followed step by step).
          for (const status of ['PENDING_APPROVAL', 'APPROVED', 'QUEUED'] as const) {
            await sql`update lbg.messages set status = ${status},
                             approved_by = coalesce(${status === 'APPROVED' ? s.auto_send_approved_by : null}::uuid,
                                                    approved_by)
                       where business_id = ${ctx.businessId} and id = ${messageId}`.execute(trx);
          }
        }
        if (auto) toDispatch.push(messageId);
        await sql`insert into lbg.reminders (business_id, reminder_type, subject_key, customer_id, due_date, message_id, run_id)
                  values (${ctx.businessId}, ${type}, ${c.subjectKey}, ${c.customerId}, ${c.dueDate}::date,
                          ${messageId}, ${runId})`.execute(trx);
        created.push({ type, customerId: c.customerId, messageId });
      }
    }
    const counts: Record<string, number> = {};
    for (const s of skipped) counts[`${s.type}.${s.reason}`] = (counts[`${s.type}.${s.reason}`] ?? 0) + 1;
    await sql`insert into lbg.reminder_runs (business_id, id, run_date, created_count, skipped, ran_by)
              values (${ctx.businessId}, ${runId}, ${today}::date, ${created.length}, ${JSON.stringify(counts)}::jsonb,
                      ${ctx.userId})`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'reminder.run',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { runId, date: today, created: created.length, skipped: counts, alreadyDrafted },
    });
    return { runId, date: today, created, skipped, alreadyDrafted, toDispatch };
  });

  const dispatched: { messageId: string; result: DispatchOutcome }[] = [];
  for (const id of run.toDispatch) {
    dispatched.push({ messageId: id, result: await dispatchMessage(db, ctx, provider, id, now) });
  }
  return {
    runId: run.runId,
    date: run.date,
    created: run.created,
    skipped: run.skipped,
    alreadyDrafted: run.alreadyDrafted,
    dispatched,
  };
}

export interface Reminder {
  readonly id: string;
  readonly type: ReminderType;
  readonly customerId: string;
  readonly customerName: string;
  readonly dueDate: string;
  readonly messageId: string;
  readonly messageStatus: string;
  readonly body: string;
  readonly createdAt: string;
}

/** Reminders with their message's current status (drafts wait for review). */
export async function listReminders(
  db: Db,
  ctx: TenantContext,
  filter: { readonly type?: ReminderType | undefined; readonly status?: string | undefined } = {},
): Promise<Reminder[]> {
  return withTenant(db, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      reminder_type: ReminderType;
      customer_id: string;
      name: string;
      due_date: string;
      message_id: string;
      status: string;
      body: string;
      created_at: Date;
    }>`
      select r.id, r.reminder_type, r.customer_id, c.name, r.due_date::text as due_date, r.message_id, m.status,
             m.body, r.created_at
        from lbg.reminders r
        join lbg.messages m on m.business_id = r.business_id and m.id = r.message_id
        join lbg.customers c on c.business_id = r.business_id and c.id = r.customer_id
       where r.business_id = ${ctx.businessId}
         ${filter.type ? sql`and r.reminder_type = ${filter.type}` : sql``}
         ${filter.status ? sql`and m.status = ${filter.status}` : sql``}
       order by r.created_at desc, r.id desc limit 500`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      type: r.reminder_type,
      customerId: r.customer_id,
      customerName: r.name,
      dueDate: r.due_date,
      messageId: r.message_id,
      messageStatus: r.status,
      body: r.body,
      createdAt: r.created_at.toISOString(),
    }));
  });
}
