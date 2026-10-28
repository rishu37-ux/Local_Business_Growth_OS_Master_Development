// Point of sale (increment 5.8: FR-POS-1…3). The cart is a draft sale on the
// server: every change is saved and priced there (tax, discounts, limits), so
// the screen shows exactly what will be issued. A known customer's
// single-item sale takes four interactions: scan, mobile, payment method,
// complete.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams, useSearchParams } from 'react-router';
import { api, ApiError, formatPaise, formatQty, rupeesToPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { PhotoLookup } from '../camera.tsx';
import { Alert, Badge, Button, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';

interface PosUnit {
  unitId: string;
  imeis: string[];
  serialNumber: string | null;
}
interface PosItem {
  variantId: string;
  sku: string;
  name: string;
  serialized: boolean;
  sellingPricePaise: number;
  available: string;
  units: PosUnit[];
}
interface SearchResult {
  unit: (PosUnit & { variantId: string }) | null;
  items: PosItem[];
}
interface Discount {
  kind: 'PERCENT' | 'AMOUNT';
  bp?: number;
  paise?: number;
}
interface SaleView {
  id: string;
  documentType: string;
  lines: {
    variantId: string;
    unitId: string | null;
    description: string;
    quantity: string;
    unitPricePaise: number;
    discount: Discount | null;
    amounts: { totalPaise: number; lineDiscountPaise: number };
  }[];
  totals: {
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    roundOffPaise: number;
    totalPaise: number;
  };
  problems: { code: string; lineIndex?: number; message: string }[];
  discountApproved: boolean;
}
interface Customer {
  id: string;
  name: string;
  mobileE164: string | null;
}
interface Issued {
  invoiceId: string;
  number: string;
  totalPaise: number;
  paidPaise: number;
  balanceDuePaise: number;
  advanceAddedPaise: number;
  changePaise: number;
}
interface Line {
  key: string;
  variantId: string;
  unitId: string | null;
  quantity: string;
  /** Line discount in rupees as typed ("" = none). */
  discount: string;
  /** A price agreed elsewhere (an online order's channel price, 11.3); kept when the draft is saved again. */
  unitPricePaise?: number;
}
interface PaymentRow {
  key: string;
  method: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';
  amount: string;
  reference: string;
  tendered: string;
}

const METHODS: readonly (readonly [PaymentRow['method'], string])[] = [
  ['CASH', 'Cash'],
  ['UPI', 'UPI'],
  ['CARD', 'Card'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['OTHER', 'Other'],
];

let keySeq = 0;
const nextKey = () => String(++keySeq);
const rupees = (paise: number) => (paise / 100).toFixed(2);

export function PosPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const base = `/api/businesses/${businessId}`;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState('');
  const [discountKind, setDiscountKind] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [mobile, setMobile] = useState('');
  const [newName, setNewName] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lookup, setLookup] = useState<'idle' | 'not-found'>('idle');
  const [saleId, setSaleId] = useState<string | null>(null);
  const [view, setView] = useState<SaleView | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [paymentsEdited, setPaymentsEdited] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const latest = useRef(0);
  // Saves run one after another, so a quick second change never creates a second draft.
  const saleRef = useRef<string | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const held = useQuery({
    queryKey: ['held-sales', businessId],
    queryFn: () =>
      api<{ sales: { id: string; customerName: string | null; lineCount: number; totalPaise: number }[] }>(
        `${base}/sales`,
      ),
  });

  /** Saves the cart as a draft and shows the server's pricing. */
  type CartState = {
    lines: Line[];
    customer: Customer | null;
    invoiceDiscount: string;
    discountKind: 'AMOUNT' | 'PERCENT';
  };
  const sync = (next: CartState): Promise<void> => {
    const call = ++latest.current;
    chain.current = chain.current.then(() => save(next, call));
    return chain.current;
  };
  const save = async (next: CartState, call: number) => {
    setMessage(null);
    if (next.lines.length === 0) {
      setView(null);
      return;
    }
    const inv = next.invoiceDiscount.trim();
    const invoiceDiscountBody =
      inv === ''
        ? null
        : next.discountKind === 'PERCENT'
          ? { kind: 'PERCENT', bp: Math.round(Number(inv) * 100) }
          : { kind: 'AMOUNT', paise: rupeesToPaise(inv) ?? 0 };
    const body = {
      customerId: next.customer?.id ?? null,
      invoiceDiscount: invoiceDiscountBody,
      lines: next.lines.map((l) => ({
        variantId: l.variantId,
        ...(l.unitId ? { unitId: l.unitId } : { quantity: l.quantity || '1' }),
        ...(l.unitPricePaise === undefined ? {} : { unitPricePaise: l.unitPricePaise }),
        ...(l.discount.trim() ? { discount: { kind: 'AMOUNT', paise: rupeesToPaise(l.discount) ?? 0 } } : {}),
      })),
    };
    try {
      const current = saleRef.current;
      const res = current
        ? await api<{ sale: SaleView }>(`${base}/sales/${current}`, { method: 'PUT', body })
        : await api<{ sale: SaleView }>(`${base}/sales`, { method: 'POST', body });
      saleRef.current = res.sale.id;
      setSaleId(res.sale.id);
      if (call !== latest.current) return;
      setView(res.sale);
      if (!paymentsEdited) {
        setPayments((rows) => [
          {
            key: rows[0]?.key ?? nextKey(),
            method: rows[0]?.method ?? 'CASH',
            amount: rupees(res.sale.totals.totalPaise),
            reference: '',
            tendered: '',
          },
        ]);
      }
    } catch (err) {
      if (call === latest.current) setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  const update = (
    patch: Partial<{
      lines: Line[];
      customer: Customer | null;
      invoiceDiscount: string;
      discountKind: 'AMOUNT' | 'PERCENT';
    }>,
  ) => {
    const next = { lines, customer, invoiceDiscount, discountKind, ...patch };
    if (patch.lines) setLines(patch.lines);
    if ('customer' in patch) setCustomer(patch.customer ?? null);
    if (patch.invoiceDiscount !== undefined) setInvoiceDiscount(patch.invoiceDiscount);
    if (patch.discountKind) setDiscountKind(patch.discountKind);
    return sync(next);
  };

  /** Resolves once the sale is saved (which clears the message); null if the unit was already in it. */
  const addUnit = (variantId: string, unitId: string): Promise<void> | null => {
    if (lines.some((l) => l.unitId === unitId)) {
      setMessage({ text: 'This unit is already in the sale.', tone: 'error' });
      return null;
    }
    const saved = update({ lines: [...lines, { key: nextKey(), variantId, unitId, quantity: '1', discount: '' }] });
    setResults(null);
    setQuery('');
    return saved;
  };
  const addItem = (item: PosItem) => {
    const existing = lines.find((l) => l.variantId === item.variantId && !l.unitId);
    const next = existing
      ? lines.map((l) => (l === existing ? { ...l, quantity: String(Number(l.quantity || '1') + 1) } : l))
      : [...lines, { key: nextKey(), variantId: item.variantId, unitId: null, quantity: '1', discount: '' }];
    void update({ lines: next });
    setResults(null);
    setQuery('');
  };

  const search = () => searchFor(query.trim());
  const searchFor = async (q: string) => {
    if (!q) return;
    try {
      const r = await api<SearchResult>(`${base}/pos/search?q=${encodeURIComponent(q)}`);
      // A scanned IMEI goes straight into the sale; so does an exact barcode of a quantity item.
      if (r.unit) {
        void addUnit(r.unit.variantId, r.unit.unitId);
        return;
      }
      const only = r.items.length === 1 ? r.items[0] : undefined;
      if (only && !only.serialized && (only.sku.toLowerCase() === q.toLowerCase() || /^\d{8,14}$/.test(q))) {
        addItem(only);
        return;
      }
      setResults(r);
      if (r.items.length === 0) setMessage({ text: `Nothing found for “${q}”.`, tone: 'error' });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  const findCustomer = async (value: string) => {
    setMobile(value);
    setLookup('idle');
    const digits = value.replace(/\D/g, '');
    if (digits.length < 10) return;
    try {
      const r = await api<{ customers: Customer[] }>(`${base}/customers?mobile=${encodeURIComponent(value)}`);
      const found = r.customers[0];
      if (found) void update({ customer: found });
      else setLookup('not-found');
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  const addCustomer = async () => {
    try {
      const r = await api<{ customer: Customer }>(`${base}/customers`, {
        method: 'POST',
        body: { name: newName, mobile },
      });
      setLookup('idle');
      void update({ customer: r.customer });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  const quickPay = (method: PaymentRow['method']) => {
    setPaymentsEdited(true);
    setPayments([
      { key: nextKey(), method, amount: view ? rupees(view.totals.totalPaise) : '', reference: '', tendered: '' },
    ]);
  };
  const editPayment = (key: string, patch: Partial<PaymentRow>) => {
    setPaymentsEdited(true);
    setPayments((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const reset = () => {
    latest.current++;
    saleRef.current = null;
    setLines([]);
    setCustomer(null);
    setMobile('');
    setNewName('');
    setInvoiceDiscount('');
    setSaleId(null);
    setView(null);
    setPayments([]);
    setPaymentsEdited(false);
    setResults(null);
    setReason('');
    void queryClient.invalidateQueries({ queryKey: ['held-sales', businessId] });
  };

  const resume = async (id: string, keepPrices = false) => {
    try {
      const r = await api<{ sale: SaleView & { customer: Customer | null } }>(`${base}/sales/${id}`);
      setIssued(null);
      latest.current++;
      saleRef.current = id;
      setSaleId(id);
      setView(r.sale);
      setCustomer(r.sale.customer);
      setMobile(r.sale.customer?.mobileE164 ?? '');
      setLines(
        r.sale.lines.map((l) => ({
          key: nextKey(),
          variantId: l.variantId,
          unitId: l.unitId,
          quantity: l.quantity,
          discount: l.discount?.kind === 'AMOUNT' && l.discount.paise ? rupees(l.discount.paise) : '',
          ...(keepPrices ? { unitPricePaise: l.unitPricePaise } : {}),
        })),
      );
      setPaymentsEdited(false);
      setPayments([
        { key: nextKey(), method: 'CASH', amount: rupees(r.sale.totals.totalPaise), reference: '', tendered: '' },
      ]);
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  // An online order billed from Online selling opens here as its draft (11.3).
  const [params, setParams] = useSearchParams();
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const id = params.get('sale');
    if (!id || opened.current === id) return;
    opened.current = id;
    void resume(id, true);
    setParams({}, { replace: true });
  });

  const paid = payments.reduce((s, p) => s + (rupeesToPaise(p.amount) ?? 0), 0);
  const total = view?.totals.totalPaise ?? 0;

  const complete = async () => {
    if (!saleId || !view) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = {
        expectedTotalPaise: view.totals.totalPaise,
        payments: payments
          .filter((p) => (rupeesToPaise(p.amount) ?? 0) > 0)
          .map((p) => ({
            method: p.method,
            amountPaise: rupeesToPaise(p.amount) ?? 0,
            ...(p.reference.trim() ? { reference: p.reference.trim() } : {}),
            ...(p.method === 'CASH' && p.tendered.trim() ? { tenderedPaise: rupeesToPaise(p.tendered) ?? 0 } : {}),
          })),
      };
      const r = await api<{ invoice: Issued }>(`${base}/sales/${saleId}/issue`, { method: 'POST', body });
      setIssued(r.invoice);
      reset();
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
      if (err instanceof ApiError && err.code === 'TOTAL_CHANGED')
        void sync({ lines, customer, invoiceDiscount, discountKind });
    } finally {
      setBusy(false);
    }
  };

  const requestApproval = async () => {
    if (!saleId) return;
    try {
      await api(`${base}/sales/${saleId}/discount-approval`, { method: 'POST', body: { reason } });
      setMessage({ text: 'Approval requested. A manager can approve it under Approvals.', tone: 'success' });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  const printHref = (id: string, size: string) => `${base}/invoices/${id}/print?size=${size}`;
  const lineView = (i: number) => view?.lines[i];

  return (
    <Page
      eyebrow="Point of sale"
      title="New sale"
      description="Scan an IMEI or barcode, or search by name. Prices include tax as set in the catalogue."
    >
      {issued ? (
        <section aria-labelledby="done-heading" className="border-emerald-200">
          <h2 id="done-heading" className="section-title">
            Sale complete: invoice {issued.number}
          </h2>
          <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-ink-500">Total</dt>
              <dd className="text-lg font-semibold">{formatPaise(issued.totalPaise)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Paid</dt>
              <dd className="text-lg font-semibold">{formatPaise(issued.paidPaise)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Balance due</dt>
              <dd className="text-lg font-semibold">{formatPaise(issued.balanceDuePaise)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Change to give</dt>
              <dd className="text-lg font-semibold">{formatPaise(issued.changePaise)}</dd>
            </div>
          </dl>
          <p className="flex flex-wrap gap-4 text-sm">
            <a className="link" href={printHref(issued.invoiceId, 'A4')} target="_blank" rel="noopener">
              Print A4
            </a>
            <a className="link" href={printHref(issued.invoiceId, '80MM')} target="_blank" rel="noopener">
              Print receipt (80 mm)
            </a>
            <a className="link" href={`${base}/invoices/${issued.invoiceId}/pdf?size=A4`}>
              Download PDF
            </a>
          </p>
        </section>
      ) : null}

      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <section aria-labelledby="items-heading" className="card">
            <h2 id="items-heading" className="section-title">
              Items
            </h2>
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field
                    label="Scan or search"
                    name="posSearch"
                    value={query}
                    onChange={setQuery}
                    isRequired={false}
                    description="IMEI, barcode, SKU or model name."
                  />
                </div>
                <div className="mb-3">
                  <Button type="submit" variant="secondary">
                    Search
                  </Button>
                </div>
              </div>
            </Form>
            <details className="mb-3">
              <summary className="cursor-pointer text-sm font-medium text-brand-700">
                Add by photo (IMEI or barcode)
              </summary>
              <div className="mt-2">
                <PhotoLookup
                  businessId={businessId}
                  what="IMEI or barcode"
                  name="pos"
                  onResult={(r) => {
                    // 12.2 AC2: an available phone goes in with its IMEI; a sold or unknown one is only reported.
                    const phone = r.imeis.find((x) => x.unit?.status === 'IN_STOCK');
                    if (phone?.unit) {
                      const text = `Added ${phone.unit.productName}, IMEI ${phone.imei}.`;
                      // After the save (which clears the message), unless the save reported an error.
                      void addUnit(phone.unit.variantId, phone.unit.unitId)?.then(() => {
                        setMessage((m) => (m?.tone === 'error' ? m : { text, tone: 'success' }));
                      });
                      return;
                    }
                    const other = r.imeis.find((x) => x.unit);
                    if (other?.unit) {
                      setMessage({
                        text: `IMEI ${other.imei} is ${other.unit.status.replaceAll('_', ' ').toLowerCase()}; it cannot be sold.`,
                        tone: 'error',
                      });
                      return;
                    }
                    const product = r.products[0];
                    if (product && r.imeis.length === 0) {
                      setQuery(product.sku);
                      setMessage({
                        text: `Found ${product.productName}. Choose it from the results.`,
                        tone: 'success',
                      });
                      void searchFor(product.sku);
                      return;
                    }
                    setMessage({
                      text:
                        r.imeis.length > 0
                          ? `IMEI ${r.imeis[0]?.imei ?? ''} is not in this shop's stock.`
                          : 'No IMEI or known barcode could be read. Try a sharper photo, or type it.',
                      tone: 'error',
                    });
                  }}
                />
              </div>
            </details>
            {results && results.items.length > 0 ? (
              <ul className="mb-4 flex flex-col gap-2" aria-label="Search results">
                {results.items.map((item) => (
                  <li key={item.variantId} className="card-inset">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-xs text-ink-600">
                          {item.sku} · {formatPaise(item.sellingPricePaise)} · {formatQty(item.available)} in stock
                        </p>
                      </div>
                      {item.serialized ? null : (
                        <Button
                          variant="secondary"
                          onPress={() => {
                            addItem(item);
                          }}
                        >
                          Add {item.name}
                        </Button>
                      )}
                    </div>
                    {item.serialized ? (
                      item.units.length > 0 ? (
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {item.units.map((u) => (
                            <li key={u.unitId}>
                              <Button
                                variant="secondary"
                                onPress={() => {
                                  void addUnit(item.variantId, u.unitId);
                                }}
                              >
                                Add IMEI {u.imeis[0] ?? u.serialNumber ?? '—'}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-sm text-ink-600">No unit in stock.</p>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {lines.length === 0 ? (
              <p className="text-sm text-ink-600">No items yet.</p>
            ) : (
              <Table caption="Items in this sale" headers={['Item', 'Qty', 'Discount (₹)', 'Amount', '']}>
                {lines.map((l, i) => {
                  const v = lineView(i);
                  return (
                    <tr key={l.key}>
                      <td className={cell}>
                        {v?.description ?? '…'}
                        {v ? (
                          <span className="block text-xs text-ink-600">{formatPaise(v.unitPricePaise)} each</span>
                        ) : null}
                      </td>
                      <td className={cell}>
                        {l.unitId ? (
                          '1'
                        ) : (
                          <input
                            aria-label={`Quantity of ${v?.description ?? 'item'}`}
                            className="w-16 rounded-lg border border-ink-300 px-2 py-1"
                            inputMode="decimal"
                            value={l.quantity}
                            onChange={(e) => {
                              setLines(lines.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)));
                            }}
                            onBlur={(e) => {
                              void update({
                                lines: lines.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)),
                              });
                            }}
                          />
                        )}
                      </td>
                      <td className={cell}>
                        <input
                          aria-label={`Discount on ${v?.description ?? 'item'} (₹)`}
                          className="w-20 rounded-lg border border-ink-300 px-2 py-1"
                          inputMode="decimal"
                          value={l.discount}
                          onChange={(e) => {
                            setLines(lines.map((x) => (x.key === l.key ? { ...x, discount: e.target.value } : x)));
                          }}
                          onBlur={(e) => {
                            void update({
                              lines: lines.map((x) => (x.key === l.key ? { ...x, discount: e.target.value } : x)),
                            });
                          }}
                        />
                      </td>
                      <td className={cell}>{v ? formatPaise(v.amounts.totalPaise) : '…'}</td>
                      <td className={cell}>
                        <button
                          type="button"
                          className="link cursor-pointer text-sm"
                          onClick={() => {
                            void update({ lines: lines.filter((x) => x.key !== l.key) });
                          }}
                        >
                          Remove<span className="sr-only"> {v?.description}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
            {view?.problems.map((p) => (
              <p key={`${p.code}-${String(p.lineIndex ?? '')}`} className="mb-2 text-sm text-red-800">
                {p.lineIndex === undefined ? '' : `Line ${String(p.lineIndex + 1)}: `}
                {p.message}
              </p>
            ))}
            {view?.problems.some((p) => p.code === 'DISCOUNT_NEEDS_APPROVAL') ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field
                    label="Reason for the discount (at least 10 characters)"
                    name="approvalReason"
                    value={reason}
                    onChange={setReason}
                    isRequired={false}
                  />
                </div>
                <div className="mb-3">
                  <Button variant="secondary" onPress={() => void requestApproval()}>
                    Request approval
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="customer-heading" className="card">
            <h2 id="customer-heading" className="section-title">
              Customer
            </h2>
            {customer ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  <span className="font-medium">{customer.name}</span>{' '}
                  <span className="text-sm text-ink-600">{customer.mobileE164}</span>
                </p>
                <button
                  type="button"
                  className="link cursor-pointer text-sm"
                  onClick={() => {
                    setMobile('');
                    void update({ customer: null });
                  }}
                >
                  Change customer
                </button>
              </div>
            ) : (
              <>
                <Field
                  label="Customer mobile (optional for a fully paid sale)"
                  name="customerMobile"
                  value={mobile}
                  onChange={(v) => void findCustomer(v)}
                  inputMode="numeric"
                  isRequired={false}
                />
                {lookup === 'not-found' ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field
                        label="New customer's name"
                        name="customerName"
                        value={newName}
                        onChange={setNewName}
                        isRequired={false}
                      />
                    </div>
                    <div className="mb-3">
                      <Button variant="secondary" onPress={() => void addCustomer()} isDisabled={newName.trim() === ''}>
                        Add customer
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>

        <aside aria-label="Payment" className="min-w-0">
          <section aria-labelledby="pay-heading" className="card">
            <h2 id="pay-heading" className="section-title">
              Payment
            </h2>
            <div className="mb-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
              <Field
                label="Invoice discount"
                name="invoiceDiscount"
                value={invoiceDiscount}
                onChange={setInvoiceDiscount}
                isRequired={false}
                inputMode="numeric"
              />
              <NativeSelect
                label="As"
                name="discountKind"
                value={discountKind}
                onChange={(v) => {
                  void update({ discountKind: v === 'PERCENT' ? 'PERCENT' : 'AMOUNT' });
                }}
                options={[
                  ['AMOUNT', '₹'],
                  ['PERCENT', '%'],
                ]}
              />
            </div>
            <div className="mb-4">
              <Button
                variant="secondary"
                onPress={() => {
                  void update({ invoiceDiscount });
                }}
                isDisabled={lines.length === 0}
              >
                Apply discount
              </Button>
            </div>
            {view ? (
              <>
                <p className="mb-2 text-xs text-ink-600">
                  <Badge>{view.documentType === 'TAX_INVOICE' ? 'Tax invoice' : 'Bill of supply'}</Badge>
                </p>
                <dl className="mb-4 space-y-1 text-sm">
                  {view.totals.discountPaise > 0 ? (
                    <div className="flex justify-between">
                      <dt>Discount</dt>
                      <dd>−{formatPaise(view.totals.discountPaise)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between">
                    <dt>Taxable value</dt>
                    <dd>{formatPaise(view.totals.taxablePaise)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Tax</dt>
                    <dd>
                      {formatPaise(
                        view.totals.cgstPaise + view.totals.sgstPaise + view.totals.igstPaise + view.totals.cessPaise,
                      )}
                    </dd>
                  </div>
                  {view.totals.roundOffPaise !== 0 ? (
                    <div className="flex justify-between">
                      <dt>Round-off</dt>
                      <dd>{formatPaise(view.totals.roundOffPaise)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between border-t border-ink-200 pt-2 text-lg font-semibold">
                    <dt>Total</dt>
                    <dd data-testid="pos-total">{formatPaise(view.totals.totalPaise)}</dd>
                  </div>
                </dl>
              </>
            ) : null}

            <fieldset className="mb-3">
              <legend className="mb-2 text-sm font-medium text-ink-800">Paid by</legend>
              <div className="flex flex-wrap gap-2">
                {(['CASH', 'UPI', 'CARD'] as const).map((m) => (
                  <Button
                    key={m}
                    variant="secondary"
                    onPress={() => {
                      quickPay(m);
                    }}
                    isDisabled={!view}
                  >
                    {m === 'CASH' ? 'Cash' : m === 'UPI' ? 'UPI' : 'Card'}
                  </Button>
                ))}
              </div>
            </fieldset>
            {payments.map((p, i) => (
              <div key={p.key} className="card-inset mb-2">
                <NativeSelect
                  label={`Payment ${String(i + 1)} method`}
                  name={`method-${p.key}`}
                  value={p.method}
                  onChange={(v) => {
                    editPayment(p.key, { method: v as PaymentRow['method'] });
                  }}
                  options={METHODS}
                />
                <Field
                  label={`Payment ${String(i + 1)} amount (₹)`}
                  name={`amount-${p.key}`}
                  value={p.amount}
                  onChange={(v) => {
                    editPayment(p.key, { amount: v });
                  }}
                  isRequired={false}
                  inputMode="numeric"
                />
                {p.method === 'CASH' ? (
                  <Field
                    label="Cash handed over (₹, optional)"
                    name={`tendered-${p.key}`}
                    value={p.tendered}
                    onChange={(v) => {
                      editPayment(p.key, { tendered: v });
                    }}
                    isRequired={false}
                    inputMode="numeric"
                  />
                ) : (
                  <Field
                    label="Reference (UPI ref or card last 4 digits)"
                    name={`ref-${p.key}`}
                    value={p.reference}
                    onChange={(v) => {
                      editPayment(p.key, { reference: v });
                    }}
                    isRequired={false}
                  />
                )}
                {payments.length > 1 ? (
                  <button
                    type="button"
                    className="link cursor-pointer text-sm"
                    onClick={() => {
                      setPaymentsEdited(true);
                      setPayments(payments.filter((x) => x.key !== p.key));
                    }}
                  >
                    Remove payment {i + 1}
                  </button>
                ) : null}
              </div>
            ))}
            <div className="mb-3">
              <button
                type="button"
                className="link cursor-pointer text-sm"
                onClick={() => {
                  setPaymentsEdited(true);
                  setPayments([
                    ...payments,
                    {
                      key: nextKey(),
                      method: 'UPI',
                      amount: rupees(Math.max(total - paid, 0)),
                      reference: '',
                      tendered: '',
                    },
                  ]);
                }}
              >
                Split payment
              </button>
            </div>
            {view ? (
              <p className="mb-3 text-sm">
                {paid < total ? (
                  <span>
                    Balance due: <strong>{formatPaise(total - paid)}</strong>
                    {customer ? null : ' — choose a customer for a part payment'}
                  </span>
                ) : paid > total ? (
                  <span>
                    Paid {formatPaise(paid - total)} more than the total{customer ? ' (kept as advance)' : ''}
                  </span>
                ) : (
                  <span>Paid in full.</span>
                )}
              </p>
            ) : null}
            <Button onPress={() => void complete()} isDisabled={!view || busy || view.problems.length > 0}>
              Complete sale
            </Button>
            <p className="mt-3 text-xs text-ink-600">
              Payments are recorded as entered; UPI and card settlement is not verified.
            </p>
            {lines.length > 0 ? (
              <div className="mt-3 border-t border-ink-100 pt-3">
                <Button variant="secondary" onPress={reset}>
                  Hold and start a new sale
                </Button>
              </div>
            ) : null}
          </section>
          {(held.data?.sales ?? []).filter((s) => s.id !== saleId).length > 0 ? (
            <section aria-labelledby="held-heading" className="card">
              <h2 id="held-heading" className="section-title">
                Held sales
              </h2>
              <ul className="flex flex-col gap-2">
                {(held.data?.sales ?? [])
                  .filter((s) => s.id !== saleId)
                  .slice(0, 8)
                  .map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {s.customerName ?? 'Walk-in'} · {s.lineCount} item(s) · {formatPaise(s.totalPaise)}
                      </span>
                      <button type="button" className="link cursor-pointer" onClick={() => void resume(s.id)}>
                        Resume<span className="sr-only"> sale for {s.customerName ?? 'walk-in'}</span>
                      </button>
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-xs text-ink-600">Held sales do not reserve stock.</p>
            </section>
          ) : null}
          {business.can('pos.sell') ? null : <p className="text-sm">You do not have permission to sell.</p>}
        </aside>
      </div>
    </Page>
  );
}
