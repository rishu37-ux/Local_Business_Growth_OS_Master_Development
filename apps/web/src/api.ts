// Same-origin JSON client. Cookies carry the session; browsers send Origin on
// state-changing requests, which the API checks (CSRF).

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Itemised problems some errors carry (e.g. a refused reminder template). */
  readonly problems: readonly string[];

  constructor(status: number, code: string, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

interface ErrorShape {
  readonly error?: { readonly code?: string; readonly message?: string; readonly problems?: readonly string[] };
  readonly code?: string;
  readonly message?: string;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as (T & ErrorShape) | null;
  if (!res.ok) {
    const code = data?.error?.code ?? data?.code ?? 'ERROR';
    const message = data?.error?.message ?? data?.message ?? 'Something went wrong.';
    throw new ApiError(res.status, code, message, data?.error?.problems ?? []);
  }
  return data as T;
}

export interface Me {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly twoFactorEnabled: boolean;
  readonly mfaRequired: boolean;
  readonly platformAdmin: boolean;
}

/** null when not signed in. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/api/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

// All 28 states and 8 union territories with their GST state codes, sorted by
// name (D-073; the same list as INDIAN_STATES in @lbgos/domain, checked by a test).
export const STATES: readonly (readonly [string, string])[] = [
  ['35', 'Andaman and Nicobar Islands'],
  ['37', 'Andhra Pradesh'],
  ['12', 'Arunachal Pradesh'],
  ['18', 'Assam'],
  ['10', 'Bihar'],
  ['04', 'Chandigarh'],
  ['22', 'Chhattisgarh'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['07', 'Delhi'],
  ['30', 'Goa'],
  ['24', 'Gujarat'],
  ['06', 'Haryana'],
  ['02', 'Himachal Pradesh'],
  ['01', 'Jammu and Kashmir'],
  ['20', 'Jharkhand'],
  ['29', 'Karnataka'],
  ['32', 'Kerala'],
  ['38', 'Ladakh'],
  ['31', 'Lakshadweep'],
  ['23', 'Madhya Pradesh'],
  ['27', 'Maharashtra'],
  ['14', 'Manipur'],
  ['17', 'Meghalaya'],
  ['15', 'Mizoram'],
  ['13', 'Nagaland'],
  ['21', 'Odisha'],
  ['34', 'Puducherry'],
  ['03', 'Punjab'],
  ['08', 'Rajasthan'],
  ['11', 'Sikkim'],
  ['33', 'Tamil Nadu'],
  ['36', 'Telangana'],
  ['16', 'Tripura'],
  ['09', 'Uttar Pradesh'],
  ['05', 'Uttarakhand'],
  ['19', 'West Bengal'],
];

/** "1,500.50" or "1500.5" (rupees) → paise; null if not a valid amount. */
export function rupeesToPaise(text: string): number | null {
  const m = /^(\d{1,11})(?:\.(\d{1,2}))?$/.exec(text.replace(/,/g, '').trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Paise → "₹1,500.50" (Indian digit grouping). */
export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return `${paise < 0 ? '−' : ''}₹${inr.format(Math.abs(paise) / 100)}`;
}

/** Trims "2.000" → "2", "1.500" → "1.5". */
export const formatQty = (q: string): string => q.replace(/\.?0+$/, '') || '0';

/** Uploads a file as the raw request body (the scan route's format). */
export async function uploadFile<T>(path: string, file: Blob): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = (await res.json().catch(() => null)) as (T & ErrorShape) | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'The upload failed.');
  }
  return data as T;
}
