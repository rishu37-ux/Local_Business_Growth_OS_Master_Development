// The API & Integrations Hub (increment 7.3: FR-HUB-1, -2, -4, -6, FR-SUB-3
// AC1–2, WORKFLOWS §10, D-056). Configuration is stored here; credentials go
// to the secret store (7.2) and are opened only for a call. Every test and
// call is recorded with result, latency, units and cost; quotas stop calls.
import { channelConfigProblem, templateBodyValid, whatsappPurpose, type TemplatePurpose } from '@lbgos/domain';
import { sql } from 'kysely';
import { SYSTEM_ACTOR, withTenant, type Db, type TenantContext, type Trx } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { checkTarget, OutboundError, type OutboundOptions } from '../outbound/index.ts';
import { assertQuotaIn, QuotaError, quotaNoticesIn } from '../quotas/index.ts';
import { readSecretValue, revokeSecret, rotateSecret, storeSecret, type Keyring } from '../secrets/index.ts';
import {
  adapterFor,
  CATEGORIES,
  PROVIDERS,
  type AdapterCall,
  type AdapterResult,
  type AuthMethod,
  type Category,
  type ProviderAdapter,
} from './adapters.ts';

export {
  adapterFor,
  CATEGORIES,
  customRestAdapter,
  mockAdapter,
  PROVIDERS,
  secretFields,
  smsDltAdapter,
  whatsappCloudAdapter,
  type ProviderTemplate,
  type SendRequest,
  type AdapterCall,
  type AdapterResult,
  type AuthMethod,
  type Category,
  type ImageGeneration,
  type ProviderAdapter,
  type ProviderSpec,
  type TextGeneration,
} from './adapters.ts';

export type IntegrationStatus = 'PLANNED' | 'CONFIGURED' | 'TESTED' | 'VERIFIED' | 'FAILED' | 'DISABLED' | 'REVOKED';

export class IntegrationError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'PROVIDER_UNKNOWN'
    | 'CATEGORY_NOT_SUPPORTED'
    | 'AUTH_NOT_SUPPORTED'
    | 'BASE_URL_REQUIRED'
    | 'ENDPOINT_NOT_ALLOWED'
    | 'SECRET_REQUIRED'
    | 'INVALID_STATE'
    | 'NOT_CONFIGURED'
    | 'QUOTA_EXCEEDED'
    | 'CONFIG_INVALID'
    | 'OPERATION_NOT_SUPPORTED'
    | 'TEMPLATE_INVALID'
    | 'SYNC_FAILED';
  readonly detail: string | undefined;

  constructor(code: IntegrationError['code'], message: string, detail?: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.detail = detail;
  }
}

/** What the hub needs besides the databases. */
export interface HubDeps {
  readonly appDb: Db;
  /** Secrets role pool and keys; null when the secret store is not configured. */
  readonly secrets: { readonly db: Db; readonly keyring: Keyring } | null;
  /** Mock adapters are offered outside production only. */
  readonly allowMocks: boolean;
  readonly outbound?: Pick<OutboundOptions, 'resolver' | 'transport'> | undefined;
  /** Base delay of the exponential retry backoff (ms); default 500. */
  readonly retryBaseMs?: number | undefined;
}

export interface Integration {
  readonly id: string;
  readonly category: Category;
  readonly provider: string;
  readonly label: string;
  readonly owner: 'TENANT' | 'PLATFORM';
  readonly authMethod: AuthMethod;
  readonly baseUrl: string | null;
  readonly tokenUrl: string | null;
  readonly testPath: string | null;
  readonly allowedPort: number | null;
  readonly scopes: readonly string[];
  readonly modelId: string | null;
  readonly monthlyUnitLimit: number | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** Non-secret provider configuration. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly secretId: string | null;
  readonly status: IntegrationStatus;
  readonly statusReason: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
}

interface Row {
  id: string;
  category: Category;
  provider: string;
  label: string;
  owner: 'TENANT' | 'PLATFORM';
  auth_method: AuthMethod;
  base_url: string | null;
  token_url: string | null;
  test_path: string | null;
  allowed_port: number | null;
  scopes: string[];
  model_id: string | null;
  monthly_unit_limit: number | null;
  timeout_ms: number;
  max_retries: number;
  config: Record<string, unknown>;
  secret_id: string | null;
  status: IntegrationStatus;
  status_reason: string | null;
  last_success_at: Date | null;
  last_error_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}

const COLUMNS = sql`id, category, provider, label, owner, auth_method, base_url, token_url, test_path, allowed_port, scopes,
                    model_id, monthly_unit_limit, timeout_ms, max_retries, config, secret_id, status, status_reason,
                    last_success_at, last_error_at, last_error_code, created_at`;

const toIntegration = (r: Row): Integration => ({
  id: r.id,
  category: r.category,
  provider: r.provider,
  label: r.label,
  owner: r.owner,
  authMethod: r.auth_method,
  baseUrl: r.base_url,
  tokenUrl: r.token_url,
  testPath: r.test_path,
  allowedPort: r.allowed_port,
  scopes: r.scopes,
  modelId: r.model_id,
  monthlyUnitLimit: r.monthly_unit_limit,
  timeoutMs: r.timeout_ms,
  maxRetries: r.max_retries,
  config: r.config,
  secretId: r.secret_id,
  status: r.status,
  statusReason: r.status_reason,
  lastSuccessAt: r.last_success_at?.toISOString() ?? null,
  lastErrorAt: r.last_error_at?.toISOString() ?? null,
  lastErrorCode: r.last_error_code,
  createdAt: r.created_at.toISOString(),
});

