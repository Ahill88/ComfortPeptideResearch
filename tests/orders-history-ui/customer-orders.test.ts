import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ORDER_STATUSES, formatOrderDate, formatOrderMoney, isOrderCursor, isOrderId, isOrderInstant, isTerminalOrder, orderProductHref,
  orderStatusLabel, orderTotalRows, ordersSignInHref, parseCustomerOrderDetail, parseCustomerOrderPage, parseCustomerTimeline, safeTrackingUrl,
} from '../../apps/storefront/lib/orders/customer-orders';
// @ts-ignore Node fixture shared with browser QA.
import { CREATED, PAID, SHIPPED, PRIVATE_TEXT, HOSTILE_TEXT, detail, fixtureOrders, summary } from './fixtures.mjs';

test('valid detail and page retain only customer contract fields', () => {
  const parsed = parseCustomerOrderDetail({ ...detail(), internalNote: PRIVATE_TEXT, adminName: PRIVATE_TEXT });
  assert.deepEqual(parsed, detail());
  assert.deepEqual(parseCustomerOrderPage({ items: [summary()], nextCursor: 'c29tZS1jdXJzb3I', admin: PRIVATE_TEXT }), { items: [summary()], nextCursor: 'c29tZS1jdXJzb3I' });
  assert.equal(JSON.stringify(parsed).includes(PRIVATE_TEXT), false);
});

