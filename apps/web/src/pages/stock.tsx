// Stock: lookup by scan, levels, reports, inspections and adjustments
// (FR-INV-4, FR-INV-6, FR-INV-7, FR-INV-9). Report numbers are labelled with
// their definitions; reorder figures are suggestions only.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, ApiError, formatPaise, formatQty } from '../api.ts';
import { PhotoLookup } from '../camera.tsx';
import { useBusiness } from '../business.ts';
import { Alert, Button, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';
import { ExportLinks } from '../exports.tsx';
import { useVariantOptions } from './purchases.tsx';

interface StockRow {
  variantId: string;
  sku: string;
  productName: string;
  variantLabel: string;
  serialized: boolean;
  available: string;
  inspection: string;
  damaged: string;
  repair: string;
  reorderLevel: number | null;
  low: boolean;
  availableValuePaise?: number;
}
type Message = { text: string; tone: 'error' | 'success' } | null;

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (options: { formats: string[] }) => Detector;

/** BarcodeDetector exists only in some browsers; without it, the manual field is all there is. */
function barcodeDetector(): DetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * One field for typed or scanned codes (FR-INV-9). USB/Bluetooth scanners act
 * as keyboards and end with Enter, so no configuration is needed. A camera
 * button appears only when the browser can detect barcodes.
 */
export function ScanField(props: { label: string; onCode: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const onCode = useRef(props.onCode);
  onCode.current = props.onCode;
  const Ctor = barcodeDetector();

  useEffect(() => {
    if (!scanning || !Ctor) return;
    let stream: MediaStream | null = null;
    const state = { stopped: false };
    const detector = new Ctor({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        for (;;) {
          const el = video.current as HTMLVideoElement | null;
          if (state.stopped || !el) return;
          const found = await detector.detect(el);
          const value = found[0]?.rawValue;
          if (value) {
            onCode.current(value);
            setScanning(false);
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setCameraError('The camera could not be used. Type or scan the code instead.');
        setScanning(false);
      }
    })();
    return () => {
      state.stopped = true;
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, [scanning, Ctor]);

  return (
    <div className="mb-4">
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) props.onCode(code.trim());
          setCode('');
        }}
      >
        <Field
          label={props.label}
          name="scan"
          value={code}
          onChange={setCode}
          isRequired={false}
          description="Type a barcode, SKU or IMEI, or scan it with a barcode scanner."
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit">Find</Button>
          {Ctor ? (
            <Button
              variant="secondary"
              onPress={() => {
                setCameraError(null);
                setScanning((s) => !s);
              }}
            >
              {scanning ? 'Stop camera' : 'Scan with camera'}
            </Button>
          ) : null}
        </div>
      </Form>
      {scanning ? <video ref={video} className="mt-3 max-h-64 w-full rounded bg-black" muted playsInline /> : null}
      <Alert message={cameraError} />
    </div>
  );
}

export function StockPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const stock = useQuery({
    queryKey: ['stock', businessId, ''],
    queryFn: () => api<{ stock: StockRow[] }>(`/api/businesses/${businessId}/stock`),
  });
  const recon = useQuery({
    queryKey: ['stock', businessId, 'reconciliation'],
    queryFn: () => api<{ consistent: boolean }>(`/api/businesses/${businessId}/stock/reconciliation`),
  });
  const [found, setFound] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const canSeeCost = business.can('catalogue.cost.view');

  const lookup = async (code: string) => {
    setFound(null);
    setLookupError(null);
    try {
      const r = await api<{ match: string; productName: string; sku: string; unitStatus?: string }>(
        `/api/businesses/${businessId}/lookup?code=${encodeURIComponent(code)}`,
      );
      setFound(
        `${r.productName} — ${r.sku} (matched by ${r.match.toLowerCase()})${r.unitStatus ? `, unit ${r.unitStatus.replaceAll('_', ' ').toLowerCase()}` : ''}`,
      );
    } catch (err) {
      setLookupError(err instanceof ApiError && err.status === 404 ? `Nothing found for “${code}”.` : errorText(err));
    }
  };

  return (
    <Page
      title="Stock"
      actions={
        <div className="flex flex-col gap-1">
          <ExportLinks businessId={businessId} list="stock" what="stock levels" />
          <ExportLinks businessId={businessId} list="imeis" what="phones by IMEI" />
        </div>
      }
    >
      <ScanField label="Find by code" onCode={(c) => void lookup(c)} />
      <details className="mb-4">
        <summary className="cursor-pointer text-sm font-medium text-brand-700">Find by photo (IMEI or barcode)</summary>
        <div className="mt-2">
          <PhotoLookup
            businessId={businessId}
            what="IMEI or barcode"
            name="stock"
            onResult={(r) => {
              setLookupError(null);
              const parts = [
                ...r.imeis.map((x) =>
                  x.unit
                    ? `IMEI ${x.imei}: ${x.unit.productName} (${x.unit.sku}), ${x.unit.status.replaceAll('_', ' ').toLowerCase()}`
                    : `IMEI ${x.imei}: not in this shop`,
                ),
                ...r.products.map((p) => `${p.productName} (${p.sku}): ${formatQty(p.available)} available`),
              ];
              if (parts.length === 0) setLookupError('No IMEI or known barcode could be read from the photo.');
              setFound(parts.length ? parts.join(' · ') : null);
            }}
          />
        </div>
      </details>
      <Alert message={found} tone="success" />
      <Alert message={lookupError} />
      <p className="mb-2 text-sm text-ink-600">
        Available = sellable stock. Returned goods awaiting inspection, damaged and in-repair stock are counted
        separately and cannot be sold.{' '}
        {recon.data
          ? recon.data.consistent
            ? 'Stock levels match the stock ledger.'
            : 'Stock levels do NOT match the ledger — contact support.'
          : ''}
      </p>
      <Table
        caption="Stock levels"
        headers={[
          'Product',
          'SKU',
          'Available',
          'Inspection',
          'Damaged',
          'Repair',
          'Reorder level',
          ...(canSeeCost ? ['Value at cost'] : []),
        ]}
      >
        {(stock.data?.stock ?? []).map((r) => (
          <tr key={r.variantId}>
            <td className={cell}>
              {r.productName} {r.variantLabel ? <span className="text-ink-600">({r.variantLabel})</span> : null}
            </td>
            <td className={cell}>{r.sku}</td>
            <td className={cell}>
              {formatQty(r.available)}
              {r.low ? <strong className="ml-1 text-red-800">Low</strong> : null}
            </td>
            <td className={cell}>{formatQty(r.inspection)}</td>
            <td className={cell}>{formatQty(r.damaged)}</td>
            <td className={cell}>{formatQty(r.repair)}</td>
            <td className={cell}>{r.reorderLevel ?? '—'}</td>
            {canSeeCost ? <td className={cell}>{formatPaise(r.availableValuePaise)}</td> : null}
          </tr>
        ))}
      </Table>
      <Reports businessId={businessId} />
      {business.can('returns.inspect') ? (
        <Inspections
          businessId={businessId}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['stock', businessId] });
          }}
        />
      ) : null}
      {business.can('inventory.adjust.request') ? (
        <Adjustments
          businessId={businessId}
          canApprove={business.can('inventory.adjust.approve')}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['stock', businessId] });
          }}
        />
      ) : null}
    </Page>
  );
}

