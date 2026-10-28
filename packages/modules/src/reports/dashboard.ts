// Dashboard tiles (increment 6.5: FR-LED-3 AC1, FR-INV-7 AC1, D-051). Every
// figure comes from the report functions themselves, so the dashboard always
// equals the reports (AC2). A tile appears only for those allowed to see the
// report it comes from; nothing is labelled profit or cash except as defined.
import { METRICS, type MetricKey } from '@lbgos/domain';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { stockOverview } from '../inventory/index.ts';
import { marginSummary, paymentMethodSummary, receivablesAgeing, salesSummary } from './index.ts';

export interface Tile {
  readonly key: MetricKey;
  readonly label: string;
  readonly definition: string;
  readonly unit: 'paise' | 'count';
  /** Today and this month (business dates) for period figures; `now` for balances and counts. */
  readonly today?: number;
  readonly month?: number;
  readonly now?: number;
  /** The report the figure comes from (for a "details" link). */
  readonly source: string;
}

export interface Dashboard {
  readonly today: string;
  readonly month: { readonly from: string; readonly to: string };
  readonly tiles: readonly Tile[];
}

const tile = (
  key: MetricKey,
  unit: Tile['unit'],
  source: string,
  values: Pick<Tile, 'today' | 'month' | 'now'>,
): Tile => ({
  key,
  label: METRICS[key].label,
  definition: METRICS[key].definition,
  unit,
  source,
  ...values,
});

export async function dashboard(db: Db, ctx: TenantContext, can: (permission: string) => boolean): Promise<Dashboard> {
  const day = { kind: 'day' as const };
  const month = { kind: 'month' as const };
  const tiles: Tile[] = [];
  const todaySales = await salesSummary(db, ctx, day);
  const monthSales = await salesSummary(db, ctx, month);
  if (can('reports.sales.view')) {
    tiles.push(
      tile('netSales', 'paise', 'sales-summary', {
        today: todaySales.current.netSalesPaise,
        month: monthSales.current.netSalesPaise,
      }),
    );
    const cashToday = await paymentMethodSummary(db, ctx, day);
    const cashMonth = await paymentMethodSummary(db, ctx, month);
    tiles.push(
      tile('cashReceived', 'paise', 'payments', { today: cashToday.totals.netPaise, month: cashMonth.totals.netPaise }),
    );
  }
  if (can('reports.financial.view')) {
    const ageing = await receivablesAgeing(db, ctx);
    tiles.push(tile('receivables', 'paise', 'receivables', { now: ageing.totals.totalPaise }));
    tiles.push(tile('customerAdvances', 'paise', 'receivables', { now: ageing.customerAdvancesPaise }));
    const marginToday = await marginSummary(db, ctx, day);
    const marginMonth = await marginSummary(db, ctx, month);
    tiles.push(
      tile('grossMargin', 'paise', 'margin', {
        today: marginToday.grossMarginPaise,
        month: marginMonth.grossMarginPaise,
      }),
    );
  }
  if (can('inventory.view')) {
    const low = await stockOverview(db, ctx, { lowOnly: true, canSeeCost: false });
    tiles.push(tile('lowStock', 'count', 'stock', { now: low.length }));
  }
  if (can('customers.view')) {
    const { rows } = await withTenant(db, ctx, (trx) =>
      sql<{ n: number }>`
        select count(*)::int as n from lbg.reminders r
          join lbg.messages m on m.business_id = r.business_id and m.id = r.message_id
         where r.business_id = ${ctx.businessId} and m.status in ('DRAFT', 'PENDING_APPROVAL')`.execute(trx),
    );
    tiles.push(tile('remindersWaiting', 'count', 'reminders', { now: rows[0]?.n ?? 0 }));
  }
  return {
    today: todaySales.period.from,
    month: { from: monthSales.period.from, to: monthSales.period.to },
    tiles,
  };
}
