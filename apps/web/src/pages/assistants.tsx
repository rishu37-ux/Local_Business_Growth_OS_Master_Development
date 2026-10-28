// AI assistants (increment 8.6 for FR-AGT-1, -4, -5, FR-RPT-5): ask one of
// the five assistants a question; the answer separates facts from your
// records (with period and source) from the assistant's suggestions; any
// proposal waits for a person to approve it. Limits and cancellation are shown.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { useBusiness } from '../business.ts';
import {
  Alert,
  Badge,
  Button,
  cell,
  errorText,
  humanize,
  NativeSelect,
  Page,
  statusTone,
  Table,
  TextArea,
} from '../ui.tsx';

interface AgentTool {
  name: string;
  description: string;
  permission: string;
  consequential: boolean;
  allowed: boolean;
}
interface Agent {
  key: string;
  name: string;
  purpose: string;
  tools: AgentTool[];
}
interface Fact {
  label: string;
  value: string;
  period?: string;
  source: string;
}
interface Run {
  id: string;
  agent: string;
  question: string;
  status: string;
  statusReason: string | null;
  usage: { toolCalls: number; modelCalls: number; units: number };
  limits: { timeoutSeconds: number; maxToolCalls: number };
  answer: {
    facts: Fact[];
    suggestions: string;
    flags: { kind: string; text: string }[];
    proposals: { kind: string; id: string; effect: string }[];
  } | null;
  steps: { seq: number; kind: string; tool: string | null; errorCode: string | null }[];
  createdAt: string;
}

const key = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const PROPOSAL_WHERE: Record<string, string> = {
  APPROVAL_REQUEST: 'approvals',
  CAMPAIGN: 'campaigns',
  STUDIO_DRAFT: 'studio',
};

