// Purchases: drafts with IMEI entry, deterministic checks, posting and
// reversal (FR-INV-3, FR-INV-5, FR-INV-8, WORKFLOWS §5). The IMEI box accepts
// a USB/Bluetooth scanner: each scan ends with Enter, giving one IMEI per line.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useNavigate, useParams } from 'react-router';
import { api, formatPaise, formatQty, rupeesToPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Button, cell, errorText, Field, NativeSelect, Page, Table, TextArea } from '../ui.tsx';
import { useSuppliers } from './suppliers.tsx';

export interface LineForm {
  variantId: string;
  quantity: string;
  unitCost: string;
  taxRateId: string;
  imeis: string;
}
export interface DraftForm {
  supplierId: string;
  invoiceNo: string;
  invoiceDate: string;
  supplierTotal: string;
  lines: LineForm[];
}

interface Problem {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  message: string;
  lineNo?: number;
  position?: number;
}
interface PurchaseView {
  id: string;
  status: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  supplierTotalPaise: number | null;
  isInterState: boolean;
  totals: { taxable: number; cgst: number; sgst: number; igst: number; tax: number; total: number };
  lines: {
    lineNo: number;
    variantId: string;
    sku: string;
    productName: string;
    quantity: string;
    unitCostPaise: number;
    taxRateId: string | null;
    total: number;
    units: { imei1: string | null; imei2: string | null; serialNumber: string | null }[];
  }[];
  problems: Problem[];
}

export const emptyLine = (): LineForm => ({ variantId: '', quantity: '1', unitCost: '', taxRateId: '', imeis: '' });

export function useVariantOptions(businessId: string) {
  const stock = useQuery({
    queryKey: ['stock', businessId, ''],
    queryFn: () =>
      api<{
        stock: { variantId: string; sku: string; productName: string; variantLabel: string; serialized: boolean }[];
      }>(`/api/businesses/${businessId}/stock`),
  });
  const rows = stock.data?.stock ?? [];
  return {
    options: rows.map(
      (r) => [r.variantId, `${r.productName} ${r.variantLabel ? `(${r.variantLabel})` : ''} — ${r.sku}`] as const,
    ),
    serialized: (id: string) => rows.find((r) => r.variantId === id)?.serialized === true,
  };
}

/** Form → API body. IMEI lines: "IMEI1" or "IMEI1, IMEI2" (or "S/N:XYZ" for a serial number). */
export function draftBody(form: DraftForm, serialized: (variantId: string) => boolean) {
  const total = form.supplierTotal.trim() ? rupeesToPaise(form.supplierTotal) : null;
  if (form.supplierTotal.trim() && total === null) throw new Error('Enter the printed total in rupees.');
  return {
    supplierId: form.supplierId,
    supplierInvoiceNo: form.invoiceNo.trim(),
    supplierInvoiceDate: form.invoiceDate.trim(),
    ...(total === null ? {} : { supplierTotalPaise: total }),
    lines: form.lines.map((l, i) => {
      const cost = rupeesToPaise(l.unitCost);
      if (!l.variantId) throw new Error(`Line ${String(i + 1)}: choose a product.`);
      if (cost === null) throw new Error(`Line ${String(i + 1)}: enter the unit cost in rupees.`);
      const units = l.imeis
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          if (/^s\/?n[:\s]/i.test(s)) return { serialNumber: s.replace(/^s\/?n[:\s]*/i, '') };
          const [imei1, imei2] = s.split(/[,\s]+/);
          return { imei1, ...(imei2 ? { imei2 } : {}) };
        });
      return {
        variantId: l.variantId,
        quantity: l.quantity.trim(),
        unitCostPaise: cost,
        taxRateId: l.taxRateId || null,
        ...(serialized(l.variantId) || units.length > 0 ? { units } : {}),
      };
    }),
  };
}

