// API & Integrations Hub (increment 7.7 for FR-HUB-1…6, FR-MSG-1, -2, -4).
// Every integration shows its real status; credentials are write-only (only
// a 4-character hint is ever shown); tests, health and usage come from the
// API. WhatsApp and SMS show their webhook address and templates.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, formatPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, cell, errorText, Field, humanize, NativeSelect, Page, Table, TextArea } from '../ui.tsx';

interface Provider {
  provider: string;
  name: string;
  categories: string[];
  authMethods: string[];
  needsBaseUrl: boolean;
  mock: boolean;
  note: string;
}
interface Integration {
  id: string;
  category: string;
  provider: string;
  label: string;
  authMethod: string;
  baseUrl: string | null;
  modelId: string | null;
  monthlyUnitLimit: number | null;
  config: Record<string, unknown>;
  secretId: string | null;
  status: string;
  statusReason: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
}
interface Health {
  usage: { monthUnits: number; monthCostPaise: number; limit: number | null; warning: boolean; stopped: boolean };
  recent: {
    kind: string;
    purpose: string;
    ok: boolean;
    latencyMs: number | null;
    errorCode: string | null;
    at: string;
  }[];
}
interface Template {
  id: string;
  name: string;
  language: string;
  purpose: string;
  body: string;
  dltTemplateId: string | null;
  status: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  MESSAGING: 'WhatsApp',
  SMS: 'SMS',
  EMAIL: 'Email',
  LLM: 'Text AI',
  IMAGE_VIDEO: 'Image AI',
  OCR: 'OCR',
  STORAGE: 'Storage',
  PAYMENTS: 'Payments',
  SOCIAL: 'Social',
};
const AUTH_LABELS: Record<string, string> = {
  NONE: 'None',
  API_KEY: 'API key',
  BEARER: 'Bearer token',
  OAUTH2_CLIENT_CREDENTIALS: 'OAuth2 client credentials',
};
/** What each status means for the shop (WORKFLOWS §10). */
const STATUS_HELP: Record<string, string> = {
  PLANNED: 'Saved without a credential; nothing can be used yet.',
  CONFIGURED: 'Saved with a credential, not tested yet.',
  TESTED: 'The connection test succeeded.',
  VERIFIED: 'A real operation was confirmed by the provider.',
  FAILED: 'The last test failed; fix it and test again.',
  DISABLED: 'Turned off; nothing is sent or received.',
  REVOKED: 'The credential was destroyed; this integration has ended.',
};
const tone = (s: string) =>
  s === 'TESTED' || s === 'VERIFIED'
    ? 'success'
    : s === 'FAILED' || s === 'REVOKED'
      ? 'danger'
      : s === 'DISABLED'
        ? 'neutral'
        : 'warning';

