// Suppliers (FR-INV-8 AC1). The GSTIN format and check character are
// validated; registration is not verified.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useParams } from 'react-router';
import { api, STATES } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Button, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';

export interface SupplierRow {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  mobileE164: string | null;
}

export function useSuppliers(businessId: string) {
  return useQuery({
    queryKey: ['suppliers', businessId],
    queryFn: () => api<{ suppliers: SupplierRow[] }>(`/api/businesses/${businessId}/suppliers`),
  });
}

export function SuppliersPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const suppliers = useSuppliers(businessId);
  const [name, setName] = useState('');
  const [gstin, setGstin] = useState('');
  const [mobile, setMobile] = useState('');
  const [state, setState] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const stateName = (code: string | null) => STATES.find(([c]) => c === code)?.[1] ?? code ?? '—';

  const add = async () => {
    setMessage(null);
    try {
      await api(`/api/businesses/${businessId}/suppliers`, {
        method: 'POST',
        body: {
          name,
          ...(gstin.trim() ? { gstin: gstin.trim() } : {}),
          ...(mobile.trim() ? { mobileE164: mobile.trim() } : {}),
          ...(state ? { stateCode: state } : {}),
        },
      });
      setMessage({ text: `${name} added.`, tone: 'success' });
      setName('');
      setGstin('');
      setMobile('');
      await queryClient.invalidateQueries({ queryKey: ['suppliers', businessId] });
    } catch (err) {
      setMessage({ text: errorText(err), tone: 'error' });
    }
  };

  return (
    <Page title="Suppliers">
      <Alert message={suppliers.error ? errorText(suppliers.error) : null} />
      <Table caption="Suppliers" headers={['Name', 'GSTIN', 'State', 'Mobile']}>
        {(suppliers.data?.suppliers ?? []).map((s) => (
          <tr key={s.id}>
            <td className={cell}>{s.name}</td>
            <td className={`${cell} break-all`}>{s.gstin ?? '—'}</td>
            <td className={cell}>{stateName(s.stateCode)}</td>
            <td className={cell}>{s.mobileE164 ?? '—'}</td>
          </tr>
        ))}
      </Table>
      {business.can('suppliers.manage') ? (
        <section aria-labelledby="add-supplier">
          <h2 id="add-supplier" className="mb-2 text-xl font-semibold">
            Add a supplier
          </h2>
          <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Field label="Supplier name" name="supplierName" value={name} onChange={setName} />
            <Field
              label="GSTIN (optional)"
              name="gstin"
              value={gstin}
              onChange={setGstin}
              isRequired={false}
              description="The state is taken from the GSTIN when one is given."
            />
            <Field
              label="Mobile (optional, e.g. +919800000000)"
              name="mobile"
              value={mobile}
              onChange={setMobile}
              isRequired={false}
            />
            <NativeSelect
              label="State"
              name="supplierState"
              value={state}
              onChange={setState}
              options={[['', 'Not given'], ...STATES]}
            />
            <Button type="submit">Add supplier</Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}
