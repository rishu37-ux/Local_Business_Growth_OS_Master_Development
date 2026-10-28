// Offers (increment 7.7 for FR-AIC-2 AC1, AC3): drafted by marketing staff,
// approved by an approver; only an approved, current offer can be used in
// generated content. An approved offer is fixed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, formatPaise, rupeesToPaise } from '../api.ts';
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
} from '../ui.tsx';

export interface Offer {
  id: string;
  title: string;
  discountKind: 'PERCENT' | 'AMOUNT';
  discountValue: number;
  validFrom: string;
  validTo: string;
  terms: string | null;
  status: 'DRAFT' | 'APPROVED' | 'WITHDRAWN';
}

export const discountText = (o: Pick<Offer, 'discountKind' | 'discountValue'>) =>
  o.discountKind === 'PERCENT' ? `${String(o.discountValue / 100)}% off` : `${formatPaise(o.discountValue)} off`;

export function OffersPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const today = new Date().toISOString().slice(0, 10);
  const offers = useQuery({
    queryKey: ['offers', businessId],
    queryFn: () => api<{ offers: Offer[] }>(`${base}/offers`),
  });
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('PERCENT');
  const [value, setValue] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [terms, setTerms] = useState('');
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
  const approve = business.can('marketing.approve');
  const draft = business.can('marketing.draft');
  const rows = offers.data?.offers ?? [];
  return (
    <Page
      eyebrow="Marketing"
      title="Offers"
      description="Discounts that generated content may mention. Only an approved offer that has not ended can be used."
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <section aria-labelledby="offers-heading">
        <h2 id="offers-heading" className="section-title">
          Offers
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-600">No offers yet.</p>
        ) : (
          <Table caption="Offers" headers={['Offer', 'Discount', 'Valid', 'Status', '']}>
            {rows.map((o) => {
              const ended = o.validTo < today;
              return (
                <tr key={o.id}>
                  <td className={cell}>
                    {o.title}
                    {o.terms ? <p className="text-xs text-ink-600">{o.terms}</p> : null}
                  </td>
                  <td className={cell}>{discountText(o)}</td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {o.validFrom} to {o.validTo}
                    {ended ? <p className="text-xs text-red-800">Ended</p> : null}
                  </td>
                  <td className={cell}>
                    <Badge tone={statusTone(o.status)}>{humanize(o.status)}</Badge>
                  </td>
                  <td className={cell}>
                    {approve && o.status === 'DRAFT' ? (
                      <Button
                        onPress={() => {
                          void run(() => api(`${base}/offers/${o.id}/approve`, { method: 'POST' }), 'Offer approved.');
                        }}
                      >
                        Approve {o.title}
                      </Button>
                    ) : null}{' '}
                    {approve && o.status !== 'WITHDRAWN' ? (
                      <Button
                        variant="secondary"
                        onPress={() => {
                          void run(
                            () => api(`${base}/offers/${o.id}/withdraw`, { method: 'POST' }),
                            'Offer withdrawn.',
                          );
                        }}
                      >
                        Withdraw {o.title}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>
      {draft ? (
        <section aria-labelledby="add-offer-heading">
          <h2 id="add-offer-heading" className="section-title">
            New offer
          </h2>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              const amount = kind === 'PERCENT' ? Math.round(Number(value) * 100) : (rupeesToPaise(value) ?? 0);
              void run(
                () =>
                  api(`${base}/offers`, {
                    method: 'POST',
                    body: {
                      title: title.trim(),
                      discountKind: kind,
                      discountValue: Number.isFinite(amount) ? amount : 0,
                      validFrom: from,
                      validTo: to,
                      terms: terms.trim() || null,
                    },
                  }),
                'Offer saved as a draft. An approver must approve it before use.',
              ).then((ok) => {
                if (ok) {
                  setTitle('');
                  setValue('');
                  setTerms('');
                }
              });
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Title" name="offerTitle" value={title} onChange={setTitle} />
              <NativeSelect
                label="Discount type"
                name="offerKind"
                value={kind}
                onChange={setKind}
                options={[
                  ['PERCENT', 'Percentage'],
                  ['AMOUNT', 'Amount in rupees'],
                ]}
              />
              <Field
                label={kind === 'PERCENT' ? 'Discount (%)' : 'Discount (₹)'}
                name="offerValue"
                value={value}
                onChange={setValue}
                inputMode="numeric"
              />
              <Field label="Valid from (YYYY-MM-DD)" name="offerFrom" value={from} onChange={setFrom} />
              <Field label="Valid to (YYYY-MM-DD)" name="offerTo" value={to} onChange={setTo} />
              <Field label="Terms (optional)" name="offerTerms" value={terms} onChange={setTerms} isRequired={false} />
            </div>
            <Button type="submit">Save offer</Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}
