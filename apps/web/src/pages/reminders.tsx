// Reminders (increment 6.7 for FR-REM-1): settings and templates per type, a
// run for today, and the drafts waiting for review. Drafted reminders are
// messages: approving and sending goes through the same consent checks.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api.ts';
import { useBusiness } from '../business.ts';
import {
  Alert,
  Button,
  cell,
  Checkbox,
  errorText,
  Field,
  humanize,
  NativeSelect,
  Page,
  Table,
  TextArea,
} from '../ui.tsx';
import { MessageActions, StatusWithReason, type Msg } from './customer-crm.tsx';

interface Setting {
  type: string;
  enabled: boolean;
  autoSend: boolean;
  channel: string;
  template: string;
  days: number;
  purpose: 'MARKETING' | 'TRANSACTIONAL';
}
interface Reminder {
  id: string;
  type: string;
  customerId: string;
  customerName: string;
  dueDate: string;
  messageId: string;
  messageStatus: string;
  body: string;
}
interface Run {
  date: string;
  created: { type: string; customerId: string }[];
  skipped: { type: string; customerId: string; reason: string; missing?: string[] }[];
  alreadyDrafted: number;
}

const TYPES: Readonly<Record<string, { title: string; days: string; placeholders: string }>> = {
  BIRTHDAY: {
    title: 'Birthday',
    days: 'Days before the birthday',
    placeholders: '{name} {shop}',
  },
  WARRANTY_EXPIRY: {
    title: 'Warranty ending',
    days: 'Days before the warranty ends',
    placeholders: '{name} {shop} {model} {imei_last4} {warranty_end}',
  },
  SERVICE_DUE: {
    title: 'Service due',
    days: 'Days after the sale of a phone',
    placeholders: '{name} {shop} {model} {imei_last4} {service_date}',
  },
  PAYMENT_DUE: {
    title: 'Payment due',
    days: 'Days an unpaid bill has been open',
    placeholders: '{name} {shop} {amount_due}',
  },
};
const SKIP_REASONS: Readonly<Record<string, string>> = {
  NO_CONSENT: 'no marketing consent',
  MISSING_FIELD: 'a detail the text needs is not recorded',
  NO_ADDRESS: 'no address for the channel',
};

