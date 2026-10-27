// Same-origin JSON client. Cookies carry the session; browsers send Origin on
// state-changing requests, which the API checks (CSRF).

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorShape {
  readonly error?: { readonly code?: string; readonly message?: string };
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
    throw new ApiError(res.status, code, message);
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

// GST state codes for the pilot regions (subset; the full list arrives with tax setup in Phase 5).
export const STATES: readonly (readonly [string, string])[] = [
  ['07', 'Delhi'],
  ['09', 'Uttar Pradesh'],
  ['19', 'West Bengal'],
  ['24', 'Gujarat'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['36', 'Telangana'],
];