export function AssistantsPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}/agents`;
  const catalogue = useQuery({
    queryKey: ['agents', businessId],
    queryFn: () => api<{ agents: Agent[]; configured: boolean }>(base),
    enabled: business.can('agents.use'),
  });
  const runs = useQuery({ queryKey: ['agent-runs', businessId], queryFn: () => api<{ runs: Run[] }>(`${base}/runs`) });
  const [agent, setAgent] = useState('INVENTORY');
  const [question, setQuestion] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const current = useQuery({
    queryKey: ['agent-run', businessId, open],
    queryFn: () => api<{ run: Run }>(`${base}/runs/${open ?? ''}`),
    enabled: open !== null,
  });
  const act = async (fn: () => Promise<{ run: Run }>, ok: string) => {
    setNotice(null);
    setBusy(true);
    try {
      const out = await fn();
      setOpen(out.run.id);
      setNotice({ text: ok, tone: 'success' });
      await queryClient.invalidateQueries();
    } catch (err) {
      setNotice({ text: errorText(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const agents = catalogue.data?.agents ?? [];
  const spec = agents.find((a) => a.key === agent);
  const run = current.data?.run ?? null;
  return (
    <Page
      eyebrow="Assistants"
      title="AI assistants"
      description="Ask about your shop. Figures always come from your records; anything that changes something waits for a person to approve it."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {catalogue.data && !catalogue.data.configured ? (
        <Alert message="No AI integration is connected and tested yet. Add one in the API Hub to use the assistants." />
      ) : null}
      {business.can('agents.use') ? (
        <section aria-labelledby="ask-heading">
          <h2 id="ask-heading" className="section-title">
            Ask an assistant
          </h2>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api<{ run: Run }>(`${base}/runs`, {
                    method: 'POST',
                    body: { agent, question, idempotencyKey: key() },
                  }),
                'The assistant has answered.',
              ).then(() => {
                setQuestion('');
              });
            }}
          >
            <NativeSelect
              label="Assistant"
              name="agent"
              value={agent}
              onChange={setAgent}
              options={agents.map((a) => [a.key, a.name] as const)}
            />
            {spec ? (
              <p className="mb-3 text-sm text-ink-600">
                {spec.purpose} It can use:{' '}
                {spec.tools
                  .map((t) => `${t.name.replaceAll('_', ' ')}${t.allowed ? '' : ' (not with your permissions)'}`)
                  .join(', ')}
                .
              </p>
            ) : null}
            <TextArea label="Your question" name="question" value={question} onChange={setQuestion} rows={3} />
            <Button type="submit" isDisabled={busy || question.trim() === ''}>
              {busy ? 'Working…' : 'Ask'}
            </Button>
          </Form>
        </section>
      ) : null}

      {run ? (
        <section aria-labelledby="answer-heading">
          <h2 id="answer-heading" className="section-title">
            Answer
          </h2>
          <p className="mb-3 text-sm text-ink-700">
            <Badge tone={statusTone(run.status === 'LIMIT_REACHED' ? 'FAILED' : run.status)}>
              {humanize(run.status)}
            </Badge>{' '}
            {run.statusReason ?? ''} · {String(run.usage.toolCalls)} of {String(run.limits.maxToolCalls)} tool calls ·{' '}
            {String(run.usage.units)} units
          </p>
          <p className="mb-3 text-sm">Question: {run.question}</p>
          <h3 className="mb-2 text-base font-semibold">Facts (from your records)</h3>
          {(run.answer?.facts ?? []).length === 0 ? (
            <p className="mb-3 text-sm text-ink-600">No figures were looked up.</p>
          ) : (
            <Table caption="Facts from your records" headers={['Fact', 'Value', 'Period', 'Source']}>
              {(run.answer?.facts ?? []).map((f, i) => (
                <tr key={`${f.label}-${String(i)}`}>
                  <td className={cell}>{f.label}</td>
                  <td className={cell}>{f.value}</td>
                  <td className={cell}>{f.period ?? '—'}</td>
                  <td className={cell}>{f.source}</td>
                </tr>
              ))}
            </Table>
          )}
          {run.answer ? (
            <>
              <h3 className="mb-2 text-base font-semibold">Suggestions (from the assistant)</h3>
              <p className="mb-3 text-sm whitespace-pre-wrap" data-testid="agent-suggestions">
                {run.answer.suggestions || '—'}
              </p>
              {run.answer.flags.length > 0 ? (
                <Alert
                  message={`The suggestion mentions figures that are not in your records: ${run.answer.flags.map((f) => f.text).join(', ')}. Do not rely on them.`}
                />
              ) : null}
            </>
          ) : null}
          {(run.answer?.proposals ?? []).length > 0 || run.status === 'AWAITING_APPROVAL' ? (
            <>
              <h3 className="mb-2 text-base font-semibold">Proposals waiting for a person</h3>
              <ul className="mb-3 list-disc pl-5 text-sm">
                {(run.answer?.proposals ?? []).map((p) => (
                  <li key={p.id}>
                    {p.effect}{' '}
                    <Link
                      className="text-brand-700 underline"
                      to={`/b/${businessId}/${PROPOSAL_WHERE[p.kind] ?? 'approvals'}`}
                    >
                      Review
                    </Link>
                  </li>
                ))}
                {run.status === 'AWAITING_APPROVAL' && run.statusReason ? (
                  <li>
                    {run.statusReason}{' '}
                    <Link className="text-brand-700 underline" to={`/b/${businessId}/approvals`}>
                      Review in Approvals
                    </Link>
                  </li>
                ) : null}
              </ul>
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {run.status === 'AWAITING_APPROVAL' ? (
              <Button
                variant="secondary"
                onPress={() => {
                  void act(
                    () => api<{ run: Run }>(`${base}/runs/${run.id}/resume`, { method: 'POST' }),
                    'Checked the decision.',
                  );
                }}
              >
                Continue after the decision
              </Button>
            ) : null}
            {['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status) ? (
              <Button
                variant="danger"
                onPress={() => {
                  void act(() => api<{ run: Run }>(`${base}/runs/${run.id}/cancel`, { method: 'POST' }), 'Cancelled.');
                }}
              >
                Cancel this run
              </Button>
            ) : null}
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer">Steps ({String(run.steps.length)})</summary>
            <ol className="mt-2 list-decimal pl-5">
              {run.steps.map((s) => (
                <li key={s.seq}>
                  {humanize(s.kind)}
                  {s.tool ? `: ${s.tool.replaceAll('_', ' ')}` : ''}
                  {s.errorCode ? ` — refused (${s.errorCode})` : ''}
                </li>
              ))}
            </ol>
          </details>
        </section>
      ) : null}

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="section-title">
          Earlier questions
        </h2>
        {(runs.data?.runs ?? []).length === 0 ? (
          <p className="text-sm text-ink-600">None yet.</p>
        ) : (
          <Table caption="Earlier questions" headers={['When', 'Assistant', 'Question', 'Status', '']}>
            {(runs.data?.runs ?? []).map((r) => (
              <tr key={r.id}>
                <td className={cell}>{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                <td className={cell}>{agents.find((a) => a.key === r.agent)?.name ?? humanize(r.agent)}</td>
                <td className={`${cell} break-words`}>{r.question}</td>
                <td className={cell}>
                  <Badge tone={statusTone(r.status === 'LIMIT_REACHED' ? 'FAILED' : r.status)}>
                    {humanize(r.status)}
                  </Badge>
                </td>
                <td className={cell}>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setOpen(r.id);
                    }}
                  >
                    Show answer {new Date(r.createdAt).toLocaleTimeString('en-IN')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </Page>
  );
}
