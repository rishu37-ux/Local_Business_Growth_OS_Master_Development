// Campaigns (increment 7.7 for FR-AIC-3 AC1, FR-AIC-4 AC2, FR-MSG-4): one
// approved text to a tag segment on one channel. The approver approves the
// exact version shown; any edit is a new draft version. Sending checks consent,
// opt-outs and quiet hours for every customer; counts come from the messages.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api } from '../api.ts';
import { useBusiness } from '../business.ts';
import {
  Alert,
  Badge,
  Button,
  cell,
  errorText,
  Field,
  humanize,
  NativeSelect,
  Page,
  statusTone,
  Table,
  TextArea,
} from '../ui.tsx';
import type { Draft } from './studio.tsx';

interface Counts {
  recipients: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  blocked: number;
  failed: number;
  cancelled: number;
}
interface Campaign {
  id: string;
  name: string;
  channel: string;
  body: string;
  draftId: string | null;
  segmentTags: string[];
  segmentMatch: 'ANY' | 'ALL';
  version: number;
  contentSha256: string;
  status: string;
  statusReason: string | null;
  scheduledAt: string | null;
  approvedBy: string | null;
  audienceCount: number | null;
  excludedCount: number | null;
  counts: Counts;
}
interface Audience {
  members: number;
  eligible: number;
  noAddress: number;
  noConsent: number;
  suppressed: number;
}
const CHANNELS = [
  ['WHATSAPP', 'WhatsApp'],
  ['SMS', 'SMS'],
  ['EMAIL', 'Email'],
] as const;
const channelName = (c: string) => CHANNELS.find(([k]) => k === c)?.[1] ?? c;
const tagsText = (c: Pick<Campaign, 'segmentTags' | 'segmentMatch'>) =>
  c.segmentTags.length === 0
    ? 'All customers'
    : `Tagged ${c.segmentTags.join(c.segmentMatch === 'ALL' ? ' and ' : ' or ')}`;

