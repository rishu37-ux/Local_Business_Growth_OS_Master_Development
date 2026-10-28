// One online order with everything the platform sent (Phase 13, D-072):
// platform details, the buyer, delivery and billing address, payment, items
// and totals, and our own state (stock kept, billed). Buyer details come
// masked from the API for members without customers.view.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Form } from 'react-aria-components';
import { Link, useNavigate, useParams } from 'react-router';
import { api, formatPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, cell, errorText, Field, Page, Table } from '../ui.tsx';

export interface Address {
  name: string | null;
  phone: string | null;
  line1: string | null;
  line2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
}
export interface Order {
  id: string;
  channelId: string;
  channelName: string;
  channelKind: 'WEBSITE' | 'MARKETPLACE';
  externalOrderId: string;
  state: 'OPEN' | 'BILLING' | 'BILLED' | 'CANCELLED';
  customerName: string | null;
  customerMobile: string | null;
  buyerEmail: string | null;
  buyerGstin: string | null;
  shipTo: Address | null;
  billTo: Address | null;
  buyerErased: boolean;
  masked: boolean;
  paymentMethod: 'PREPAID' | 'COD' | null;
  paymentStatus: 'PAID' | 'PENDING' | 'REFUNDED' | null;
  fulfilledBy: 'SELLER' | 'MARKETPLACE' | null;
  platformStatus: string | null;
  shipBy: string | null;
  deliverBy: string | null;
  carrier: string | null;
  trackingId: string | null;
  totals: {
    itemsPaise: number | null;
    shippingPaise: number | null;
    discountPaise: number | null;
    taxPaise: number | null;
    totalPaise: number | null;
    marketplaceFeesPaise: number | null;
  };
  droppedFields: string[];
  detailsUpdatedAt: string | null;
  oversold: boolean;
  needsAttention: boolean;
  saleId: string | null;
  invoiceNumber: string | null;
  placedAt: string;
  cancelledReason: string | null;
  lines: {
    variantId: string | null;
    externalSku: string;
    productName: string | null;
    title: string | null;
    quantity: number;
    unitPricePaise: number | null;
  }[];
}

export const ORDER_STATE: Record<Order['state'], [string, 'success' | 'warning' | 'neutral' | 'danger']> = {
  OPEN: ['New — stock kept', 'warning'],
  BILLING: ['Being billed — stock kept', 'warning'],
  BILLED: ['Billed', 'success'],
  CANCELLED: ['Cancelled', 'neutral'],
};
export const PAYMENT_METHOD: Record<NonNullable<Order['paymentMethod']>, string> = {
  PREPAID: 'Prepaid',
  COD: 'Cash on delivery',
};
export const PAYMENT_STATUS: Record<NonNullable<Order['paymentStatus']>, string> = {
  PAID: 'paid',
  PENDING: 'not paid yet',
  REFUNDED: 'refunded',
};
export const FULFILLED_BY: Record<NonNullable<Order['fulfilledBy']>, string> = {
  SELLER: 'You ship it',
  MARKETPLACE: 'The marketplace ships it',
};
export const when = (iso: string) => new Date(iso).toLocaleString('en-IN');
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const NOT_GIVEN = 'Not given by the platform';

