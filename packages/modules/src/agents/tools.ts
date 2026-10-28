// Agent tools (increment 8.2: FR-AGT-1, -2, -3, FR-RPT-5, D-061). Each tool
// declares the permission it needs and a strict argument schema; it runs with
// the session's tenant and user, never with anything taken from model output.
// Read tools return deterministic figures as facts with their period and
// source; consequential tools only create approval requests or drafts, and
// recompute any value the model supplies.
import { quantityToMilli, milliToQuantity } from '@lbgos/domain';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { listCampaigns } from '../campaigns/index.ts';
import { adjustStock, stockOverview, type AdjustmentAction } from '../inventory/index.ts';
import { marginSummary, receivablesAgeing, salesSummary } from '../reports/index.ts';
import { generateCaption, listOffers, type StudioDeps } from '../studio/index.ts';
import { createCampaign, submitCampaign } from '../campaigns/index.ts';

export interface Fact {
  readonly label: string;
  /** As shown to people, e.g. "₹1,500.00" or "3". */
  readonly value: string;
  readonly period?: string | undefined;
  readonly source: string;
  /** Machine values for the post-check of the model's text. */
  readonly paise?: number | undefined;
  readonly count?: number | undefined;
}

export interface ToolResult {
  /** A summary stored with the step: IDs, counts and figures, never contact details. */
  readonly summary: Readonly<Record<string, unknown>>;
  readonly facts: readonly Fact[];
  /** Set by consequential tools: what now waits for a human. */
  readonly proposal?: {
    readonly kind: 'APPROVAL_REQUEST' | 'CAMPAIGN' | 'STUDIO_DRAFT';
    readonly id: string;
    readonly effect: string;
  };
}

export class ToolError extends Error {
  readonly code:
    | 'UNKNOWN_TOOL'
    | 'FORBIDDEN'
    | 'FOREIGN_SCOPE'
    | 'INVALID_ARGUMENTS'
    | 'VALUE_MISMATCH'
    | 'NOT_FOUND'
    | 'TOOL_FAILED';

