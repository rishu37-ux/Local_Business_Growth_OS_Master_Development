// Financial years in the business's timezone (NFR-9, FR-RPT-3, D-012).

/** Calendar year and month (1–12) of `at` as seen in `timeZone`. */
export function localYearMonth(at: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(at);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: value('year'), month: value('month') };
}

/**
 * Financial-year label such as "2026-27" (the format used by invoice series).
 * With fyStartMonth = 4 (India default), 31 March belongs to the previous year.
 */
export function financialYear(at: Date, timeZone: string, fyStartMonth: number): string {
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) throw new Error('invalid fyStartMonth');
  const { year, month } = localYearMonth(at, timeZone);
  const start = month >= fyStartMonth ? year : year - 1;
  // A January start makes the financial year equal the calendar year.
  const end = fyStartMonth === 1 ? start : start + 1;
  return `${start}-${String(end % 100).padStart(2, '0')}`;
}