/** "2026-11-02T18:30" (local) → ISO with offset. */
function localToIso(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function CampaignsPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const list = useQuery({
    queryKey: ['campaigns', businessId],
    queryFn: () => api<{ campaigns: Campaign[]; provider: { configured: boolean } }>(`${base}/campaigns`),
  });
  const drafts = useQuery({
    queryKey: ['drafts', businessId],
    queryFn: () => api<{ drafts: Draft[] }>(`${base}/studio/drafts`),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('WHATSAPP');
  const [source, setSource] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [match, setMatch] = useState('ANY');
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
  const approvedCaptions = (drafts.data?.drafts ?? []).filter(
    (d) => d.kind === 'CAPTION' && d.status === 'APPROVED' && d.approvedSha256 === d.contentSha256,
  );
  const rows = list.data?.campaigns ?? [];
  const current = rows.find((c) => c.id === open) ?? null;
  return (
    <Page
      eyebrow="Marketing"
      title="Campaigns"
      description="Send one approved message to a group of customers. Only customers who agreed to marketing and have not opted out receive it."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {list.data && !list.data.provider.configured ? (
        <Alert message="No messaging provider is connected and tested yet, so campaigns cannot be sent. Drafting and approval work." />
      ) : null}
      <section aria-labelledby="campaigns-heading">
        <h2 id="campaigns-heading" className="section-title">
          Campaigns
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-600">No campaigns yet.</p>
        ) : (
          <Table caption="Campaigns" headers={['Name', 'Channel', 'Who', 'Status', 'Sent / blocked / failed', '']}>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className={cell}>{c.name}</td>
                <td className={cell}>{channelName(c.channel)}</td>
                <td className={cell}>{tagsText(c)}</td>
                <td className={cell}>
                  <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                  {c.scheduledAt && c.status === 'SCHEDULED' ? (
                    <p className="text-xs text-ink-600">{new Date(c.scheduledAt).toLocaleString('en-IN')}</p>
                  ) : null}
                </td>
                <td className={cell}>
                  {String(c.counts.sent)} / {String(c.counts.blocked)} / {String(c.counts.failed)}
                </td>
                <td className={cell}>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setOpen(c.id === open ? null : c.id);
                    }}
                  >
                    {c.id === open ? `Close ${c.name}` : `Open ${c.name}`}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      {current ? (
        <CampaignDetail
          key={`${current.id}-${String(current.version)}`}
          base={base}
          campaign={current}
          can={business.can}
          run={run}
        />
      ) : null}
      {business.can('marketing.draft') ? (
        <section aria-labelledby="new-campaign-heading">
          <h2 id="new-campaign-heading" className="section-title">
            New campaign
          </h2>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api(`${base}/campaigns`, {
                    method: 'POST',
                    body: {
                      name: name.trim(),
                      channel,
                      ...(source ? { draftId: source } : { body: body.trim() }),
                      segmentTags: tags
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                      segmentMatch: match,
                    },
                  }),
                'Campaign saved as a draft.',
              ).then((ok) => {
                if (ok) {
                  setName('');
                  setBody('');
                }
              });
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Name" name="campaignName" value={name} onChange={setName} />
              <NativeSelect
                label="Channel"
                name="campaignChannel"
                value={channel}
                onChange={setChannel}
                options={CHANNELS}
              />
              <NativeSelect
                label="Text"
                name="campaignSource"
                value={source}
                onChange={setSource}
                options={[
                  ['', 'Type the text'],
                  ...approvedCaptions.map(
                    (d) => [d.id, `Approved Studio caption: ${(d.body ?? '').slice(0, 40)}…`] as const,
                  ),
                ]}
              />
              <Field
                label="Customer tags (comma separated; empty = all)"
                name="campaignTags"
                value={tags}
                onChange={setTags}
                isRequired={false}
              />
              <NativeSelect
                label="Match"
                name="campaignMatch"
                value={match}
                onChange={setMatch}
                options={[
                  ['ANY', 'Any of the tags'],
                  ['ALL', 'All of the tags'],
                ]}
              />
            </div>
            {source ? null : <TextArea label="Message" name="campaignBody" value={body} onChange={setBody} rows={4} />}
            <Button type="submit">Save campaign</Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}

function CampaignDetail(props: {
  base: string;
  campaign: Campaign;
  can: (permission: string) => boolean;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;
}) {
  const c = props.campaign;
  const url = `${props.base}/campaigns/${c.id}`;
  const detail = useQuery({
    queryKey: ['campaign', c.id, c.status, c.version],
    queryFn: () => api<{ audience: Audience }>(url),
  });
  const [text, setText] = useState(c.body);
  const [when, setWhen] = useState('');
  const editable = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED'].includes(c.status);
  const finished = ['COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED'].includes(c.status);
  const a = detail.data?.audience;
  return (
    <section aria-labelledby="campaign-detail-heading">
      <h2 id="campaign-detail-heading" className="section-title">
        {c.name}
      </h2>
      <p className="mb-3 text-sm text-ink-700">
        {channelName(c.channel)} · {tagsText(c)} · version {String(c.version)} · content{' '}
        <span className="font-mono">{c.contentSha256.slice(0, 8)}</span> ·{' '}
        <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
        {c.statusReason ? ` — ${c.statusReason}` : ''}
      </p>
      {c.draftId || !editable || !props.can('marketing.draft') ? (
        <blockquote className="mb-3 rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm break-words whitespace-pre-wrap">
          {c.body}
        </blockquote>
      ) : (
        <>
          <TextArea
            label="Message"
            name="campaignEdit"
            value={text}
            onChange={setText}
            rows={4}
            description="Saving a change makes a new version; an approval or schedule is cleared."
          />
          <div className="mb-3">
            <Button
              variant="secondary"
              isDisabled={text.trim() === c.body}
              onPress={() => {
                void props.run(
                  () => api(url, { method: 'PATCH', body: { body: text.trim() } }),
                  'Saved as a new version; it needs approval again.',
                );
              }}
            >
              Save as new version
            </Button>
          </div>
        </>
      )}
      {a && !finished && c.status !== 'RUNNING' ? (
        <dl data-testid="campaign-audience" className="mb-4 grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-600">Customers in the group</dt>
            <dd className="text-lg font-semibold">{String(a.members)}</dd>
          </div>
          <div>
            <dt className="text-ink-600">Would receive it now</dt>
            <dd className="text-lg font-semibold">{String(a.eligible)}</dd>
          </div>
          <div>
            <dt className="text-ink-600">Left out</dt>
            <dd>
              {String(a.noConsent)} without marketing consent, {String(a.suppressed)} opted out, {String(a.noAddress)}{' '}
              without a number or address
            </dd>
          </div>
        </dl>
      ) : null}
      {c.audienceCount !== null ? (
        <Table
          caption="Results"
          headers={[
            'In the group',
            'Left out at sending',
            'Messages',
            'Waiting',
            'Sent',
            'Delivered',
            'Blocked',
            'Failed',
            'Cancelled',
          ]}
        >
          <tr data-testid="campaign-results">
            <td className={cell}>{String(c.audienceCount)}</td>
            <td className={cell}>{String(c.excludedCount ?? 0)}</td>
            <td className={cell}>{String(c.counts.recipients)}</td>
            <td className={cell}>{String(c.counts.pending)}</td>
            <td className={cell}>{String(c.counts.sent)}</td>
            <td className={cell}>{String(c.counts.delivered)}</td>
            <td className={cell}>{String(c.counts.blocked)}</td>
            <td className={cell}>{String(c.counts.failed)}</td>
            <td className={cell}>{String(c.counts.cancelled)}</td>
          </tr>
        </Table>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        {props.can('marketing.draft') && c.status === 'DRAFT' ? (
          <Button
            onPress={() => {
              void props.run(() => api(`${url}/submit`, { method: 'POST' }), 'Sent for approval.');
            }}
          >
            Send for approval
          </Button>
        ) : null}
        {props.can('marketing.approve') && c.status === 'PENDING_APPROVAL' ? (
          <>
            <Button
              onPress={() => {
                void props.run(
                  () => api(`${url}/approve`, { method: 'POST', body: { contentSha256: c.contentSha256 } }),
                  'Approved: this exact version may be sent.',
                );
              }}
            >
              Approve this version
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                void props.run(
                  () => api(`${url}/return`, { method: 'POST', body: { reason: 'Returned for changes.' } }),
                  'Returned to draft.',
                );
              }}
            >
              Return for changes
            </Button>
          </>
        ) : null}
        {props.can('marketing.send') && (c.status === 'APPROVED' || c.status === 'SCHEDULED') ? (
          <Button
            onPress={() => {
              if (window.confirm(`Send "${c.name}" now to the customers who may receive it?`)) {
                void props.run(() => api(`${url}/send`, { method: 'POST' }), 'Campaign sent; see the results.');
              }
            }}
          >
            Send now
          </Button>
        ) : null}
        {props.can('marketing.send') && c.status === 'RUNNING' ? (
          <Button
            variant="secondary"
            onPress={() => {
              void props.run(
                () => api(`${url}/dispatch`, { method: 'POST' }),
                'Waiting messages were sent where allowed.',
              );
            }}
          >
            Send waiting messages
          </Button>
        ) : null}
        {props.can('marketing.send') && c.status === 'SCHEDULED' ? (
          <Button
            variant="secondary"
            onPress={() => {
              void props.run(() => api(`${url}/unschedule`, { method: 'POST' }), 'Schedule removed.');
            }}
          >
            Remove schedule
          </Button>
        ) : null}
        {props.can('marketing.draft') && !finished ? (
          <Button
            variant="danger"
            onPress={() => {
              void props.run(() => api(`${url}/cancel`, { method: 'POST' }), 'Campaign cancelled.');
            }}
          >
            Cancel campaign
          </Button>
        ) : null}
      </div>
      {props.can('marketing.send') && (c.status === 'APPROVED' || c.status === 'SCHEDULED') ? (
        <Form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const at = localToIso(when);
            void props.run(
              () => api(`${url}/schedule`, { method: 'POST', body: { at: at ?? '' } }),
              'Campaign scheduled.',
            );
          }}
        >
          <div className="mb-3 flex flex-col gap-1">
            <label htmlFor="campaign-when" className="text-sm font-medium text-ink-800">
              Send at (your local time)
            </label>
            <input
              id="campaign-when"
              type="datetime-local"
              value={when}
              onChange={(e) => {
                setWhen(e.target.value);
              }}
              className="w-full max-w-xs rounded-lg border border-ink-300 bg-white px-3 py-2 text-base"
            />
          </div>
          <Button type="submit" variant="secondary" isDisabled={!when}>
            Schedule
          </Button>
        </Form>
      ) : null}
    </section>
  );
}
