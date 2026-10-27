// Scans: upload a product label or supplier invoice, then review what was read
// before anything is created (FR-OCR-1…4). Values that were not found stay
// empty; flagged values must be confirmed; "Create" makes a draft purchase only.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useNavigate, useParams } from 'react-router';
import { api, uploadFile } from '../api.ts';
import { Alert, Button, cell, Checkbox, errorText, NativeSelect, Page, Table } from '../ui.tsx';
import { draftBody, emptyLine, PurchaseForm, useVariantOptions, type DraftForm } from './purchases.tsx';

interface ExtractedField {
  key: string;
  value: string | null;
  level: string;
  source: string | null;
  needsConfirmation: boolean;
  problems: string[];
}
interface Scan {
  id: string;
  scanType: 'PRODUCT_LABEL' | 'SUPPLIER_INVOICE';
  status: string;
  errorCode: string | null;
  retriesLeft: number;
  manualEntry: boolean;
  createdPurchaseId: string | null;
  file: { contentType: string; malwareScan: string };
  extraction: {
    fields: ExtractedField[];
    imeis?: ExtractedField[];
    lines?: {
      key: string;
      description: ExtractedField;
      quantity: ExtractedField;
      unitPricePaise: ExtractedField;
      amountPaise: ExtractedField;
      computedAmountPaise: number | null;
      imeis: ExtractedField[];
    }[];
  } | null;
  needsConfirmation: string[];
  existingImeis: { imei: string }[];
  catalogueMatches: { variantId: string; reason: string }[];
  lineMatches: Record<string, { variantId: string; reason: string }[]>;
  supplierMatches: { supplierId: string; name: string; reason: string }[];
}

const ACTIVE = new Set(['UPLOADED', 'QUEUED', 'PROCESSING']);
const TYPE_LABEL = { PRODUCT_LABEL: 'Product box label', SUPPLIER_INVOICE: 'Supplier invoice' } as const;
const PROBLEM: Readonly<Record<string, string>> = {
  IMEI_INVALID: 'not a valid IMEI',
  IMEI_MALFORMED: 'IMEI has the wrong length',
  DUPLICATE_IN_SCAN: 'appears twice in this scan',
  GSTIN_INVALID: 'GSTIN check failed',
  INVALID_DATE: 'not a real date',
  AMOUNT_MISMATCH: 'printed amount differs from quantity × price',
};

