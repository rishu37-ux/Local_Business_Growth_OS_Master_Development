// Scans: upload a product label or supplier invoice, then review what was read
// before anything is created (FR-OCR-1…4). Values that were not found stay
// empty; flagged values must be confirmed; "Create" makes a draft purchase only.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useNavigate, useParams } from 'react-router';
import { api, rupeesToPaise, uploadFile } from '../api.ts';
import { TakePhoto } from '../camera.tsx';
import { Alert, Button, cell, Checkbox, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';
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

  const send = async (photo: Blob | null = file, name = file?.name ?? 'scan') => {
    setMessage(null);
    if (!photo) {
      setMessage({ text: 'Choose a photo or PDF first.', tone: 'error' });
      return;
    }
    try {
      await uploadFile(`/api/businesses/${businessId}/scans?type=${type}&name=${encodeURIComponent(name)}`, photo);
      setMessage({ text: 'Uploaded. Reading the document…', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['scans', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title="Scans">
      <p className="mb-3 text-sm text-ink-600">
        Photos (JPEG, PNG, WebP) or PDFs up to 10 MB. Files are checked for type and size; no malware scanner is
        configured. The text is read on this shop's server (Tesseract) when it is installed; always check what was read.
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
        <TakePhoto
          what={type === 'PRODUCT_LABEL' ? 'box label' : 'supplier bill'}
          name="scan"
          onPhoto={(photo, name) => void send(photo, name)}
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
            className="w-full max-w-full rounded border border-ink-300 bg-white px-3 py-2"
          />
        </div>
        <Button type="submit">Upload</Button>
      </Form>
      <Table caption="Scans" headers={['Type', 'Uploaded', 'Status']}>
        {(scans.data?.scans ?? []).map((s) => (
          <tr key={s.id}>
            <td className={cell}>
              <Link className="link" to={`/b/${businessId}/scans/${s.id}`}>
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
          <td className={`${cell} break-all text-ink-600`}>{f.source ?? '—'}</td>
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
          className="mb-4 max-h-80 rounded border border-ink-200"
        />
      ) : (
        <p className="mb-4">
          <a className="link" href={fileUrl}>
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
          <h2 className="section-title">What was read</h2>
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
      {s.status === 'NEEDS_REVIEW' && s.scanType === 'PRODUCT_LABEL' && s.catalogueMatches.length === 0 ? (
        <NewProductFromLabel
          businessId={businessId}
          scanId={scanId}
          onCreated={async (name) => {
            setMessage({
              text: `${name} added to the catalogue. Now create the purchase to bring it into stock.`,
              tone: 'success',
            });
            await queryClient.invalidateQueries();
            setForm(null);
          }}
        />
      ) : null}
      {s.status === 'NEEDS_REVIEW' && form ? (
        <section aria-labelledby="create">
          <h2 id="create" className="section-title">
            Create a draft purchase
          </h2>
          <p className="mb-3 text-sm text-ink-600">
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
          <Link className="link" to={`/b/${businessId}/purchases/${s.createdPurchaseId}`}>
            Open the draft purchase
          </Link>
        </p>
      ) : null}
    </Page>
  );
}

interface ProductDraft {
  brandName: string | null;
  brandId: string | null;
  modelName: string | null;
  modelNumber: string | null;
  isSerialized: boolean;
  variant: {
    ram: string | null;
    storage: string | null;
    colour: string | null;
    barcode: string | null;
    sku: string | null;
  };
  imeis: string[];
}

/** 12.3: a product from the box label, pre-filled and checked by the person, saved by the normal product rules. */
function NewProductFromLabel(props: {
  businessId: string;
  scanId: string;
  onCreated: (name: string) => Promise<void>;
}) {
  const base = `/api/businesses/${props.businessId}`;
  const draft = useQuery({
    queryKey: ['product-draft', props.businessId, props.scanId],
    queryFn: () => api<{ draft: ProductDraft }>(`${base}/scans/${props.scanId}/product-draft`),
  });
  const d = draft.data?.draft;
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [serialized, setSerialized] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!d || f) return;
    setSerialized(d.isSerialized);
    setF({
      brand: d.brandName ?? '',
      modelName: d.modelName ?? '',
      modelNumber: d.modelNumber ?? '',
      ram: d.variant.ram ?? '',
      storage: d.variant.storage ?? '',
      colour: d.variant.colour ?? '',
      barcode: d.variant.barcode ?? '',
      sku: d.variant.sku ?? '',
      price: '',
    });
  }, [d, f]);
  if (!d || !f) return null;
  const set = (k: string) => (v: string) => {
    setF({ ...f, [k]: v });
  };
  const save = async () => {
    setError(null);
    const price = rupeesToPaise(f.price ?? '');
    if (price === null) {
      setError('Enter the selling price in rupees.');
      return;
    }
    try {
      let brandId = d.brandId;
      const brand = (f.brand ?? '').trim();
      if (brand && (!brandId || brand.toLowerCase() !== (d.brandName ?? '').toLowerCase())) {
        brandId = (await api<{ id: string }>(`${base}/brands`, { method: 'POST', body: { name: brand } })).id;
      }
      const text = (k: string) => (f[k] ?? '').trim() || null;
      await api(`${base}/products`, {
        method: 'POST',
        body: {
          ...(brandId ? { brandId } : {}),
          modelName: text('modelName') ?? '',
          modelNumber: text('modelNumber'),
          isSerialized: serialized,
          variants: [
            {
              sku: text('sku') ?? '',
              barcode: text('barcode'),
              ram: text('ram'),
              storage: text('storage'),
              colour: text('colour'),
              sellingPricePaise: price,
            },
          ],
        },
      });
      await props.onCreated(text('modelName') ?? 'The product');
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section aria-labelledby="new-product">
      <h2 id="new-product" className="section-title">
        Add this product to the catalogue
      </h2>
      <p className="mb-3 text-sm text-ink-600">
        No matching product was found. Check the values read from the label, add the selling price, and save. The IMEIs
        come into stock with the purchase below.
      </p>
      <Alert message={error} />
      <Form
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Brand" name="npBrand" value={f.brand ?? ''} onChange={set('brand')} isRequired={false} />
          <Field label="Model" name="npModel" value={f.modelName ?? ''} onChange={set('modelName')} />
          <Field
            label="Model number"
            name="npModelNumber"
            value={f.modelNumber ?? ''}
            onChange={set('modelNumber')}
            isRequired={false}
          />
          <Field label="SKU (your code for it)" name="npSku" value={f.sku ?? ''} onChange={set('sku')} />
          <Field label="RAM" name="npRam" value={f.ram ?? ''} onChange={set('ram')} isRequired={false} />
          <Field
            label="Storage"
            name="npStorage"
            value={f.storage ?? ''}
            onChange={set('storage')}
            isRequired={false}
          />
          <Field label="Colour" name="npColour" value={f.colour ?? ''} onChange={set('colour')} isRequired={false} />
          <Field
            label="Barcode"
            name="npBarcode"
            value={f.barcode ?? ''}
            onChange={set('barcode')}
            isRequired={false}
          />
          <Field
            label="Selling price (₹)"
            name="npPrice"
            value={f.price ?? ''}
            onChange={set('price')}
            inputMode="numeric"
          />
        </div>
        <Checkbox
          label="Each piece has its own IMEI or serial number"
          name="npSerialized"
          checked={serialized}
          onChange={setSerialized}
        />
        <Button type="submit">Save product</Button>
      </Form>
    </section>
  );
}
