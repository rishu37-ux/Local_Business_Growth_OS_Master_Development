// Report periods (FR-RPT-1 AC1, FR-RPT-3). Dates are business-local
// calendar dates "yyyy-mm-dd" (documents already carry their business date),
// so no timezone arithmetic is needed here. Week start: 1 = Monday … 7 = Sunday.

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'fy';

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface Period extends DateRange {
  readonly kind: PeriodKind | 'custom';
  readonly previous: DateRange;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): Date {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`invalid date: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== date) throw new RangeError(`invalid date: ${date}`);
  return d;
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (y: number, m: number, day: number) => fmt(new Date(Date.UTC(y, m, day)));

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** Whole days from `from` to `to` (0 when equal). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

function checkOptions(weekStart: number, fyStartMonth: number): void {
  if (!Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7) throw new RangeError('invalid week start');
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12)
    throw new RangeError('invalid fyStartMonth');
}

function rangeOf(kind: PeriodKind, anchor: string, weekStart: number, fyStartMonth: number): DateRange {
  const d = parse(anchor);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (kind) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1 = Monday … 7 = Sunday
      const from = addDays(anchor, -((iso - weekStart + 7) % 7));
      return { from, to: addDays(from, 6) };
    }
    case 'month':
      return { from: ymd(y, m, 1), to: ymd(y, m + 1, 0) };
    case 'year':
      return { from: ymd(y, 0, 1), to: ymd(y, 11, 31) };
    case 'fy': {
      const startYear = m + 1 >= fyStartMonth ? y : y - 1;
      return { from: ymd(startYear, fyStartMonth - 1, 1), to: ymd(startYear + 1, fyStartMonth - 1, 0) };
    }
  }
}

/** The period of `kind` containing `anchor`, and the period before it. */
export function periodRange(
  kind: PeriodKind,
  anchor: string,
  options: { readonly weekStart: number; readonly fyStartMonth: number },
): Period {
  checkOptions(options.weekStart, options.fyStartMonth);
  const current = rangeOf(kind, anchor, options.weekStart, options.fyStartMonth);
  const previous = rangeOf(kind, addDays(current.from, -1), options.weekStart, options.fyStartMonth);
  return { kind, ...current, previous };
}

/** A custom range; the previous period is the same number of days just before it. */
export function customPeriod(from: string, to: string): Period {
  const length = daysBetween(from, to);
  if (length < 0) throw new RangeError('the end date is before the start date');
  if (length > 3660) throw new RangeError('a report covers at most 10 years');
  const prevTo = addDays(from, -1);
  return { kind: 'custom', from, to, previous: { from: addDays(prevTo, -length), to: prevTo } };
}

/** Days of an invoice outstanding on `asOf`, and its ageing bucket (FR-RPT-1: 0–30, 31–60, 61–90, 90+). */
export function ageingBucket(invoiceDate: string, asOf: string): '0-30' | '31-60' | '61-90' | '90+' {
  const days = Math.max(0, daysBetween(invoiceDate, asOf));
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