export function ScansPage() {
  const { businessId = '' } = useParams();
  const queryClient = useQueryClient();
  const [type, setType] = useState<'PRODUCT_LABEL' | 'SUPPLIER_INVOICE'>('SUPPLIER_INVOICE');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const scans = useQuery({
    queryKey: ['scans', businessId],
    queryFn: () =>
      api<{
        scans: {
          id: string;
          scanType: keyof typeof TYPE_LABEL;
          status: string;
          errorCode: string | null;
          createdAt: string;
        }[];
      }>(`/api/businesses/${businessId}/scans`),
    refetchInterval: (q) => (q.state.data?.scans.some((s) => ACTIVE.has(s.status)) ? 2000 : false),
  });

  const send = async () => {
    setMessage(null);
    if (!file) {
      setMessage({ text: 'Choose a photo or PDF first.', tone: 'error' });
      return;
    }
    try {
      await uploadFile(`/api/businesses/${businessId}/scans?type=${type}&name=${encodeURIComponent(file.name)}`, file);
      setMessage({ text: 'Uploaded. Reading the document…', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['scans', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title="Scans">
      <p className="mb-3 text-sm text-slate-700">
        Photos (JPEG, PNG, WebP) or PDFs up to 10 MB. Files are checked for type and size; no malware scanner is
        configured. This build reads text with a test adapter only — no OCR service is connected yet.
      </p>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <NativeSelect
          label="What are you scanning?"
          name="scanType"
          value={type}
          onChange={(v) => {
            setType(v === 'PRODUCT_LABEL' ? 'PRODUCT_LABEL' : 'SUPPLIER_INVOICE');
          }}
          options={[
            ['SUPPLIER_INVOICE', TYPE_LABEL.SUPPLIER_INVOICE],
            ['PRODUCT_LABEL', TYPE_LABEL.PRODUCT_LABEL],
          ]}
        />
        <div className="mb-3 flex flex-col gap-1">
          <label htmlFor="scan-file" className="font-medium">
            Photo or PDF
          </label>
          <input
            id="scan-file"
            name="scanFile"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
            }}
            className="w-full max-w-full rounded border border-slate-400 bg-white px-3 py-2"
          />
        </div>
        <Button type="submit">Upload</Button>
      </Form>
      <Table caption="Scans" headers={['Type', 'Uploaded', 'Status']}>
        {(scans.data?.scans ?? []).map((s) => (
          <tr key={s.id}>
            <td className={cell}>
              <Link className="text-blue-800 underline" to={`/b/${businessId}/scans/${s.id}`}>
                {TYPE_LABEL[s.scanType]}
              </Link>
            </td>
            <td className={cell}>{new Date(s.createdAt).toLocaleString('en-IN')}</td>
            <td className={cell}>
              {s.status.replaceAll('_', ' ').toLowerCase()}
              {s.errorCode ? ` (${s.errorCode.replaceAll('_', ' ').toLowerCase()})` : ''}
            </td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}

function initialForm(scan: Scan, serialized: (id: string) => boolean): DraftForm {
  const e = scan.extraction;
  const value = (key: string) => e?.fields.find((f) => f.key === key)?.value ?? '';
  const supplierId = scan.supplierMatches[0]?.supplierId ?? '';
  if (!e) return { supplierId, invoiceNo: '', invoiceDate: '', supplierTotal: '', lines: [emptyLine()] };
  const date = value('invoiceDate');
  const base = {
    supplierId,
    invoiceNo: value('invoiceNo'),
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    supplierTotal: value('totalPaise') ? (Number(value('totalPaise')) / 100).toFixed(2) : '',
  };
  if (scan.scanType === 'PRODUCT_LABEL') {
    const imeis = (e.imeis ?? []).map((f) => f.value ?? '').filter(Boolean);
    const variantId = scan.catalogueMatches[0]?.variantId ?? '';
    // A label usually shows IMEI 1 and IMEI 2 of one phone.
    return {
      ...base,
      lines: [{ ...emptyLine(), variantId, quantity: '1', imeis: imeis.slice(0, 2).join(', ') }],
    };
  }
  const lines = (e.lines ?? []).map((l) => {
    const variantId = scan.lineMatches[l.key]?.[0]?.variantId ?? '';
    return {
      variantId,
      quantity: l.quantity.value ?? '',
      unitCost: l.unitPricePaise.value ? (Number(l.unitPricePaise.value) / 100).toFixed(2) : '',
      taxRateId: '',
      imeis: serialized(variantId) ? l.imeis.map((f) => f.value ?? '').join('\n') : '',
    };
  });
  return { ...base, lines: lines.length > 0 ? lines : [emptyLine()] };
}

function FieldRows(props: {
  fields: readonly ExtractedField[];
  label: (key: string) => string;
  confirmed: Set<string>;
  toggle: (key: string, on: boolean) => void;
}) {
  return (
    <>
      {props.fields.map((f) => (
        <tr key={f.key}>
          <td className={cell}>{props.label(f.key)}</td>
          <td className={`${cell} break-all`}>{f.value ?? <em>not found</em>}</td>
          <td className={cell}>{f.value === null ? '—' : f.level}</td>
          <td className={`${cell} break-all text-slate-700`}>{f.source ?? '—'}</td>
          <td className={cell}>
            {f.problems.map((p) => PROBLEM[p] ?? p).join('; ') || '—'}
            {f.needsConfirmation ? (
              <Checkbox
                label={`Confirm ${props.label(f.key)}`}
                name={`confirm-${f.key}`}
                checked={props.confirmed.has(f.key)}
                onChange={(on) => {
                  props.toggle(f.key, on);
                }}
              />
            ) : null}
          </td>
        </tr>
      ))}
    </>
  );
}

const LABELS: Readonly<Record<string, string>> = {
  brand: 'Brand',
  modelName: 'Model',
  modelNumber: 'Model number',
  ram: 'RAM',
  storage: 'Storage',
  colour: 'Colour',
  barcode: 'Barcode',
  serialNumber: 'Serial number',
  supplierName: 'Supplier name',
  gstin: 'GSTIN',
  invoiceNo: 'Invoice number',
  invoiceDate: 'Invoice date',
  totalPaise: 'Printed total (paise)',
};

function labelFor(key: string): string {
  const imei = /^(?:line\.(\d+)\.)?imei\.(\d+)$/.exec(key);
  if (imei) return `${imei[1] ? `Line ${imei[1]} ` : ''}IMEI ${imei[2] ?? ''}`;
  const line = /^line\.(\d+)\.(\w+)$/.exec(key);
  if (line) {
    const what = {
      description: 'description',
      quantity: 'quantity',
      unitPricePaise: 'unit price (paise)',
      amountPaise: 'amount (paise)',
    }[line[2] ?? ''];
    return `Line ${line[1] ?? ''} ${what ?? line[2] ?? ''}`;
  }
  return LABELS[key] ?? key;
}

export function ScanReviewPage() {
  const { businessId = '', scanId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const variants = useVariantOptions(businessId);
  const scan = useQuery({
    queryKey: ['scan', businessId, scanId],
    queryFn: () => api<{ scan: Scan }>(`/api/businesses/${businessId}/scans/${scanId}`),
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.scan.status) ? 2000 : false),
  });
  const s = scan.data?.scan;
  const [form, setForm] = useState<DraftForm | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  useEffect(() => {
    if (s?.status === 'NEEDS_REVIEW' && form === null && variants.options.length > 0)
      setForm(initialForm(s, variants.serialized));
  }, [s, form, variants]);

  const toggle = (key: string, on: boolean) => {
    setConfirmed((old) => {
      const next = new Set(old);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const create = async () => {
    if (!form) return;
    setMessage(null);
    try {
      const out = await api<{ purchaseId: string }>(`/api/businesses/${businessId}/scans/${scanId}/create`, {
        method: 'POST',
        body: { purchase: draftBody(form, variants.serialized), confirmed: [...confirmed] },
      });
      await queryClient.invalidateQueries();
      await navigate(`/b/${businessId}/purchases/${out.purchaseId}`);
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  const act = async (path: 'retry' | 'discard') => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/scans/${scanId}/${path}`, { method: 'POST', body: {} });
      await queryClient.invalidateQueries({ queryKey: ['scan', businessId, scanId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  if (!s) return <Page title="Scan">{scan.error ? <Alert message={errorText(scan.error)} /> : <p>Loading…</p>}</Page>;
  const e = s.extraction;
  const fileUrl = `/api/businesses/${businessId}/scans/${scanId}/file`;
  const unconfirmed = s.needsConfirmation.filter((k) => !confirmed.has(k));
  return (
    <Page title={`Review ${TYPE_LABEL[s.scanType].toLowerCase()}`}>
      <p className="mb-3">
        Status: <strong>{s.status.replaceAll('_', ' ').toLowerCase()}</strong>
        {s.errorCode ? ` (${s.errorCode.replaceAll('_', ' ').toLowerCase()})` : ''}
        {s.file.malwareScan === 'NOT_CONFIGURED' ? ' · Not scanned for malware (no scanner configured).' : ''}
      </p>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      {s.file.contentType.startsWith('image/') ? (
        <img
          src={fileUrl}
          alt={`Uploaded ${TYPE_LABEL[s.scanType].toLowerCase()}`}
          className="mb-4 max-h-80 rounded border border-slate-300"
        />
      ) : (
        <p className="mb-4">
          <a className="text-blue-800 underline" href={fileUrl}>
            Download the uploaded PDF
          </a>
        </p>
      )}
      {s.status === 'FAILED' ? (
        <div className="mb-4 flex flex-wrap gap-3">
          {s.retriesLeft > 0 ? <Button onPress={() => void act('retry')}>Try again</Button> : null}
          <Button variant="secondary" onPress={() => void act('discard')}>
            Discard
          </Button>
        </div>
      ) : null}
      {e ? (
        <>
          {s.manualEntry ? <Alert message="Automatic structuring was discarded; check every field by hand." /> : null}
          {s.existingImeis.length > 0 ? (
            <Alert message={`Already in stock records: ${s.existingImeis.map((x) => x.imei).join(', ')}`} />
          ) : null}
          <h2 className="mb-2 text-xl font-semibold">What was read</h2>
          <Table
            caption="Fields read from the document"
            headers={['Field', 'Value', 'Confidence', 'Seen in the document as', 'Checks']}
          >
            <FieldRows
              fields={[
                ...e.fields,
                ...(e.imeis ?? []),
                ...(e.lines ?? []).flatMap((l) => [
                  l.description,
                  l.quantity,
                  l.unitPricePaise,
                  l.amountPaise,
                  ...l.imeis,
                ]),
              ]}
              label={labelFor}
              confirmed={confirmed}
              toggle={toggle}
            />
          </Table>
          {s.catalogueMatches.length > 0 ? (
            <p className="mb-3">Suggested product: {s.catalogueMatches.map((m) => m.reason).join(', ')}.</p>
          ) : null}
        </>
      ) : null}
      {s.status === 'NEEDS_REVIEW' && form ? (
        <section aria-labelledby="create">
          <h2 id="create" className="mb-2 text-xl font-semibold">
            Create a draft purchase
          </h2>
          <p className="mb-3 text-sm text-slate-700">
            Check and correct the values below. Nothing is added to stock until the draft is posted.
          </p>
          <Form
            onSubmit={(ev) => {
              ev.preventDefault();
              void create();
            }}
          >
            <PurchaseForm businessId={businessId} form={form} onChange={setForm} />
            {unconfirmed.length > 0 ? (
              <p className="mb-3 font-medium text-red-800">
                Confirm the highlighted fields above ({unconfirmed.length} left).
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" isDisabled={unconfirmed.length > 0}>
                Create draft purchase
              </Button>
              <Button variant="secondary" onPress={() => void act('discard')}>
                Discard scan
              </Button>
            </div>
          </Form>
        </section>
      ) : null}
      {s.createdPurchaseId ? (
        <p>
          <Link className="text-blue-800 underline" to={`/b/${businessId}/purchases/${s.createdPurchaseId}`}>
            Open the draft purchase
          </Link>
        </p>
      ) : null}
    </Page>
  );
}
