// Customer profile sections for increment 6.7: optional details (FR-CRM-1 AC1),
// owned units and warranty (FR-CRM-1 AC2), consent and opt-out (FR-CON-1),
// communications (FR-CON-1 AC3), erasure (FR-PRV-1 AC2) and the customer
// export (FR-CRM-2 AC2). The API enforces every permission and rule again.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link } from 'react-router';
import { api } from '../api.ts';
import {
  Alert,
  Badge,
  Button,
  cell,
  Checkbox,
  errorText,
  Field,
  humanize,
  NativeSelect,
  statusTone,
  Table,
  TextArea,
} from '../ui.tsx';

export interface CrmCustomer {
  id: string;
  name: string;
  mobileE164: string | null;
  email: string | null;
  alternateMobileE164: string | null;
  dob: string | null;
  tags: string[];
  contactChannels: string[];
  notes: string | null;
  erased: boolean;
}

type Can = (permission: string) => boolean;
type Notice = { text: string; tone: 'error' | 'success' } | null;

const CHANNELS = [
  ['WHATSAPP', 'WhatsApp'],
  ['SMS', 'SMS'],
  ['EMAIL', 'Email'],
] as const;
const PURPOSES = [
  ['TRANSACTIONAL', 'Transactional (bills, receipts, service updates)'],
  ['MARKETING', 'Marketing (offers, reminders)'],
] as const;
const channelLabel = (c: string) => CHANNELS.find(([k]) => k === c)?.[1] ?? (c === 'CALL' ? 'Phone call' : c);

/** Plain words for the reasons a message was blocked or failed. */
export const REASONS: Readonly<Record<string, string>> = {
  SUPPRESSED: 'the contact opted out',
  NO_MARKETING_CONSENT: 'no marketing consent recorded',
  CONSENT_WITHDRAWN: 'consent was withdrawn',
  CUSTOMER_ERASED: 'the customer’s data was erased',
  NO_ADDRESS: 'no address for this channel',
  PROVIDER_NOT_CONFIGURED: 'no messaging provider is connected',
  PROVIDER_ERROR: 'the provider could not be reached',
};
export const reasonText = (r: string | null) => (r ? (REASONS[r] ?? humanize(r)) : '');