/** Address lines in reading order; empty when nothing is known. */
export const addressLines = (a: Address | null): string[] =>
  a
    ? [
        a.name,
        a.line1,
        a.line2,
        a.landmark ? `Near ${a.landmark.replace(/^near /i, '')}` : null,
        [a.city, [a.state, a.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
        a.country && a.country !== 'IN' ? a.country : null,
        a.phone,
      ].filter((l): l is string => Boolean(l))
    : [];

/** A definition list row; a missing value says so instead of staying blank. */
function Row(props: { term: string; children: ReactNode }) {
  const empty = props.children === null || props.children === undefined || props.children === '';
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-ink-100 py-2 last:border-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="text-sm font-medium text-ink-700">{props.term}</dt>
      <dd className={`min-w-0 text-sm break-words ${empty ? 'text-ink-600' : ''}`}>
        {empty ? NOT_GIVEN : props.children}
      </dd>
    </div>
  );
}

function AddressBlock(props: { title: string; address: Address | null; hidden: boolean }) {
  const lines = addressLines(props.address);
  return (
    <div className="min-w-0">
      <h3 className="mb-1 font-semibold">{props.title}</h3>
      {lines.length ? (
        <address className="text-sm not-italic">
          {lines.map((l, i) => (
            <div key={`${props.title}-${String(i)}`}>{l}</div>
          ))}
        </address>
      ) : (
        <p className="text-sm text-ink-600">{props.hidden ? 'Hidden' : NOT_GIVEN}</p>
      )}
    </div>
  );
}

export function OnlineOrderPage() {
  const { businessId = '', orderId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const base = `/api/businesses/${businessId}`;
  const query = useQuery({
    queryKey: ['channel-order', businessId, orderId],
    queryFn: () => api<{ order: Order }>(`${base}/channel-orders/${orderId}`),
  });
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const [reason, setReason] = useState('');
  const [eraseReason, setEraseReason] = useState('');
  const o = query.data?.order;
  const failed = (err: unknown) => {
    setNotice({ text: errorText(err), tone: 'error' });
  };
  const done = async (text: string) => {
    setNotice({ text, tone: 'success' });
    await queryClient.invalidateQueries();
  };
  const back = (
    <Link to={`/b/${businessId}/online`} className="text-sm font-medium text-brand-700 underline">
      Back to online selling
    </Link>
  );
  if (!o) {
    return (
      <Page eyebrow="Online order" title="Online order" actions={back}>
        <Alert message={query.error ? errorText(query.error) : null} tone="error" />
        {query.isPending ? <p className="text-sm text-ink-600">Loading…</p> : null}
      </Page>
    );
  }
  const t = o.totals;
  const lineSum = o.lines.reduce((s, l) => s + (l.unitPricePaise ?? 0) * l.quantity, 0);
  const net = t.totalPaise !== null && t.marketplaceFeesPaise !== null ? t.totalPaise - t.marketplaceFeesPaise : null;
  const open = o.state === 'OPEN' || o.state === 'BILLING';
  const hidden = o.masked;
  return (
    <Page
      eyebrow={`Online order · ${o.channelName}`}
      title={`Order ${o.externalOrderId}`}
      description={`Received ${when(o.placedAt)}`}
      actions={back}
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <section aria-labelledby="status-heading">
        <h2 id="status-heading" className="section-title">
          Status
        </h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <Badge tone={ORDER_STATE[o.state][1]}>{ORDER_STATE[o.state][0]}</Badge>
          {o.oversold ? <Badge tone="danger">More than in stock</Badge> : null}
          {o.needsAttention ? <Badge tone="danger">Needs attention</Badge> : null}
        </div>
        <dl>
          <Row term="Invoice">
            {o.invoiceNumber ??
              (o.state === 'BILLING' ? 'Draft in Point of sale' : o.state === 'OPEN' ? 'Not billed yet' : null)}
          </Row>
          {o.cancelledReason ? <Row term="Cancelled because">{o.cancelledReason}</Row> : null}
        </dl>
        {business.can('pos.sell') && open ? (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <Button
                onPress={() => {
                  setNotice(null);
                  api<{ saleId: string }>(`${base}/channel-orders/${o.id}/bill`, { method: 'POST', body: {} })
                    .then((r) => navigate(`/b/${businessId}/pos?sale=${r.saleId}`))
                    .catch(failed);
                }}
              >
                Bill in Point of sale
              </Button>
            </div>
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                setNotice(null);
                api(`${base}/channel-orders/${o.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } })
                  .then(() => done('Order cancelled; its stock is free again.'))
                  .catch(failed);
              }}
            >
              <Field
                label="Reason, if you cancel this order"
                name="orderCancelReason"
                value={reason}
                onChange={setReason}
                isRequired={false}
              />
              <Button type="submit" variant="danger" isDisabled={reason.trim().length < 3}>
                Cancel order
              </Button>
            </Form>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="platform-heading">
        <h2 id="platform-heading" className="section-title">
          Platform
        </h2>
        <dl>
          <Row term="Channel">{`${o.channelName} (${o.channelKind === 'WEBSITE' ? 'your website' : 'marketplace'})`}</Row>
          <Row term="Platform order ID">{o.externalOrderId}</Row>
          <Row term="Received">{when(o.placedAt)}</Row>
          <Row term="Status on the platform">{o.platformStatus}</Row>
          <Row term="Shipped by">{o.fulfilledBy ? FULFILLED_BY[o.fulfilledBy] : null}</Row>
          <Row term="Ship by">{o.shipBy ? day(o.shipBy) : null}</Row>
          <Row term="Deliver by">{o.deliverBy ? day(o.deliverBy) : null}</Row>
          <Row term="Carrier">{o.carrier}</Row>
          <Row term="Tracking ID">{o.trackingId}</Row>
          {o.detailsUpdatedAt ? <Row term="Last update from the platform">{when(o.detailsUpdatedAt)}</Row> : null}
        </dl>
        {o.droppedFields.length ? (
          <p className="mt-2 text-sm text-ink-700">
            Some details sent by the platform were not valid and were left out: {o.droppedFields.join(', ')}.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="buyer-heading">
        <h2 id="buyer-heading" className="section-title">
          Buyer
        </h2>
        {o.buyerErased ? (
          <p className="mb-2 text-sm text-ink-700">The buyer's personal details were erased.</p>
        ) : hidden ? (
          <p className="mb-2 text-sm text-ink-700">
            Contact details and addresses are hidden: you need permission to see customer details.
          </p>
        ) : null}
        <dl className="mb-4">
          <Row term="Name">{o.customerName}</Row>
          <Row term="Mobile">
            {o.customerMobile && !hidden ? (
              <a href={`tel:${o.customerMobile}`} className="underline">
                {o.customerMobile}
              </a>
            ) : (
              o.customerMobile
            )}
          </Row>
          <Row term="Email">{hidden ? 'Hidden' : o.buyerEmail}</Row>
          <Row term="GSTIN">{hidden ? 'Hidden' : o.buyerGstin}</Row>
        </dl>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <AddressBlock title="Delivery address" address={o.shipTo} hidden={hidden} />
          <AddressBlock title="Billing address" address={o.billTo} hidden={hidden} />
        </div>
      </section>

      <section aria-labelledby="payment-heading">
        <h2 id="payment-heading" className="section-title">
          Payment
        </h2>
        <dl>
          <Row term="Method">{o.paymentMethod ? PAYMENT_METHOD[o.paymentMethod] : null}</Row>
          <Row term="Status">{o.paymentStatus ? PAYMENT_STATUS[o.paymentStatus] : null}</Row>
        </dl>
      </section>

      <section aria-labelledby="items-heading">
        <h2 id="items-heading" className="section-title">
          Items
        </h2>
        <Table
          caption="Items in this order"
          headers={['On the platform', 'SKU', 'Your product', 'Qty', 'Price', 'Amount']}
        >
          {o.lines.map((l, i) => (
            <tr key={`${o.id}-${String(i)}`}>
              <td className={cell}>{l.title ?? '—'}</td>
              <td className={cell}>{l.externalSku}</td>
              <td className={cell}>{l.productName ?? <Badge tone="danger">No product with this SKU</Badge>}</td>
              <td className={cell}>{l.quantity}</td>
              <td className={cell}>{l.unitPricePaise === null ? '—' : formatPaise(l.unitPricePaise)}</td>
              <td className={cell}>{l.unitPricePaise === null ? '—' : formatPaise(l.unitPricePaise * l.quantity)}</td>
            </tr>
          ))}
        </Table>
        <h3 className="mb-1 font-semibold">Totals from the platform</h3>
        <dl>
          <Row term="Items">{t.itemsPaise === null ? null : formatPaise(t.itemsPaise)}</Row>
          <Row term="Shipping">{t.shippingPaise === null ? null : formatPaise(t.shippingPaise)}</Row>
          <Row term="Discount">{t.discountPaise === null ? null : `− ${formatPaise(t.discountPaise)}`}</Row>
          <Row term="Tax (included)">{t.taxPaise === null ? null : formatPaise(t.taxPaise)}</Row>
          <Row term="Order total">{t.totalPaise === null ? null : formatPaise(t.totalPaise)}</Row>
          <Row term="Marketplace fees">
            {t.marketplaceFeesPaise === null ? null : `− ${formatPaise(t.marketplaceFeesPaise)}`}
          </Row>
          <Row term="You receive (total − fees)">{net === null ? null : formatPaise(net)}</Row>
        </dl>
        <p className="mt-2 text-xs text-ink-600">
          As reported by the platform; your invoice is made by Point of sale with your tax rates. Sum of the lines:{' '}
          {formatPaise(lineSum)}.
        </p>
      </section>

      {business.data?.access.roles.includes('Owner') && !o.buyerErased ? (
        <section aria-labelledby="erase-buyer-heading">
          <h2 id="erase-buyer-heading" className="section-title">
            Erase the buyer's details
          </h2>
          <p className="mb-3 text-sm text-ink-700">
            Removes the buyer's name, phone, email, GSTIN and addresses from this order. Items, totals and any invoice
            stay. This cannot be undone. You may be asked to sign in again.
          </p>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              api(`${base}/channel-orders/${o.id}/erase-buyer`, { method: 'POST', body: { reason: eraseReason } })
                .then(() => done("The buyer's details were erased."))
                .catch(failed);
            }}
          >
            <Field
              label="Reason (at least 10 characters)"
              name="eraseBuyerReason"
              value={eraseReason}
              onChange={setEraseReason}
            />
            <Button type="submit" variant="danger">
              Erase the buyer's details
            </Button>
          </Form>
        </section>
      ) : null}
    </Page>
  );
}