function Reports({ businessId }: { businessId: string }) {
  const reorder = useQuery({
    queryKey: ['stock', businessId, 'reorder'],
    queryFn: () =>
      api<{
        formula: string;
        period: { days: number };
        leadTimeDays: number;
        onOrderNote: string;
        rows: {
          variantId: string;
          sku: string;
          productName: string;
          averageDailySales: string;
          suggestedUnits: number;
        }[];
      }>(`/api/businesses/${businessId}/stock/reports/reorder`),
  });
  const aged = useQuery({
    queryKey: ['stock', businessId, 'aged'],
    queryFn: () =>
      api<{
        slowDays: number;
        deadDays: number;
        rows: { variantId: string; sku: string; productName: string; age: string; daysWithoutSale: number }[];
      }>(`/api/businesses/${businessId}/stock/reports/aged`),
  });
  return (
    <section aria-labelledby="reports" className="mb-6">
      <h2 id="reports" className="section-title">
        Reorder suggestions
      </h2>
      {reorder.data ? (
        <p className="mb-2 text-sm text-ink-600">
          Suggestion only. Formula: {reorder.data.formula}. Sales period: last {reorder.data.period.days} days; lead
          time {reorder.data.leadTimeDays} days. {reorder.data.onOrderNote}
        </p>
      ) : null}
      <Table caption="Reorder suggestions" headers={['Product', 'SKU', 'Average daily sales', 'Suggested order']}>
        {(reorder.data?.rows ?? []).map((r) => (
          <tr key={r.variantId}>
            <td className={cell}>{r.productName}</td>
            <td className={cell}>{r.sku}</td>
            <td className={cell}>{formatQty(r.averageDailySales)}</td>
            <td className={cell}>{r.suggestedUnits}</td>
          </tr>
        ))}
      </Table>
      <h2 className="section-title">Slow-moving and dead stock</h2>
      {aged.data ? (
        <p className="mb-2 text-sm text-ink-600">
          In stock with no sale for {aged.data.slowDays} days (slow) or {aged.data.deadDays} days (dead); items never
          sold count from when they were first received.
        </p>
      ) : null}
      <Table caption="Slow-moving and dead stock" headers={['Product', 'SKU', 'Days without a sale', 'Status']}>
        {(aged.data?.rows ?? []).map((r) => (
          <tr key={r.variantId}>
            <td className={cell}>{r.productName}</td>
            <td className={cell}>{r.sku}</td>
            <td className={cell}>{r.daysWithoutSale}</td>
            <td className={cell}>{r.age.toLowerCase()}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function Inspections({ businessId, onDone }: { businessId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ['stock', businessId, 'inspections'],
    queryFn: () =>
      api<{
        queue: {
          variantId: string;
          unitId: string | null;
          sku: string;
          productName: string;
          imei1: string | null;
          status: string;
          quantity: string;
        }[];
      }>(`/api/businesses/${businessId}/stock/inspections`),
  });
  const [message, setMessage] = useState<Message>(null);
  const record = async (item: { variantId: string; unitId: string | null; quantity: string }, outcome: string) => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/stock/inspections`, {
        method: 'POST',
        body: item.unitId ? { unitId: item.unitId, outcome } : { variantId: item.variantId, quantity: '1', outcome },
      });
      setMessage({ text: 'Inspection recorded.', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['stock', businessId] });
      onDone();
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  const items = queue.data?.queue ?? [];
  return (
    <section aria-labelledby="inspections" className="mb-6">
      <h2 id="inspections" className="section-title">
        Awaiting inspection
      </h2>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      {items.length === 0 ? <p className="mb-2">Nothing is waiting.</p> : null}
      <ul className="mb-2">
        {items.map((it) => {
          const what = `${it.productName} ${it.imei1 ? `IMEI ${it.imei1}` : `(${formatQty(it.quantity)} waiting)`}`;
          const outcomes: [string, string][] =
            it.status === 'IN_REPAIR'
              ? [['REPAIRED', 'Back from repair']]
              : [
                  ['RESTOCK', 'Restock'],
                  ['DAMAGED', 'Damaged'],
                  ['REPAIR', 'Send to repair'],
                  ['RETURN_TO_SUPPLIER', 'Return to supplier'],
                ];
          return (
            <li key={`${it.variantId}-${it.unitId ?? 'qty'}`} className="mb-3 card-inset">
              <p className="mb-2">{what}</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label={`Outcome for ${what}`}>
                {outcomes.map(([value, label]) => (
                  <Button key={value} variant="secondary" onPress={() => void record(it, value)}>
                    {label}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Adjustments(props: { businessId: string; canApprove: boolean; onDone: () => void }) {
  const variants = useVariantOptions(props.businessId);
  const [variantId, setVariantId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<Message>(null);
  const submit = async () => {
    setMessage(null);
    try {
      const out = await api<{ status: string }>(`/api/businesses/${props.businessId}/stock/adjustments`, {
        method: 'POST',
        body: { kind: 'QUANTITY', variantId, quantity: quantity.trim(), reason },
      });
      setMessage({
        text:
          out.status === 'EXECUTED' ? 'Stock adjusted.' : 'Sent for approval. The stock changes once it is approved.',
        tone: 'success',
      });
      setQuantity('');
      setReason('');
      props.onDone();
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };
  return (
    <section aria-labelledby="adjust" className="mb-6">
      <h2 id="adjust" className="section-title">
        Adjust a stock count
      </h2>
      <p className="mb-2 text-sm text-ink-600">
        For items counted by quantity.{' '}
        {props.canApprove
          ? 'Your adjustments apply at once and are recorded.'
          : 'An approver must approve your adjustment.'}
      </p>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <NativeSelect
          label="Product to adjust"
          name="adjustVariant"
          value={variantId}
          onChange={setVariantId}
          options={[['', 'Choose a product'], ...variants.options]}
        />
        <Field
          label="Change in quantity (e.g. -2 or 3)"
          name="adjustQuantity"
          value={quantity}
          onChange={setQuantity}
          description="Negative removes stock, positive adds it."
        />
        <Field label="Reason (at least 10 characters)" name="adjustReason" value={reason} onChange={setReason} />
        <Button type="submit">{props.canApprove ? 'Adjust stock' : 'Request adjustment'}</Button>
      </Form>
    </section>
  );
}
