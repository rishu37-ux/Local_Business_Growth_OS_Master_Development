// Provider adapters (FR-HUB-1, D-056). Business logic depends only on these
// interfaces. Every category has a mock adapter (development and tests only:
// it contacts nothing and says so). `custom_rest` can only test a REST/JSON
// endpoint through the guarded client; operations need a provider-specific
// adapter. 7.6 adds the WhatsApp Cloud API adapter (Meta's documented Graph
// API; tested only against a local mock of it) and a DLT-aware SMS adapter
// speaking a platform-defined JSON contract (D-059).
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
  'MARKETPLACE',
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
  /** Non-secret provider configuration (WhatsApp IDs, DLT entity and headers). */
  readonly config: Readonly<Record<string, unknown>>;
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
  /** Sends one business-initiated message as a provider template; `ok` = accepted, with the provider's reference. */
  sendMessage?(call: AdapterCall, req: SendRequest): Promise<AdapterResult<{ readonly providerMessageId: string }>>;
  /** Reads the provider's templates (WhatsApp); SMS DLT templates are entered as registered. */
  syncTemplates?(call: AdapterCall): Promise<AdapterResult<readonly ProviderTemplate[]>>;
  /** Marketplace (11.2): sets the sellable quantity of each SKU on the channel. */
  pushInventory?(
    call: AdapterCall,
    items: readonly InventoryItem[],
  ): Promise<AdapterResult<{ readonly rejected: readonly { readonly sku: string; readonly code: string }[] }>>;
  /** Marketplace (11.3): orders created or changed since the cursor, and the next cursor. */
  fetchOrders?(
    call: AdapterCall,
    cursor: string | null,
  ): Promise<AdapterResult<{ readonly orders: readonly FeedOrder[]; readonly cursor: string | null }>>;
}

export interface InventoryItem {
  readonly sku: string;
  readonly quantity: number;
  readonly pricePaise: number;
}

/** An order as a marketplace reports it (never trusted for anything but its own content). */
export interface FeedOrder {
  readonly id: string;
  readonly status: 'NEW' | 'CANCELLED';
  readonly placedAt: string;
  readonly lines: readonly {
    readonly sku: string;
    readonly quantity: number;
    readonly unitPricePaise: number | null;
  }[];
}

export interface SendRequest {
  readonly messageId: string;
  /** E.164 with "+". */
  readonly to: string;
  readonly purpose: 'MARKETING' | 'TRANSACTIONAL';
  readonly template: {
    readonly name: string;
    readonly language: string;
    readonly params: readonly string[];
    /** SMS: the DLT template ID and the full text. */
    readonly dltTemplateId?: string | null;
    readonly text: string;
  };
}