function SettingForm(props: { base: string; setting: Setting; canEdit: boolean; canApprove: boolean }) {
  const s = props.setting;
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(s.enabled);
  const [autoSend, setAutoSend] = useState(s.autoSend);
  const [channel, setChannel] = useState(s.channel);
  const [days, setDays] = useState(String(s.days));
  const [template, setTemplate] = useState(s.template);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const meta = TYPES[s.type] ?? { title: humanize(s.type), days: 'Days', placeholders: '' };
  const id = `setting-${s.type}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="section-title">
        {meta.title} <span className="text-sm font-normal text-ink-600">({humanize(s.purpose)})</span>
      </h2>
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          setNotice(null);
          api(`${props.base}/reminders/settings/${s.type}`, {
            method: 'PUT',
            body: { enabled, autoSend, channel, template, days: Number(days) },
          }).then(
            async () => {
              setNotice({ text: `${meta.title} reminder saved.`, tone: 'success' });
              await queryClient.invalidateQueries();
            },
            (err: unknown) => {
              const problems = err instanceof ApiError ? err.problems : [];
              setNotice({ text: problems.length > 0 ? problems.join(' ') : errorText(err), tone: 'error' });
            },
          );
        }}
      >
        <div className="flex flex-wrap gap-x-6">
          <Checkbox label="Turned on" name={`${id}-enabled`} checked={enabled} onChange={setEnabled} />
          <Checkbox
            label={
              props.canApprove || s.autoSend
                ? 'Send automatically (still checks consent and quiet hours)'
                : 'Send automatically (needs an approver)'
            }
            name={`${id}-auto`}
            checked={autoSend}
            onChange={setAutoSend}
          />
        </div>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <NativeSelect
            label="Channel"
            name={`${id}-channel`}
            value={channel}
            onChange={setChannel}
            options={[
              ['WHATSAPP', 'WhatsApp'],
              ['SMS', 'SMS'],
              ['EMAIL', 'Email'],
            ]}
          />
          <Field label={meta.days} name={`${id}-days`} value={days} onChange={setDays} inputMode="numeric" />
        </div>
        <TextArea
          label="Message text"
          name={`${id}-template`}
          value={template}
          onChange={setTemplate}
          description={`You can use: ${meta.placeholders}. A customer missing one of these is skipped.`}
        />
        {props.canEdit ? <Button type="submit">Save</Button> : null}
      </Form>
    </section>
  );
}

export function RemindersPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const settings = useQuery({
    queryKey: ['reminder-settings', businessId],
    queryFn: () => api<{ settings: Setting[] }>(`${base}/reminders/settings`),
  });
  const reminders = useQuery({
    queryKey: ['reminders', businessId],
    queryFn: () => api<{ reminders: Reminder[] }>(`${base}/reminders`),
  });
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const canEdit = business.can('marketing.draft');
  const purposeOf = (type: string) => settings.data?.settings.find((s) => s.type === type)?.purpose ?? 'MARKETING';
  const nameOf = (id: string) => reminders.data?.reminders.find((r) => r.customerId === id)?.customerName;
  return (
    <Page
      eyebrow="Customers"
      title="Reminders"
      description="Reminders are drafted for you to review. Nothing is sent without consent, and offers only between 9:00 and 21:00."
      actions={
        canEdit ? (
          <Button
            onPress={() => {
              setNotice(null);
              api<{ run: Run }>(`${base}/reminders/run`, { method: 'POST', body: {} }).then(
                async (r) => {
                  setRun(r.run);
                  setNotice({
                    text: `Run for ${r.run.date}: ${String(r.run.created.length)} drafted, ${String(r.run.skipped.length)} skipped.`,
                    tone: 'success',
                  });
                  await queryClient.invalidateQueries();
                },
                (err: unknown) => {
                  setNotice({ text: errorText(err), tone: 'error' });
                },
              );
            }}
          >
            Run reminders now
          </Button>
        ) : null
      }
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {run && run.skipped.length > 0 ? (
        <section aria-labelledby="skipped-heading">
          <h2 id="skipped-heading" className="section-title">
            Skipped in this run
          </h2>
          <ul className="list-disc pl-5 text-sm">
            {run.skipped.map((s, i) => (
              <li key={`${s.customerId}-${String(i)}`}>
                {TYPES[s.type]?.title ?? s.type}:{' '}
                <Link className="link" to={`/b/${businessId}/customers/${s.customerId}`}>
                  {nameOf(s.customerId) ?? 'customer'}
                </Link>{' '}
                — {SKIP_REASONS[s.reason] ?? s.reason}
                {s.missing ? ` (${s.missing.join(', ')})` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="drafted-heading">
        <h2 id="drafted-heading" className="section-title">
          Drafted reminders
        </h2>
        {(reminders.data?.reminders ?? []).length === 0 ? (
          <p className="text-sm text-ink-600">No reminders yet.</p>
        ) : (
          <Table caption="Drafted reminders" headers={['Type', 'Customer', 'Due', 'Text', 'Status', 'Actions']}>
            {(reminders.data?.reminders ?? []).map((r) => (
              <tr key={r.id}>
                <td className={cell}>{TYPES[r.type]?.title ?? r.type}</td>
                <td className={cell}>
                  <Link className="link" to={`/b/${businessId}/customers/${r.customerId}`}>
                    {r.customerName}
                  </Link>
                </td>
                <td className={cell}>{r.dueDate}</td>
                <td className={`${cell} max-w-xs break-words`}>{r.body}</td>
                <td className={cell}>
                  <StatusWithReason status={r.messageStatus} reason={null} />
                </td>
                <td className={cell}>
                  <MessageActions
                    base={base}
                    message={{ id: r.messageId, purpose: purposeOf(r.type), status: r.messageStatus } as Msg}
                    can={business.can}
                    onDone={setNotice}
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      {(settings.data?.settings ?? []).map((s) => (
        <SettingForm
          key={s.type}
          base={base}
          setting={s}
          canEdit={canEdit}
          canApprove={business.can('marketing.approve')}
        />
      ))}
    </Page>
  );
}
