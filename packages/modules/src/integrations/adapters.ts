// Provider adapters (FR-HUB-1, D-056). Business logic depends only on these
// interfaces. Every category has a mock adapter (development and tests only:
// it contacts nothing and says so). `custom_rest` can only test a REST/JSON
// endpoint through the guarded client; operations need a provider-specific
// adapter. Real provider adapters are added only with evidence (7.6).
import { guardedRequest, OutboundError, type OutboundOptions } from '../outbound/index.ts';

export const CATEGORIES = [
  'MESSAGING',
  'SMS',
  'EMAIL',
  'LLM',
  'IMAGE_VIDEO',
  'OCR',
  'STORAGE',
  'PAYMENTS',
  'SOCIAL',
] as const;
export type Category = (typeof CATEGORIES)[number];
export type AuthMethod = 'NONE' | 'API_KEY' | 'BEARER' | 'OAUTH2_CLIENT_CREDENTIALS';

/** What an adapter is given for one call: the configuration and the opened secret (never logged). */
export interface AdapterCall {
  readonly provider: string;
  readonly authMethod: AuthMethod;
  readonly baseUrl: string | null;
  readonly tokenUrl: string | null;
  readonly testPath: string | null;
  readonly allowedPort: number | null;
  readonly scopes: readonly string[];
  readonly modelId: string | null;
  readonly timeoutMs: number;
  readonly secret: string | null;
  /** DNS/transport injection for tests; production uses the system resolver and https. */
  readonly outbound?: Pick<OutboundOptions, 'resolver' | 'transport'> | undefined;
}

export interface AdapterFailure {
  readonly ok: false;
  readonly code: string;
  readonly retryable: boolean;
}

export type AdapterResult<T = undefined> =
  | ({ readonly ok: true; readonly units?: number; readonly costPaise?: number | null } & (T extends undefined
      ? object
      : { readonly value: T }))
  | AdapterFailure;

export interface TextGeneration {
  readonly text: string;
}
export interface ImageGeneration {
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png';
}

export interface ProviderAdapter {
  readonly provider: string;
  /** Whether it really contacts a provider (false for mocks). */
  readonly real: boolean;
  /** A harmless call proving the configuration works (FR-HUB-4 AC1). */
  test(call: AdapterCall): Promise<AdapterResult>;
  generateText?(
    call: AdapterCall,
    req: { readonly system: string; readonly input: string; readonly maxUnits: number },
  ): Promise<AdapterResult<TextGeneration>>;
  generateImage?(
    call: AdapterCall,
    req: { readonly prompt: string; readonly aspect: string },
  ): Promise<AdapterResult<ImageGeneration>>;
}

/** A provider the hub offers: which categories, auth methods and fields it uses. */
export interface ProviderSpec {
  readonly provider: string;
  readonly name: string;
  readonly categories: readonly Category[];
  readonly authMethods: readonly AuthMethod[];
  readonly needsBaseUrl: boolean;
  readonly mock: boolean;
  readonly note: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    provider: 'mock',
    name: 'Test adapter',
    categories: CATEGORIES,
    authMethods: ['NONE', 'API_KEY'],
    needsBaseUrl: false,
    mock: true,
    note: 'Development and automated tests only. Contacts nothing; results are synthetic.',
  },
  {
    provider: 'custom_rest',
    name: 'Custom REST/JSON endpoint',
    categories: ['LLM', 'IMAGE_VIDEO', 'SMS', 'EMAIL', 'PAYMENTS', 'SOCIAL'],
    authMethods: ['API_KEY', 'BEARER', 'OAUTH2_CLIENT_CREDENTIALS'],
    needsBaseUrl: true,
    mock: false,
    note: 'Connection test only (GET on the test path through the guarded client). Operations need a provider adapter.',
  },
];

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/**
 * Deterministic: the "model" writes a caption from the structured input
 * (`{"products":[{"name","price"}],"offer":{...},"shop":...}`). Model IDs
 * steer test scenarios: `mock-invent` adds a price and a date that are not
 * in the input (to exercise the grounding check), `mock-fail` fails, and
 * `mock-flaky-N` fails N times before succeeding (retry policy).
 */
