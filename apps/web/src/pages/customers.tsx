// Customers: list and search, and a customer's account — balance, what is
// owed, advance, payments and statement (increments 5.2, 5.4, 5.8); profile,
// consent, messages, erasure and export (increment 6.7).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
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
import {
  Communications,
  ConsentSection,
  CustomerExport,
  EraseSection,
  OwnedItems,
  ProfileDetails,
  type CrmCustomer,
} from './customer-crm.tsx';

interface Customer extends CrmCustomer {
  gstin: string | null;
  stateCode: string | null;
  address: string | null;
}
interface Account {
  balancePaise: number;
  receivablePaise: number;
  advancePaise: number;
  openInvoices: {
    id: string;
    number: string;
    date: string;
    outstandingPaise: number;
    totalPaise: number;
    status: string;
  }[];
  payments: {
    id: string;
    method: string;
    amountPaise: number;
    reference: string | null;
    receivedAt: string;
    reversesPaymentId: string | null;
    reversed: boolean;
  }[];
}
interface Statement {
  openingPaise: number;
  closingPaise: number;
  entries: { date: string; type: string; amountPaise: number; document: string | null; balancePaise: number }[];
}

const METHODS = [
  ['CASH', 'Cash'],
  ['UPI', 'UPI'],
  ['CARD', 'Card'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['OTHER', 'Other'],
] as const;

export function CustomersPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const list = useQuery({
    queryKey: ['customers', businessId, q],
    queryFn: () => api<{ customers: Customer[] }>(`${base}/customers?q=${encodeURIComponent(q)}`),
  });
  return (
    <Page eyebrow="Sales" title="Customers" description="Search by name or mobile number.">
      <section aria-labelledby="find-heading">
        <h2 id="find-heading" className="section-title">
          Find a customer
        </h2>
        <Field label="Name or mobile" name="customerSearch" value={q} onChange={setQ} isRequired={false} />
        <Table caption="Customers" headers={['Name', 'Mobile', 'GSTIN']}>
          {(list.data?.customers ?? []).map((c) => (
            <tr key={c.id}>
              <td className={cell}>
                <Link className="link" to={`/b/${businessId}/customers/${c.id}`}>
                  {c.name}
                </Link>
              </td>
              <td className={cell}>{c.mobileE164 ?? '—'}</td>
              <td className={cell}>{c.gstin ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </section>
      {business.can('customers.manage') ? (
        <section aria-labelledby="add-heading">
          <h2 id="add-heading" className="section-title">
            Add a customer
          </h2>
          <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(null);
              api(`${base}/customers`, { method: 'POST', body: { name, mobile } }).then(
                async () => {
                  setMessage({ text: `${name} added.`, tone: 'success' });
                  setName('');
                  setMobile('');
                  await queryClient.invalidateQueries({ queryKey: ['customers', businessId] });
                },
                (err: unknown) => {
                  setMessage({ text: errorText(err), tone: 'error' });
                },
              );
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-2">
              <Field label="Name" name="newCustomerName" value={name} onChange={setName} />
              <Field label="Mobile" name="newCustomerMobile" value={mobile} onChange={setMobile} inputMode="numeric" />
            </div>
            <Button type="submit">Add customer</Button>
          </Form>
        </section>
      ) : null}
      {business.can('customers.export') ? <CustomerExport base={base} /> : null}
    </Page>
  );
}

export function CustomerPage() {
  const { businessId = '', customerId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const customer = useQuery({
    queryKey: ['customer', businessId, customerId],
    queryFn: () => api<{ customer: Customer }>(`${base}/customers/${customerId}`),
  });
  const canLedger = business.can('customer_ledger.view');
  const account = useQuery({
    queryKey: ['account', businessId, customerId],
    queryFn: () => api<{ account: Account }>(`${base}/customers/${customerId}/account`),
    enabled: canLedger,
  });
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const range = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const statement = useQuery({
    queryKey: ['statement', businessId, customerId, from, to],
    queryFn: () => api<{ statement: Statement }>(`${base}/customers/${customerId}/statement?from=${from}&to=${to}`),
    enabled: canLedger && range,
  });
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [refund, setRefund] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ text: ok, tone: 'success' });
      await queryClient.invalidateQueries();
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  const c = customer.data?.customer;
  const a = account.data?.account;
  return (
    <Page
      eyebrow="Customer"
      title={c?.name ?? 'Customer'}
      description={c ? [c.mobileE164, c.gstin ? `GSTIN ${c.gstin}` : null].filter(Boolean).join(' · ') : 'Loading…'}
    >
      <Alert
        message={message?.text ?? (customer.error ? errorText(customer.error) : null)}
        tone={message?.tone ?? 'error'}
      />
      {c ? <ProfileDetails key={`${c.id}-${String(c.erased)}`} base={base} customer={c} can={business.can} /> : null}
      {a ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <div className="card mb-0">
            <p className="text-sm text-ink-600">Balance</p>
            <p className="text-2xl font-semibold" data-testid="customer-balance">
              {formatPaise(Math.abs(a.balancePaise))}
            </p>
            <p className="text-xs text-ink-600">
              {a.balancePaise > 0
                ? 'The customer owes the shop.'
                : a.balancePaise < 0
                  ? 'Advance held for the customer.'
                  : 'Nothing owed.'}
            </p>
          </div>
          <div className="card mb-0">
            <p className="text-sm text-ink-600">Amount due</p>
            <p className="text-2xl font-semibold">{formatPaise(a.receivablePaise)}</p>
          </div>
          <div className="card mb-0">
            <p className="text-sm text-ink-600">Advance held</p>
            <p className="text-2xl font-semibold">{formatPaise(a.advancePaise)}</p>
          </div>
        </div>
      ) : null}

      {a ? (
        <section aria-labelledby="open-heading">
          <h2 id="open-heading" className="section-title">
            Open invoices
          </h2>
          {a.openInvoices.length === 0 ? <p className="text-sm text-ink-600">Nothing is due.</p> : null}
          {a.openInvoices.length > 0 ? (
            <Table caption="Open invoices" headers={['Number', 'Date', 'Total', 'Due', 'Status']}>
              {a.openInvoices.map((i) => (
                <tr key={i.id}>
                  <td className={cell}>
                    <Link className="link" to={`/b/${businessId}/invoices/${i.id}`}>
                      {i.number}
                    </Link>
                  </td>
                  <td className={cell}>{i.date}</td>
                  <td className={cell}>{formatPaise(i.totalPaise)}</td>
                  <td className={cell}>{formatPaise(i.outstandingPaise)}</td>
                  <td className={cell}>
                    <Badge tone={statusTone(i.status)}>{humanize(i.status)}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </section>
      ) : null}

      {business.can('payments.record') ? (
        <section aria-labelledby="pay-heading">
          <h2 id="pay-heading" className="section-title">
            Record a payment
          </h2>
          <p className="mb-3 text-sm text-ink-600">
            Paid towards the oldest invoices first; anything extra is kept as advance.
          </p>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api(`${base}/customers/${customerId}/payments`, {
                    method: 'POST',
                    body: {
                      method,
                      amountPaise: rupeesToPaise(amount) ?? 0,
                      ...(reference.trim() ? { reference: reference.trim() } : {}),
                    },
                  }),
                'Payment recorded.',
              ).then(() => {
                setAmount('');
                setReference('');
              });
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-3">
              <NativeSelect label="Method" name="payMethod" value={method} onChange={setMethod} options={METHODS} />
              <Field label="Amount (₹)" name="payAmount" value={amount} onChange={setAmount} inputMode="numeric" />
              <Field
                label="Reference (optional)"
                name="payReference"
                value={reference}
                onChange={setReference}
                isRequired={false}
              />
            </div>
            <Button type="submit">Record payment</Button>
          </Form>
        </section>
      ) : null}

      {a && a.advancePaise > 0 && business.can('refunds.approve') ? (
        <section aria-labelledby="refund-heading">
          <h2 id="refund-heading" className="section-title">
            Refund advance
          </h2>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api(`${base}/customers/${customerId}/refunds`, {
                    method: 'POST',
                    body: { amountPaise: rupeesToPaise(refund) ?? 0, method: 'CASH', reason: refundReason },
                  }),
                'Advance refunded.',
              );
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-2">
              <Field
                label="Amount to refund in cash (₹)"
                name="refundAmount"
                value={refund}
                onChange={setRefund}
                inputMode="numeric"
              />
              <Field
                label="Reason (at least 10 characters)"
                name="refundReason"
                value={refundReason}
                onChange={setRefundReason}
              />
            </div>
            <Button type="submit">Refund</Button>
          </Form>
        </section>
      ) : null}

      {canLedger ? (
        <section aria-labelledby="statement-heading">
          <h2 id="statement-heading" className="section-title">
            Statement
          </h2>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="From (YYYY-MM-DD)" name="statementFrom" value={from} onChange={setFrom} />
            <Field label="To (YYYY-MM-DD)" name="statementTo" value={to} onChange={setTo} />
          </div>
          {business.can('reports.export') && range ? (
            <p className="mb-3 flex gap-3 text-sm">
              <span className="text-ink-600">Export:</span>
              <a
                className="link"
                href={`${base}/customers/${customerId}/statement/export?from=${from}&to=${to}&format=pdf`}
              >
                PDF
              </a>
              <a
                className="link"
                href={`${base}/customers/${customerId}/statement/export?from=${from}&to=${to}&format=csv`}
              >
                CSV
              </a>
            </p>
          ) : null}
          {statement.data ? (
            <Table caption="Statement" headers={['Date', 'Entry', 'Document', 'Amount', 'Balance']}>
              <tr>
                <td className={cell}>{from}</td>
                <td className={cell}>Opening balance</td>
                <td className={cell} />
                <td className={cell} />
                <td className={cell}>{formatPaise(statement.data.statement.openingPaise)}</td>
              </tr>
              {statement.data.statement.entries.map((e, i) => (
                <tr key={`${e.date}-${String(i)}`}>
                  <td className={cell}>{e.date}</td>
                  <td className={cell}>{humanize(e.type)}</td>
                  <td className={cell}>{e.document ?? '—'}</td>
                  <td className={cell}>{formatPaise(e.amountPaise)}</td>
                  <td className={cell}>{formatPaise(e.balancePaise)}</td>
                </tr>
              ))}
              <tr>
                <td className={cell}>{to}</td>
                <td className={`${cell} font-semibold`}>Closing balance</td>
                <td className={cell} />
                <td className={cell} />
                <td className={`${cell} font-semibold`}>{formatPaise(statement.data.statement.closingPaise)}</td>
              </tr>
            </Table>
          ) : null}
          <p className="text-xs text-ink-600">Positive balance: the customer owes the shop. Negative: advance held.</p>
        </section>
      ) : null}
      <OwnedItems base={base} businessId={businessId} customerId={customerId} />
      {/* After erasure these sections are not shown at all: their cached data may still hold the old addresses until refetched. */}
      {c && !c.erased ? <ConsentSection base={base} businessId={businessId} customer={c} can={business.can} /> : null}
      {c && !c.erased ? <Communications base={base} businessId={businessId} customer={c} can={business.can} /> : null}
      {c && !c.erased && business.data?.access.roles.includes('Owner') ? (
        <EraseSection base={base} customer={c} />
      ) : null}
    </Page>
  );
}