export interface ProviderTemplate {
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: string;
  readonly body: string;
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
    provider: 'whatsapp_cloud',
    name: 'WhatsApp Business Platform (Cloud API)',
    categories: ['MESSAGING'],
    authMethods: ['BEARER'],
    needsBaseUrl: true,
    mock: false,
    note: 'Meta Graph API, e.g. https://graph.facebook.com/v21.0 (check the current version). Credential: JSON with accessToken, appSecret and verifyToken. Approved templates only for business-initiated messages.',
  },
  {
    provider: 'sms_dlt_json',
    name: 'SMS gateway (DLT, JSON)',
    categories: ['SMS'],
    authMethods: ['API_KEY'],
    needsBaseUrl: true,
    mock: false,
    note: 'A gateway accepting the platform JSON contract (D-059) with DLT entity, header and template IDs. Credential: JSON with apiKey and webhookSecret.',
  },
  {
    provider: 'marketplace_json',
    name: 'Marketplace connector (JSON)',
    categories: ['MARKETPLACE'],
    authMethods: ['API_KEY'],
    needsBaseUrl: true,
    mock: false,
    note: 'A connector for one marketplace (e.g. a service linked to your Amazon or Flipkart seller account) that accepts the platform JSON contract (D-070): POST /v1/inventory and GET /v1/orders. Credential: JSON with apiKey. Amazon and Flipkart are not contacted directly.',
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
    // The mock marketplace is keyed by config.store, so a test can tell two channels apart.
    pushInventory: (call, items) => {
      const failed = failFor(call) ?? mockMarketplace.failure(call);
      if (failed) return Promise.resolve(failed);
      mockMarketplace.pushes.push({ label: cfg(call, 'store'), items: [...items] });
      return Promise.resolve({ ok: true, value: { rejected: [] }, units: 1 });
    },
    fetchOrders: (call, cursor) => {
      const failed = failFor(call) ?? mockMarketplace.failure(call);
      if (failed) return Promise.resolve(failed);
      const all = mockMarketplace.orders.get(cfg(call, 'store')) ?? [];
      const from = cursor ? Number(cursor) : 0;
      return Promise.resolve({
        ok: true,
        value: { orders: all.slice(from), cursor: String(all.length) },
        units: 1,
      });
    },
    generateText: (call, req) => {
      const failed = failFor(call);
      if (failed) return Promise.resolve(failed);
      const agent = mockAgentStep(call.modelId, req.input);
      if (agent !== null) {
        const units = Math.min(req.maxUnits, Math.ceil((req.input.length + agent.length) / 4));
        return Promise.resolve({ ok: true, value: { text: agent }, units, costPaise: units });
      }
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

/**
 * The mock "model" for agent runs (protocol 1, D-061): it replies with one
 * JSON step. Tests script it through the question: each `[[call tool {json}]]`
 * is called in turn, then it answers with a suggestion quoting the first fact
 * value. Without directives it calls the agent's first tool once. Model IDs:
 * `mock-agent-loop` calls the first tool forever (limits), `mock-agent-bad`
 * replies with plain text (invalid output), `mock-agent-invent` answers with a
 * figure that is in no tool result.
 */
function mockAgentStep(modelId: string | null, input: string): string | null {
  let data: {
    agentProtocol?: number;
    question?: string;
    tools?: { name?: string }[];
    history?: { tool?: string; facts?: { value?: string }[] }[];
  };
  try {
    data = JSON.parse(input) as typeof data;
  } catch {
    return null;
  }
  if (data.agentProtocol !== 1) return null;
  const tools = (data.tools ?? []).map((t) => t.name ?? '');
  const history = data.history ?? [];
  if (modelId === 'mock-agent-bad') return 'I think the stock is fine.';
  if (modelId === 'mock-agent-loop') return JSON.stringify({ tool: tools[0] ?? '', arguments: {} });
  const directives = [...(data.question ?? '').matchAll(/\[\[call ([a-z_]+) (\{.*?\})\]\]/g)].map((m) => ({
    tool: m[1] ?? '',
    args: m[2] ?? '{}',
  }));
  const next = directives[history.length];
  if (next) {
    let args: unknown;
    try {
      args = JSON.parse(next.args);
    } catch {
      args = {};
    }
    return JSON.stringify({ tool: next.tool, arguments: args });
  }
  if (directives.length === 0 && history.length === 0) return JSON.stringify({ tool: tools[0] ?? '', arguments: {} });
  const first = history.flatMap((h) => h.facts ?? [])[0]?.value ?? 'no figures';
  const extra = modelId === 'mock-agent-invent' ? ' Sales will reach ₹99,999 next week.' : '';
  return JSON.stringify({ final: { suggestions: `Based on your records: ${first}.${extra}` } });
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
  if (provider === 'whatsapp_cloud') return whatsappCloudAdapter();
  if (provider === 'sms_dlt_json') return smsDltAdapter();
  if (provider === 'marketplace_json') return marketplaceJsonAdapter();
  return null;
}

// ---------------------------------------------------------------------------
// Messaging channels (7.6)
// ---------------------------------------------------------------------------

/** A channel credential is JSON; returns the named string fields or null. */
export function secretFields<K extends string>(secret: string | null, keys: readonly K[]): Record<K, string> | null {
  if (!secret) return null;
  let v: unknown;
  try {
    v = JSON.parse(secret);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const f = (v as Record<string, unknown>)[k];
    if (typeof f !== 'string' || f === '') return null;
    out[k] = f;
  }
  return out;
}

const cfg = (call: AdapterCall, key: string) => {
  const v = call.config[key];
  return typeof v === 'string' ? v : '';
};

async function jsonRequest(
  call: AdapterCall,
  url: string,
  init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: unknown } | AdapterFailure> {
  try {
    const res = await guardedRequest(url, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      timeoutMs: call.timeoutMs,
      maxBytes: 512 * 1024,
      allowedPorts: call.allowedPort ? [call.allowedPort] : [],
      ...(call.outbound ?? {}),
    });
    let json: unknown = null;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof OutboundError) {
      return { ok: false, code: err.code, retryable: err.code === 'TIMEOUT' || err.code === 'NETWORK_ERROR' };
    }
    return { ok: false, code: 'ADAPTER_ERROR', retryable: false };
  }
}