async function rowIn(trx: Trx, ctx: TenantContext, id: string, lock = false): Promise<Row> {
  const { rows } = await sql<Row>`select ${COLUMNS} from lbg.integrations
                                   where business_id = ${ctx.businessId} and id = ${id} ${lock ? sql`for update` : sql``}`.execute(
    trx,
  );
  const r = rows[0];
  if (!r) throw new IntegrationError('NOT_FOUND', 'Integration not found.');
  return r;
}

export function providers(allowMocks: boolean) {
  return PROVIDERS.filter((p) => allowMocks || !p.mock);
}

/** Endpoint checks at save time (the guarded client checks again on every request). */
async function checkEndpoint(deps: HubDeps, url: string | null | undefined, port: number | null | undefined) {
  if (!url) return;
  try {
    await checkTarget(url, {
      allowedPorts: port ? [port] : [],
      ...(deps.outbound?.resolver ? { resolver: deps.outbound.resolver } : {}),
    });
  } catch (err) {
    if (err instanceof OutboundError) {
      throw new IntegrationError('ENDPOINT_NOT_ALLOWED', 'This endpoint is not allowed.', err.code);
    }
    throw err;
  }
}

export interface IntegrationInput {
  readonly category: Category;
  readonly provider: string;
  readonly label: string;
  readonly authMethod: AuthMethod;
  readonly baseUrl?: string | null | undefined;
  readonly tokenUrl?: string | null | undefined;
  readonly testPath?: string | null | undefined;
  readonly allowedPort?: number | null | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly modelId?: string | null | undefined;
  readonly monthlyUnitLimit?: number | null | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  /** Non-secret provider configuration (checked per provider). */
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  /** The credential; stored sealed, never returned. */
  readonly secret?: string | undefined;
}

