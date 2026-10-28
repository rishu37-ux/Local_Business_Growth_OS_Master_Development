// Expenses (increment 6.7 for FR-EXP-1): switch the module on, record an
// expense with its receipt, and correct by reversal. Operating profit is in
// Reports, labelled an estimate.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api, formatPaise, rupeesToPaise, uploadFile } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';
import { ExportLinks } from '../exports.tsx';

interface Expense {
  id: string;
  date: string;
  category: string;
  amountPaise: number;
  method: string;
  reference: string | null;
  notes: string | null;
  uploadId: string | null;
  reversesExpenseId: string | null;
  reversedBy: string | null;
  reason: string | null;
}

export const CATEGORIES = [
  ['RENT', 'Rent'],
  ['SALARIES', 'Salaries'],
  ['ELECTRICITY', 'Electricity'],
  ['INTERNET_PHONE', 'Internet and phone'],
  ['TRANSPORT', 'Transport'],
  ['REPAIRS_MAINTENANCE', 'Repairs and maintenance'],
  ['MARKETING', 'Marketing'],
  ['SUPPLIES', 'Supplies'],
  ['BANK_CHARGES', 'Bank charges'],
  ['TAXES_FEES', 'Taxes and fees'],
  ['OTHER', 'Other'],
] as const;
const METHODS = [
  ['CASH', 'Cash'],
  ['UPI', 'UPI'],
  ['CARD', 'Card'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['OTHER', 'Other'],
] as const;
const label = (list: readonly (readonly [string, string])[], key: string) => list.find(([k]) => k === key)?.[1] ?? key;

function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function ExpensesPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const range = monthRange(validMonth ? month : today.slice(0, 7));
  const settings = useQuery({
    queryKey: ['expense-settings', businessId],
    queryFn: () => api<{ settings: { enabled: boolean } }>(`${base}/expenses/settings`),
    enabled: business.can('business.settings.view'),
  });
  const list = useQuery({
    queryKey: ['expenses', businessId, range.from],
    queryFn: () => api<{ expenses: Expense[] }>(`${base}/expenses?from=${range.from}&to=${range.to}`),
  });
  const [date, setDate] = useState(today);
  const [category, setCategory] = useState('RENT');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
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
  const enabled = settings.data?.settings.enabled ?? true;
  const rows = list.data?.expenses ?? [];
  const total = rows.reduce((t, e) => t + e.amountPaise, 0);
  return (
    <Page
      eyebrow="Accounts"
      title="Expenses"
      description="Shop expenses such as rent, salaries and bills. A mistake is corrected by reversing the entry."
      actions={
        <ExportLinks
          businessId={businessId}
          list="expenses"
          what="this month's expenses"
          from={range.from}
          to={range.to}
        />
      }
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      {settings.data ? (
        <section aria-labelledby="module-heading">
          <h2 id="module-heading" className="section-title">
            Expenses module
          </h2>
          <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            Status: <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
          </p>
          {business.can('business.settings.manage') ? (
            <Button
              variant="secondary"
              onPress={() => {
                void run(
                  () => api(`${base}/expenses/settings`, { method: 'PUT', body: { enabled: !enabled } }),
                  enabled ? 'Expenses turned off.' : 'Expenses turned on.',
                );
              }}
            >
              {enabled ? 'Turn expenses off' : 'Turn expenses on'}
            </Button>
          ) : null}
        </section>
      ) : null}

      {enabled ? (
        <section aria-labelledby="add-expense-heading">
          <h2 id="add-expense-heading" className="section-title">
            Record an expense
          </h2>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const uploadId = file
                  ? (
                      await uploadFile<{ uploadId: string }>(
                        `${base}/expenses/attachments?name=${encodeURIComponent(file.name.slice(0, 200))}`,
                        file,
                      )
                    ).uploadId
                  : null;
                await api(`${base}/expenses`, {
                  method: 'POST',
                  body: {
                    date,
                    category,
                    amountPaise: rupeesToPaise(amount) ?? 0,
                    method,
                    reference: reference.trim() || null,
                    notes: notes.trim() || null,
                    uploadId,
                  },
                });
              }, 'Expense recorded.').then((ok) => {
                if (ok) {
                  setAmount('');
                  setReference('');
                  setNotes('');
                  setFile(null);
                }
              });
            }}
          >
            <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Date (YYYY-MM-DD)" name="expenseDate" value={date} onChange={setDate} />
              <NativeSelect
                label="Category"
                name="expenseCategory"
                value={category}
                onChange={setCategory}
                options={CATEGORIES}
              />
              <Field label="Amount (₹)" name="expenseAmount" value={amount} onChange={setAmount} inputMode="numeric" />
              <NativeSelect
                label="Paid by"
                name="expenseMethod"
                value={method}
                onChange={setMethod}
                options={METHODS}
              />
              <Field
                label="Reference (optional)"
                name="expenseReference"
                value={reference}
                onChange={setReference}
                isRequired={false}
              />
              <Field
                label="Notes (optional)"
                name="expenseNotes"
                value={notes}
                onChange={setNotes}
                isRequired={false}
              />
            </div>
            <div className="mb-3 flex flex-col gap-1">
              <label htmlFor="expense-receipt" className="text-sm font-medium text-ink-800">
                Receipt photo or PDF (optional)
              </label>
              <input
                id="expense-receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                }}
                className="max-w-full text-sm"
              />
            </div>
            <Button type="submit">Record expense</Button>
          </Form>
        </section>
      ) : (
        <p className="mb-4 text-sm text-ink-600">Expenses are turned off for this shop.</p>
      )}

      <section aria-labelledby="list-heading">
        <h2 id="list-heading" className="section-title">
          Expenses in {range.from.slice(0, 7)}
        </h2>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="Month (YYYY-MM)" name="expenseMonth" value={month} onChange={setMonth} />
        </div>
        <p className="mb-3 text-sm">
          Total after corrections: <strong>{formatPaise(total)}</strong>.{' '}
          {business.can('reports.financial.view') ? (
            <Link className="link" to={`/b/${businessId}/reports`}>
              See the operating-profit estimate in Reports
            </Link>
          ) : null}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-600">No expenses in this month.</p>
        ) : (
          <Table caption="Expenses" headers={['Date', 'Category', 'Amount', 'Paid by', 'Details', 'Correction']}>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className={cell}>{e.date}</td>
                <td className={cell}>{label(CATEGORIES, e.category)}</td>
                <td className={`${cell} tabular-nums`}>{formatPaise(e.amountPaise)}</td>
                <td className={cell}>{label(METHODS, e.method)}</td>
                <td className={`${cell} max-w-xs break-words`}>
                  {e.reversesExpenseId
                    ? `Reversal: ${e.reason ?? ''}`
                    : [e.reference, e.notes].filter(Boolean).join(' · ') || '—'}
                  {e.uploadId ? (
                    <>
                      {' '}
                      <a className="link" href={`${base}/expenses/${e.id}/attachment`}>
                        Receipt
                      </a>
                    </>
                  ) : null}
                </td>
                <td className={cell}>
                  {e.reversesExpenseId ? (
                    <Badge>Reversal</Badge>
                  ) : e.reversedBy ? (
                    <Badge tone="danger">Reversed</Badge>
                  ) : enabled && reversing !== e.id ? (
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setReversing(e.id);
                        setReason('');
                      }}
                    >
                      Reverse
                    </Button>
                  ) : null}
                  {reversing === e.id ? (
                    <Form
                      className="mt-2"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        void run(
                          () => api(`${base}/expenses/${e.id}/reverse`, { method: 'POST', body: { reason } }),
                          'Expense reversed.',
                        ).then((ok) => {
                          if (ok) setReversing(null);
                        });
                      }}
                    >
                      <Field
                        label="Why (at least 10 characters)"
                        name={`reason-${e.id}`}
                        value={reason}
                        onChange={setReason}
                      />
                      <Button type="submit" variant="danger">
                        Confirm reversal
                      </Button>
                    </Form>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </Page>
  );
}