const httpFailure = (status: number, code: string): AdapterFailure => ({
  ok: false,
  code: code.slice(0, 40),
  retryable: status === 429 || status >= 500,
});

/** Graph API error code, e.g. {"error":{"code":131026}} → WA_131026. */
const graphError = (status: number, json: unknown): AdapterFailure => {
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  // 130429/131048/131056 are Meta's rate-limit codes: retryable.
  const rate = code === 130429 || code === 131048 || code === 131056;
  const f = httpFailure(status, typeof code === 'number' ? `WA_${String(code)}` : `HTTP_${String(status)}`);
  return rate ? { ...f, retryable: true } : f;
};

const base = (call: AdapterCall) => (call.baseUrl ?? '').replace(/\/+$/, '');

/**
 * WhatsApp Business Platform, Cloud API (Graph API). Business-initiated
 * messages are template messages (POST /{phone-number-id}/messages with
 * type "template"); templates are read from /{waba-id}/message_templates.
 */
export function whatsappCloudAdapter(): ProviderAdapter {
  const auth = (call: AdapterCall) => {
    const s = secretFields(call.secret, ['accessToken']);
    return s ? { authorization: `Bearer ${s.accessToken}` } : null;
  };
  return {
    provider: 'whatsapp_cloud',
    real: true,
    async test(call) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const url = `${base(call)}/${encodeURIComponent(cfg(call, 'phoneNumberId'))}?fields=display_phone_number,verified_name`;
      const res = await jsonRequest(call, url, { headers });
      if ('ok' in res) return res;
      return res.status === 200 ? { ok: true } : graphError(res.status, res.json);
    },
    async sendMessage(call, req) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const body = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: req.to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: req.template.name,
          language: { code: req.template.language },
          ...(req.template.params.length > 0
            ? {
                components: [{ type: 'body', parameters: req.template.params.map((text) => ({ type: 'text', text })) }],
              }
            : {}),
        },
      };
      const url = `${base(call)}/${encodeURIComponent(cfg(call, 'phoneNumberId'))}/messages`;
      const res = await jsonRequest(call, url, { method: 'POST', headers, body });
      if ('ok' in res) return res;
      if (res.status !== 200) return graphError(res.status, res.json);
      const id = (res.json as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
      if (typeof id !== 'string' || id === '' || id.length > 200) {
        return { ok: false, code: 'NO_MESSAGE_ID', retryable: false };
      }
      return { ok: true, value: { providerMessageId: id }, units: 1 };
    },
    async syncTemplates(call) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const url = `${base(call)}/${encodeURIComponent(cfg(call, 'wabaId'))}/message_templates?fields=name,language,status,category,components&limit=200`;
      const res = await jsonRequest(call, url, { headers });
      if ('ok' in res) return res;
      if (res.status !== 200) return graphError(res.status, res.json);
      const data = (res.json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return { ok: false, code: 'BAD_RESPONSE', retryable: false };
      const out: ProviderTemplate[] = [];
      for (const t of data as Record<string, unknown>[]) {
        const comps = Array.isArray(t.components) ? (t.components as Record<string, unknown>[]) : [];
        const text = comps.find((c) => c.type === 'BODY')?.text;
        if (typeof t.name !== 'string' || typeof t.language !== 'string' || typeof text !== 'string') continue;
        out.push({
          name: t.name,
          language: t.language,
          category: typeof t.category === 'string' ? t.category : '',
          status: typeof t.status === 'string' ? t.status : '',
          body: text,
        });
      }
      return { ok: true, value: out };
    },
  };
}

