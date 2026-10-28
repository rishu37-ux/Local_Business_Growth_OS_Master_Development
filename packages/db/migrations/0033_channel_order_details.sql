-- Online order details (Phase 13, D-072): the platform's details of an order
-- (status, fulfilment, payment, totals) and the buyer's details (contact,
-- delivery and billing address). Buyer details are personal data: they can
-- be erased per order or with the customer (privacy_requests gains a target).

alter table lbg.channel_orders
  add column buyer_email         text check (length(buyer_email) between 3 and 254),
  add column buyer_gstin         text check (buyer_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  add column ship_to             jsonb check (jsonb_typeof(ship_to) = 'object' and octet_length(ship_to::text) <= 2000),
  add column bill_to             jsonb check (jsonb_typeof(bill_to) = 'object' and octet_length(bill_to::text) <= 2000),
  add column buyer_erased_at     timestamptz,
  add column payment_method      text check (payment_method in ('PREPAID', 'COD')),
  add column payment_status      text check (payment_status in ('PAID', 'PENDING', 'REFUNDED')),
  add column fulfilled_by        text check (fulfilled_by in ('SELLER', 'MARKETPLACE')),
  add column platform_status     text check (length(platform_status) between 1 and 40),
  add column ship_by             timestamptz,
  add column deliver_by          timestamptz,
  add column carrier             text check (length(carrier) between 1 and 60),
  add column tracking_id         text check (length(tracking_id) between 1 and 100),
  add column items_paise         bigint check (items_paise >= 0),
  add column shipping_paise      bigint check (shipping_paise >= 0),
  add column discount_paise      bigint check (discount_paise >= 0),
  add column tax_paise           bigint check (tax_paise >= 0),
  add column total_paise         bigint check (total_paise >= 0),
  add column marketplace_fees_paise bigint check (marketplace_fees_paise >= 0),
  add column dropped_fields      text[] not null default '{}' check (cardinality(dropped_fields) <= 40),
  add column details_updated_at  timestamptz,
  add constraint channel_orders_erased_has_no_buyer check (
    buyer_erased_at is null or (customer_name is null and customer_mobile is null and buyer_email is null
                                and buyer_gstin is null and ship_to is null and bill_to is null));

alter table lbg.channel_order_lines
  add column title text check (length(title) between 1 and 200);

-- Progress fields follow the feed; buyer fields may only be erased (the app never re-fills them).
grant update (payment_status, platform_status, ship_by, deliver_by, carrier, tracking_id, details_updated_at,
              customer_name, customer_mobile, buyer_email, buyer_gstin, ship_to, bill_to, buyer_erased_at)
  on lbg.channel_orders to lbgos_app;

-- An erasure request targets a customer or the buyer of one channel order.
alter table lbg.privacy_requests
  alter column customer_id drop not null,
  add column channel_order_id uuid,
  drop constraint privacy_requests_kind_check,
  add constraint privacy_requests_kind_check check (kind in ('ERASE', 'ERASE_ORDER_BUYER')),
  add constraint privacy_requests_target check (
    (kind = 'ERASE' and customer_id is not null and channel_order_id is null)
    or (kind = 'ERASE_ORDER_BUYER' and channel_order_id is not null and customer_id is null)),
  add foreign key (business_id, channel_order_id) references lbg.channel_orders(business_id, id);
create unique index privacy_requests_one_order_erase_uq on lbg.privacy_requests (business_id, channel_order_id)
  where kind = 'ERASE_ORDER_BUYER';
