// Usage and monitoring (increment 8.6 for FR-SUB-3 AC2, NFR-5, NFR-10):
// this month's use against the plan's allowances, the owner's AI overage cap,
// what the job runner did, integration health and assistant runs.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, cell, errorText, Field, humanize, Page, Table } from '../ui.tsx';

interface Metric {
  metric: 'AI' | 'MESSAGES' | 'STORAGE';
  used: number;
  limit: number | null;
  overage: number;
  percent: number | null;
  warning: boolean;
  stopped: boolean;
}
interface Monitoring {
  jobs: { job: string; status: string; processed: number; errorCode: string | null; startedAt: string }[];
  integrations: {
    id: string;
    label: string;
    status: string;
    lastErrorCode: string | null;
    calls24h: number;
    errors24h: number;
  }[];
  agentRuns7d: { status: string; n: number }[];
}

const NAMES: Record<Metric['metric'], string> = { AI: 'AI use (units)', MESSAGES: 'Messages sent', STORAGE: 'Storage' };
const JOBS: Record<string, string> = {
  campaigns: 'Scheduled campaigns',
  messages: 'Waiting messages',
  reminders: 'Daily reminders',
  agent_timeouts: 'Assistant time limits',
  trial_notices: 'Trial notices',
  quota_notices: 'Usage notices',
};
const amount = (m: Metric['metric'], n: number) => (m === 'STORAGE' ? `${(n / 1024 / 1024).toFixed(1)} MB` : String(n));

export function UsagePage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const usage = useQuery({
    queryKey: ['usage', businessId],
    queryFn: () => api<{ usage: Metric[]; aiOverageCapUnits: number }>(`${base}/usage`),
  });
  const monitoring = useQuery({
    queryKey: ['monitoring', businessId],
    queryFn: () => api<{ monitoring: Monitoring }>(`${base}/monitoring`),
  });
  const [cap, setCap] = useState('');
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const m = monitoring.data?.monitoring;
  return (
    <Page
      eyebrow="Settings"
      title="Usage and monitoring"
      description="This month's use against your plan, and what the system did on its own (scheduled sends, reminders, notices)."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading" className="section-title">
          This month
        </h2>
        <Table caption="Usage against the plan" headers={['What', 'Used', 'Plan allowance', 'Status']}>
          {(usage.data?.usage ?? []).map((u) => (
            <tr key={u.metric} data-testid={`usage-${u.metric}`}>
              <td className={cell}>{NAMES[u.metric]}</td>
              <td className={cell}>{amount(u.metric, u.used)}</td>
              <td className={cell}>
                {u.limit === null ? 'No limit set' : amount(u.metric, u.limit)}
                {u.overage > 0 ? ` (+${String(u.overage)} allowed by you)` : ''}
              </td>
              <td className={cell}>
                {u.stopped ? (
                  <Badge tone="danger">Stopped until next month</Badge>
                ) : u.warning ? (
                  <Badge tone="warning">{`${String(u.percent ?? 0)} % used`}</Badge>
                ) : (
                  <Badge tone="success">{u.percent === null ? 'OK' : `${String(u.percent)} % used`}</Badge>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {business.can('business.settings.manage') ? (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              api(`${base}/usage/overage`, { method: 'PUT', body: { aiOverageCapUnits: Number(cap) || 0 } })
                .then(async () => {
                  setNotice({ text: 'Extra AI allowance saved.', tone: 'success' });
                  setCap('');
                  await queryClient.invalidateQueries();
                })
                .catch((err: unknown) => {
                  setNotice({ text: errorText(err), tone: 'error' });
                });
            }}
          >
            <Field
              label={`Extra AI units allowed beyond the plan each month (now ${String(usage.data?.aiOverageCapUnits ?? 0)})`}
              name="overageCap"
              value={cap}
              onChange={setCap}
              inputMode="numeric"
            />
            <Button type="submit" variant="secondary">
              Save extra allowance
            </Button>
          </Form>
        ) : null}
      </section>
      <section aria-labelledby="jobs-heading">
        <h2 id="jobs-heading" className="section-title">
          Work done by the system
        </h2>
        {(m?.jobs ?? []).length === 0 ? (
          <p className="text-sm text-ink-600">Nothing recorded yet.</p>
        ) : (
          <Table caption="Work done by the system" headers={['When', 'What', 'Result', 'Items']}>
            {(m?.jobs ?? []).map((j, i) => (
              <tr key={`${j.startedAt}-${String(i)}`}>
                <td className={cell}>{new Date(j.startedAt).toLocaleString('en-IN')}</td>
                <td className={cell}>{JOBS[j.job] ?? humanize(j.job)}</td>
                <td className={cell}>
                  {j.status === 'FAILED' ? <Badge tone="danger">{`Failed (${j.errorCode ?? ''})`}</Badge> : 'Done'}
                </td>
                <td className={cell}>{String(j.processed)}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <section aria-labelledby="health-heading">
        <h2 id="health-heading" className="section-title">
          Integrations (last 24 hours)
        </h2>
        {(m?.integrations ?? []).length === 0 ? (
          <p className="text-sm text-ink-600">No integrations.</p>
        ) : (
          <Table caption="Integration health" headers={['Integration', 'Status', 'Calls', 'Errors', 'Last error']}>
            {(m?.integrations ?? []).map((i) => (
              <tr key={i.id}>
                <td className={cell}>{i.label}</td>
                <td className={cell}>{humanize(i.status)}</td>
                <td className={cell}>{String(i.calls24h)}</td>
                <td className={cell}>{String(i.errors24h)}</td>
                <td className={cell}>{i.lastErrorCode ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-sm text-ink-600">
          Assistant questions in the last 7 days:{' '}
          {(m?.agentRuns7d ?? []).length === 0
            ? 'none'
            : (m?.agentRuns7d ?? []).map((r) => `${String(r.n)} ${humanize(r.status).toLowerCase()}`).join(', ')}
          .
        </p>
      </section>
    </Page>
  );
}