function useRun(setNotice: (n: Notice) => void) {
  const queryClient = useQueryClient();
  return async (fn: () => Promise<unknown>, ok: string) => {
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
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export function ProfileDetails(props: { base: string; customer: CrmCustomer; can: Can }) {
  const c = props.customer;
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(c.email ?? '');
  const [alt, setAlt] = useState(c.alternateMobileE164 ?? '');
  const [dob, setDob] = useState(c.dob ?? '');
  const [tags, setTags] = useState(c.tags.join(', '));
  const [channels, setChannels] = useState<string[]>(c.contactChannels);
  const [notes, setNotes] = useState(c.notes ?? '');
  const [notice, setNotice] = useState<Notice>(null);
  const run = useRun(setNotice);
  const rows: [string, string][] = [
    ['Mobile', c.mobileE164 ?? '—'],
    ['Alternate mobile', c.alternateMobileE164 ?? '—'],
    ['Email', c.email ?? '—'],
    ['Date of birth', c.dob ?? '—'],
    ['Tags', c.tags.length > 0 ? c.tags.join(', ') : '—'],
    ['Preferred channels', c.contactChannels.length > 0 ? c.contactChannels.map(channelLabel).join(', ') : '—'],
    ['Notes', c.notes ?? '—'],
  ];
  return (
    <section aria-labelledby="details-heading">
      <h2 id="details-heading" className="section-title">
        Details
      </h2>
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {c.erased ? (
        <p className="mb-3 text-sm text-ink-700">
          This customer’s personal data was erased. Issued invoices keep the details printed on them.
        </p>
      ) : null}
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-ink-500">{k}</dt>
            <dd className="mt-0.5 font-medium break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {props.can('customers.manage') && !c.erased && !editing ? (
        <div className="mt-4">
          <Button
            variant="secondary"
            onPress={() => {
              setEditing(true);
            }}
          >
            Edit details
          </Button>
        </div>
      ) : null}
      {editing ? (
        <Form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api(`${props.base}/customers/${c.id}`, {
                  method: 'PATCH',
                  body: {
                    email: email.trim() || null,
                    alternateMobile: alt.trim() || null,
                    dob: dob.trim() || null,
                    tags: tags
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                    contactChannels: channels,
                    notes: notes.trim() || null,
                  },
                }),
              'Details saved.',
            ).then((ok) => {
              if (ok) setEditing(false);
            });
          }}
        >
          <p className="mb-3 text-sm text-ink-600">All of these are optional. Only name and mobile are required.</p>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Email (optional)" name="editEmail" value={email} onChange={setEmail} isRequired={false} />
            <Field
              label="Alternate mobile (optional)"
              name="editAlt"
              value={alt}
              onChange={setAlt}
              isRequired={false}
            />
            <Field
              label="Date of birth, YYYY-MM-DD (optional)"
              name="editDob"
              value={dob}
              onChange={setDob}
              isRequired={false}
            />
            <Field
              label="Tags, separated by commas (optional, up to 10)"
              name="editTags"
              value={tags}
              onChange={setTags}
              isRequired={false}
            />
          </div>
          <fieldset className="mb-3">
            <legend className="mb-1 text-sm font-medium text-ink-800">
              Preferred channels (a preference, not consent)
            </legend>
            <div className="flex flex-wrap gap-x-5">
              {['WHATSAPP', 'SMS', 'EMAIL', 'CALL'].map((ch) => (
                <Checkbox
                  key={ch}
                  label={channelLabel(ch)}
                  name={`channel-${ch}`}
                  checked={channels.includes(ch)}
                  onChange={(on) => {
                    setChannels(on ? [...channels, ch] : channels.filter((x) => x !== ch));
                  }}
                />
              ))}
            </div>
          </fieldset>
          <TextArea label="Notes (optional)" name="editNotes" value={notes} onChange={setNotes} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Save details</Button>
            <Button
              variant="secondary"
              onPress={() => {
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </Form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Owned units and warranty
// ---------------------------------------------------------------------------

interface OwnedItem {
  invoiceId: string;
  invoiceNumber: string | null;
  saleDate: string;
  description: string;
  imeis: string[];
  serialNumber: string | null;
  warrantyMonths: number | null;
  warrantyProvider: string | null;
  warrantyEnd: string | null;
}

export function OwnedItems(props: { base: string; businessId: string; customerId: string }) {
  const items = useQuery({
    queryKey: ['owned', props.businessId, props.customerId],
    queryFn: () => api<{ items: OwnedItem[] }>(`${props.base}/customers/${props.customerId}/owned-items`),
  });
  const list = items.data?.items ?? [];
  return (
    <section aria-labelledby="owned-heading">
      <h2 id="owned-heading" className="section-title">
        Phones and items owned
      </h2>
      <p className="mb-3 text-sm text-ink-600">Warranty end = sale date + the warranty months recorded at the sale.</p>
      {list.length === 0 ? (
        <p className="text-sm text-ink-600">No phones or warranty items bought here yet.</p>
      ) : (
        <Table
          caption="Phones and items owned"
          headers={['Item', 'IMEI / serial', 'Sold on', 'Invoice', 'Warranty ends']}
        >
          {list.map((i, n) => (
            <tr key={`${i.invoiceId}-${String(n)}`}>
              <td className={cell}>{i.description}</td>
              <td className={cell}>{i.imeis.length > 0 ? i.imeis.join(' / ') : (i.serialNumber ?? '—')}</td>
              <td className={cell}>{i.saleDate}</td>
              <td className={cell}>
                <Link className="link" to={`/b/${props.businessId}/invoices/${i.invoiceId}`}>
                  {i.invoiceNumber ?? 'Invoice'}
                </Link>
              </td>
              <td className={cell}>
                {i.warrantyEnd
                  ? `${i.warrantyEnd}${i.warrantyProvider ? ` (${i.warrantyProvider})` : ''}`
                  : i.warrantyMonths === null
                    ? 'Not recorded'
                    : 'No warranty'}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Consent and opt-out
// ---------------------------------------------------------------------------

interface ChannelState {
  channel: string;
  address: string | null;
  suppressed: boolean;
  transactional: string | null;
  marketing: string | null;
  transactionalAllowed: boolean;
  marketingAllowed: boolean;
}
interface ConsentRecord {
  id: string;
  channel: string;
  purpose: string;
  status: string;
  source: string;
  recordedAt: string;
}

const allowed = (ok: boolean) => <Badge tone={ok ? 'success' : 'neutral'}>{ok ? 'Allowed' : 'Not allowed'}</Badge>;

export function ConsentSection(props: { base: string; businessId: string; customer: CrmCustomer; can: Can }) {
  const c = props.customer;
  const consents = useQuery({
    queryKey: ['consents', props.businessId, c.id],
    queryFn: () =>
      api<{ consents: { channels: ChannelState[]; history: ConsentRecord[] } }>(
        `${props.base}/customers/${c.id}/consents`,
      ),
  });
  const [channel, setChannel] = useState('WHATSAPP');
  const [purpose, setPurpose] = useState('MARKETING');
  const [status, setStatus] = useState('GRANTED');
  const [source, setSource] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const run = useRun(setNotice);
  const data = consents.data?.consents;
  const manage = props.can('customers.manage') && !c.erased;
  return (
    <section aria-labelledby="consent-heading">
      <h2 id="consent-heading" className="section-title">
        Consent and opt-out
      </h2>
      <p className="mb-3 text-sm text-ink-600">
        Bills and service messages are allowed unless the customer said no. Offers and reminders need the customer’s
        recorded yes for that channel. Checked again at the moment of sending.
      </p>
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <Table caption="Consent by channel" headers={['Channel', 'Address', 'Transactional', 'Marketing', 'Opt-out']}>
        {(data?.channels ?? []).map((s) => (
          <tr key={s.channel}>
            <td className={cell}>{channelLabel(s.channel)}</td>
            <td className={cell}>{s.address ?? '—'}</td>
            <td className={cell}>{allowed(s.transactionalAllowed)}</td>
            <td className={cell}>{allowed(s.marketingAllowed)}</td>
            <td className={cell}>
              {s.suppressed ? (
                <Badge tone="danger">Opted out</Badge>
              ) : manage && s.address ? (
                <Button
                  variant="secondary"
                  onPress={() => {
                    void run(
                      () =>
                        api(`${props.base}/customers/${c.id}/opt-out`, {
                          method: 'POST',
                          body: { channel: s.channel },
                        }),
                      `Opted out of ${channelLabel(s.channel)}.`,
                    );
                  }}
                >
                  Opt out of {channelLabel(s.channel)}
                </Button>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </Table>
      {manage ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api(`${props.base}/customers/${c.id}/consents`, {
                  method: 'POST',
                  body: { channel, purpose, status, source },
                }),
              'Consent recorded.',
            ).then((ok) => {
              if (ok) setSource('');
            });
          }}
        >
          <h3 className="mb-2 font-semibold">Record consent</h3>
          <div className="grid gap-x-3 sm:grid-cols-3">
            <NativeSelect
              label="Channel"
              name="consentChannel"
              value={channel}
              onChange={setChannel}
              options={CHANNELS}
            />
            <NativeSelect
              label="Purpose"
              name="consentPurpose"
              value={purpose}
              onChange={setPurpose}
              options={PURPOSES}
            />
            <NativeSelect
              label="Answer"
              name="consentStatus"
              value={status}
              onChange={setStatus}
              options={[
                ['GRANTED', 'Yes, agreed'],
                ['WITHDRAWN', 'No / withdrawn'],
              ]}
            />
          </div>
          <Field
            label="How it was given (e.g. asked at the counter, signed form)"
            name="consentSource"
            value={source}
            onChange={setSource}
          />
          <Button type="submit">Record consent</Button>
        </Form>
      ) : null}
      {data && data.history.length > 0 ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">Consent history</summary>
          <Table caption="Consent history" headers={['When', 'Channel', 'Purpose', 'Answer', 'How']}>
            {data.history.map((h) => (
              <tr key={h.id}>
                <td className={cell}>{new Date(h.recordedAt).toLocaleString('en-IN')}</td>
                <td className={cell}>{channelLabel(h.channel)}</td>
                <td className={cell}>{humanize(h.purpose)}</td>
                <td className={cell}>{h.status === 'GRANTED' ? 'Yes' : 'No / withdrawn'}</td>
                <td className={cell}>{h.source}</td>
              </tr>
            ))}
          </Table>
        </details>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

export interface Msg {
  id: string;
  customerId: string | null;
  channel: string;
  purpose: string;
  origin: string;
  body: string;
  status: string;
  statusReason: string | null;
  createdAt: string;
  events: { status: string; reason: string | null; at: string }[];
}

/** Buttons that move a message along WORKFLOWS §9 for the member's permissions. */
export function MessageActions(props: { base: string; message: Msg; can: Can; onDone: (n: Notice) => void }) {
  const m = props.message;
  const run = useRun(props.onDone);
  const marketing = m.purpose === 'MARKETING';
  const act = (path: string, ok: string) => {
    void run(() => api(`${props.base}/messages/${m.id}/${path}`, { method: 'POST', body: {} }), ok);
  };
  const draftKey = marketing ? 'marketing.draft' : 'customers.manage';
  const approveKey = marketing ? 'marketing.approve' : 'customers.manage';
  const sendKey = marketing ? 'marketing.send' : 'customers.manage';
  return (
    <div className="flex flex-wrap gap-2">
      {m.status === 'DRAFT' && props.can(draftKey) ? (
        <Button
          variant="secondary"
          onPress={() => {
            act('submit', 'Sent for approval.');
          }}
        >
          Send for approval
        </Button>
      ) : null}
      {m.status === 'PENDING_APPROVAL' && props.can(approveKey) ? (
        <Button
          variant="secondary"
          onPress={() => {
            act('approve', 'Approved.');
          }}
        >
          Approve
        </Button>
      ) : null}
      {m.status === 'APPROVED' && props.can(sendKey) ? (
        <Button
          onPress={() => {
            act('send', 'Send attempted — see the status.');
          }}
        >
          Send
        </Button>
      ) : null}
      {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED'].includes(m.status) && props.can(draftKey) ? (
        <Button
          variant="secondary"
          onPress={() => {
            act('cancel', 'Cancelled.');
          }}
        >
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

export function StatusWithReason(props: { status: string; reason: string | null }) {
  return (
    <span className="flex flex-col gap-1">
      <Badge tone={statusTone(props.status)}>{humanize(props.status)}</Badge>
      {props.reason ? <span className="text-xs text-ink-600">Reason: {reasonText(props.reason)}</span> : null}
    </span>
  );
}

export function Communications(props: { base: string; businessId: string; customer: CrmCustomer; can: Can }) {
  const c = props.customer;
  const messages = useQuery({
    queryKey: ['messages', props.businessId, c.id],
    queryFn: () =>
      api<{ messages: Msg[]; provider: { configured: boolean } }>(`${props.base}/messages?customerId=${c.id}`),
  });
  const [channel, setChannel] = useState('WHATSAPP');
  const [purpose, setPurpose] = useState('TRANSACTIONAL');
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const run = useRun(setNotice);
  const canWrite = !c.erased && props.can(purpose === 'MARKETING' ? 'marketing.draft' : 'customers.manage');
  const create = (send: boolean) => {
    void run(
      () =>
        api(`${props.base}/messages`, {
          method: 'POST',
          body: { customerId: c.id, channel, purpose, body, send },
        }),
      send ? 'Send attempted — see the status below.' : 'Draft saved.',
    ).then((ok) => {
      if (ok) setBody('');
    });
  };
  const list = messages.data?.messages ?? [];
  return (
    <section aria-labelledby="comms-heading">
      <h2 id="comms-heading" className="section-title">
        Messages
      </h2>
      {messages.data && !messages.data.provider.configured ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No messaging provider is connected yet, so nothing is delivered: a message that passes the consent checks ends
          as “Failed — no messaging provider is connected”.
        </p>
      ) : null}
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {list.length === 0 ? <p className="mb-3 text-sm text-ink-600">No messages yet.</p> : null}
      {list.length > 0 ? (
        <Table caption="Messages" headers={['Created', 'Channel', 'Text', 'Status', 'History', 'Actions']}>
          {list.map((m) => (
            <tr key={m.id}>
              <td className={cell}>{new Date(m.createdAt).toLocaleString('en-IN')}</td>
              <td className={cell}>
                {channelLabel(m.channel)}
                <span className="block text-xs text-ink-600">{humanize(m.purpose)}</span>
              </td>
              <td className={`${cell} max-w-xs break-words`}>{m.body}</td>
              <td className={cell}>
                <StatusWithReason status={m.status} reason={m.statusReason} />
              </td>
              <td className={`${cell} text-xs`}>{m.events.map((e) => humanize(e.status)).join(' → ')}</td>
              <td className={cell}>
                <MessageActions base={props.base} message={m} can={props.can} onDone={setNotice} />
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {!c.erased && (props.can('customers.manage') || props.can('marketing.draft')) ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            create(false);
          }}
        >
          <h3 className="mb-2 font-semibold">New message</h3>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <NativeSelect label="Channel" name="msgChannel" value={channel} onChange={setChannel} options={CHANNELS} />
            <NativeSelect label="Purpose" name="msgPurpose" value={purpose} onChange={setPurpose} options={PURPOSES} />
          </div>
          <TextArea label="Message text" name="msgBody" value={body} onChange={setBody} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" isDisabled={!canWrite || body.trim() === ''}>
              Save draft
            </Button>
            {purpose === 'TRANSACTIONAL' ? (
              <Button
                variant="secondary"
                isDisabled={!canWrite || body.trim() === ''}
                onPress={() => {
                  create(true);
                }}
              >
                Send now
              </Button>
            ) : null}
          </div>
          {purpose === 'MARKETING' ? (
            <p className="mt-2 text-sm text-ink-600">Marketing messages are approved before they can be sent.</p>
          ) : null}
        </Form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Erasure (owner)
// ---------------------------------------------------------------------------

export function EraseSection(props: { base: string; customer: CrmCustomer }) {
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const run = useRun(setNotice);
  return (
    <section aria-labelledby="erase-heading">
      <h2 id="erase-heading" className="section-title">
        Erase personal data
      </h2>
      <p className="mb-3 text-sm text-ink-700">
        Removes the name, contact details, date of birth, notes and tags, withdraws all consent, stops every message and
        blanks past message texts. Invoices already issued keep what was printed on them (tax records). This cannot be
        undone. You may be asked to sign in again.
      </p>
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => api(`${props.base}/customers/${props.customer.id}/erase`, { method: 'POST', body: { reason } }),
            'Personal data erased.',
          );
        }}
      >
        <Field label="Reason (at least 10 characters)" name="eraseReason" value={reason} onChange={setReason} />
        <Button type="submit" variant="danger">
          Erase personal data
        </Button>
      </Form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Customer export (FR-CRM-2 AC2)
// ---------------------------------------------------------------------------

const EXPORT_FIELDS = [
  ['name', 'Name'],
  ['mobile', 'Mobile'],
  ['alternateMobile', 'Alternate mobile'],
  ['email', 'Email'],
  ['address', 'Address'],
  ['gstin', 'GSTIN'],
  ['stateCode', 'State code'],
  ['dob', 'Date of birth'],
  ['tags', 'Tags'],
  ['contactChannels', 'Preferred channels'],
  ['notes', 'Notes'],
  ['createdAt', 'Customer since'],
] as const;

export function CustomerExport(props: { base: string }) {
  const [fields, setFields] = useState<string[]>(['name', 'mobile']);
  const [tag, setTag] = useState('');
  const href = `${props.base}/customers/export?fields=${fields.join(',')}${tag.trim() ? `&tag=${encodeURIComponent(tag.trim())}` : ''}`;
  return (
    <section aria-labelledby="export-heading">
      <h2 id="export-heading" className="section-title">
        Export customers
      </h2>
      <p className="mb-3 text-sm text-ink-600">
        Choose only the fields you need. The file contains personal data; every export is recorded.
      </p>
      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium text-ink-800">Fields</legend>
        <div className="grid gap-x-4 sm:grid-cols-3">
          {EXPORT_FIELDS.map(([key, label]) => (
            <Checkbox
              key={key}
              label={label}
              name={`export-${key}`}
              checked={fields.includes(key)}
              onChange={(on) => {
                setFields(on ? [...fields, key] : fields.filter((f) => f !== key));
              }}
            />
          ))}
        </div>
      </fieldset>
      <Field
        label="Only customers with this tag (optional)"
        name="exportTag"
        value={tag}
        onChange={setTag}
        isRequired={false}
      />
      {fields.length > 0 ? (
        <a className="link" href={href}>
          Download CSV
        </a>
      ) : (
        <p className="text-sm text-ink-600">Choose at least one field.</p>
      )}
    </section>
  );
}