/**
 * SMS through a gateway that accepts the platform JSON contract (D-059):
 * POST {base}/v1/sms {to, text, category, dlt: {entityId, header, templateId},
 * reference} → {id}. Promotional and transactional traffic use their own
 * registered headers; a message without a DLT template never leaves.
 */
export function smsDltAdapter(): ProviderAdapter {
  const auth = (call: AdapterCall) => {
    const s = secretFields(call.secret, ['apiKey']);
    return s ? { 'x-api-key': s.apiKey } : null;
  };
  return {
    provider: 'sms_dlt_json',
    real: true,
    async test(call) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const res = await jsonRequest(call, `${base(call)}${call.testPath ?? '/v1/account'}`, { headers });
      if ('ok' in res) return res;
      return res.status === 200 ? { ok: true } : httpFailure(res.status, `HTTP_${String(res.status)}`);
    },
    async sendMessage(call, req) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const senders = (call.config.headers ?? {}) as Record<string, string | undefined>;
      const header = senders[req.purpose];
      if (!header) return { ok: false, code: 'DLT_HEADER_MISSING', retryable: false };
      if (!req.template.dltTemplateId) return { ok: false, code: 'NO_DLT_TEMPLATE', retryable: false };
      const body = {
        to: req.to,
        text: req.template.text,
        category: req.purpose === 'MARKETING' ? 'PROMOTIONAL' : 'TRANSACTIONAL',
        dlt: { entityId: cfg(call, 'dltEntityId'), header, templateId: req.template.dltTemplateId },
        reference: req.messageId,
      };
      const res = await jsonRequest(call, `${base(call)}/v1/sms`, { method: 'POST', headers, body });
      if ('ok' in res) return res;
      if (res.status < 200 || res.status >= 300) {
        const code = (res.json as { code?: unknown } | null)?.code;
        return httpFailure(
          res.status,
          typeof code === 'string' && /^[A-Z0-9_]{1,30}$/.test(code) ? `SMS_${code}` : `HTTP_${String(res.status)}`,
        );
      }
      const id = (res.json as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id === '' || id.length > 200) {
        return { ok: false, code: 'NO_MESSAGE_ID', retryable: false };
      }
      return { ok: true, value: { providerMessageId: id }, units: 1 };
    },
  };
}

// ---------------------------------------------------------------------------
// Marketplaces (11.2–11.3)
// ---------------------------------------------------------------------------

const SKU = /^[A-Za-z0-9._/-]{1,60}$/;
const ORDER_ID = /^[A-Za-z0-9._:/-]{1,100}$/;

/** Validates a feed from outside: anything malformed is dropped, never half-applied. */
export function parseFeedOrders(json: unknown): FeedOrder[] | null {
  const list = (json as { orders?: unknown } | null)?.orders;
  if (!Array.isArray(list) || list.length > 500) return null;
  const out: FeedOrder[] = [];
  for (const o of list as unknown[]) {
    const r = o as { id?: unknown; status?: unknown; placedAt?: unknown; lines?: unknown };
    if (typeof r.id !== 'string' || !ORDER_ID.test(r.id)) return null;
    if (r.status !== 'NEW' && r.status !== 'CANCELLED') return null;
    const placed = typeof r.placedAt === 'string' ? new Date(r.placedAt) : null;
    if (!placed || Number.isNaN(placed.getTime())) return null;
    if (!Array.isArray(r.lines) || r.lines.length === 0 || r.lines.length > 100) return null;
    const lines = [];
    for (const l of r.lines as unknown[]) {
      const x = l as { sku?: unknown; quantity?: unknown; unitPricePaise?: unknown };
      if (typeof x.sku !== 'string' || !SKU.test(x.sku)) return null;
      if (!Number.isInteger(x.quantity) || (x.quantity as number) < 1 || (x.quantity as number) > 1000) return null;
      const price =
        x.unitPricePaise === null || x.unitPricePaise === undefined
          ? null
          : Number.isInteger(x.unitPricePaise) && (x.unitPricePaise as number) >= 0
            ? (x.unitPricePaise as number)
            : undefined;
      if (price === undefined) return null;
      lines.push({ sku: x.sku, quantity: x.quantity as number, unitPricePaise: price });
    }
    out.push({ id: r.id, status: r.status, placedAt: placed.toISOString(), lines });
  }
  return out;
}

