// Online selling (increments 11.2–11.3, D-070): where the shop's stock is
// offered (its website and marketplace connectors), what each channel may sell,
// and the orders that come in. Stock stays in one place: an order reserves it
// until it is billed in Point of sale or cancelled.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link, useNavigate, useParams } from 'react-router';
import { api, formatPaise, rupeesToPaise } from '../api.ts';
import { useBusiness } from '../business.ts';
import { Alert, Badge, Button, cell, errorText, Field, NativeSelect, Page, Table } from '../ui.tsx';
import { ExportLinks } from '../exports.tsx';
import { FULFILLED_BY, ORDER_STATE, PAYMENT_METHOD, PAYMENT_STATUS, when, type Order } from './online-order.tsx';
import { useVariantOptions } from './purchases.tsx';

interface Channel {
  id: string;
  kind: 'WEBSITE' | 'MARKETPLACE';
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  stockBuffer: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  listings: number;
  pendingPushes: number;
  openOrders: number;
}
interface Listing {
  id: string;
  channelId: string;
  variantId: string;
  productName: string;
  externalSku: string;
  pricePaise: number;
  published: boolean;
  available: number;
  reserved: number;
  availableToSell: number;
  lastPushedQuantity: number | null;
  pushPending: boolean;
}
interface Integration {
  id: string;
  category: string;
  label: string;
  status: string;
}

