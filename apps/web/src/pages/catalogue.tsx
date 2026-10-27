// Catalogue: products (models) with variants, and versioned tax rates
// (FR-INV-1, FR-INV-2, FR-TAX-2). Cost prices appear only for members who may see them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { api, formatPaise, rupeesToPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Button, cell, Checkbox, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';

interface ProductSummary {
  id: string;
  modelName: string;
  modelNumber: string | null;
  brandName: string | null;
  isSerialized: boolean;
  variantCount: number;
}
interface Variant {
  id: string;
  sku: string;
  barcode: string | null;
  ram: string | null;
  storage: string | null;
  colour: string | null;
  sellingPricePaise: number;
  purchasePricePaise?: number | null;
  avgCostPaise?: number | null;
  reorderLevel: number | null;
  hsnCode: string | null;
}
interface TaxRate {
  id: string;
  name: string;
  ratePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

type Message = { text: string; tone: 'error' | 'success' } | null;

function useTaxRates(businessId: string) {
  return useQuery({
    queryKey: ['tax-rates', businessId],
    queryFn: () => api<{ taxRates: TaxRate[] }>(`/api/businesses/${businessId}/tax-rates`),
  });
}

/** Variant fields shared by "new product" and "add variant". */
function VariantFields(props: {
  businessId: string;
  canSeeCost: boolean;
  value: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const rates = useTaxRates(props.businessId);
  const v = props.value;
  const set = (key: string) => (value: string) => {
    props.onChange(key, value);
  };
  return (
    <>
      <Field
        label="SKU"
        name="sku"
        value={v.sku ?? ''}
        onChange={set('sku')}
        description="Letters, digits and . _ / - only."
      />
      <Field
        label="Barcode (optional)"
        name="barcode"
        value={v.barcode ?? ''}
        onChange={set('barcode')}
        isRequired={false}
      />
      <div className="grid gap-x-3 sm:grid-cols-3">
        <Field label="RAM" name="ram" value={v.ram ?? ''} onChange={set('ram')} isRequired={false} />
        <Field label="Storage" name="storage" value={v.storage ?? ''} onChange={set('storage')} isRequired={false} />
        <Field label="Colour" name="colour" value={v.colour ?? ''} onChange={set('colour')} isRequired={false} />
      </div>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field
          label="Selling price (₹)"
          name="selling"
          value={v.selling ?? ''}
          onChange={set('selling')}
          inputMode="numeric"
        />
        {props.canSeeCost ? (
          <Field
            label="Purchase price (₹, optional)"
            name="purchase"
            value={v.purchase ?? ''}
            onChange={set('purchase')}
            isRequired={false}
            inputMode="numeric"
          />
        ) : null}
      </div>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field
          label="HSN code (optional)"
          name="hsn"
          value={v.hsn ?? ''}
          onChange={set('hsn')}
          isRequired={false}
          inputMode="numeric"
        />
        <Field
          label="Reorder level (optional)"
          name="reorder"
          value={v.reorder ?? ''}
          onChange={set('reorder')}
          isRequired={false}
          inputMode="numeric"
        />
      </div>
      <NativeSelect
        label="Tax rate"
        name="taxRate"
        value={v.taxRate ?? ''}
        onChange={set('taxRate')}
        options={[
          ['', 'None'],
          ...(rates.data?.taxRates ?? [])
            .filter((r) => !r.effectiveTo)
            .map((r) => [r.id, `${r.name} (${r.ratePercent}%)`] as const),
        ]}
      />
    </>
  );
}

function variantBody(v: Record<string, string>, canSeeCost: boolean) {
  const selling = rupeesToPaise(v.selling ?? '');
  if (selling === null) throw new Error('Enter the selling price in rupees, e.g. 14999 or 14999.50.');
  const purchase = v.purchase ? rupeesToPaise(v.purchase) : null;
  if (v.purchase && purchase === null) throw new Error('Enter the purchase price in rupees.');
  const opt = (s: string | undefined) => (s?.trim() ? s.trim() : undefined);
  return {
    sku: (v.sku ?? '').trim(),
    sellingPricePaise: selling,
    ...(opt(v.barcode) ? { barcode: opt(v.barcode) } : {}),
    ...(opt(v.ram) ? { ram: opt(v.ram) } : {}),
    ...(opt(v.storage) ? { storage: opt(v.storage) } : {}),
    ...(opt(v.colour) ? { colour: opt(v.colour) } : {}),
    ...(opt(v.hsn) ? { hsnCode: opt(v.hsn) } : {}),
    ...(opt(v.reorder) ? { reorderLevel: Number(v.reorder) } : {}),
    ...(opt(v.taxRate) ? { taxRateId: opt(v.taxRate) } : {}),
    ...(canSeeCost && purchase !== null ? { purchasePricePaise: purchase } : {}),
  };
}

export function CataloguePage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const products = useQuery({
    queryKey: ['products', businessId, search],
    queryFn: () =>
      api<{ products: ProductSummary[] }>(
        `/api/businesses/${businessId}/products${search ? `?q=${encodeURIComponent(search)}` : ''}`,
      ),
  });
  const [modelName, setModelName] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [serialized, setSerialized] = useState(true);
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message>(null);
  const canManage = business.can('catalogue.manage');
  const canSeeCost = business.can('catalogue.cost.view');

  const create = async () => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/products`, {
        method: 'POST',
        body: {
          modelName,
          isSerialized: serialized,
          ...(modelNumber ? { modelNumber } : {}),
          variants: [variantBody(variant, canSeeCost)],
        },
      });
      setMessage({ text: `${modelName} added.`, tone: 'success' });
      setModelName('');
      setModelNumber('');
      setVariant({});
      await queryClient.invalidateQueries({ queryKey: ['products', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title="Catalogue">
      <p className="mb-4">
        <Link className="text-blue-800 underline" to={`/b/${businessId}/tax-rates`}>
          Tax rates
        </Link>
      </p>
      <Field label="Search products" name="search" value={search} onChange={setSearch} isRequired={false} />
      <Table caption="Products" headers={['Model', 'Model number', 'Tracking', 'Variants']}>
        {(products.data?.products ?? []).map((p) => (
          <tr key={p.id}>
            <td className={cell}>
              <Link className="text-blue-800 underline" to={`/b/${businessId}/catalogue/${p.id}`}>
                {p.modelName}
              </Link>
            </td>
            <td className={cell}>{p.modelNumber ?? '—'}</td>
            <td className={cell}>{p.isSerialized ? 'Each unit (IMEI/serial)' : 'Quantity'}</td>
            <td className={cell}>{p.variantCount}</td>
          </tr>
        ))}
      </Table>
      {canManage ? (
        <section aria-labelledby="new-product">
          <h2 id="new-product" className="mb-2 text-xl font-semibold">
            Add a product
          </h2>
          <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Field label="Model name" name="modelName" value={modelName} onChange={setModelName} />
            <Field
              label="Model number (optional)"
              name="modelNumber"
              value={modelNumber}
              onChange={setModelNumber}
              isRequired={false}
            />
            <Checkbox
              label="Track each unit by IMEI or serial number (phones)"
              name="serialized"
              checked={serialized}
              onChange={setSerialized}
            />
            <h3 className="mb-2 font-semibold">First variant</h3>
            <VariantFields
              businessId={businessId}
              canSeeCost={canSeeCost}
              value={variant}
              onChange={(k, v) => {
                setVariant((old) => ({ ...old, [k]: v }));
              }}
            />
            <Button type="submit">Add product</Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}

export function ProductPage() {
  const { businessId = '', productId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const product = useQuery({
    queryKey: ['product', businessId, productId],
    queryFn: () =>
      api<{ product: { modelName: string; isSerialized: boolean; variants: Variant[] } }>(
        `/api/businesses/${businessId}/products/${productId}`,
      ),
  });
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message>(null);
  const canSeeCost = business.can('catalogue.cost.view');
  const p = product.data?.product;

  const add = async () => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/products/${productId}/variants`, {
        method: 'POST',
        body: variantBody(variant, canSeeCost),
      });
      setMessage({ text: 'Variant added.', tone: 'success' });
      setVariant({});
      await queryClient.invalidateQueries({ queryKey: ['product', businessId, productId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title={p?.modelName ?? 'Product'}>
      <Alert message={product.error ? errorText(product.error) : null} />
      <Table
        caption="Variants"
        headers={[
          'SKU',
          'RAM / storage / colour',
          'Selling price',
          ...(canSeeCost ? ['Purchase price', 'Average cost'] : []),
          'Reorder level',
        ]}
      >
        {(p?.variants ?? []).map((v) => (
          <tr key={v.id}>
            <td className={cell}>{v.sku}</td>
            <td className={cell}>{[v.ram, v.storage, v.colour].filter(Boolean).join(' / ') || '—'}</td>
            <td className={cell}>{formatPaise(v.sellingPricePaise)}</td>
            {canSeeCost ? (
              <>
                <td className={cell}>{formatPaise(v.purchasePricePaise)}</td>
                <td className={cell}>{formatPaise(v.avgCostPaise)}</td>
              </>
            ) : null}
            <td className={cell}>{v.reorderLevel ?? '—'}</td>
          </tr>
        ))}
      </Table>
      {business.can('catalogue.manage') ? (
        <section aria-labelledby="add-variant">
          <h2 id="add-variant" className="mb-2 text-xl font-semibold">
            Add a variant
          </h2>
          <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <VariantFields
              businessId={businessId}
              canSeeCost={canSeeCost}
              value={variant}
              onChange={(k, v) => {
                setVariant((old) => ({ ...old, [k]: v }));
              }}
            />
            <Button type="submit">Add variant</Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}

export function TaxRatesPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const rates = useTaxRates(businessId);
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState('');
  const [message, setMessage] = useState<Message>(null);

  const add = async () => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/tax-rates`, {
        method: 'POST',
        body: { name, ratePercent: rate, effectiveFrom: from },
      });
      setMessage({ text: 'Tax rate saved.', tone: 'success' });
      setName('');
      setRate('');
      await queryClient.invalidateQueries({ queryKey: ['tax-rates', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title="Tax rates">
      <p className="mb-3 text-sm text-slate-700">
        No rates are built in. Enter the rates your tax adviser has confirmed; a change is saved as a new version from a
        date, and past documents keep the rate they used.
      </p>
      <Table caption="Tax rates" headers={['Name', 'Rate', 'From', 'Until']}>
        {(rates.data?.taxRates ?? []).map((r) => (
          <tr key={r.id}>
            <td className={cell}>{r.name}</td>
            <td className={cell}>{r.ratePercent}%</td>
            <td className={cell}>{r.effectiveFrom}</td>
            <td className={cell}>{r.effectiveTo ?? 'open'}</td>
          </tr>
        ))}
      </Table>
      {business.can('tax.settings.manage') ? (
        <section aria-labelledby="add-rate">
          <h2 id="add-rate" className="mb-2 text-xl font-semibold">
            Add a tax rate
          </h2>
          <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Field label="Name" name="rateName" value={name} onChange={setName} />
            <Field label="Rate (%)" name="ratePercent" value={rate} onChange={setRate} inputMode="numeric" />
            <Field label="Effective from (YYYY-MM-DD)" name="effectiveFrom" value={from} onChange={setFrom} />
            <Button type="submit">Save tax rate</Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}
