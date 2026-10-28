// Issued documents: list, detail with print/PDF, cancellation, credit and
// debit notes, and the shop details printed on documents (increments 5.5,
// 5.6, 5.8). Actions appear only with the permission; the API checks again.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api, formatPaise, formatQty } from '../api.ts';
import { useBusiness } from '../business.ts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
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

interface Summary {
  id: string;
  documentType: string;
  number: string | null;
  invoiceDate: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  totalPaise: number;
  allocatedPaise: number;
  creditedPaise: number;
  outstandingPaise: number;
  paymentStatus: string | null;
  originalInvoiceId: string | null;
}
interface Detail extends Summary {
  originalInvoiceNumber: string | null;
  placeOfSupply: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  roundOffPaise: number;
  lines: {
    lineNo: number;
    description: string;
    hsnCode: string | null;
    quantity: string;
    unitPricePaise: number;
    totalPaise: number;
  }[];
  payments: { paymentId: string; method: string; reference: string | null; allocatedPaise: number }[];
}

export const DOC_LABEL: Record<string, string> = {
  TAX_INVOICE: 'Tax invoice',
  BILL_OF_SUPPLY: 'Bill of supply',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
};
const REFUND_METHODS = [
  ['CASH', 'Cash'],
  ['UPI', 'UPI'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['OTHER', 'Other'],
] as const;

export function InvoicesPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const base = `/api/businesses/${businessId}`;
  const list = useQuery({
    queryKey: ['invoices', businessId],
    queryFn: () => api<{ invoices: Summary[] }>(`${base}/invoices`),
  });
  return (
    <Page
      eyebrow="Sales"
      title="Invoices"
      description="Issued invoices, bills of supply, credit and debit notes, newest first."
    >
      <Alert message={list.error ? errorText(list.error) : null} />
      <section aria-labelledby="list-heading">
        <h2 id="list-heading" className="section-title">
          Documents
        </h2>
        <Table caption="Issued documents" headers={['Number', 'Date', 'Type', 'Customer', 'Total', 'Status', 'Due']}>
          {(list.data?.invoices ?? []).map((i) => (
            <tr key={i.id}>
              <td className={cell}>
                <Link className="link" to={`/b/${businessId}/invoices/${i.id}`}>
                  {i.number}
                </Link>
              </td>
              <td className={cell}>{i.invoiceDate}</td>
              <td className={cell}>{DOC_LABEL[i.documentType] ?? i.documentType}</td>
              <td className={cell}>{i.customerName ?? 'Walk-in'}</td>
              <td className={cell}>{formatPaise(i.totalPaise)}</td>
              <td className={cell}>
                <Badge tone={statusTone(i.status === 'ISSUED' && i.paymentStatus ? i.paymentStatus : i.status)}>
                  {i.status === 'ISSUED' && i.paymentStatus ? humanize(i.paymentStatus) : humanize(i.status)}
                </Badge>
              </td>
              <td className={cell}>{i.outstandingPaise > 0 ? formatPaise(i.outstandingPaise) : '—'}</td>
            </tr>
          ))}
        </Table>
        {list.data?.invoices.length === 0 ? <p className="text-sm text-ink-600">No documents yet.</p> : null}
      </section>
      {business.can('business.settings.manage') ? <PrintSettings businessId={businessId} /> : null}
    </Page>
  );
}

function PrintSettings({ businessId }: { businessId: string }) {
  const base = `/api/businesses/${businessId}`;
  const current = useQuery({
    queryKey: ['print-settings', businessId],
    queryFn: () =>
      api<{
        settings: {
          printSize: string;
          address: string | null;
          phone: string | null;
          email: string | null;
          terms: string | null;
        };
      }>(`${base}/print-settings`),
  });
  const [form, setForm] = useState<{
    printSize: string;
    address: string;
    phone: string;
    email: string;
    terms: string;
  } | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const s = current.data?.settings;
  const f = form ?? {
    printSize: s?.printSize ?? 'A4',
    address: s?.address ?? '',
    phone: s?.phone ?? '',
    email: s?.email ?? '',
    terms: s?.terms ?? '',
  };
  const set = (k: keyof typeof f) => (v: string) => {
    setForm({ ...f, [k]: v });
  };
  return (
    <section aria-labelledby="print-heading">
      <h2 id="print-heading" className="section-title">
        Printed details
      </h2>
      <p className="mb-3 text-sm text-ink-600">
        Shown on invoices issued from now on. Documents already issued keep the details they were issued with.
      </p>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          api(`${base}/print-settings`, {
            method: 'PUT',
            body: {
              printSize: f.printSize,
              address: f.address || null,
              phone: f.phone || null,
              email: f.email || null,
              terms: f.terms || null,
            },
          }).then(
            () => {
              setMessage({ text: 'Printed details saved.', tone: 'success' });
            },
            (err: unknown) => {
              setMessage({ text: errorText(err), tone: 'error' });
            },
          );
        }}
      >
        <NativeSelect
          label="Default paper"
          name="printSize"
          value={f.printSize}
          onChange={set('printSize')}
          options={[
            ['A4', 'A4'],
            ['A5', 'A5'],
            ['80MM', '80 mm roll'],
            ['58MM', '58 mm roll'],
          ]}
        />
        <TextArea label="Shop address" name="address" value={f.address} onChange={set('address')} rows={2} />
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="Shop phone" name="shopPhone" value={f.phone} onChange={set('phone')} isRequired={false} />
          <Field
            label="Shop email"
            name="shopEmail"
            type="email"
            value={f.email}
            onChange={set('email')}
            isRequired={false}
          />
        </div>
        <TextArea label="Terms printed on invoices" name="terms" value={f.terms} onChange={set('terms')} rows={2} />
        <Button type="submit">Save printed details</Button>
      </Form>
    </section>
  );
}