export function OnlineSellingPage() {
  const { businessId = '' } = useParams();
  const business = useBusiness(businessId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const base = `/api/businesses/${businessId}`;
  const channels = useQuery({
    queryKey: ['channels', businessId],
    queryFn: () => api<{ channels: Channel[] }>(`${base}/channels`),
  });
  const listings = useQuery({
    queryKey: ['channel-listings', businessId],
    queryFn: () => api<{ listings: Listing[] }>(`${base}/channel-listings`),
  });
  const canOrders = business.can('pos.sell') || business.can('inventory.view');
  const orders = useQuery({
    queryKey: ['channel-orders', businessId],
    queryFn: () => api<{ orders: Order[] }>(`${base}/channel-orders`),
    enabled: canOrders,
  });
  const canChannels = business.can('integrations.manage');
  const integrations = useQuery({
    queryKey: ['integrations', businessId],
    queryFn: () => api<{ integrations: Integration[] }>(`${base}/integrations`),
    enabled: canChannels,
  });
  const variants = useVariantOptions(businessId);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const [connector, setConnector] = useState('');
  const [channelName, setChannelName] = useState('');
  const [variantId, setVariantId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [orderChannel, setOrderChannel] = useState('');
  const [orderState, setOrderState] = useState('');
  const chans = channels.data?.channels ?? [];
  const nameOf = (id: string) => chans.find((c) => c.id === id)?.name ?? '';
  const refresh = async (text: string) => {
    setNotice({ text, tone: 'success' });
    await queryClient.invalidateQueries();
  };
  const failed = (err: unknown) => {
    setNotice({ text: errorText(err), tone: 'error' });
  };
  const connectors = (integrations.data?.integrations ?? []).filter(
    (i) => i.category === 'MARKETPLACE' && (i.status === 'TESTED' || i.status === 'VERIFIED'),
  );
  return (
    <Page
      eyebrow="Sales"
      title="Online selling"
      description="Offer your stock on your website and on marketplaces. Each order keeps its stock until you bill it in Point of sale or cancel it; marketplaces get the new quantity automatically."
      actions={<ExportLinks businessId={businessId} list="online-orders" what="online orders" />}
    >
      <Alert message={notice?.text ?? null} tone={notice?.tone ?? 'error'} />
      <section aria-labelledby="channels-heading">
        <h2 id="channels-heading" className="section-title">
          Where you sell
        </h2>
        <Table caption="Sales channels" headers={['Channel', 'Kept back', 'Products', 'Open orders', 'Last sync', '']}>
          {chans.map((c) => (
            <tr key={c.id}>
              <td className={cell}>
                {c.name} <span className="text-ink-600">({c.kind === 'WEBSITE' ? 'your website' : 'marketplace'})</span>
                {c.status === 'PAUSED' ? (
                  <>
                    {' '}
                    <Badge tone="neutral">Paused</Badge>
                  </>
                ) : null}
              </td>
              <td className={cell}>{String(c.stockBuffer)}</td>
              <td className={cell}>{String(c.listings)}</td>
              <td className={cell}>{String(c.openOrders)}</td>
              <td className={cell}>
                {c.kind === 'WEBSITE' ? (
                  'Live'
                ) : c.lastSyncError ? (
                  <Badge tone="danger">{`Failed (${c.lastSyncError})`}</Badge>
                ) : c.lastSyncAt ? (
                  `${when(c.lastSyncAt)}${c.pendingPushes > 0 ? ` · ${String(c.pendingPushes)} waiting` : ''}`
                ) : (
                  'Not yet'
                )}
              </td>
              <td className={cell}>
                {canChannels ? (
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setNotice(null);
                      api(`${base}/channels/${c.id}`, {
                        method: 'PATCH',
                        body: { status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' },
                      })
                        .then(() => refresh(c.status === 'ACTIVE' ? `${c.name} paused.` : `${c.name} resumed.`))
                        .catch(failed);
                    }}
                  >
                    {c.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                    <span className="sr-only"> {c.name}</span>
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
        <p className="mb-3 text-sm text-ink-600">
          &quot;Kept back&quot; is stock never offered on that channel, so a last item sold in the shop is not also sold
          online. Amazon, Flipkart and others connect through a marketplace connector in the API Hub.
        </p>
        {canChannels ? (
          <div className="flex flex-wrap items-end gap-3">
            <Button
              variant="secondary"
              onPress={() => {
                setNotice(null);
                api<{ orders: number; pushed: number }>(`${base}/channels/sync`, { method: 'POST', body: {} })
                  .then((r) =>
                    refresh(`Synced: ${String(r.orders)} order change(s), ${String(r.pushed)} product(s) sent.`),
                  )
                  .catch(failed);
              }}
            >
              Sync marketplaces now
            </Button>
          </div>
        ) : null}
        {canChannels && connectors.length > 0 ? (
          <Form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              api(`${base}/channels`, { method: 'POST', body: { name: channelName.trim(), integrationId: connector } })
                .then(() => refresh('Marketplace added.'))
                .catch(failed);
            }}
          >
            <h3 className="mb-2 font-semibold">Add a marketplace</h3>
            <NativeSelect
              label="Connector (tested in the API Hub)"
              name="connector"
              value={connector}
              onChange={setConnector}
              options={[['', 'Choose a connector'], ...connectors.map((i) => [i.id, i.label] as const)]}
            />
            <Field
              label="Name shown here (e.g. Amazon)"
              name="channelName"
              value={channelName}
              onChange={setChannelName}
            />
            <Button type="submit" variant="secondary" isDisabled={!connector || channelName.trim().length < 2}>
              Add marketplace
            </Button>
          </Form>
        ) : null}
      </section>

      <section aria-labelledby="listings-heading">
        <h2 id="listings-heading" className="section-title">
          Products offered
        </h2>
        {business.can('catalogue.manage') ? (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              const paise = price.trim() ? rupeesToPaise(price) : null;
              if (price.trim() && paise === null) {
                setNotice({ text: 'Enter the price in rupees.', tone: 'error' });
                return;
              }
              api(`${base}/channels/${channelId}/listings`, {
                method: 'PUT',
                body: { variantId, published: true, ...(paise === null ? {} : { pricePaise: paise }) },
              })
                .then(() => refresh(`Offered on ${nameOf(channelId)}.`))
                .catch(failed);
            }}
          >
            <div className="grid gap-x-4 sm:grid-cols-3">
              <NativeSelect
                label="Product"
                name="listVariant"
                value={variantId}
                onChange={setVariantId}
                options={[['', 'Choose a product'], ...variants.options]}
              />
              <NativeSelect
                label="Channel"
                name="listChannel"
                value={channelId}
                onChange={setChannelId}
                options={[['', 'Choose a channel'], ...chans.map((c) => [c.id, c.name] as const)]}
              />
              <Field
                label="Price on this channel in ₹ (optional)"
                name="listPrice"
                value={price}
                onChange={setPrice}
                isRequired={false}
              />
            </div>
            <Button type="submit" variant="secondary" isDisabled={!variantId || !channelId}>
              Offer this product
            </Button>
          </Form>
        ) : null}
        {(listings.data?.listings ?? []).length === 0 ? (
          <p className="text-sm text-ink-600">No products are offered online yet.</p>
        ) : (
          <Table
            caption="Products offered"
            headers={['Product', 'Channel', 'Price', 'In stock', 'Kept for orders', 'Can sell', 'Sent', '']}
          >
            {(listings.data?.listings ?? []).map((l) => (
              <tr key={l.id}>
                <td className={cell}>
                  {l.productName} <span className="text-ink-600">{l.externalSku}</span>
                </td>
                <td className={cell}>{nameOf(l.channelId)}</td>
                <td className={cell}>{formatPaise(l.pricePaise)}</td>
                <td className={cell}>{String(l.available)}</td>
                <td className={cell}>{String(l.reserved)}</td>
                <td className={cell}>
                  {l.published ? String(l.availableToSell) : <Badge tone="neutral">Hidden</Badge>}
                </td>
                <td className={cell}>
                  {chans.find((c) => c.id === l.channelId)?.kind === 'WEBSITE'
                    ? 'Live'
                    : l.pushPending
                      ? 'Waiting'
                      : l.lastPushedQuantity === null
                        ? '—'
                        : String(l.lastPushedQuantity)}
                </td>
                <td className={cell}>
                  {business.can('catalogue.manage') ? (
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setNotice(null);
                        api(`${base}/channels/${l.channelId}/listings`, {
                          method: 'PUT',
                          body: { variantId: l.variantId, published: !l.published },
                        })
                          .then(() => refresh(l.published ? 'Hidden from that channel.' : 'Offered again.'))
                          .catch(failed);
                      }}
                    >
                      {l.published ? 'Hide' : 'Offer'}
                      <span className="sr-only">
                        {' '}
                        {l.productName} on {nameOf(l.channelId)}
                      </span>
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {canOrders ? (
        <section aria-labelledby="orders-heading">
          <h2 id="orders-heading" className="section-title">
            Online orders
          </h2>
          {(orders.data?.orders ?? []).length === 0 ? (
            <p className="text-sm text-ink-600">No online orders yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-4">
                <NativeSelect
                  label="Show orders from"
                  name="orderChannel"
                  value={orderChannel}
                  onChange={setOrderChannel}
                  options={[['', 'All channels'], ...chans.map((c) => [c.id, c.name] as const)]}
                />
                <NativeSelect
                  label="Status"
                  name="orderState"
                  value={orderState}
                  onChange={setOrderState}
                  options={[
                    ['', 'All'],
                    ['OPEN', 'New — stock kept'],
                    ['BILLING', 'Being billed'],
                    ['BILLED', 'Billed'],
                    ['CANCELLED', 'Cancelled'],
                  ]}
                />
              </div>
              {business.can('pos.sell') ? (
                <Field
                  label="Reason, if you cancel an order"
                  name="cancelReason"
                  value={reason}
                  onChange={setReason}
                  isRequired={false}
                />
              ) : null}
              <Table
                caption="Online orders"
                headers={['Received', 'Order', 'Buyer', 'Deliver to', 'Payment', 'Items', 'Status', '']}
              >
                {(orders.data?.orders ?? [])
                  .filter(
                    (o) =>
                      (orderChannel === '' || o.channelId === orderChannel) &&
                      (orderState === '' || o.state === orderState),
                  )
                  .map((o) => (
                    <tr key={o.id}>
                      <td className={cell}>{when(o.placedAt)}</td>
                      <td className={cell}>
                        <div>{o.channelName}</div>
                        <Link
                          to={`/b/${businessId}/online/orders/${o.id}`}
                          className="font-medium text-brand-700 underline"
                        >
                          {o.externalOrderId}
                          <span className="sr-only"> — open order details</span>
                        </Link>
                        {o.platformStatus ? <div className="text-ink-600">{o.platformStatus}</div> : null}
                      </td>
                      <td className={cell}>
                        {o.buyerErased ? <span className="text-ink-600">Erased</span> : (o.customerName ?? '—')}
                        {o.customerMobile ? <div className="text-ink-600">{o.customerMobile}</div> : null}
                      </td>
                      <td className={cell}>
                        {o.shipTo?.city || o.shipTo?.pincode
                          ? [o.shipTo.city, o.shipTo.pincode].filter(Boolean).join(' ')
                          : '—'}
                        {o.fulfilledBy ? <div className="text-ink-600">{FULFILLED_BY[o.fulfilledBy]}</div> : null}
                      </td>
                      <td className={cell}>
                        {o.paymentMethod ? PAYMENT_METHOD[o.paymentMethod] : '—'}
                        {o.paymentStatus ? <div className="text-ink-600">{PAYMENT_STATUS[o.paymentStatus]}</div> : null}
                        {o.totals.totalPaise === null ? null : <div>{formatPaise(o.totals.totalPaise)}</div>}
                      </td>
                      <td className={cell}>
                        {o.lines.map((l, i) => (
                          <div key={`${o.id}-${String(i)}`}>
                            {`${String(l.quantity)} × ${l.productName ?? l.title ?? `unknown SKU ${l.externalSku}`}`}
                            {l.unitPricePaise === null ? '' : ` @ ${formatPaise(l.unitPricePaise)}`}
                          </div>
                        ))}
                      </td>
                      <td className={cell}>
                        <Badge tone={ORDER_STATE[o.state][1]}>{ORDER_STATE[o.state][0]}</Badge>
                        {o.invoiceNumber ? <div>{o.invoiceNumber}</div> : null}
                        {o.oversold ? (
                          <div>
                            <Badge tone="danger">More than in stock</Badge>
                          </div>
                        ) : null}
                        {o.needsAttention ? (
                          <div>
                            <Badge tone="danger">Needs attention</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td className={cell}>
                        {business.can('pos.sell') && (o.state === 'OPEN' || o.state === 'BILLING') ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              onPress={() => {
                                setNotice(null);
                                api<{ saleId: string }>(`${base}/channel-orders/${o.id}/bill`, {
                                  method: 'POST',
                                  body: {},
                                })
                                  .then((r) => navigate(`/b/${businessId}/pos?sale=${r.saleId}`))
                                  .catch(failed);
                              }}
                            >
                              Bill in Point of sale<span className="sr-only"> order {o.externalOrderId}</span>
                            </Button>
                            <Button
                              variant="danger"
                              isDisabled={reason.trim().length < 3}
                              onPress={() => {
                                setNotice(null);
                                api(`${base}/channel-orders/${o.id}/cancel`, {
                                  method: 'POST',
                                  body: { reason: reason.trim() },
                                })
                                  .then(() => refresh('Order cancelled; its stock is free again.'))
                                  .catch(failed);
                              }}
                            >
                              Cancel<span className="sr-only"> order {o.externalOrderId}</span>
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </Table>
            </>
          )}
        </section>
      ) : null}
    </Page>
  );
}
