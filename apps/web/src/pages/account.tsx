// Billing and support (increment 10.1/10.2: FR-SUP-1, FR-SUB-1 AC3): the
// platform's invoices to this business, and owner-granted, time-boxed support
// access with every support action listed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, formatPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';

interface BillingInvoice {
  id: string;
  number: string;
  planName: string;
  periodStart: string;
  periodEnd: string;
  amountPaise: number;
  status: 'ISSUED' | 'PAID' | 'VOID';
  paidOn: string | null;
  paymentReference: string | null;
}
interface SupportGrant {
  id: string;
  purpose: string;
  grantedAt: string;
  expiresAt: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}
interface SupportAction {
  at: string;
  action: string;
  method: string | null;
  route: string | null;
  refused: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN');
const ACTIONS: Record<string, string> = {
  'support.granted': 'Access granted',
  'support.revoked': 'Access revoked',
  'support.access': 'Viewed',
};
/** "/api/businesses/:businessId/customers/:id" → "customers / record". */
const place = (route: string | null) =>
  (route ?? '')
    .replace('/api/businesses/:businessId', '')
    .split('/')
    .filter(Boolean)
    .map((p) => (p.startsWith(':') ? 'record' : p))
    .join(' / ') || 'overview';

export function AccountPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const invoices = useQuery({
    queryKey: ['billing', businessId],
    queryFn: () => api<{ invoices: BillingInvoice[] }>(`${base}/billing-invoices`),
    enabled: business.can('subscription.manage'),
  });
  const support = useQuery({
    queryKey: ['support', businessId],
    queryFn: () => api<{ grants: SupportGrant[]; actions: SupportAction[] }>(`${base}/support`),
    enabled: business.can('support.grant'),
  });
  const [purpose, setPurpose] = useState('');
  const [hours, setHours] = useState('4');
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const done = async (text: string) => {
    setNotice({ text, tone: 'success' });
    await queryClient.invalidateQueries();
  };
  const failed = (err: unknown) => {
    setNotice({ text: errorText(err), tone: 'error' });
  };
  const grants = support.data?.grants ?? [];
  const actions = support.data?.actions ?? [];
  return (
    <Page
      eyebrow="Settings"
      title="Billing and support"
      description="What the platform has billed you, and who from platform support may look at your business."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {business.can('subscription.manage') ? (
        <section aria-labelledby="billing-heading">
          <h2 id="billing-heading" className="section-title">
            Invoices from the platform
          </h2>
          <p className="mb-2 text-sm text-ink-600">
            Pilot pricing, to be validated. GST is not yet shown on these invoices (it waits for a tax review). Payments
            are recorded by the platform team when they receive them.
          </p>
          {(invoices.data?.invoices ?? []).length === 0 ? (
            <p className="text-sm text-ink-600">No invoices yet.</p>
          ) : (
            <Table caption="Invoices from the platform" headers={['Number', 'Plan', 'Period', 'Amount', 'Status']}>
              {(invoices.data?.invoices ?? []).map((i) => (
                <tr key={i.id}>
                  <td className={cell}>{i.number}</td>
                  <td className={cell}>{i.planName}</td>
                  <td className={cell}>{`${i.periodStart} to ${i.periodEnd}`}</td>
                  <td className={cell}>{formatPaise(i.amountPaise)}</td>
                  <td className={cell}>
                    {i.status === 'PAID' ? (
                      <Badge tone="success">{`Paid on ${i.paidOn ?? ''}`}</Badge>
                    ) : i.status === 'VOID' ? (
                      <Badge tone="neutral">Cancelled</Badge>
                    ) : (
                      <Badge tone="warning">Due</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      ) : null}
      {business.can('support.grant') ? (
        <section aria-labelledby="support-heading">
          <h2 id="support-heading" className="section-title">
            Support access
          </h2>
          <p className="mb-2 text-sm text-ink-600">
            Platform support cannot see your business unless you allow it here. Access is view-only, ends by itself, and
            every page support opens is listed below. You can end it at any time.
          </p>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              api(`${base}/support/grants`, { method: 'POST', body: { purpose, hours: Number(hours) } })
                .then(async () => {
                  setPurpose('');
                  await done('Support access granted.');
                })
                .catch(failed);
            }}
          >
            <Field
              label="Why support needs access (at least 10 characters)"
              name="supportPurpose"
              value={purpose}
              onChange={setPurpose}
            />
            <NativeSelect
              label="For how long"
              name="supportHours"
              value={hours}
              onChange={setHours}
              options={[
                ['1', '1 hour'],
                ['4', '4 hours'],
                ['24', '24 hours'],
                ['72', '72 hours (the longest allowed)'],
              ]}
            />
            <Button type="submit" variant="secondary" isDisabled={purpose.trim().length < 10}>
              Allow support access
            </Button>
          </Form>
          {grants.length === 0 ? (
            <p className="mt-3 text-sm text-ink-600">Support has never had access.</p>
          ) : (
            <Table caption="Support access given" headers={['Purpose', 'Given', 'Ends', 'Status', '']}>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td className={cell}>{g.purpose}</td>
                  <td className={cell}>{when(g.grantedAt)}</td>
                  <td className={cell}>{when(g.expiresAt)}</td>
                  <td className={cell}>
                    {g.status === 'ACTIVE' ? (
                      <Badge tone="warning">Active</Badge>
                    ) : (
                      <Badge tone="neutral">{g.status === 'REVOKED' ? 'Ended by you' : 'Expired'}</Badge>
                    )}
                  </td>
                  <td className={cell}>
                    {g.status === 'ACTIVE' ? (
                      <Button
                        variant="secondary"
                        onPress={() => {
                          setNotice(null);
                          api(`${base}/support/grants/${g.id}/revoke`, { method: 'POST', body: {} })
                            .then(() => done('Support access ended.'))
                            .catch(failed);
                        }}
                      >
                        End access
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <h3 className="mt-4 mb-2 font-semibold">What support did</h3>
          {actions.length === 0 ? (
            <p className="text-sm text-ink-600">Nothing recorded.</p>
          ) : (
            <Table caption="What support did" headers={['When', 'What', 'Where']}>
              {actions.map((a, i) => (
                <tr key={`${a.at}-${String(i)}`}>
                  <td className={cell}>{when(a.at)}</td>
                  <td className={cell}>
                    {a.refused ? (
                      <Badge tone="danger">Tried to change (refused)</Badge>
                    ) : (
                      (ACTIONS[a.action] ?? a.action)
                    )}
                  </td>
                  <td className={cell}>{a.action === 'support.access' ? place(a.route) : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      ) : null}
    </Page>
  );
}
