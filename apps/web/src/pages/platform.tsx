// Platform review queue (BR-T2, BR-T3) and billing invoices with manual
// payment (FR-SUB-1 AC3, increment 10.2).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatPaise } from '../api.ts';
import { Alert, Badge, Button, cell, errorText, Field, Page, Table } from '../ui.tsx';

interface Application {
  businessId: string;
  legalName: string;
  status: string;
  stateCode: string | null;
  applicants: { email: string; displayName: string }[];
}

export function PlatformPage() {
  const queue = useQuery({
    queryKey: ['platform', 'applications'],
    queryFn: () => api<{ applications: Application[] }>('/api/platform/applications'),
  });
  return (
    <Page title="Applications to review">
      <Alert message={queue.error ? errorText(queue.error) : null} />
      {(queue.data?.applications ?? []).length === 0 ? <p>No applications waiting.</p> : null}
      <ul className="flex flex-col gap-4">
        {(queue.data?.applications ?? []).map((a) => (
          <ApplicationCard key={a.businessId} application={a} />
        ))}
      </ul>
      <Billing />
    </Page>
  );
}

function ApplicationCard({ application: a }: { application: Application }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string) => {
    setError(null);
    try {
      await api(`/api/platform/businesses/${a.businessId}/${path}`, { method: 'POST', body: reason ? { reason } : {} });
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <li className="card-inset">
      <h2 className="text-lg font-semibold">{a.legalName}</h2>
      <p className="mb-2 text-sm">
        {a.status.replaceAll('_', ' ').toLowerCase()} · state {a.stateCode ?? '—'} ·{' '}
        {a.applicants.map((p) => p.email).join(', ')}
      </p>
      <Alert message={error} />
      <Field
        label="Reason (required to reject or request changes)"
        name={`reason-${a.businessId}`}
        value={reason}
        onChange={setReason}
        isRequired={false}
      />
      <div className="flex flex-wrap gap-2">
        <Button onPress={() => void act('approve')}>Approve</Button>
        <Button variant="secondary" onPress={() => void act('request-changes')}>
          Request changes
        </Button>
        <Button variant="danger" onPress={() => void act('reject')}>
          Reject
        </Button>
      </div>
    </li>
  );
}

interface BillingInvoice {
  id: string;
  businessId: string;
  number: string;
  planName: string;
  periodStart: string;
  periodEnd: string;
  amountPaise: number;
  status: 'ISSUED' | 'PAID' | 'VOID';
  paidOn: string | null;
}

function Billing() {
  const queryClient = useQueryClient();
  const invoices = useQuery({
    queryKey: ['platform', 'billing'],
    queryFn: () => api<{ invoices: BillingInvoice[] }>('/api/platform/billing-invoices'),
  });
  const [businessId, setBusinessId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const send = async (path: string, body: object, text: string) => {
    setNotice(null);
    try {
      await api(path, { method: 'POST', body });
      setNotice({ text, tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    } catch (err) {
      setNotice({ text: errorText(err), tone: 'error' });
    }
  };
  return (
    <section aria-labelledby="billing-heading" className="mt-8">
      <h2 id="billing-heading" className="section-title">
        Billing invoices
      </h2>
      <p className="mb-2 text-sm text-ink-600">
        Issued at the plan price of today. GST is not computed until the tax review. No payment gateway is connected:
        record a payment only after you have seen it arrive.
      </p>
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label="Business ID" name="billBusiness" value={businessId} onChange={setBusinessId} />
        <Field label="Period start (YYYY-MM-DD)" name="billStart" value={periodStart} onChange={setPeriodStart} />
        <Field label="Period end (YYYY-MM-DD)" name="billEnd" value={periodEnd} onChange={setPeriodEnd} />
      </div>
      <Button
        variant="secondary"
        onPress={() =>
          void send('/api/platform/billing-invoices', { businessId, periodStart, periodEnd }, 'Invoice issued.')
        }
      >
        Issue invoice
      </Button>
      <div className="mt-4 grid gap-x-4 sm:grid-cols-3">
        <Field label="Payment reference" name="billReference" value={reference} onChange={setReference} />
        <Field label="Paid on (YYYY-MM-DD)" name="billPaidOn" value={paidOn} onChange={setPaidOn} />
        <Field
          label="Reason to cancel (at least 10 characters)"
          name="billReason"
          value={reason}
          onChange={setReason}
        />
      </div>
      {(invoices.data?.invoices ?? []).length === 0 ? (
        <p className="text-sm text-ink-600">No invoices yet.</p>
      ) : (
        <Table caption="Billing invoices" headers={['Number', 'Business', 'Period', 'Amount', 'Status', '']}>
          {(invoices.data?.invoices ?? []).map((i) => (
            <tr key={i.id}>
              <td className={cell}>{i.number}</td>
              <td className={cell}>{i.businessId.slice(0, 8)}</td>
              <td className={cell}>{`${i.periodStart} to ${i.periodEnd}`}</td>
              <td className={cell}>{formatPaise(i.amountPaise)}</td>
              <td className={cell}>
                <Badge tone={i.status === 'PAID' ? 'success' : i.status === 'VOID' ? 'neutral' : 'warning'}>
                  {i.status === 'PAID' ? `Paid (manual) ${i.paidOn ?? ''}` : i.status === 'VOID' ? 'Cancelled' : 'Due'}
                </Badge>
              </td>
              <td className={cell}>
                {i.status === 'ISSUED' ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onPress={() =>
                        void send(
                          `/api/platform/billing-invoices/${i.id}/payment`,
                          { reference, paidOn },
                          'Payment recorded.',
                        )
                      }
                    >
                      Record payment
                    </Button>
                    <Button
                      variant="danger"
                      onPress={() =>
                        void send(`/api/platform/billing-invoices/${i.id}/void`, { reason }, 'Invoice cancelled.')
                      }
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