export async function createIntegration(
  deps: HubDeps,
  ctx: TenantContext,
  input: IntegrationInput,
  requestId?: string,
): Promise<Integration> {
  const spec = providers(deps.allowMocks).find((p) => p.provider === input.provider);
  if (!spec) throw new IntegrationError('PROVIDER_UNKNOWN', 'This provider is not available.');
  if (!spec.categories.includes(input.category)) {
    throw new IntegrationError('CATEGORY_NOT_SUPPORTED', 'This provider does not offer that category.');
  }
  if (!spec.authMethods.includes(input.authMethod)) {
    throw new IntegrationError('AUTH_NOT_SUPPORTED', 'This provider does not support that sign-in method.');
  }
  if (spec.needsBaseUrl && !input.baseUrl)
    throw new IntegrationError('BASE_URL_REQUIRED', 'An https base URL is required.');
  if (input.authMethod === 'OAUTH2_CLIENT_CREDENTIALS' && !input.tokenUrl) {
    throw new IntegrationError('BASE_URL_REQUIRED', 'A token URL is required for OAuth2 client credentials.');
  }
  const problem = channelConfigProblem(input.provider, input.config ?? {});
  if (problem) throw new IntegrationError('CONFIG_INVALID', problem);
  await checkEndpoint(deps, input.baseUrl, input.allowedPort);
  await checkEndpoint(deps, input.tokenUrl, input.allowedPort);
  const secretInfo =
    input.secret && input.authMethod !== 'NONE'
      ? await storeSecret(
          deps.appDb,
          deps.secrets?.keyring ?? null,
          ctx,
          { purpose: 'integration', label: input.label, value: input.secret },
          requestId ? { requestId } : {},
        )
      : null;
  const configured = input.authMethod === 'NONE' || secretInfo !== null;
  return withTenant(deps.appDb, ctx, async (trx) => {
    const { rows } = await sql<Row>`
      insert into lbg.integrations (business_id, category, provider, label, auth_method, base_url, token_url, test_path,
                                    allowed_port, scopes, model_id, monthly_unit_limit, timeout_ms, max_retries,
                                    config, secret_id, status, created_by)
      values (${ctx.businessId}, ${input.category}, ${input.provider}, ${input.label.trim()}, ${input.authMethod},
              ${input.baseUrl ?? null}, ${input.tokenUrl ?? null}, ${input.testPath ?? null}, ${input.allowedPort ?? null},
              ${[...(input.scopes ?? [])]}::text[], ${input.modelId ?? null}, ${input.monthlyUnitLimit ?? null},
              ${input.timeoutMs ?? 15_000}, ${input.maxRetries ?? 3}, ${JSON.stringify(input.config ?? {})}::jsonb,
              ${secretInfo?.id ?? null},
              ${configured ? 'CONFIGURED' : 'PLANNED'}, ${ctx.userId})
      returning ${COLUMNS}`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('integration insert returned nothing');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.create',
      targetType: 'integration',
      targetId: row.id,
      metadata: {
        category: row.category,
        provider: row.provider,
        authMethod: row.auth_method,
        secret: secretInfo !== null,
      },
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

export async function listIntegrations(appDb: Db, ctx: TenantContext): Promise<Integration[]> {
  return withTenant(appDb, ctx, async (trx) => {
    const { rows } = await sql<Row>`select ${COLUMNS} from lbg.integrations where business_id = ${ctx.businessId}
                                     order by created_at desc, id limit 200`.execute(trx);
    return rows.map(toIntegration);
  });
}

/** One integration; viewing its configuration is audited (FR-HUB-3 AC4). */
export async function getIntegration(
  appDb: Db,
  ctx: TenantContext,
  id: string,
  requestId?: string,
): Promise<Integration> {
  return withTenant(appDb, ctx, async (trx) => {
    const row = await rowIn(trx, ctx, id);
    await recordTenantEvent(trx, ctx, {
      action: 'integration.view',
      targetType: 'integration',
      targetId: id,
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

export type IntegrationPatch = Partial<
  Pick<
    IntegrationInput,
    | 'label'
    | 'baseUrl'
    | 'tokenUrl'
    | 'testPath'
    | 'allowedPort'
    | 'scopes'
    | 'modelId'
    | 'monthlyUnitLimit'
    | 'timeoutMs'
    | 'maxRetries'
    | 'config'
  >
>;

/** Configuration changes; a tested integration must be tested again. */
export async function updateIntegration(
  deps: HubDeps,
  ctx: TenantContext,
  id: string,
  patch: IntegrationPatch,
  requestId?: string,
): Promise<Integration> {
  await checkEndpoint(deps, patch.baseUrl, patch.allowedPort);
  await checkEndpoint(deps, patch.tokenUrl, patch.allowedPort);
  return withTenant(deps.appDb, ctx, async (trx) => {
    const cur = await rowIn(trx, ctx, id, true);
    if (cur.status === 'REVOKED') throw new IntegrationError('INVALID_STATE', 'A revoked integration cannot change.');
    const m = {
      label: (patch.label ?? cur.label).trim(),
      baseUrl: patch.baseUrl === undefined ? cur.base_url : patch.baseUrl,
      tokenUrl: patch.tokenUrl === undefined ? cur.token_url : patch.tokenUrl,
      testPath: patch.testPath === undefined ? cur.test_path : patch.testPath,
      allowedPort: patch.allowedPort === undefined ? cur.allowed_port : patch.allowedPort,
      scopes: [...(patch.scopes ?? cur.scopes)],
      modelId: patch.modelId === undefined ? cur.model_id : patch.modelId,
      limit: patch.monthlyUnitLimit === undefined ? cur.monthly_unit_limit : patch.monthlyUnitLimit,
      timeoutMs: patch.timeoutMs ?? cur.timeout_ms,
      maxRetries: patch.maxRetries ?? cur.max_retries,
      config: patch.config ?? cur.config,
    };
    const problem = channelConfigProblem(cur.provider, m.config);
    if (problem) throw new IntegrationError('CONFIG_INVALID', problem);
    const retest = ['TESTED', 'VERIFIED', 'FAILED'].includes(cur.status);
    const { rows } = await sql<Row>`
      update lbg.integrations
         set label = ${m.label}, base_url = ${m.baseUrl}, token_url = ${m.tokenUrl}, test_path = ${m.testPath},
             allowed_port = ${m.allowedPort}, scopes = ${m.scopes}::text[], model_id = ${m.modelId},
             monthly_unit_limit = ${m.limit}, timeout_ms = ${m.timeoutMs}, max_retries = ${m.maxRetries},
             config = ${JSON.stringify(m.config)}::jsonb, status = ${retest ? 'CONFIGURED' : cur.status},
             status_reason = ${retest ? 'Configuration changed; test again.' : cur.status_reason}
       where business_id = ${ctx.businessId} and id = ${id}
      returning ${COLUMNS}`.execute(trx);
    const row = rows[0];
    if (!row) throw new IntegrationError('NOT_FOUND', 'Integration not found.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.update',
      targetType: 'integration',
      targetId: id,
      metadata: { fields: Object.keys(patch), retest },
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

/** Stores or rotates the credential (the old one is revoked); the integration must be tested again. */
export async function setIntegrationSecret(
  deps: HubDeps,
  ctx: TenantContext,
  id: string,
  value: string,
  requestId?: string,
): Promise<Integration> {
  const cur = await withTenant(deps.appDb, ctx, (trx) => rowIn(trx, ctx, id));
  if (cur.status === 'REVOKED') throw new IntegrationError('INVALID_STATE', 'A revoked integration cannot change.');
  if (cur.auth_method === 'NONE') throw new IntegrationError('INVALID_STATE', 'This integration uses no credential.');
  const keyring = deps.secrets?.keyring ?? null;
  const info = cur.secret_id
    ? await rotateSecret(deps.appDb, keyring, ctx, cur.secret_id, value, requestId)
    : await storeSecret(
        deps.appDb,
        keyring,
        ctx,
        { purpose: 'integration', label: cur.label, value },
        requestId ? { requestId } : {},
      );
  return withTenant(deps.appDb, ctx, async (trx) => {
    // PLANNED/TESTED/VERIFIED/FAILED → CONFIGURED; a disabled integration stays disabled.
    const next: IntegrationStatus = cur.status === 'DISABLED' ? 'DISABLED' : 'CONFIGURED';
    const { rows } = await sql<Row>`
      update lbg.integrations set secret_id = ${info.id}, status = ${next},
             status_reason = ${next === 'CONFIGURED' ? 'Credential changed; test again.' : cur.status_reason}
       where business_id = ${ctx.businessId} and id = ${id}
      returning ${COLUMNS}`.execute(trx);
    const row = rows[0];
    if (!row) throw new IntegrationError('NOT_FOUND', 'Integration not found.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.secret',
      targetType: 'integration',
      targetId: id,
      metadata: { secretId: info.id, rotated: cur.secret_id !== null },
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

async function setStatus(
  trx: Trx,
  ctx: TenantContext,
  id: string,
  status: IntegrationStatus,
  reason: string | null,
  extra = sql``,
): Promise<Row> {
  const { rows } = await sql<Row>`
    update lbg.integrations set status = ${status}, status_reason = ${reason} ${extra}
     where business_id = ${ctx.businessId} and id = ${id}
    returning ${COLUMNS}`.execute(trx);
  const row = rows[0];
  if (!row) throw new IntegrationError('NOT_FOUND', 'Integration not found.');
  return row;
}

export async function disableIntegration(
  appDb: Db,
  ctx: TenantContext,
  id: string,
  requestId?: string,
): Promise<Integration> {
  return withTenant(appDb, ctx, async (trx) => {
    const cur = await rowIn(trx, ctx, id, true);
    if (cur.status === 'REVOKED' || cur.status === 'DISABLED') {
      throw new IntegrationError('INVALID_STATE', `The integration is already ${cur.status.toLowerCase()}.`);
    }
    const row = await setStatus(trx, ctx, id, 'DISABLED', 'Disabled by a user.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.disable',
      targetType: 'integration',
      targetId: id,
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

export async function enableIntegration(
  appDb: Db,
  ctx: TenantContext,
  id: string,
  requestId?: string,
): Promise<Integration> {
  return withTenant(appDb, ctx, async (trx) => {
    const cur = await rowIn(trx, ctx, id, true);
    if (cur.status !== 'DISABLED')
      throw new IntegrationError('INVALID_STATE', 'Only a disabled integration can be enabled.');
    const row = await setStatus(trx, ctx, id, 'CONFIGURED', 'Enabled again; test before use.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.enable',
      targetType: 'integration',
      targetId: id,
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

/** Revokes the credential (sealed material destroyed) and ends the integration. */
export async function revokeIntegration(
  appDb: Db,
  ctx: TenantContext,
  id: string,
  requestId?: string,
): Promise<Integration> {
  const cur = await withTenant(appDb, ctx, (trx) => rowIn(trx, ctx, id));
  if (cur.status === 'REVOKED') throw new IntegrationError('INVALID_STATE', 'The integration is already revoked.');
  if (cur.secret_id) {
    try {
      await revokeSecret(appDb, ctx, cur.secret_id, requestId);
    } catch (err) {
      if ((err as { code?: string }).code !== 'REVOKED') throw err;
    }
  }
  return withTenant(appDb, ctx, async (trx) => {
    const row = await setStatus(trx, ctx, id, 'REVOKED', 'Revoked; the credential was destroyed.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.revoke',
      targetType: 'integration',
      targetId: id,
      ...(requestId ? { requestId } : {}),
    });
    return toIntegration(row);
  });
}

// ---------------------------------------------------------------------------
// Calls: quota, retries, recording (FR-HUB-2 retry policy, FR-HUB-4, FR-SUB-3)
// ---------------------------------------------------------------------------

export interface Usage {
  readonly monthUnits: number;
  readonly monthCostPaise: number;
  readonly limit: number | null;
  /** 0–100+, null without a limit. */
  readonly percent: number | null;
  readonly warning: boolean;
  readonly stopped: boolean;
}

async function usageIn(trx: Trx, ctx: TenantContext, row: Pick<Row, 'id' | 'monthly_unit_limit'>): Promise<Usage> {
  const { rows } = await sql<{ units: string; cost: string }>`
    select coalesce(sum(c.units), 0) as units, coalesce(sum(coalesce(c.cost_paise, c.estimated_cost_paise, 0)), 0) as cost
      from lbg.integration_calls c join lbg.businesses b on b.id = c.business_id
     where c.business_id = ${ctx.businessId} and c.integration_id = ${row.id} and c.kind = 'CALL'
       and date_trunc('month', c.at at time zone b.timezone) = date_trunc('month', now() at time zone b.timezone)`.execute(
    trx,
  );
  const units = Number(rows[0]?.units ?? 0);
  const limit = row.monthly_unit_limit;
  const percent = limit === null ? null : Math.floor((units * 100) / limit);
  return {
    monthUnits: units,
    monthCostPaise: Number(rows[0]?.cost ?? 0),
    limit,
    percent,
    warning: percent !== null && percent >= 80,
    stopped: percent !== null && percent >= 100,
  };
}

export interface Health {
  readonly lastSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly calls24h: number;
  readonly errors24h: number;
  /** Errors / calls over the last 24 hours (0–1), null without calls. */
  readonly errorRate24h: number | null;
  readonly usage: Usage;
  readonly recent: readonly {
    readonly kind: string;
    readonly purpose: string;
    readonly ok: boolean;
    readonly latencyMs: number | null;
    readonly errorCode: string | null;
    readonly units: number;
    readonly at: string;
  }[];
}

export async function integrationHealth(appDb: Db, ctx: TenantContext, id: string): Promise<Health> {
  return withTenant(appDb, ctx, async (trx) => {
    const row = await rowIn(trx, ctx, id);
    const { rows: agg } = await sql<{ n: number; errors: number }>`
      select count(*)::int as n, count(*) filter (where not ok)::int as errors from lbg.integration_calls
       where business_id = ${ctx.businessId} and integration_id = ${id} and at > now() - interval '24 hours'`.execute(
      trx,
    );
    const { rows: recent } = await sql<{
      kind: string;
      purpose: string;
      ok: boolean;
      latency_ms: number | null;
      error_code: string | null;
      units: number;
      at: Date;
    }>`select kind, purpose, ok, latency_ms, error_code, units, at from lbg.integration_calls
        where business_id = ${ctx.businessId} and integration_id = ${id} order by at desc, id limit 20`.execute(trx);
    const n = agg[0]?.n ?? 0;
    const errors = agg[0]?.errors ?? 0;
    return {
      lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      lastErrorAt: row.last_error_at?.toISOString() ?? null,
      lastErrorCode: row.last_error_code,
      calls24h: n,
      errors24h: errors,
      errorRate24h: n === 0 ? null : errors / n,
      usage: await usageIn(trx, ctx, row),
      recent: recent.map((r) => ({
        kind: r.kind,
        purpose: r.purpose,
        ok: r.ok,
        latencyMs: r.latency_ms,
        errorCode: r.error_code,
        units: r.units,
        at: r.at.toISOString(),
      })),
    };
  });
}

async function recordCall(
  db: Db,
  ctx: TenantContext,
  row: Row,
  rec: {
    readonly kind: 'TEST' | 'CALL';
    readonly purpose: string;
    readonly ok: boolean;
    readonly latencyMs: number;
    readonly errorCode: string | null;
    readonly units: number;
    readonly estimatedCostPaise: number | null;
    readonly costPaise: number | null;
  },
  nextStatus: { readonly status: IntegrationStatus; readonly reason: string | null } | null,
): Promise<Row> {
  return withTenant(db, ctx, async (trx) => {
    await sql`insert into lbg.integration_calls (business_id, integration_id, kind, purpose, ok, latency_ms, error_code, units,
                                                 estimated_cost_paise, cost_paise, user_id)
              values (${ctx.businessId}, ${row.id}, ${rec.kind}, ${rec.purpose}, ${rec.ok}, ${rec.latencyMs},
                      ${rec.errorCode}, ${rec.units}, ${rec.estimatedCostPaise}, ${rec.costPaise}, ${ctx.userId})`.execute(
      trx,
    );
    const health = rec.ok
      ? sql`, last_success_at = now()`
      : sql`, last_error_at = now(), last_error_code = ${rec.errorCode}`;
    if (!nextStatus) {
      const { rows } = await sql<Row>`update lbg.integrations set status = status ${health}
                                       where business_id = ${ctx.businessId} and id = ${row.id} returning ${COLUMNS}`.execute(
        trx,
      );
      return rows[0] ?? row;
    }
    if (nextStatus.status === 'TESTED' && row.status === 'FAILED') {
      await setStatus(trx, ctx, row.id, 'CONFIGURED', null);
    }
    return setStatus(trx, ctx, row.id, nextStatus.status, nextStatus.reason, health);
  });
}

async function openCall(deps: HubDeps, ctx: TenantContext, row: Row): Promise<AdapterCall> {
  let secret: string | null = null;
  if (row.auth_method !== 'NONE') {
    if (!row.secret_id || !deps.secrets) {
      throw new IntegrationError('SECRET_REQUIRED', 'The credential is missing or the secret store is not configured.');
    }
    secret = await readSecretValue(deps.secrets.db, deps.secrets.keyring, ctx, row.secret_id);
  }
  return {
    provider: row.provider,
    authMethod: row.auth_method,
    baseUrl: row.base_url,
    tokenUrl: row.token_url,
    testPath: row.test_path,
    allowedPort: row.allowed_port,
    scopes: row.scopes,
    modelId: row.model_id,
    timeoutMs: row.timeout_ms,
    config: row.config,
    secret,
    outbound: deps.outbound,
  };
}

/** Runs `fn` with up to `maxRetries` retries on retryable failures (exponential backoff). */
async function withRetries<T>(
  maxRetries: number,
  baseMs: number,
  fn: () => Promise<AdapterResult<T>>,
): Promise<{ result: AdapterResult<T>; attempts: number }> {
  let attempts = 0;
  for (;;) {
    attempts++;
    const result = await fn();
    if (result.ok || !result.retryable || attempts > maxRetries) return { result, attempts };
    await new Promise((r) => setTimeout(r, baseMs * 2 ** (attempts - 1)));
  }
}

/** "Test connection" (FR-HUB-4 AC1): `TESTED` only on success; the result and latency are recorded. */
export async function testIntegration(
  deps: HubDeps,
  ctx: TenantContext,
  id: string,
  requestId?: string,
): Promise<{
  readonly integration: Integration;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly errorCode: string | null;
}> {
  const row = await withTenant(deps.appDb, ctx, (trx) => rowIn(trx, ctx, id));
  if (!['CONFIGURED', 'TESTED', 'VERIFIED', 'FAILED'].includes(row.status)) {
    throw new IntegrationError('INVALID_STATE', `A ${row.status.toLowerCase()} integration cannot be tested.`);
  }
  const adapter = adapterFor(row.provider, deps.allowMocks);
  if (!adapter) throw new IntegrationError('PROVIDER_UNKNOWN', 'No adapter is available for this provider.');
  const call = await openCall(deps, ctx, row);
  const started = performance.now();
  const { result } = await withRetries(0, 0, () => adapter.test(call));
  const latencyMs = Math.round(performance.now() - started);
  const errorCode = result.ok ? null : result.code.slice(0, 40).replace(/[^A-Z0-9_]/g, '_');
  const next = result.ok
    ? row.status === 'VERIFIED'
      ? null
      : { status: 'TESTED' as const, reason: null }
    : { status: 'FAILED' as const, reason: `Test failed: ${errorCode ?? ''}` };
  const updated = await recordCall(
    deps.appDb,
    ctx,
    row,
    {
      kind: 'TEST',
      purpose: 'connection.test',
      ok: result.ok,
      latencyMs,
      errorCode,
      units: 0,
      estimatedCostPaise: null,
      costPaise: null,
    },
    next,
  );
  await withTenant(deps.appDb, ctx, (trx) =>
    recordTenantEvent(trx, ctx, {
      action: 'integration.test',
      targetType: 'integration',
      targetId: id,
      metadata: { ok: result.ok, latencyMs, errorCode },
      ...(requestId ? { requestId } : {}),
    }),
  );
  return { integration: toIntegration(updated), ok: result.ok, latencyMs, errorCode };
}

/** The usable integration for a category: TESTED or VERIFIED (VERIFIED first, then the newest). */
export async function activeIntegration(
  appDb: Db,
  ctx: TenantContext,
  category: Category,
): Promise<Integration | null> {
  return withTenant(appDb, ctx, async (trx) => {
    const { rows } = await sql<Row>`
      select ${COLUMNS} from lbg.integrations
       where business_id = ${ctx.businessId} and category = ${category} and status in ('TESTED', 'VERIFIED')
       order by (status = 'VERIFIED') desc, created_at desc limit 1`.execute(trx);
    return rows[0] ? toIntegration(rows[0]) : null;
  });
}

/**
 * Calls a provider operation through the integration of `category`:
 * quota check (hard stop at 100 %), retries per the integration's policy,
 * and one recorded call with latency, units and cost (FR-SUB-3 AC1–2).
 */
export async function callProvider<T>(
  deps: HubDeps,
  ctx: TenantContext,
  category: Category,
  purpose: string,
  op: (adapter: ProviderAdapter, call: AdapterCall) => Promise<AdapterResult<T>> | null,
  estimate: { readonly units: number; readonly costPaise: number | null } = { units: 0, costPaise: null },
): Promise<{
  readonly result: AdapterResult<T>;
  readonly integration: Integration;
  readonly usage: Usage;
  readonly attempts: number;
}> {
  const active = await activeIntegration(deps.appDb, ctx, category);
  if (!active) throw new IntegrationError('NOT_CONFIGURED', 'No tested integration is configured for this.');
  const row = await withTenant(deps.appDb, ctx, (trx) => rowIn(trx, ctx, active.id));
  const before = await withTenant(deps.appDb, ctx, (trx) => usageIn(trx, ctx, row));
  if (before.limit !== null && before.monthUnits + estimate.units > before.limit) {
    throw new IntegrationError('QUOTA_EXCEEDED', 'The monthly usage limit for this integration has been reached.');
  }
  // The plan's monthly AI allowance (FR-SUB-3 AC2), across all AI integrations of the business.
  const ai = category === 'LLM' || category === 'IMAGE_VIDEO';
  if (ai) {
    await withTenant(deps.appDb, ctx, (trx) => assertQuotaIn(trx, ctx, 'AI', estimate.units)).catch((err: unknown) => {
      if (err instanceof QuotaError) throw new IntegrationError('QUOTA_EXCEEDED', err.message);
      throw err;
    });
  }
  const adapter = adapterFor(row.provider, deps.allowMocks);
  if (!adapter) throw new IntegrationError('PROVIDER_UNKNOWN', 'No adapter is available for this provider.');
  const call = await openCall(deps, ctx, row);
  const started = performance.now();
  const { result, attempts } = await withRetries(row.max_retries, deps.retryBaseMs ?? 500, () => {
    const p = op(adapter, call);
    return p ?? Promise.resolve({ ok: false as const, code: 'OPERATION_NOT_SUPPORTED', retryable: false });
  });
  const latencyMs = Math.round(performance.now() - started);
  const errorCode = result.ok ? null : result.code.slice(0, 40).replace(/[^A-Z0-9_]/g, '_');
  const updated = await recordCall(
    deps.appDb,
    ctx,
    row,
    {
      kind: 'CALL',
      purpose,
      ok: result.ok,
      latencyMs,
      errorCode,
      units: result.ok ? (result.units ?? 0) : 0,
      estimatedCostPaise: estimate.costPaise,
      costPaise: result.ok ? (result.costPaise ?? null) : null,
    },
    null,
  );
  if (ai) await withTenant(deps.appDb, ctx, (trx) => quotaNoticesIn(trx, ctx));
  const usage = await withTenant(deps.appDb, ctx, (trx) => usageIn(trx, ctx, updated));
  return { result, integration: toIntegration(updated), usage, attempts };
}

export const isCategory = (c: string): c is Category => (CATEGORIES as readonly string[]).includes(c);

/**
 * A delivered or read receipt is a real operation confirmed by the provider:
 * a tested integration becomes VERIFIED (WORKFLOWS §10).
 */
export async function markVerified(appDb: Db, ctx: TenantContext, id: string): Promise<void> {
  await withTenant(appDb, ctx, (trx) =>
    sql`update lbg.integrations set status = 'VERIFIED', status_reason = 'Confirmed by a provider receipt.'
         where business_id = ${ctx.businessId} and id = ${id} and status = 'TESTED'`.execute(trx),
  );
}

// ---------------------------------------------------------------------------
// Provider templates (7.6: FR-MSG-1 AC1, FR-MSG-2 AC1)
// ---------------------------------------------------------------------------

export interface MessageTemplate {
  readonly id: string;
  readonly integrationId: string;
  readonly channel: 'WHATSAPP' | 'SMS';
  readonly name: string;
  readonly language: string;
  readonly purpose: TemplatePurpose;
  readonly providerCategory: string | null;
  readonly body: string;
  readonly dltTemplateId: string | null;
  readonly status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  readonly source: 'SYNC' | 'MANUAL';
  readonly syncedAt: string | null;
}

interface TemplateRow {
  id: string;
  integration_id: string;
  channel: MessageTemplate['channel'];
  name: string;
  language: string;
  purpose: TemplatePurpose;
  provider_category: string | null;
  body: string;
  dlt_template_id: string | null;
  status: MessageTemplate['status'];
  source: MessageTemplate['source'];
  synced_at: Date | null;
}
const TEMPLATE_COLUMNS = sql`id, integration_id, channel, name, language, purpose, provider_category, body, dlt_template_id,
                             status, source, synced_at`;
const toTemplate = (r: TemplateRow): MessageTemplate => ({
  id: r.id,
  integrationId: r.integration_id,
  channel: r.channel,
  name: r.name,
  language: r.language,
  purpose: r.purpose,
  providerCategory: r.provider_category,
  body: r.body,
  dltTemplateId: r.dlt_template_id,
  status: r.status,
  source: r.source,
  syncedAt: r.synced_at?.toISOString() ?? null,
});

export async function listTemplates(appDb: Db, ctx: TenantContext, integrationId: string): Promise<MessageTemplate[]> {
  return withTenant(appDb, ctx, async (trx) => {
    await rowIn(trx, ctx, integrationId);
    const { rows } = await sql<TemplateRow>`
      select ${TEMPLATE_COLUMNS} from lbg.message_templates
       where business_id = ${ctx.businessId} and integration_id = ${integrationId}
       order by name, language`.execute(trx);
    return rows.map(toTemplate);
  });
}

/** Approved templates of the channel's active integration, in a stable order (for matching). */
export async function approvedTemplatesIn(
  trx: Trx,
  ctx: TenantContext,
  integrationId: string,
): Promise<MessageTemplate[]> {
  const { rows } = await sql<TemplateRow>`
    select ${TEMPLATE_COLUMNS} from lbg.message_templates
     where business_id = ${ctx.businessId} and integration_id = ${integrationId} and status = 'APPROVED'
     order by created_at, id`.execute(trx);
  return rows.map(toTemplate);
}

const WA_STATUS: Record<string, MessageTemplate['status']> = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  IN_APPEAL: 'PENDING',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
};

/** Reads the WhatsApp templates from the provider; templates no longer listed are disabled here. */
export async function syncTemplates(
  deps: HubDeps,
  ctx: TenantContext,
  integrationId: string,
  requestId?: string,
): Promise<MessageTemplate[]> {
  const row = await withTenant(deps.appDb, ctx, (trx) => rowIn(trx, ctx, integrationId));
  if (!['TESTED', 'VERIFIED'].includes(row.status)) {
    throw new IntegrationError('INVALID_STATE', 'Test the integration before reading its templates.');
  }
  const adapter = adapterFor(row.provider, deps.allowMocks);
  if (!adapter?.syncTemplates) {
    throw new IntegrationError(
      'OPERATION_NOT_SUPPORTED',
      'This provider has no template list; enter templates instead.',
    );
  }
  const result = await adapter.syncTemplates(await openCall(deps, ctx, row));
  if (!result.ok) throw new IntegrationError('SYNC_FAILED', 'The provider did not return its templates.', result.code);
  await withTenant(deps.appDb, ctx, async (trx) => {
    const seen: string[] = [];
    for (const t of result.value) {
      const lang = /^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.language) ? t.language : null;
      if (!lang || t.body.length > 1024 || t.name.length > 512) continue;
      const valid = templateBodyValid({ channel: 'WHATSAPP', body: t.body });
      const status = valid ? (WA_STATUS[t.status.toUpperCase()] ?? 'PENDING') : 'DISABLED';
      const { rows } = await sql<{ id: string }>`
        insert into lbg.message_templates (business_id, integration_id, channel, name, language, purpose,
                                           provider_category, body, status, source, synced_at, created_by)
        values (${ctx.businessId}, ${integrationId}, 'WHATSAPP', ${t.name}, ${lang}, ${whatsappPurpose(t.category)},
                ${t.category.slice(0, 40) || null}, ${t.body}, ${status}, 'SYNC', now(), ${ctx.userId})
        on conflict (business_id, integration_id, name, language) do update
           set purpose = excluded.purpose, provider_category = excluded.provider_category, body = excluded.body,
               status = excluded.status, synced_at = excluded.synced_at
        returning id`.execute(trx);
      if (rows[0]) seen.push(rows[0].id);
    }
    await sql`update lbg.message_templates set status = 'DISABLED', synced_at = now()
               where business_id = ${ctx.businessId} and integration_id = ${integrationId} and source = 'SYNC'
                 and status <> 'DISABLED' and not (id = any(${seen}::uuid[]))`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'integration.templates_sync',
      targetType: 'integration',
      targetId: integrationId,
      metadata: { received: result.value.length, stored: seen.length },
      ...(requestId ? { requestId } : {}),
    });
  });
  return listTemplates(deps.appDb, ctx, integrationId);
}

/** An SMS template as registered on the DLT portal (FR-MSG-2 AC1). */
export async function registerDltTemplate(
  appDb: Db,
  ctx: TenantContext,
  integrationId: string,
  input: {
    readonly name: string;
    readonly purpose: TemplatePurpose;
    readonly body: string;
    readonly dltTemplateId: string;
  },
  requestId?: string,
): Promise<MessageTemplate> {
  if (!templateBodyValid({ channel: 'SMS', body: input.body })) {
    throw new IntegrationError('TEMPLATE_INVALID', 'The template text is empty.');
  }
  return withTenant(appDb, ctx, async (trx) => {
    const row = await rowIn(trx, ctx, integrationId);
    if (row.category !== 'SMS') throw new IntegrationError('OPERATION_NOT_SUPPORTED', 'Only SMS uses DLT templates.');
    if (row.status === 'REVOKED') throw new IntegrationError('INVALID_STATE', 'A revoked integration cannot change.');
    const { rows } = await sql<TemplateRow>`
      insert into lbg.message_templates (business_id, integration_id, channel, name, language, purpose, body,
                                         dlt_template_id, status, source, created_by)
      values (${ctx.businessId}, ${integrationId}, 'SMS', ${input.name.trim()}, 'en', ${input.purpose},
              ${input.body.trim()}, ${input.dltTemplateId}, 'APPROVED', 'MANUAL', ${ctx.userId})
      on conflict (business_id, integration_id, name, language) do nothing
      returning ${TEMPLATE_COLUMNS}`.execute(trx);
    const t = rows[0];
    if (!t) throw new IntegrationError('TEMPLATE_INVALID', 'A template with this name already exists.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.template_register',
      targetType: 'integration',
      targetId: integrationId,
      metadata: { templateId: t.id, purpose: input.purpose },
      ...(requestId ? { requestId } : {}),
    });
    return toTemplate(t);
  });
}

export async function disableTemplate(
  appDb: Db,
  ctx: TenantContext,
  integrationId: string,
  templateId: string,
): Promise<MessageTemplate> {
  return withTenant(appDb, ctx, async (trx) => {
    const { rows } = await sql<TemplateRow>`
      update lbg.message_templates set status = 'DISABLED'
       where business_id = ${ctx.businessId} and integration_id = ${integrationId} and id = ${templateId}
      returning ${TEMPLATE_COLUMNS}`.execute(trx);
    const t = rows[0];
    if (!t) throw new IntegrationError('NOT_FOUND', 'Template not found.');
    await recordTenantEvent(trx, ctx, {
      action: 'integration.template_disable',
      targetType: 'integration',
      targetId: integrationId,
      metadata: { templateId },
    });
    return toTemplate(t);
  });
}

// ---------------------------------------------------------------------------
// Webhook targets (NFR-18)
// ---------------------------------------------------------------------------

export interface WebhookTarget {
  /** Tenant context with the system actor. */
  readonly ctx: TenantContext;
  readonly integrationId: string;
  readonly provider: string;
  readonly category: Category;
  readonly config: Readonly<Record<string, unknown>>;
  /** The opened channel credential (JSON); never logged. */
  readonly secret: string;
}

/** The tested channel integration behind a webhook URL, with its opened credential; null when there is none. */
export async function webhookTarget(deps: HubDeps, integrationId: string): Promise<WebhookTarget | null> {
  if (!deps.secrets) return null;
  const { rows } = await sql<{
    business_id: string;
    provider: string;
    category: Category;
    secret_id: string | null;
    config: Record<string, unknown>;
  }>`select * from lbg.webhook_target(${integrationId}::uuid)`.execute(deps.appDb);
  const t = rows[0];
  if (!t?.secret_id) return null;
  const ctx = { businessId: t.business_id, userId: SYSTEM_ACTOR };
  const secret = await readSecretValue(deps.secrets.db, deps.secrets.keyring, ctx, t.secret_id);
  return { ctx, integrationId, provider: t.provider, category: t.category, config: t.config, secret };
}