export function IntegrationsPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const manage = business.can('integrations.manage');
  const providers = useQuery({
    queryKey: ['providers', businessId],
    queryFn: () => api<{ providers: Provider[]; storeConfigured: boolean }>(`${base}/integrations/providers`),
  });
  const list = useQuery({
    queryKey: ['integrations', businessId],
    queryFn: () => api<{ integrations: Integration[] }>(`${base}/integrations`),
  });
  const secrets = useQuery({
    queryKey: ['secrets', businessId],
    queryFn: () => api<{ secrets: { id: string; hint: string | null }[] }>(`${base}/secrets`),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setNotice(null);
    try {
      await fn();
      setNotice({ text: ok, tone: 'success' });
      await queryClient.invalidateQueries();
      return true;
    } catch (err) {
      setNotice({ text: errorText(err), tone: 'error' });
      return false;
    }
  };
  const rows = list.data?.integrations ?? [];
  const hint = (id: string | null) => secrets.data?.secrets.find((x) => x.id === id)?.hint ?? null;
  const current = rows.find((i) => i.id === selected) ?? null;
  return (
    <Page
      eyebrow="Settings"
      title="API Hub"
      description="Connections to outside services. Nothing is connected until you add it with its credential and the test succeeds."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {providers.data && !providers.data.storeConfigured ? (
        <Alert message="The secret store is not configured on this server, so credentials cannot be saved." />
      ) : null}
      <section aria-labelledby="integrations-heading">
        <h2 id="integrations-heading" className="section-title">
          Integrations
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-600">No integrations yet.</p>
        ) : (
          <Table caption="Integrations" headers={['Name', 'Kind', 'Provider', 'Status', 'Credential', '']}>
            {rows.map((i) => (
              <tr key={i.id}>
                <td className={cell}>{i.label}</td>
                <td className={cell}>{CATEGORY_LABELS[i.category] ?? i.category}</td>
                <td className={cell}>
                  {providers.data?.providers.find((p) => p.provider === i.provider)?.name ?? i.provider}
                </td>
                <td className={cell}>
                  <Badge tone={tone(i.status)}>{humanize(i.status)}</Badge>
                  <p className="mt-1 text-xs text-ink-600">{i.statusReason ?? STATUS_HELP[i.status]}</p>
                </td>
                <td className={cell}>
                  {i.secretId ? <span className="font-mono">••••{hint(i.secretId) ?? ''}</span> : 'None'}
                </td>
                <td className={cell}>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setSelected(i.id === selected ? null : i.id);
                    }}
                  >
                    {i.id === selected ? `Close ${i.label}` : `Open ${i.label}`}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      {current ? (
        <IntegrationDetail key={current.id} base={base} integration={current} manage={manage} run={run} />
      ) : null}
      {manage && providers.data ? <AddIntegration base={base} providers={providers.data.providers} run={run} /> : null}
    </Page>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;

function AddIntegration(props: { base: string; providers: Provider[]; run: Run }) {
  const categories = [...new Set(props.providers.flatMap((p) => p.categories))];
  const [category, setCategory] = useState(categories.includes('LLM') ? 'LLM' : (categories[0] ?? 'LLM'));
  const choices = props.providers.filter((p) => p.categories.includes(category));
  const [providerName, setProviderName] = useState('');
  const provider = choices.find((p) => p.provider === providerName) ?? choices[0];
  const [authMethod, setAuthMethod] = useState('');
  const auth = provider?.authMethods.includes(authMethod) ? authMethod : (provider?.authMethods[0] ?? 'NONE');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [limit, setLimit] = useState('');
  const [secret, setSecret] = useState('');
  // WhatsApp / SMS fields; their credential is several values stored together.
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (v: string) => {
    setF((o) => ({ ...o, [k]: v }));
  };
  const wa = provider?.provider === 'whatsapp_cloud';
  const dlt = provider?.provider === 'sms_dlt_json';
  const config = wa
    ? { phoneNumberId: f.phoneNumberId ?? '', wabaId: f.wabaId ?? '' }
    : dlt
      ? {
          dltEntityId: f.dltEntityId ?? '',
          headers: {
            ...(f.txHeader ? { TRANSACTIONAL: f.txHeader } : {}),
            ...(f.promoHeader ? { MARKETING: f.promoHeader } : {}),
          },
        }
      : undefined;
  const credential = wa
    ? JSON.stringify({
        accessToken: f.accessToken ?? '',
        appSecret: f.appSecret ?? '',
        verifyToken: f.verifyToken ?? '',
      })
    : dlt
      ? JSON.stringify({ apiKey: f.apiKey ?? '', webhookSecret: f.webhookSecret ?? '' })
      : secret;
  return (
    <section aria-labelledby="add-integration-heading">
      <h2 id="add-integration-heading" className="section-title">
        Add an integration
      </h2>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void props
            .run(
              () =>
                api(`${props.base}/integrations`, {
                  method: 'POST',
                  body: {
                    category,
                    provider: provider?.provider ?? '',
                    label: label.trim(),
                    authMethod: auth,
                    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                    ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
                    ...(limit.trim() ? { monthlyUnitLimit: Number(limit) } : {}),
                    ...(config ? { config } : {}),
                    ...(auth !== 'NONE' ? { secret: credential } : {}),
                  },
                }),
              'Integration saved. Test the connection before using it.',
            )
            .then((ok) => {
              if (ok) {
                setSecret('');
                setF({});
                setLabel('');
              }
            });
        }}
      >
        <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
          <NativeSelect
            label="Kind"
            name="integrationCategory"
            value={category}
            onChange={setCategory}
            options={categories.map((c) => [c, CATEGORY_LABELS[c] ?? c] as const)}
          />
          <NativeSelect
            label="Provider"
            name="integrationProvider"
            value={provider?.provider ?? ''}
            onChange={setProviderName}
            options={choices.map((p) => [p.provider, p.name] as const)}
          />
          <NativeSelect
            label="Sign-in method"
            name="integrationAuth"
            value={auth}
            onChange={setAuthMethod}
            options={(provider?.authMethods ?? []).map((a) => [a, AUTH_LABELS[a] ?? a] as const)}
          />
          <Field label="Name" name="integrationLabel" value={label} onChange={setLabel} />
          {provider?.needsBaseUrl ? (
            <Field label="Base URL (https)" name="integrationBaseUrl" value={baseUrl} onChange={setBaseUrl} />
          ) : null}
          {category === 'LLM' || category === 'IMAGE_VIDEO' ? (
            <Field label="Model" name="integrationModel" value={modelId} onChange={setModelId} isRequired={false} />
          ) : null}
          <Field
            label="Monthly unit limit (optional)"
            name="integrationLimit"
            value={limit}
            onChange={setLimit}
            inputMode="numeric"
            isRequired={false}
          />
          {wa ? (
            <>
              <Field
                label="Phone number ID"
                name="waPhone"
                value={f.phoneNumberId ?? ''}
                onChange={set('phoneNumberId')}
                inputMode="numeric"
              />
              <Field
                label="WhatsApp Business Account ID"
                name="waAccount"
                value={f.wabaId ?? ''}
                onChange={set('wabaId')}
                inputMode="numeric"
              />
              <Field
                label="Access token"
                name="waToken"
                type="password"
                value={f.accessToken ?? ''}
                onChange={set('accessToken')}
                autoComplete="off"
              />
              <Field
                label="App secret"
                name="waAppSecret"
                type="password"
                value={f.appSecret ?? ''}
                onChange={set('appSecret')}
                autoComplete="off"
              />
              <Field
                label="Webhook verify token"
                name="waVerify"
                type="password"
                value={f.verifyToken ?? ''}
                onChange={set('verifyToken')}
                autoComplete="off"
              />
            </>
          ) : null}
          {dlt ? (
            <>
              <Field
                label="DLT entity ID"
                name="dltEntity"
                value={f.dltEntityId ?? ''}
                onChange={set('dltEntityId')}
                inputMode="numeric"
              />
              <Field
                label="Transactional header (6 letters)"
                name="dltTxHeader"
                value={f.txHeader ?? ''}
                onChange={set('txHeader')}
                isRequired={false}
              />
              <Field
                label="Promotional header (6 digits)"
                name="dltPromoHeader"
                value={f.promoHeader ?? ''}
                onChange={set('promoHeader')}
                isRequired={false}
              />
              <Field
                label="API key"
                name="smsKey"
                type="password"
                value={f.apiKey ?? ''}
                onChange={set('apiKey')}
                autoComplete="off"
              />
              <Field
                label="Webhook secret"
                name="smsHook"
                type="password"
                value={f.webhookSecret ?? ''}
                onChange={set('webhookSecret')}
                autoComplete="off"
              />
            </>
          ) : null}
          {!wa && !dlt && auth !== 'NONE' ? (
            <Field
              label="Credential"
              name="integrationSecret"
              type="password"
              value={secret}
              onChange={setSecret}
              autoComplete="off"
              description="Stored encrypted. It is never shown again; only its last 4 characters are."
            />
          ) : null}
        </div>
        {provider ? <p className="mb-3 text-sm text-ink-600">{provider.note}</p> : null}
        <Button type="submit">Save integration</Button>
      </Form>
    </section>
  );
}

function IntegrationDetail(props: { base: string; integration: Integration; manage: boolean; run: Run }) {
  const i = props.integration;
  const url = `${props.base}/integrations/${i.id}`;
  const health = useQuery({
    queryKey: ['integration', i.id, i.status, i.lastSuccessAt, i.lastErrorAt],
    queryFn: () => api<{ health: Health }>(url),
  });
  const channel = i.provider === 'whatsapp_cloud' || i.provider === 'sms_dlt_json';
  const templates = useQuery({
    queryKey: ['templates', i.id, i.status],
    queryFn: () => api<{ templates: Template[] }>(`${url}/templates`),
    enabled: channel,
  });
  const [secret, setSecret] = useState('');
  const [tpl, setTpl] = useState({ name: '', purpose: 'TRANSACTIONAL', body: '', dltTemplateId: '' });
  const usage = health.data?.health.usage;
  const live = !['REVOKED'].includes(i.status);
  const hook =
    i.provider === 'whatsapp_cloud'
      ? `${window.location.origin}/api/webhooks/whatsapp/${i.id}`
      : i.provider === 'sms_dlt_json'
        ? `${window.location.origin}/api/webhooks/sms/${i.id}`
        : null;
  return (
    <section aria-labelledby="integration-detail-heading">
      <h2 id="integration-detail-heading" className="section-title">
        {i.label}
      </h2>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-600">Status</dt>
          <dd>
            <Badge tone={tone(i.status)}>{humanize(i.status)}</Badge> {STATUS_HELP[i.status]}
          </dd>
        </div>
        <div>
          <dt className="text-ink-600">Last success / last error</dt>
          <dd>
            {i.lastSuccessAt ? new Date(i.lastSuccessAt).toLocaleString('en-IN') : 'Never'} /{' '}
            {i.lastErrorAt ? `${new Date(i.lastErrorAt).toLocaleString('en-IN')} (${i.lastErrorCode ?? ''})` : 'None'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-600">Usage this month</dt>
          <dd>
            {usage
              ? `${String(usage.monthUnits)} units${usage.limit ? ` of ${String(usage.limit)}` : ''}, cost ${formatPaise(usage.monthCostPaise)}${usage.stopped ? ' — limit reached, calls are stopped' : usage.warning ? ' — over 80 % of the limit' : ''}`
              : '…'}
          </dd>
        </div>
        {hook ? (
          <div className="min-w-0">
            <dt className="text-ink-600">Webhook address for the provider</dt>
            <dd className="font-mono text-xs break-all">{hook}</dd>
          </div>
        ) : null}
      </dl>
      {props.manage && live ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {i.status !== 'DISABLED' && i.status !== 'PLANNED' ? (
            <Button
              onPress={() => {
                void props.run(
                  () => api(`${url}/test`, { method: 'POST' }),
                  'Connection test finished; see the status.',
                );
              }}
            >
              Test connection
            </Button>
          ) : null}
          {i.status === 'DISABLED' ? (
            <Button
              variant="secondary"
              onPress={() => {
                void props.run(() => api(`${url}/enable`, { method: 'POST' }), 'Enabled. Test it again before use.');
              }}
            >
              Enable
            </Button>
          ) : (
            <Button
              variant="secondary"
              onPress={() => {
                void props.run(() => api(`${url}/disable`, { method: 'POST' }), 'Disabled.');
              }}
            >
              Disable
            </Button>
          )}
          <Button
            variant="danger"
            onPress={() => {
              if (window.confirm(`Revoke ${i.label}? The credential is destroyed and this cannot be undone.`)) {
                void props.run(
                  () => api(`${url}/revoke`, { method: 'POST' }),
                  'Revoked; the credential was destroyed.',
                );
              }
            }}
          >
            Revoke
          </Button>
        </div>
      ) : null}
      {props.manage && live && i.authMethod !== 'NONE' && !channel ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void props
              .run(() => api(`${url}/secret`, { method: 'PUT', body: { secret } }), 'Credential replaced. Test again.')
              .then((ok) => {
                if (ok) setSecret('');
              });
          }}
        >
          <Field
            label="New credential"
            name="rotateSecret"
            type="password"
            value={secret}
            onChange={setSecret}
            autoComplete="off"
          />
          <Button type="submit" variant="secondary">
            Replace credential
          </Button>
        </Form>
      ) : null}
      {health.data && health.data.health.recent.length > 0 ? (
        <Table caption="Recent tests and calls" headers={['When', 'What', 'Result', 'Time']}>
          {health.data.health.recent.slice(0, 10).map((r, n) => (
            <tr key={`${r.at}-${String(n)}`}>
              <td className={cell}>{new Date(r.at).toLocaleString('en-IN')}</td>
              <td className={cell}>{r.purpose}</td>
              <td className={cell}>{r.ok ? 'OK' : `Failed (${r.errorCode ?? ''})`}</td>
              <td className={cell}>{r.latencyMs === null ? '—' : `${String(r.latencyMs)} ms`}</td>
            </tr>
          ))}
        </Table>
      ) : null}
      {channel ? (
        <>
          <h3 className="mt-2 mb-2 text-base font-semibold">Templates</h3>
          <p className="mb-3 text-sm text-ink-600">
            Messages go out only as an approved template matching their text exactly; marketing and transactional
            templates are kept apart.
          </p>
          {(templates.data?.templates ?? []).length > 0 ? (
            <Table caption="Templates" headers={['Name', 'Purpose', 'Text', 'Status']}>
              {(templates.data?.templates ?? []).map((t) => (
                <tr key={t.id}>
                  <td className={cell}>
                    {t.name} ({t.language})
                  </td>
                  <td className={cell}>{humanize(t.purpose)}</td>
                  <td className={`${cell} break-words`}>{t.body}</td>
                  <td className={cell}>
                    <Badge tone={t.status === 'APPROVED' ? 'success' : 'neutral'}>{humanize(t.status)}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="mb-3 text-sm text-ink-600">No templates yet.</p>
          )}
          {props.manage && i.provider === 'whatsapp_cloud' ? (
            <Button
              variant="secondary"
              onPress={() => {
                void props.run(() => api(`${url}/templates/sync`, { method: 'POST' }), 'Templates read from WhatsApp.');
              }}
            >
              Read templates from WhatsApp
            </Button>
          ) : null}
          {props.manage && i.provider === 'sms_dlt_json' ? (
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                void props.run(() => api(`${url}/templates`, { method: 'POST', body: tpl }), 'DLT template added.');
              }}
            >
              <div className="grid gap-x-3 sm:grid-cols-2">
                <Field
                  label="Template name"
                  name="dltName"
                  value={tpl.name}
                  onChange={(v) => {
                    setTpl({ ...tpl, name: v });
                  }}
                />
                <Field
                  label="DLT template ID"
                  name="dltId"
                  value={tpl.dltTemplateId}
                  onChange={(v) => {
                    setTpl({ ...tpl, dltTemplateId: v });
                  }}
                  inputMode="numeric"
                />
                <NativeSelect
                  label="Purpose"
                  name="dltPurpose"
                  value={tpl.purpose}
                  onChange={(v) => {
                    setTpl({ ...tpl, purpose: v });
                  }}
                  options={[
                    ['TRANSACTIONAL', 'Transactional / service'],
                    ['MARKETING', 'Promotional'],
                  ]}
                />
              </div>
              <TextArea
                label="Registered text"
                name="dltBody"
                value={tpl.body}
                onChange={(v) => {
                  setTpl({ ...tpl, body: v });
                }}
                description="Exactly as registered on the DLT portal, with {#var#} for each variable."
              />
              <Button type="submit" variant="secondary">
                Add DLT template
              </Button>
            </Form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