/**
 * A marketplace connector that accepts the platform JSON contract (D-070):
 * POST {base}/v1/inventory {items: [{sku, quantity, pricePaise}]} →
 *   {rejected: [{sku, code}]};
 * GET {base}/v1/orders?cursor=… → {orders: [FeedOrder], cursor}.
 * Header x-api-key. It is not Amazon's or Flipkart's own API.
 */
export function marketplaceJsonAdapter(): ProviderAdapter {
  const auth = (call: AdapterCall) => {
    const s = secretFields(call.secret, ['apiKey']);
    return s ? { 'x-api-key': s.apiKey } : null;
  };
  return {
    provider: 'marketplace_json',
    real: true,
    async test(call) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const res = await jsonRequest(call, `${base(call)}${call.testPath ?? '/v1/account'}`, { headers });
      if ('ok' in res) return res;
      return res.status === 200 ? { ok: true } : httpFailure(res.status, `HTTP_${String(res.status)}`);
    },
    async pushInventory(call, items) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const res = await jsonRequest(call, `${base(call)}/v1/inventory`, { method: 'POST', headers, body: { items } });
      if ('ok' in res) return res;
      if (res.status < 200 || res.status >= 300) return httpFailure(res.status, `HTTP_${String(res.status)}`);
      const rejected = (res.json as { rejected?: unknown } | null)?.rejected;
      const list = Array.isArray(rejected)
        ? (rejected as { sku?: unknown; code?: unknown }[])
            .filter((r) => typeof r.sku === 'string' && typeof r.code === 'string')
            .map((r) => ({
              sku: String(r.sku),
              code: String(r.code)
                .replace(/[^A-Z0-9_]/g, '_')
                .slice(0, 40),
            }))
        : [];
      return { ok: true, value: { rejected: list }, units: 1 };
    },
    async fetchOrders(call, cursor) {
      const headers = auth(call);
      if (!headers) return { ok: false, code: 'SECRET_INVALID', retryable: false };
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await jsonRequest(call, `${base(call)}/v1/orders${q}`, { headers });
      if ('ok' in res) return res;
      if (res.status !== 200) return httpFailure(res.status, `HTTP_${String(res.status)}`);
      const orders = parseFeedOrders(res.json);
      if (!orders) return { ok: false, code: 'FEED_INVALID', retryable: false };
      const next = (res.json as { cursor?: unknown }).cursor;
      return {
        ok: true,
        value: { orders, cursor: typeof next === 'string' && next.length <= 500 ? next : cursor },
        units: 1,
      };
    },
  };
}

/**
 * The mock marketplace (tests and development only): it records every
 * inventory push and serves the orders a test places, per integration label.
 * Model ID "mock-fail" fails every call; a store in `failing` fails until removed.
 */
export const mockMarketplace = {
  pushes: [] as { label: string; items: InventoryItem[] }[],
  orders: new Map<string, FeedOrder[]>(),
  failing: new Set<string>(),
  failure(call: AdapterCall): AdapterFailure | null {
    return this.failing.has(cfg(call, 'store')) ? { ok: false, code: 'MOCK_UNAVAILABLE', retryable: false } : null;
  },
  place(label: string, order: FeedOrder): void {
    this.orders.set(label, [...(this.orders.get(label) ?? []), order]);
  },
  reset(): void {
    this.pushes.length = 0;
    this.orders.clear();
    this.failing.clear();
  },
};