export function mockAdapter(): ProviderAdapter {
  const flaky = new Map<string, number>();
  const failFor = (call: AdapterCall): AdapterFailure | null => {
    if (call.modelId === 'mock-fail') return { ok: false, code: 'MOCK_FAILURE', retryable: false };
    const m = /^mock-flaky-(\d)$/.exec(call.modelId ?? '');
    if (m) {
      const key = call.modelId ?? '';
      const n = flaky.get(key) ?? 0;
      flaky.set(key, n + 1);
      if (n < Number(m[1])) return { ok: false, code: 'MOCK_TEMPORARY', retryable: true };
    }
    return null;
  };
  return {
    provider: 'mock',
    real: false,
    test: (call) => Promise.resolve(failFor(call) ?? { ok: true }),
    generateText: (call, req) => {
      const failed = failFor(call);
      if (failed) return Promise.resolve(failed);
      let data: {
        products?: { name?: string; price?: string }[];
        offer?: { title?: string; discount?: string; validTo?: string } | null;
        shop?: string;
      } = {};
      try {
        data = JSON.parse(req.input) as typeof data;
      } catch {
        data = {};
      }
      const products = (data.products ?? []).map((p) => `${p.name ?? ''} at ${p.price ?? ''}`).join(' and ');
      const offer = data.offer
        ? ` ${data.offer.title ?? ''}: ${data.offer.discount ?? ''} off until ${data.offer.validTo ?? ''}.`
        : '';
      let text = `New at ${data.shop ?? 'our shop'}: ${products}.${offer} Visit us today!`;
      if (call.modelId === 'mock-invent') text += ' Only ₹999 and 50% off till 31 Dec 2099!';
      const units = Math.min(req.maxUnits, Math.ceil(text.length / 4));
      return Promise.resolve({ ok: true, value: { text }, units, costPaise: units });
    },
    generateImage: (call) => {
      const failed = failFor(call);
      if (failed) return Promise.resolve(failed);
      return Promise.resolve({
        ok: true,
        value: { bytes: PNG_1X1, contentType: 'image/png' },
        units: 1,
        costPaise: 200,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Custom REST (connection test only)
// ---------------------------------------------------------------------------

const authHeaders = async (call: AdapterCall): Promise<Record<string, string> | AdapterResult> => {
  if (call.authMethod === 'NONE') return {};
  if (!call.secret) return { ok: false, code: 'SECRET_MISSING', retryable: false };
  if (call.authMethod === 'API_KEY') return { 'x-api-key': call.secret };
  if (call.authMethod === 'BEARER') return { authorization: `Bearer ${call.secret}` };
  // OAuth2 client credentials: the secret is "client_id:client_secret".
  const sep = call.secret.indexOf(':');
  if (!call.tokenUrl || sep < 1) return { ok: false, code: 'OAUTH_CONFIG_INVALID', retryable: false };
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: call.secret.slice(0, sep),
    client_secret: call.secret.slice(sep + 1),
    ...(call.scopes.length > 0 ? { scope: call.scopes.join(' ') } : {}),
  }).toString();
  const res = await guardedRequest(call.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    timeoutMs: call.timeoutMs,
    maxBytes: 64 * 1024,
    allowedPorts: call.allowedPort ? [call.allowedPort] : [],
    ...(call.outbound ?? {}),
  });
  if (res.status < 200 || res.status >= 300)
    return { ok: false, code: `TOKEN_HTTP_${String(res.status)}`, retryable: res.status >= 500 };
  let token: unknown;
  try {
    token = (JSON.parse(res.body.toString('utf8')) as { access_token?: unknown }).access_token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || token === '') return { ok: false, code: 'TOKEN_MISSING', retryable: false };
  return { authorization: `Bearer ${token}` };
};

export function customRestAdapter(): ProviderAdapter {
  return {
    provider: 'custom_rest',
    real: true,
    async test(call) {
      if (!call.baseUrl) return { ok: false, code: 'BASE_URL_MISSING', retryable: false };
      try {
        const headers = await authHeaders(call);
        if ('ok' in headers) return headers as AdapterResult;
        const url = new URL(call.testPath ?? '/', call.baseUrl).toString();
        const res = await guardedRequest(url, {
          headers: { ...headers, accept: 'application/json' },
          timeoutMs: call.timeoutMs,
          maxBytes: 64 * 1024,
          allowedPorts: call.allowedPort ? [call.allowedPort] : [],
          ...(call.outbound ?? {}),
        });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        return { ok: false, code: `HTTP_${String(res.status)}`, retryable: res.status >= 500 || res.status === 429 };
      } catch (err) {
        if (err instanceof OutboundError) {
          return { ok: false, code: err.code, retryable: err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR' };
        }
        return { ok: false, code: 'ADAPTER_ERROR', retryable: false };
      }
    },
  };
}

/** The adapter for a provider; mocks only when allowed (never in production). */
export function adapterFor(provider: string, allowMocks: boolean): ProviderAdapter | null {
  if (provider === 'mock') return allowMocks ? mockAdapter() : null;
  if (provider === 'custom_rest') return customRestAdapter();
  return null;
}
