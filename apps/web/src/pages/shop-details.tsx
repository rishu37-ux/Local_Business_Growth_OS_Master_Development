// The shop's full address (Phase 14, D-073): used in setup step 1 and in Shop
// details on the overview. The printed one-line address is composed by the
// API from these fields.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { api, STATES } from '../api.ts';
import { Alert, Button, errorText, Field, NativeSelect } from '../ui.tsx';

export interface AddressForm {
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  district: string;
  stateCode: string;
  pincode: string;
}
export interface ShopDetails {
  displayName: string | null;
  legalName: string;
  stateCode: string | null;
  stateEditable: boolean;
  address: {
    line1: string | null;
    line2: string | null;
    landmark: string | null;
    city: string | null;
    district: string | null;
    pincode: string | null;
  };
  printed: string | null;
}

export const emptyAddress = (stateCode: string | null): AddressForm => ({
  line1: '',
  line2: '',
  landmark: '',
  city: '',
  district: '',
  stateCode: stateCode ?? '',
  pincode: '',
});
export const addressOf = (d: ShopDetails): AddressForm => ({
  line1: d.address.line1 ?? '',
  line2: d.address.line2 ?? '',
  landmark: d.address.landmark ?? '',
  city: d.address.city ?? '',
  district: d.address.district ?? '',
  stateCode: d.stateCode ?? '',
  pincode: d.address.pincode ?? '',
});
/** The body the API takes (optional lines as null). */
export const addressBody = (a: AddressForm) => ({
  line1: a.line1,
  line2: a.line2.trim() || null,
  landmark: a.landmark.trim() || null,
  city: a.city,
  district: a.district,
  stateCode: a.stateCode,
  pincode: a.pincode,
});
export const useShopDetails = (businessId: string) =>
  useQuery({
    queryKey: ['shop-details', businessId],
    queryFn: () => api<{ shop: ShopDetails }>(`/api/businesses/${businessId}/shop-details`),
  });

/** The address fields; the state is a select while it may change, else shown as text. */
export function AddressFields(props: {
  value: AddressForm;
  onChange: (next: AddressForm) => void;
  stateEditable: boolean;
}) {
  const a = props.value;
  const set = (k: keyof AddressForm) => (v: string) => {
    props.onChange({ ...a, [k]: v });
  };
  const stateName = STATES.find(([c]) => c === a.stateCode)?.[1] ?? '—';
  return (
    <fieldset className="mb-3">
      <legend className="mb-2 text-sm font-semibold text-ink-800">Shop address</legend>
      <Field
        label="Address line 1 (shop number, building, street)"
        name="addressLine1"
        value={a.line1}
        onChange={set('line1')}
      />
      <Field
        label="Address line 2 (area, locality)"
        name="addressLine2"
        value={a.line2}
        onChange={set('line2')}
        isRequired={false}
      />
      <Field label="Landmark" name="landmark" value={a.landmark} onChange={set('landmark')} isRequired={false} />
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="City or town" name="city" value={a.city} onChange={set('city')} />
        <Field label="District" name="district" value={a.district} onChange={set('district')} />
      </div>
      <div className="grid gap-x-3 sm:grid-cols-2">
        {props.stateEditable ? (
          <NativeSelect
            label="State or union territory"
            name="addressState"
            value={a.stateCode}
            onChange={set('stateCode')}
            options={[['', 'Choose a state'], ...STATES]}
          />
        ) : (
          <div className="mb-3 flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-800">State or union territory</span>
            <span className="text-sm">
              {stateName} <span className="text-ink-600">(set during setup; contact support to change it)</span>
            </span>
          </div>
        )}
        <Field label="PIN code (6 digits)" name="pincode" value={a.pincode} onChange={set('pincode')} />
      </div>
    </fieldset>
  );
}

/** Shop details on the overview (after setup): the address and how it is printed. */
export function ShopDetailsSection({ businessId, canManage }: { businessId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const details = useShopDetails(businessId);
  const [form, setForm] = useState<AddressForm | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const d = details.data?.shop;
  if (!d) return null;
  const a = form ?? addressOf(d);
  return (
    <section aria-labelledby="shop-details-heading">
      <h2 id="shop-details-heading" className="section-title">
        Shop details
      </h2>
      <p className="mb-3 text-sm text-ink-700">
        Printed on invoices issued from now on as: <span className="font-medium">{d.printed ?? 'No address yet'}</span>
      </p>
      <Alert message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      {canManage ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            setMessage(null);
            api(`/api/businesses/${businessId}/shop-details/address`, { method: 'PUT', body: addressBody(a) }).then(
              async () => {
                setForm(null);
                setMessage({ text: 'Address saved.', tone: 'success' });
                await queryClient.invalidateQueries({ queryKey: ['shop-details', businessId] });
              },
              (err: unknown) => {
                setMessage({ text: errorText(err), tone: 'error' });
              },
            );
          }}
        >
          <AddressFields value={a} onChange={setForm} stateEditable={d.stateEditable} />
          <Button type="submit">Save address</Button>
        </Form>
      ) : null}
    </section>
  );
}
