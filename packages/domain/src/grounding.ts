// Deterministic post-check for generated marketing text (FR-AIC-2 AC2,
// D-057). Finds every price, percentage, date and spec value in the text and
// flags those that are not in the facts the text was generated from. It never
// trusts the model: a flagged draft cannot be approved until it is edited or
// each flag is acknowledged by the approver.

export type FlagKind = 'PRICE' | 'PERCENT' | 'DATE' | 'SPEC';

export interface GroundingFlag {
  readonly kind: FlagKind;
  /** As written in the text. */
  readonly text: string;
}

export interface GroundingFacts {
  /** Prices in paise that may appear (selling prices, offer prices, amount discounts). */
  readonly pricesPaise: readonly number[];
  /** Percentages that may appear. */
  readonly percents: readonly number[];
  /** Dates (yyyy-mm-dd) that may appear. */
  readonly dates: readonly string[];
  /** Spec values such as "8GB", "128 GB", "50MP" (compared without spaces, case-insensitive). */
  readonly specs: readonly string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIndex = (m: string) => MONTHS.indexOf(m.slice(0, 3).toLowerCase());

const normSpec = (s: string) => s.replace(/\s+/g, '').replace(/["”]/g, 'inch').toLowerCase();

/** "15,000" / "15000.50" → paise. */
const toPaise = (num: string) => Math.round(Number(num.replace(/,/g, '')) * 100);

const PRICE = /(?:₹|\brs\.?|\binr)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?\/-/gi;
const PERCENT = /(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi;
const SPEC = /\b(\d+(?:\.\d+)?)\s?(gb|tb|mb|mp|mah|w|hz|inch|in|mm|"|”)(?![a-z])/gi;
const DATE_PATTERNS: readonly {
  re: RegExp;
  parse: (m: RegExpMatchArray) => { y: number | null; m: number; d: number };
}[] = [
  // 2026-11-30
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => ({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }) },
  // 30/11/2026, 30-11-2026, 30.11.2026 (Indian day-first)
  {
    re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g,
    parse: (m) => ({ y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) }),
  },
  // 30 Nov 2026, 30 November, 30th Nov
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/gi,
    // The pattern only matches month names, so the index is always found.
    parse: (m) => ({ y: m[3] ? Number(m[3]) : null, m: monthIndex(String(m[2])) + 1, d: Number(m[1]) }),
  },
  // Nov 30, 2026 / November 30
  {
    re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi,
    parse: (m) => ({ y: m[3] ? Number(m[3]) : null, m: monthIndex(String(m[1])) + 1, d: Number(m[2]) }),
  },
];

/** Every price, percentage, date and spec in `text` that the facts do not contain. */
export function groundingCheck(text: string, facts: GroundingFacts): GroundingFlag[] {
  const flags: GroundingFlag[] = [];
  const add = (kind: FlagKind, t: string) => {
    const clean = t.trim();
    if (!flags.some((f) => f.kind === kind && f.text === clean)) flags.push({ kind, text: clean });
  };
  // Spans already taken by a date or a price, so "30 Nov" is not also read as other numbers.
  const used: [number, number][] = [];
  const free = (start: number, end: number) => !used.some(([a, b]) => start < b && end > a);

  for (const { re, parse } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      const p = parse(m);
      used.push([start, end]);
      const ok = facts.dates.some((d) => {
        const [y, mo, da] = d.split('-').map(Number);
        return mo === p.m && da === p.d && (p.y === null || y === p.y);
      });
      if (!ok) add('DATE', m[0]);
    }
  }
  for (const m of text.matchAll(PRICE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    used.push([start, end]);
    // One of the two groups matched: "₹15,000" or "15000/-".
    const paise = toPaise(String(m[1] ?? m[2]));
    if (!facts.pricesPaise.includes(paise)) add('PRICE', m[0]);
  }
  for (const m of text.matchAll(PERCENT)) {
    const start = m.index;
    if (!free(start, start + m[0].length)) continue;
    used.push([start, start + m[0].length]);
    if (!facts.percents.includes(Number(m[1]))) add('PERCENT', m[0]);
  }
  const specs = facts.specs.map(normSpec);
  for (const m of text.matchAll(SPEC)) {
    const start = m.index;
    if (!free(start, start + m[0].length)) continue;
    used.push([start, start + m[0].length]);
    const unit = String(m[2]).toLowerCase();
    const value = normSpec(`${String(m[1])}${unit === 'in' || unit === '"' || unit === '”' ? 'inch' : unit}`);
    if (!specs.includes(value)) add('SPEC', m[0]);
  }
  return flags;
}

/** Text length limits per platform (FR-AIC-4 AC3); SMS is one 160-character segment. */
export const PLATFORM_LIMITS = {
  WHATSAPP: 1024,
  SMS: 160,
  INSTAGRAM: 2200,
  FACEBOOK: 5000,
  GOOGLE_BUSINESS: 1500,
  GENERIC: 2000,
} as const;
export type Platform = keyof typeof PLATFORM_LIMITS;

export const ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Facts for a set of products and an offer: prices, offer prices, percentages, dates, specs. */
export function factsFor(
  products: readonly { readonly pricePaise: number; readonly specs: readonly (string | null)[] }[],
  offer: {
    readonly kind: 'PERCENT' | 'AMOUNT';
    /** Basis points for PERCENT, paise for AMOUNT. */
    readonly value: number;
    readonly validFrom: string;
    readonly validTo: string;
  } | null,
): GroundingFacts {
  const prices = new Set<number>();
  const percents = new Set<number>();
  for (const p of products) {
    prices.add(p.pricePaise);
    if (offer?.kind === 'PERCENT') {
      const off = Math.round((p.pricePaise * (10_000 - offer.value)) / 10_000);
      prices.add(off);
      prices.add(Math.round(off / 100) * 100); // rounded to the rupee
    }
    if (offer?.kind === 'AMOUNT') prices.add(Math.max(0, p.pricePaise - offer.value));
  }
  if (offer?.kind === 'PERCENT') percents.add(offer.value / 100);
  if (offer?.kind === 'AMOUNT') prices.add(offer.value);
  const dates = offer ? [offer.validFrom, offer.validTo] : [];
  const specs = products.flatMap((p) => p.specs.filter((s): s is string => !!s && /\d/.test(s)));
  return { pricesPaise: [...prices], percents: [...percents], dates, specs };
}

/** "30 Nov 2026" for a yyyy-mm-dd date. */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const month = String(MONTHS[Number(m) - 1]);
  return `${String(Number(d))} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${String(y)}`;
}