export function PurchaseForm(props: { businessId: string; form: DraftForm; onChange: (form: DraftForm) => void }) {
  const { businessId, form, onChange } = props;
  const suppliers = useSuppliers(businessId);
  const variants = useVariantOptions(businessId);
  const rates = useQuery({
    queryKey: ['tax-rates', businessId],
    queryFn: () =>
      api<{ taxRates: { id: string; name: string; ratePercent: string; effectiveTo: string | null }[] }>(
        `/api/businesses/${businessId}/tax-rates`,
      ),
  });
  const set = (patch: Partial<DraftForm>) => {
    onChange({ ...form, ...patch });
  };
  const setLine = (i: number, patch: Partial<LineForm>) => {
    onChange({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  };
  return (
    <>
      <NativeSelect
        label="Supplier"
        name="supplier"
        value={form.supplierId}
        onChange={(v) => {
          set({ supplierId: v });
        }}
        options={[['', 'Choose a supplier'], ...(suppliers.data?.suppliers ?? []).map((s) => [s.id, s.name] as const)]}
      />
      <div className="grid gap-x-3 sm:grid-cols-3">
        <Field
          label="Supplier invoice number"
          name="invoiceNo"
          value={form.invoiceNo}
          onChange={(v) => {
            set({ invoiceNo: v });
          }}
        />
        <Field
          label="Invoice date (YYYY-MM-DD)"
          name="invoiceDate"
          value={form.invoiceDate}
          onChange={(v) => {
            set({ invoiceDate: v });
          }}
        />
        <Field
          label="Printed total (₹, optional)"
          name="supplierTotal"
          value={form.supplierTotal}
          onChange={(v) => {
            set({ supplierTotal: v });
          }}
          isRequired={false}
          inputMode="numeric"
        />
      </div>
      {form.lines.map((l, i) => {
        const n = String(i + 1);
        return (
          <fieldset key={n} className="mb-4 min-w-0 card-inset">
            <legend className="px-1 font-semibold">Line {n}</legend>
            <NativeSelect
              label={`Line ${n} product`}
              name={`line${n}variant`}
              value={l.variantId}
              onChange={(v) => {
                setLine(i, { variantId: v });
              }}
              options={[['', 'Choose a product'], ...variants.options]}
            />
            <div className="grid gap-x-3 sm:grid-cols-3">
              <Field
                label={`Line ${n} quantity`}
                name={`line${n}qty`}
                value={l.quantity}
                onChange={(v) => {
                  setLine(i, { quantity: v });
                }}
                inputMode="numeric"
              />
              <Field
                label={`Line ${n} unit cost before tax (₹)`}
                name={`line${n}cost`}
                value={l.unitCost}
                onChange={(v) => {
                  setLine(i, { unitCost: v });
                }}
                inputMode="numeric"
              />
              <NativeSelect
                label={`Line ${n} tax rate`}
                name={`line${n}rate`}
                value={l.taxRateId}
                onChange={(v) => {
                  setLine(i, { taxRateId: v });
                }}
                options={[
                  ['', 'No tax'],
                  ...(rates.data?.taxRates ?? []).map((r) => [r.id, `${r.name} (${r.ratePercent}%)`] as const),
                ]}
              />
            </div>
            {variants.serialized(l.variantId) ? (
              <TextArea
                label={`Line ${n} IMEIs`}
                name={`line${n}imeis`}
                value={l.imeis}
                onChange={(v) => {
                  setLine(i, { imeis: v });
                }}
                rows={Math.max(2, Number(l.quantity) || 1)}
                description="One unit per line: IMEI 1, then optionally a comma and IMEI 2. A barcode scanner can type them directly."
              />
            ) : null}
          </fieldset>
        );
      })}
      <div className="mb-4">
        <Button
          variant="secondary"
          onPress={() => {
            set({ lines: [...form.lines, emptyLine()] });
          }}
        >
          Add line
        </Button>
      </div>
    </>
  );
}

const toForm = (p: PurchaseView): DraftForm => ({
  supplierId: p.supplierId,
  invoiceNo: p.supplierInvoiceNo,
  invoiceDate: p.supplierInvoiceDate,
  supplierTotal: p.supplierTotalPaise === null ? '' : (p.supplierTotalPaise / 100).toFixed(2),
  lines: p.lines.map((l) => ({
    variantId: l.variantId,
    quantity: formatQty(l.quantity),
    unitCost: (l.unitCostPaise / 100).toFixed(2),
    taxRateId: l.taxRateId ?? '',
    imeis: l.units
      .map((u) => (u.imei1 ? [u.imei1, u.imei2].filter(Boolean).join(', ') : `S/N: ${u.serialNumber ?? ''}`))
      .join('\n'),
  })),
});

export function PurchasesPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const list = useQuery({
    queryKey: ['purchases', businessId],
    queryFn: () =>
      api<{
        purchases: {
          id: string;
          status: string;
          supplierName: string;
          supplierInvoiceNo: string;
          supplierInvoiceDate: string;
          totalPaise: number;
        }[];
      }>(`/api/businesses/${businessId}/purchases`),
  });
  return (
    <Page title="Purchases">
      {business.can('purchases.create') ? (
        <p className="mb-4">
          <Link className="link" to={`/b/${businessId}/purchases/new`}>
            New purchase
          </Link>
        </p>
      ) : null}
      <Alert message={list.error ? errorText(list.error) : null} />
      <Table caption="Purchases" headers={['Supplier', 'Invoice', 'Date', 'Total', 'Status']}>
        {(list.data?.purchases ?? []).map((p) => (
          <tr key={p.id}>
            <td className={cell}>{p.supplierName}</td>
            <td className={cell}>
              <Link className="link" to={`/b/${businessId}/purchases/${p.id}`}>
                {p.supplierInvoiceNo}
              </Link>
            </td>
            <td className={cell}>{p.supplierInvoiceDate}</td>
            <td className={cell}>{formatPaise(p.totalPaise)}</td>
            <td className={cell}>{p.status.toLowerCase()}</td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}

export function PurchaseEditorPage() {
  const { businessId = '', purchaseId = 'new' } = useParams();
  const isNew = purchaseId === 'new';
  const business = useBusiness(businessId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const variants = useVariantOptions(businessId);
  const purchase = useQuery({
    queryKey: ['purchase', businessId, purchaseId],
    queryFn: () => api<{ purchase: PurchaseView }>(`/api/businesses/${businessId}/purchases/${purchaseId}`),
    enabled: !isNew,
  });
  const [form, setForm] = useState<DraftForm>({
    supplierId: '',
    invoiceNo: '',
    invoiceDate: '',
    supplierTotal: '',
    lines: [emptyLine()],
  });
  const [override, setOverride] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const p = purchase.data?.purchase;
  useEffect(() => {
    if (p) setForm(toForm(p));
  }, [p]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ text: ok, tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['purchase', businessId] });
      await queryClient.invalidateQueries({ queryKey: ['purchases', businessId] });
      await queryClient.invalidateQueries({ queryKey: ['stock', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  const save = () =>
    run(async () => {
      const body = draftBody(form, variants.serialized);
      if (isNew) {
        const created = await api<{ id: string }>(`/api/businesses/${businessId}/purchases`, { method: 'POST', body });
        await navigate(`/b/${businessId}/purchases/${created.id}`);
      } else {
        await api(`/api/businesses/${businessId}/purchases/${purchaseId}`, { method: 'PUT', body });
      }
    }, 'Draft saved. Review the checks below before posting.');

  const draft = isNew || p?.status === 'DRAFT';
  const duplicate = p?.problems.some((x) => x.code === 'DUPLICATE_SUPPLIER_INVOICE') === true;
  return (
    <Page title={isNew ? 'New purchase' : `Purchase ${p?.supplierInvoiceNo ?? ''}`}>
      {p ? (
        <p className="mb-3">
          Status: <strong>{p.status.toLowerCase()}</strong> · {p.supplierName}
        </p>
      ) : null}
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      {draft && business.can('purchases.create') ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <PurchaseForm businessId={businessId} form={form} onChange={setForm} />
          <Button type="submit">Save draft</Button>
        </Form>
      ) : null}
      {p ? (
        <section aria-labelledby="totals" className="mt-6">
          <h2 id="totals" className="section-title">
            Totals (computed)
          </h2>
          <Table
            caption="Computed totals"
            headers={['Taxable', p.isInterState ? 'IGST' : 'CGST + SGST', 'Total', 'Printed total']}
          >
            <tr>
              <td className={cell}>{formatPaise(p.totals.taxable)}</td>
              <td className={cell}>{formatPaise(p.isInterState ? p.totals.igst : p.totals.cgst + p.totals.sgst)}</td>
              <td className={cell}>{formatPaise(p.totals.total)}</td>
              <td className={cell}>{formatPaise(p.supplierTotalPaise)}</td>
            </tr>
          </Table>
          {p.problems.length > 0 ? (
            <>
              <h2 className="section-title">Checks</h2>
              <ul className="mb-4 list-disc pl-6">
                {p.problems.map((x, i) => (
                  <li key={i}>
                    <strong>{x.severity === 'BLOCKING' ? 'Must fix' : 'Check'}:</strong>{' '}
                    {x.lineNo ? `Line ${String(x.lineNo)}${x.position ? `, unit ${String(x.position)}` : ''}: ` : ''}
                    {x.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mb-4">No problems found.</p>
          )}
        </section>
      ) : null}
      {p?.status === 'DRAFT' && business.can('purchases.post') ? (
        <section aria-labelledby="post" className="mb-6">
          <h2 id="post" className="section-title">
            Post to stock
          </h2>
          {duplicate ? (
            <Field
              label="Reason for posting a duplicate supplier invoice number"
              name="override"
              value={override}
              onChange={setOverride}
              isRequired={false}
            />
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              onPress={() => {
                void run(
                  () =>
                    api(`/api/businesses/${businessId}/purchases/${purchaseId}/post`, {
                      method: 'POST',
                      body: duplicate && override ? { overrideReason: override } : {},
                    }),
                  'Posted. The stock has been added.',
                );
              }}
            >
              Post purchase
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                void run(
                  () =>
                    api(`/api/businesses/${businessId}/purchases/${purchaseId}/discard`, { method: 'POST', body: {} }),
                  'Draft discarded.',
                );
              }}
            >
              Discard draft
            </Button>
          </div>
        </section>
      ) : null}
      {p?.status === 'POSTED' && business.can('purchases.post') ? (
        <section aria-labelledby="reverse" className="mb-6">
          <h2 id="reverse" className="section-title">
            Reverse this purchase
          </h2>
          <p className="mb-2 text-sm text-ink-600">Only possible while every unit from it is still in stock.</p>
          <Field
            label="Reason for reversing"
            name="reverseReason"
            value={reason}
            onChange={setReason}
            isRequired={false}
          />
          <Button
            variant="danger"
            onPress={() => {
              void run(
                () =>
                  api(`/api/businesses/${businessId}/purchases/${purchaseId}/reverse`, {
                    method: 'POST',
                    body: { reason },
                  }),
                'Purchase reversed.',
              );
            }}
          >
            Reverse purchase
          </Button>
        </section>
      ) : null}
    </Page>
  );
}