test('all real statuses have honest distinct labels and only delivered/cancelled/refunded are terminal', () => {
  assert.deepEqual(ORDER_STATUSES.map(orderStatusLabel), ['Pending payment', 'Paid', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Refunded']);
  assert.deepEqual(ORDER_STATUSES.filter(isTerminalOrder), ['DELIVERED', 'CANCELLED', 'REFUNDED']);
  assert.equal(isTerminalOrder('UNKNOWN'), false);
});

test('new or hostile statuses cannot masquerade as a known status or inject status text', () => {
  for (const status of ['NEW_STATUS', '<img onerror=alert(1)>', '__proto__']) {
    const parsed = parseCustomerOrderDetail(detail('order-a', { status }));
    assert.equal(parsed?.status, 'UNKNOWN');
    assert.equal(orderStatusLabel(parsed!.status), 'Status unavailable');
    assert.equal(orderStatusLabel(status as any), 'Status unavailable');
  }
});

test('money is nonnegative integer cents and the modern breakdown must match the recorded total', () => {
  for (const field of ['subtotalCents', 'shippingCents', 'taxCents', 'totalCents']) {
    for (const bad of [-1, 1.1, '500', NaN, Infinity, 2_147_483_648, undefined]) {
      assert.equal(parseCustomerOrderDetail(detail('order-a', { [field]: bad })), null, `${field}: ${bad}`);
    }
  }
  assert.equal(parseCustomerOrderDetail(detail('order-a', { totalCents: 12000 })), null);
  assert.equal(parseCustomerOrderDetail(detail('order-a', { currency: 'usd' })), null);
  assert.deepEqual(orderTotalRows(detail()), [{ label: 'Subtotal', cents: 12000 }, { label: 'Shipping', cents: 500 }, { label: 'Tax', cents: 960 }, { label: 'Total', cents: 13460 }]);
  assert.equal(formatOrderMoney(13460, 'USD'), '$134.60');
  assert.equal(formatOrderMoney(1, 'USD'), '$0.01');
});

test('legacy null subtotal shows ONLY recorded total; never infer a breakdown from lines or zero defaults', () => {
  const legacy = parseCustomerOrderDetail(fixtureOrders().get('order-legacy'))!;
  assert.equal(legacy.subtotalCents, null);
  assert.deepEqual(orderTotalRows(legacy), [{ label: 'Total', cents: 12000 }]);
  assert.deepEqual(orderTotalRows({ ...legacy, shippingCents: 999, taxCents: 333 }), [{ label: 'Total', cents: 12000 }]);
});

test('missing products remain readable without a fabricated slug or product link', () => {
  const legacy = parseCustomerOrderDetail(fixtureOrders().get('order-legacy'))!;
  assert.equal(legacy.items[0].name, 'Unavailable product');
  assert.equal(legacy.items[0].slug, null);
  assert.equal(orderProductHref(legacy.items[0].slug), null);
  assert.equal(orderProductHref('ghk-cu'), '/catalog/ghk-cu');
  for (const slug of [null, '', '../checkout', '//evil.invalid', 'https://evil.invalid', 'a?b', 'a#b', '%2f%2fevil', 'a\\b', 'a b', 'a\u202eb']) assert.equal(orderProductHref(slug), null);
});

test('bad line quantities and unsafe products of quantity × cents are rejected', () => {
  for (const quantity of [-1, 0, 0.5, '2', NaN]) {
    const input = detail(); input.items[0].quantity = quantity;
    assert.equal(parseCustomerOrderDetail(input), null);
  }
  const input = detail(); input.items[0].quantity = 2_147_483_647; input.items[0].unitCents = 2_147_483_647;
  assert.equal(parseCustomerOrderDetail(input), null);
});

test('timeline uses status/at only, excludes notes/admin/unknown and invalid dates, sorts without synthesizing events', () => {
  const input = [
    { status: 'SHIPPED', at: SHIPPED, note: PRIVATE_TEXT, admin: { name: PRIVATE_TEXT } },
    { status: 'PENDING_PAYMENT', at: CREATED },
    { status: 'PAID', at: PAID, kind: 'NOTE', note: PRIVATE_TEXT },
    { status: 'ADMIN_REVIEW', at: PAID }, { status: 'DELIVERED', at: '2026-02-30T12:00:00.000Z' },
  ];
  assert.deepEqual(parseCustomerTimeline(input), [{ status: 'PENDING_PAYMENT', at: CREATED }, { status: 'SHIPPED', at: SHIPPED }]);
  assert.deepEqual(parseCustomerTimeline([]), []);
  assert.equal(parseCustomerTimeline({ events: input }), null);
  const legacy = parseCustomerOrderDetail(fixtureOrders().get('order-legacy'))!;
  assert.equal(legacy.status, 'DELIVERED');
  assert.deepEqual(legacy.timeline, [{ status: 'PENDING_PAYMENT', at: CREATED }], 'current status is not backfilled into historical events');
});

test('hostile text stays literal, bidi overrides are removed, and extra private data is discarded at every level', () => {
  const hostile = parseCustomerOrderDetail(fixtureOrders().get('order-hostile'))!;
  assert.equal(hostile.items[0].name, HOSTILE_TEXT);
  assert.equal(hostile.items[0].slug, null);
  assert.equal(hostile.shipments[0].trackingUrl, null);
  assert.equal(JSON.stringify(hostile).includes(PRIVATE_TEXT), false);
  assert.equal(hostile.timeline.length, 1);
  const input = detail(); input.items[0].name = 'Lab\u202e\u2066\u0000 name';
  assert.equal(parseCustomerOrderDetail(input)?.items[0].name, 'Lab name');
});

test('only valid calendar instants are formatted, with explicit UTC for times', () => {
  for (const good of [CREATED, '2024-02-29T00:00:00Z']) assert.equal(isOrderInstant(good), true);
  for (const bad of ['2026-02-30T00:00:00.000Z', '2026-02-29T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-01-01', 'today', null]) assert.equal(isOrderInstant(bad), false);
  assert.equal(formatOrderDate(CREATED), 'Oct 1, 2026');
  assert.match(formatOrderDate(CREATED, true), /UTC/);
  assert.equal(parseCustomerOrderDetail(detail('order-a', { createdAt: 'bad' })), null);
});

test('id/cursor boundaries and sign-in return paths cannot become redirects', () => {
  assert.equal(isOrderId('Order_A-123'), true);
  assert.equal(isOrderCursor('opaque_base64url-123'), true);
  for (const bad of ['', '../x', 'a/b', 'a?b', '//evil.invalid', 'https://evil.invalid', 'a\\b', 'a\u202eb', 'x'.repeat(65)]) assert.equal(isOrderId(bad), false);
  assert.equal(isOrderCursor('x'.repeat(201)), false);
  assert.equal(ordersSignInHref('order-123'), '/login?next=%2Forders%2Forder-123');
  for (const bad of [undefined, '//evil.invalid', '../checkout', 'https://evil.invalid']) assert.equal(ordersSignInHref(bad), '/login?next=%2Forders');
});

test('malformed page data, repeated IDs and invalid cursor are rejected rather than displayed as empty history', () => {
  assert.deepEqual(parseCustomerOrderPage({ items: [], nextCursor: null }), { items: [], nextCursor: null });
  for (const input of [null, {}, { items: [], nextCursor: 'a/b' }, { items: [summary(), summary()], nextCursor: null }, { items: [summary('a', { itemCount: -1 })], nextCursor: null }, { items: [summary('a', { itemCount: '2' })], nextCursor: null }]) assert.equal(parseCustomerOrderPage(input), null);
});

test('all documented carrier templates are accepted, including percent-encoded hostile-looking tracking numbers', () => {
  const number = 'A&B/#? "x"';
  const cases = [
    ['USPS', 'https://tools.usps.com/go/TrackConfirmAction?tLabels='], ['UPS', 'https://www.ups.com/track?tracknum='],
    ['FedEx', 'https://www.fedex.com/fedextrack/?trknbr='], ['DHL', 'https://www.dhl.com/global-en/home/tracking.html?tracking-id='],
  ];
  for (const [carrier, prefix] of cases) {
    const url = prefix + encodeURIComponent(number);
    assert.equal(safeTrackingUrl(url, carrier, number), url);
  }
});

test('tracking URLs reject unsafe protocols, lookalike hosts, credentials, redirect routes, mismatched numbers and parameters', () => {
  const urls = [
    'http://www.ups.com/track?tracknum=TEST', 'javascript:alert(1)', 'data:text/html,x', '//www.ups.com/track?tracknum=TEST',
    'https://www.ups.com.evil.invalid/track?tracknum=TEST', 'https://evil.invalid/?next=https://www.ups.com',
    'https://evil@www.ups.com/track?tracknum=TEST', 'https://www.ups.com:444/track?tracknum=TEST',
    'https://www.ups.com/redirect?tracknum=TEST', 'https://www.ups.com/track?tracknum=OTHER',
    'https://www.ups.com/track?tracknum=TEST&next=https://evil.invalid', 'https://www.ups.com/track?tracknum=TEST&tracknum=TEST',
    'https://www.ups.com/track?tracknum=TEST#https://evil.invalid', 'https://www.ups.com/track?tracknum=TE\nST',
    'https://www.ups.com\\@evil.invalid/track?tracknum=TEST',
  ];
  for (const url of urls) assert.equal(safeTrackingUrl(url, 'UPS', 'TEST'), null, url);
  assert.equal(safeTrackingUrl('https://www.ups.com/track?tracknum=TEST', 'FedEx', 'TEST'), null);
  for (const carrier of ['OTHER', '__proto__', 'ups']) assert.equal(safeTrackingUrl('https://www.ups.com/track?tracknum=TEST', carrier, 'TEST'), null);
});