export function InvoiceDetailPage() {
  const { businessId = '', invoiceId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const doc = useQuery({
    queryKey: ['invoice', businessId, invoiceId],
    queryFn: () => api<{ invoice: Detail }>(`${base}/invoices/${invoiceId}`),
  });
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
  const d = doc.data?.invoice;
  if (!d) return <Page title="Invoice">{doc.error ? <Alert message={errorText(doc.error)} /> : <p>Loading…</p>}</Page>;
  const isSale = d.documentType === 'TAX_INVOICE' || d.documentType === 'BILL_OF_SUPPLY';
  const printHref = (size: string) => `${base}/invoices/${d.id}/print?size=${size}`;
  return (
    <Page
      eyebrow={DOC_LABEL[d.documentType] ?? d.documentType}
      title={d.number ?? 'Document'}
      description={
        <span className="flex flex-wrap items-center gap-2">
          {d.invoiceDate} · {d.customerName ?? 'Walk-in'} ·{' '}
          <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
          {d.status === 'ISSUED' && d.paymentStatus ? (
            <Badge tone={statusTone(d.paymentStatus)}>{humanize(d.paymentStatus)}</Badge>
          ) : null}
        </span>
      }
    >
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      <section aria-labelledby="doc-heading">
        <h2 id="doc-heading" className="section-title">
          Items and totals
        </h2>
        <p className="mb-3 flex flex-wrap gap-4 text-sm">
          <a className="link" href={printHref('A4')} target="_blank" rel="noopener">
            Print A4
          </a>
          <a className="link" href={printHref('A5')} target="_blank" rel="noopener">
            Print A5
          </a>
          <a className="link" href={printHref('80MM')} target="_blank" rel="noopener">
            Print 80 mm
          </a>
          <a className="link" href={printHref('58MM')} target="_blank" rel="noopener">
            Print 58 mm
          </a>
          <a className="link" href={`${base}/invoices/${d.id}/pdf?size=A4`}>
            Download PDF
          </a>
        </p>
        {d.originalInvoiceId ? (
          <p className="mb-3 text-sm">
            Corrects invoice{' '}
            <Link className="link" to={`/b/${businessId}/invoices/${d.originalInvoiceId}`}>
              {d.originalInvoiceNumber}
            </Link>
          </p>
        ) : null}
        <Table caption="Items" headers={['#', 'Item', 'HSN', 'Qty', 'Price', 'Amount']}>
          {d.lines.map((l) => (
            <tr key={l.lineNo}>
              <td className={cell}>{l.lineNo}</td>
              <td className={cell}>{l.description}</td>
              <td className={cell}>{l.hsnCode ?? '—'}</td>
              <td className={cell}>{formatQty(l.quantity)}</td>
              <td className={cell}>{formatPaise(l.unitPricePaise)}</td>
              <td className={cell}>{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
        </Table>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-500">Taxable value</dt>
            <dd className="font-medium">{formatPaise(d.taxablePaise)}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Tax</dt>
            <dd className="font-medium">{formatPaise(d.cgstPaise + d.sgstPaise + d.igstPaise + d.cessPaise)}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Total</dt>
            <dd className="text-lg font-semibold">{formatPaise(d.totalPaise)}</dd>
          </div>
          {isSale ? (
            <div>
              <dt className="text-ink-500">Still due</dt>
              <dd className="text-lg font-semibold">{formatPaise(d.outstandingPaise)}</dd>
            </div>
          ) : null}
        </dl>
        {d.payments.length > 0 ? (
          <>
            <h3 className="mt-4 mb-2 font-semibold">Payments applied</h3>
            <ul className="text-sm">
              {d.payments.map((p) => (
                <li key={p.paymentId}>
                  {humanize(p.method)}
                  {p.reference ? ` (${p.reference})` : ''}: {formatPaise(p.allocatedPaise)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.customerId ? (
          <p className="mt-3 text-sm">
            <Link className="link" to={`/b/${businessId}/customers/${d.customerId}`}>
              Open customer account
            </Link>
          </p>
        ) : null}
      </section>

      {isSale && d.status === 'ISSUED' && business.can('credit_notes.create') ? (
        <CreditNoteForm detail={d} canRefund={business.can('refunds.approve')} run={run} base={base} />
      ) : null}
      {isSale && d.status === 'ISSUED' && business.can('invoices.cancel') ? (
        <CancelForm detail={d} canRefund={business.can('refunds.approve')} run={run} base={base} />
      ) : null}
    </Page>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

function CreditNoteForm(props: { detail: Detail; canRefund: boolean; run: Run; base: string }) {
  const d = props.detail;
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [settlement, setSettlement] = useState(d.customerId ? 'ADVANCE' : 'REFUND');
  const [refundMethod, setRefundMethod] = useState('CASH');
  return (
    <section aria-labelledby="cn-heading">
      <h2 id="cn-heading" className="section-title">
        Return or correct with a credit note
      </h2>
      <p className="mb-3 text-sm text-ink-600">Returned goods go into inspection and cannot be sold until inspected.</p>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          const lines = d.lines
            .filter((l) => picked[l.lineNo])
            .map((l) => ({ lineNo: l.lineNo, ...(quantities[l.lineNo] ? { quantity: quantities[l.lineNo] } : {}) }));
          void props.run(
            () =>
              api(`${props.base}/invoices/${d.id}/credit-notes`, {
                method: 'POST',
                body: { reason, lines, settlement, ...(settlement === 'REFUND' ? { refundMethod } : {}) },
              }),
            'Credit note issued.',
          );
        }}
      >
        {d.lines.map((l) => (
          <div key={l.lineNo} className="flex flex-wrap items-center gap-3">
            <Checkbox
              label={`Return line ${String(l.lineNo)}: ${l.description}`}
              name={`cn-line-${String(l.lineNo)}`}
              checked={picked[l.lineNo] ?? false}
              onChange={(v) => {
                setPicked({ ...picked, [l.lineNo]: v });
              }}
            />
            {Number(l.quantity) > 1 && picked[l.lineNo] ? (
              <Field
                label={`Quantity returned (of ${formatQty(l.quantity)})`}
                name={`cn-qty-${String(l.lineNo)}`}
                value={quantities[l.lineNo] ?? ''}
                onChange={(v) => {
                  setQuantities({ ...quantities, [l.lineNo]: v });
                }}
                isRequired={false}
              />
            ) : null}
          </div>
        ))}
        <Field label="Reason (at least 10 characters)" name="cnReason" value={reason} onChange={setReason} />
        <NativeSelect
          label="Money paid for the returned items"
          name="cnSettlement"
          value={settlement}
          onChange={setSettlement}
          options={[
            ...(d.customerId ? ([['ADVANCE', 'Keep as customer advance']] as const) : []),
            ...(props.canRefund ? ([['REFUND', 'Refund it now']] as const) : []),
          ]}
        />
        {settlement === 'REFUND' ? (
          <NativeSelect
            label="Refund method"
            name="cnRefundMethod"
            value={refundMethod}
            onChange={setRefundMethod}
            options={REFUND_METHODS}
          />
        ) : null}
        <Button type="submit">Issue credit note</Button>
      </Form>
    </section>
  );
}

function CancelForm(props: { detail: Detail; canRefund: boolean; run: Run; base: string }) {
  const d = props.detail;
  const [reason, setReason] = useState('');
  const [goods, setGoods] = useState('NOT_TAKEN');
  const [settlement, setSettlement] = useState(d.customerId ? 'ADVANCE' : 'REFUND');
  return (
    <section aria-labelledby="cancel-heading">
      <h2 id="cancel-heading" className="section-title">
        Cancel this invoice
      </h2>
      <p className="mb-3 text-sm text-ink-600">
        Only within the cancellation window (by default the same day). The number stays used; after the window, issue a
        credit note.
      </p>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void props.run(
            () =>
              api(`${props.base}/invoices/${d.id}/cancel`, {
                method: 'POST',
                body: { reason, goods, settlement, ...(settlement === 'REFUND' ? { refundMethod: 'CASH' } : {}) },
              }),
            'Invoice cancelled.',
          );
        }}
      >
        <Field
          label="Reason for cancelling (at least 10 characters)"
          name="cancelReason"
          value={reason}
          onChange={setReason}
        />
        <NativeSelect
          label="The goods"
          name="cancelGoods"
          value={goods}
          onChange={setGoods}
          options={[
            ['NOT_TAKEN', 'Never left the shop (back to stock)'],
            ['RETURNED', 'Came back (into inspection)'],
          ]}
        />
        <NativeSelect
          label="Money paid on this invoice"
          name="cancelSettlement"
          value={settlement}
          onChange={setSettlement}
          options={[
            ...(d.customerId ? ([['ADVANCE', 'Keep as customer advance']] as const) : []),
            ...(props.canRefund ? ([['REFUND', 'Refund it now in cash']] as const) : []),
          ]}
        />
        <Button type="submit" variant="danger">
          Cancel invoice
        </Button>
      </Form>
    </section>
  );
}