  constructor(code: ToolError['code'], message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export interface ToolContext {
  readonly db: Db;
  readonly studio: StudioDeps;
  readonly ctx: TenantContext;
  readonly permissions: ReadonlySet<string>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly permission: string;
  /** Consequential tools create something a human must approve. */
  readonly consequential: boolean;
  readonly args: z.ZodType;
  run(tc: ToolContext, args: unknown): Promise<ToolResult>;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const rupees = (paise: number) => `${paise < 0 ? '−' : ''}₹${inr.format(Math.abs(paise) / 100)}`;
const money = (label: string, paise: number, source: string, period?: string): Fact => ({
  label,
  value: rupees(paise),
  paise,
  source,
  period,
});
const count = (label: string, n: number, source: string, period?: string): Fact => ({
  label,
  value: String(n),
  count: n,
  source,
  period,
});
const itemName = (r: { productName: string; variantLabel: string; sku: string }) =>
  `${r.productName} ${r.variantLabel}`.trim() || r.sku;
const periodText = (p: { from: string; to: string }) => `${p.from} to ${p.to}`;
const period = z.enum(['day', 'week', 'month']);

const tools: readonly Tool[] = [
  {
    name: 'stock_levels',
    description:
      'Available stock per item (optionally filtered by a search text or to items at or below reorder level).',
    permission: 'inventory.view',
    consequential: false,
    args: z.strictObject({ search: z.string().max(60).optional(), lowOnly: z.boolean().optional() }),
    async run(tc, raw) {
      const a = raw as { search?: string; lowOnly?: boolean };
      const rows = await stockOverview(tc.db, tc.ctx, { search: a.search, lowOnly: a.lowOnly, canSeeCost: false });
      const top = rows.slice(0, 15);
      return {
        summary: {
          items: rows.length,
          rows: top.map((r) => ({ variantId: r.variantId, sku: r.sku, available: r.available, low: r.low })),
        },
        facts: [
          count('Items listed', rows.length, 'Stock levels'),
          ...top.map((r) => ({ label: `Available: ${itemName(r)}`, value: r.available, source: 'Stock levels' })),
        ],
      };
    },
  },
  {
    name: 'low_stock',
    description: 'Items whose available stock is at or below their reorder level.',
    permission: 'inventory.view',
    consequential: false,
    args: z.strictObject({}),
    async run(tc) {
      const rows = await stockOverview(tc.db, tc.ctx, { lowOnly: true, canSeeCost: false });
      return {
        summary: { items: rows.length, rows: rows.slice(0, 15).map((r) => ({ variantId: r.variantId, sku: r.sku })) },
        facts: [
          count('Items at or below reorder level', rows.length, 'Stock levels (reorder level)'),
          ...rows.slice(0, 10).map((r) => ({
            label: `Low: ${itemName(r)}`,
            value: `${r.available} available, reorder level ${String(r.reorderLevel ?? '—')}`,
            source: 'Stock levels (reorder level)',
          })),
        ],
      };
    },
  },
  {
    name: 'sales_summary',
    description:
      'Net sales, gross sales, returns and invoice count for this day, week or month, with the previous period.',
    permission: 'reports.sales.view',
    consequential: false,
    args: z.strictObject({ period }),
    async run(tc, raw) {
      const r = await salesSummary(tc.db, tc.ctx, { kind: (raw as { period: 'day' | 'week' | 'month' }).period });
      const p = periodText(r.period);
      const src = 'Sales summary report';
      return {
        summary: { period: r.period.from + '/' + r.period.to, current: r.current, previous: r.previous },
        facts: [
          money('Net sales', r.current.netSalesPaise, src, p),
          money('Gross sales', r.current.grossSalesPaise, src, p),
          money('Returns', r.current.returnsPaise, src, p),
          count('Invoices', r.current.invoiceCount, src, p),
          money('Net sales, previous period', r.previous.netSalesPaise, src, periodText(r.period.previous)),
        ],
      };
    },
  },
  {
    name: 'margin',
    description: 'Taxable value, cost of goods sold and gross margin for this day, week or month.',
    permission: 'reports.financial.view',
    consequential: false,
    args: z.strictObject({ period }),
    async run(tc, raw) {
      const r = await marginSummary(tc.db, tc.ctx, { kind: (raw as { period: 'day' | 'week' | 'month' }).period });
      const p = periodText(r.period);
      const src = 'Margin report';
      return {
        summary: { taxable: r.taxableValuePaise, cogs: r.cogsPaise, margin: r.grossMarginPaise },
        facts: [
          money('Taxable value', r.taxableValuePaise, src, p),
          money('Cost of goods sold', r.cogsPaise, src, p),
          money('Gross margin', r.grossMarginPaise, src, p),
        ],
      };
    },
  },
  {
    name: 'receivables',
    description: 'Amounts customers owe, by age (0–30, 31–60, 61–90, over 90 days). No names.',
    permission: 'customer_ledger.view',
    consequential: false,
    args: z.strictObject({}),
    async run(tc) {
      const r = await receivablesAgeing(tc.db, tc.ctx);
      const src = `Receivables ageing as of ${r.asOf}`;
      return {
        summary: { customers: r.customers.length, totals: r.totals },
        facts: [
          count('Customers with a balance due', r.customers.length, src),
          money('Total due', r.totals.totalPaise, src),
          money('Due for over 90 days', r.totals['90+'], src),
        ],
      };
    },
  },
  {
    name: 'reminders_due',
    description: 'Reminder messages waiting for review or approval, by type.',
    permission: 'customers.view',
    consequential: false,
    args: z.strictObject({}),
    async run(tc) {
      const rows = await withTenant(
        tc.db,
        tc.ctx,
        async (trx) =>
          (
            await sql<{ kind: string; n: number }>`
            select r.reminder_type as kind, count(*)::int as n from lbg.reminders r
              join lbg.messages m on m.business_id = r.business_id and m.id = r.message_id
             where r.business_id = ${tc.ctx.businessId} and m.status in ('DRAFT', 'PENDING_APPROVAL')
             group by r.reminder_type order by r.reminder_type`.execute(trx)
          ).rows,
      );
      return {
        summary: { byKind: rows },
        facts: rows.map((r) => count(`Reminders waiting: ${r.kind.toLowerCase()}`, r.n, 'Reminders')),
      };
    },
  },
  {
    name: 'catalogue_facts',
    description: 'Catalogue items matching a search text, with selling prices and specifications.',
    permission: 'catalogue.view',
    consequential: false,
    args: z.strictObject({ search: z.string().min(2).max(60) }),
    async run(tc, raw) {
      const rows = await stockOverview(tc.db, tc.ctx, {
        search: (raw as { search: string }).search,
        canSeeCost: false,
      });
      const ids = rows.slice(0, 10).map((r) => r.variantId);
      const prices = await withTenant(
        tc.db,
        tc.ctx,
        async (trx) =>
          (
            await sql<{ id: string; price: string }>`
            select id, selling_price_paise::text as price from lbg.product_variants
             where business_id = ${tc.ctx.businessId} and id = any(${ids}::uuid[])`.execute(trx)
          ).rows,
      );
      return {
        summary: { variantIds: ids },
        facts: rows
          .slice(0, 10)
          .map((r) =>
            money(`Price: ${itemName(r)}`, Number(prices.find((p) => p.id === r.variantId)?.price ?? 0), 'Catalogue'),
          ),
      };
    },
  },
  {
    name: 'offers',
    description: 'Approved offers that have not ended.',
    permission: 'marketing.draft',
    consequential: false,
    args: z.strictObject({}),
    async run(tc) {
      const today = new Date().toISOString().slice(0, 10);
      const list = (await listOffers(tc.db, tc.ctx)).filter((o) => o.status === 'APPROVED' && o.validTo >= today);
      return {
        summary: { offers: list.map((o) => o.id) },
        facts: list.map((o) => ({
          label: `Offer: ${o.title}`,
          value:
            o.discountKind === 'PERCENT' ? `${String(o.discountValue / 100)}% off` : `${rupees(o.discountValue)} off`,
          period: `${o.validFrom} to ${o.validTo}`,
          source: 'Offers',
        })),
      };
    },
  },
  {
    name: 'campaign_results',
    description: 'Campaigns with their status and message counts.',
    permission: 'marketing.draft',
    consequential: false,
    args: z.strictObject({}),
    async run(tc) {
      const list = (await listCampaigns(tc.db, tc.ctx)).slice(0, 10);
      return {
        summary: { campaigns: list.map((c) => ({ id: c.id, status: c.status, counts: c.counts })) },
        facts: list.map((c) => ({
          label: `Campaign: ${c.name}`,
          value: `${c.status.toLowerCase()}, ${String(c.counts.sent)} sent, ${String(c.counts.blocked)} blocked, ${String(c.counts.failed)} failed`,
          source: 'Campaigns',
        })),
      };
    },
  },
  {
    name: 'draft_caption',
    description:
      'Writes a caption draft in the Creative Studio from catalogue items and an approved offer. It is only a draft: a person reviews and approves it there.',
    permission: 'marketing.draft',
    consequential: false,
    args: z.strictObject({
      variantIds: z.array(z.uuid()).min(1).max(5),
      offerId: z.uuid().optional(),
      platform: z.enum(['WHATSAPP', 'SMS', 'INSTAGRAM', 'FACEBOOK', 'GOOGLE_BUSINESS', 'GENERIC']),
    }),
    async run(tc, raw) {
      const a = raw as { variantIds: string[]; offerId?: string; platform: 'WHATSAPP' };
      const out = await generateCaption(tc.studio, tc.ctx, {
        productIds: a.variantIds,
        offerId: a.offerId ?? null,
        platform: a.platform,
      });
      return {
        summary: { draftId: out.draft.id, flags: out.draft.flags.length },
        facts: [],
        proposal: {
          kind: 'STUDIO_DRAFT',
          id: out.draft.id,
          effect: `A caption draft (version 1) waits for review in the Creative Studio${out.draft.flags.length > 0 ? ` with ${String(out.draft.flags.length)} values to check` : ''}.`,
        },
      };
    },
  },
  {
    name: 'propose_campaign',
    description:
      'Prepares a campaign (text, channel, customer tags) and sends it for approval. Nothing is sent until an approver approves and someone sends it.',
    permission: 'marketing.draft',
    consequential: true,
    args: z.strictObject({
      name: z.string().min(1).max(80),
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
      text: z.string().min(1).max(1000),
      tags: z.array(z.string().min(1).max(30)).max(10),
    }),
    async run(tc, raw) {
      const a = raw as { name: string; channel: 'WHATSAPP'; text: string; tags: string[] };
      const c = await createCampaign(tc.db, tc.ctx, {
        name: a.name,
        channel: a.channel,
        body: a.text,
        segmentTags: a.tags,
      });
      await submitCampaign(tc.db, tc.ctx, c.id);
      return {
        summary: { campaignId: c.id, version: c.version },
        facts: [],
        proposal: {
          kind: 'CAMPAIGN',
          id: c.id,
          effect: `Campaign "${a.name}" waits for approval; once approved and sent, it goes only to customers tagged ${a.tags.join(', ') || '(all)'} who agreed to marketing.`,
        },
      };
    },
  },
  {
    name: 'propose_stock_adjustment',
    description:
      'Proposes a stock count correction for a non-serialized item. Give the signed quantity change and the available quantity you expect afterwards; an approver decides.',
    permission: 'inventory.adjust.request',
    consequential: true,
    args: z.strictObject({
      variantId: z.uuid(),
      quantity: z.string().regex(/^-?\d{1,6}(\.\d{1,3})?$/),
      expectedAvailableAfter: z.string().regex(/^-?\d{1,7}(\.\d{1,3})?$/),
      reason: z.string().min(10).max(200),
    }),
    async run(tc, raw) {
      const a = raw as { variantId: string; quantity: string; expectedAvailableAfter: string; reason: string };
      const row = (await stockOverview(tc.db, tc.ctx, { canSeeCost: false })).find((r) => r.variantId === a.variantId);
      if (!row) throw new ToolError('NOT_FOUND', 'No such item in this shop.');
      const signed = (t: string) => (t.startsWith('-') ? -quantityToMilli(t.slice(1)) : quantityToMilli(t));
      const before = signed(row.available);
      const after = before + signed(a.quantity);
      // FR-AGT-2: the model's arithmetic is never trusted.
      if (after !== signed(a.expectedAvailableAfter)) {
        throw new ToolError(
          'VALUE_MISMATCH',
          `The expected quantity is wrong: ${row.available} ${a.quantity.startsWith('-') ? '' : '+'}${a.quantity} is ${milliToQuantity(Math.abs(after))}${after < 0 ? ' below zero' : ''}.`,
        );
      }
      if (after < 0) throw new ToolError('VALUE_MISMATCH', 'Stock cannot go below zero.');
      const action: AdjustmentAction = {
        kind: 'QUANTITY',
        variantId: a.variantId,
        quantity: a.quantity,
        reason: a.reason,
      };
      const effect = `Available stock of ${itemName(row)} goes from ${row.available} to ${milliToQuantity(after)}.`;
      const out = await adjustStock(tc.db, tc.ctx, false, action, undefined, effect);
      if (out.status !== 'PENDING_APPROVAL') throw new ToolError('TOOL_FAILED', 'Expected an approval request.');
      return {
        summary: { approvalRequestId: out.approvalRequestId, variantId: a.variantId, quantity: a.quantity },
        facts: [{ label: `Available now: ${itemName(row)}`, value: row.available, source: 'Stock levels' }],
        proposal: { kind: 'APPROVAL_REQUEST', id: out.approvalRequestId, effect },
      };
    },
  },
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(tools.map((t) => [t.name, t]));

const SCOPE_KEYS = /^(business|tenant|shop)(_?id)?$/i;

/** Validates and runs one tool call as the session's user in the session's business. */
export async function runTool(tc: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.get(name);
  if (!tool) throw new ToolError('UNKNOWN_TOOL', `There is no tool called ${name}.`);
  if (!tc.permissions.has(tool.permission)) {
    throw new ToolError('FORBIDDEN', `You do not hold ${tool.permission}, which ${name} needs.`);
  }
  // FR-AGT-3 AC2: the business comes from the session only.
  if (typeof args === 'object' && args !== null && Object.keys(args).some((k) => SCOPE_KEYS.test(k))) {
    throw new ToolError(
      'FOREIGN_SCOPE',
      'Tools work only in the current business; a business argument is not accepted.',
    );
  }
  const parsed = tool.args.safeParse(args ?? {});
  if (!parsed.success) throw new ToolError('INVALID_ARGUMENTS', 'The arguments do not match the tool.');
  try {
    return await tool.run(tc, parsed.data);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const code = (err as { code?: unknown }).code;
    throw new ToolError(
      code === 'NOT_FOUND' ? 'NOT_FOUND' : 'TOOL_FAILED',
      err instanceof Error ? err.message.slice(0, 200) : 'The tool failed.',
    );
  }
}
