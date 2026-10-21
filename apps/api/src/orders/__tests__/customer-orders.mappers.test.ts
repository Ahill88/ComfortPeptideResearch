import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { buildTimeline, buildTrackingUrl, decodeOrderCursor, encodeOrderCursor, toOrderDetail, toOrderSummary } from '../customer-orders.mappers';

test('buildTrackingUrl: the four carrier patterns', () => {
  assert.equal(buildTrackingUrl('USPS', '9400111899223197428490'), 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490');
  assert.equal(buildTrackingUrl('UPS', '1Z999AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(buildTrackingUrl('FedEx', '123456789012'), 'https://www.fedex.com/fedextrack/?trknbr=123456789012');
  assert.equal(buildTrackingUrl('DHL', '1234567890'), 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=1234567890');
});

test('buildTrackingUrl: OTHER, unknown, wrong-case and inherited carrier names have no URL', () => {
  for (const carrier of ['OTHER', 'other', 'usps', 'ups', 'fedex', 'dhl', 'FEDEX', 'Royal Mail', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(buildTrackingUrl(carrier, '123456789012'), null, carrier);
  }
  assert.equal(buildTrackingUrl(undefined as any, '1234'), null);
  assert.equal(buildTrackingUrl('UPS', undefined as any), null);
  assert.equal(buildTrackingUrl('UPS', ''), null);
  assert.equal(buildTrackingUrl('UPS', '   '), null);
});

test('buildTrackingUrl: the tracking number is URL-encoded (spaces, hyphens, reserved and hostile characters)', () => {
  assert.equal(buildTrackingUrl('USPS', '9400 1118 9922'), 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201118%209922');
  assert.equal(buildTrackingUrl('DHL', 'AB-12-CD'), 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=AB-12-CD');
  assert.equal(buildTrackingUrl('UPS', ' 1Z999 '), 'https://www.ups.com/track?tracknum=1Z999', 'surrounding whitespace is trimmed');
  assert.equal(buildTrackingUrl('FedEx', "a'b(c)d*e!f"), 'https://www.fedex.com/fedextrack/?trknbr=a%27b%28c%29d%2Ae%21f');
  assert.equal(buildTrackingUrl('UPS', 'é日本'), 'https://www.ups.com/track?tracknum=%C3%A9%E6%97%A5%E6%9C%AC');
});

test('buildTrackingUrl: injection attempts cannot add parameters, change the host, add a fragment or break out of the query value', () => {
  const attempts = [
    '1Z&evil=1',
    '1Z#frag',
    '1Z?x=y',
    '1Z/../../etc',
    '1Z\\@evil.example',
    '//evil.example/x',
    'https://evil.example',
    'javascript:alert(1)',
    '1Z%0d%0aSet-Cookie:x=y',
    '1Z\r\nHost: evil.example',
    '1Z" onmouseover="alert(1)',
    '1Z<script>alert(1)</script>',
    '1Z\u0000',
    '1Z%00',
    '1Z%',
  ];
  for (const carrier of ['USPS', 'UPS', 'FedEx', 'DHL']) {
    const host = new URL(buildTrackingUrl(carrier, '1234')!).hostname;
    for (const attempt of attempts) {
      const url = buildTrackingUrl(carrier, attempt);
      assert.ok(url, `${carrier} ${attempt}`);
      const parsed = new URL(url);
      assert.equal(parsed.protocol, 'https:');
      assert.equal(parsed.hash, '', `no fragment for ${attempt}`);
      const keys = [...parsed.searchParams.keys()];
      assert.equal(keys.length, 1, `exactly one query parameter for ${attempt}`);
      assert.equal(parsed.searchParams.get(keys[0]), attempt.trim(), 'round-trips to the original value');
      assert.match(url, /^[\x21-\x7e]+$/, 'printable ASCII only: no raw control characters, spaces or quotes');
      assert.ok(!/[<>"\\]/.test(url), 'no markup or quote characters');
      assert.equal(parsed.hostname, host, 'host never changes');
    }
  }
});

test('buildTrackingUrl: a lone surrogate cannot throw and yields null', () => {
  assert.equal(buildTrackingUrl('UPS', '12\ud800'), null);
});

test('cursor round-trips and rejects malformed values with 400', () => {
  const at = new Date('2026-10-01T12:00:00.123Z');
  const decoded = decodeOrderCursor(encodeOrderCursor(at, 'ord0001'));
  assert.equal(decoded.createdAt.getTime(), at.getTime());
  assert.equal(decoded.id, 'ord0001');
  const bad = [
    '',
    'not base64!',
    'a'.repeat(201),
    Buffer.from('{"t":"x","i":"a"}').toString('base64url'),
    Buffer.from('{"t":1,"i":5}').toString('base64url'),
    Buffer.from('{"t":1,"i":"a b"}').toString('base64url'),
    Buffer.from('{"t":1e400,"i":"a"}').toString('base64url'),
    Buffer.from('{"t":9e15,"i":"a"}').toString('base64url'),
    Buffer.from('[]').toString('base64url'),
    Buffer.from('null').toString('base64url'),
    Buffer.from('{"t":1,"i":"' + 'a'.repeat(65) + '"}').toString('base64url'),
  ];
  for (const cursor of bad) assert.throws(() => decodeOrderCursor(cursor), BadRequestException, cursor.slice(0, 20));
});

test('timeline: PENDING_PAYMENT at createdAt, then STATUS targets oldest first; legacy order with no events has one entry', () => {
  const createdAt = new Date('2026-10-01T10:00:00.000Z');
  assert.deepEqual(buildTimeline(createdAt, []), [{ status: 'PENDING_PAYMENT', at: '2026-10-01T10:00:00.000Z' }]);
  const timeline = buildTimeline(createdAt, [
    { toStatus: 'PROCESSING', createdAt: new Date('2026-10-02T10:00:00.000Z') },
    { toStatus: 'SHIPPED', createdAt: new Date('2026-10-03T10:00:00.000Z') },
  ]);
  assert.deepEqual(timeline.map((entry) => entry.status), ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED']);
  for (const entry of timeline) assert.deepEqual(Object.keys(entry), ['status', 'at']);
});

test('timeline: events without a target status are ignored; a finalized payment time stands in for a missing PAID event only', () => {
  const createdAt = new Date('2026-10-01T10:00:00.000Z');
  const paidAt = new Date('2026-10-01T11:00:00.000Z');
  const processing = { toStatus: 'PROCESSING', createdAt: new Date('2026-10-02T10:00:00.000Z') };
  assert.deepEqual(buildTimeline(createdAt, [{ toStatus: null, createdAt: paidAt }, processing], paidAt).map((e) => e.status), ['PENDING_PAYMENT', 'PAID', 'PROCESSING']);
  assert.deepEqual(buildTimeline(createdAt, [{ toStatus: 'PAID', createdAt: new Date('2026-10-01T11:30:00.000Z') }, processing], paidAt).map((e) => e.status), ['PENDING_PAYMENT', 'PAID', 'PROCESSING']);
  assert.equal(buildTimeline(createdAt, [{ toStatus: 'PAID', createdAt: new Date('2026-10-01T11:30:00.000Z') }], paidAt)[1].at, '2026-10-01T11:30:00.000Z', 'the recorded event wins');
});

test('summary and detail mappers emit exactly the contract keys', () => {
  const order = { id: 'o1', status: 'SHIPPED', totalCents: 100, subtotalCents: null, shippingCents: 0, taxCents: 0, currency: 'USD', createdAt: new Date('2026-10-01T10:00:00.000Z') };
  const shipments = [
    { id: 's1', carrier: 'UPS', trackingNumber: 'AAAA1111', shippedAt: new Date('2026-10-02T10:00:00.000Z'), deliveredAt: null },
    { id: 's2', carrier: 'DHL', trackingNumber: 'BBBB2222', shippedAt: new Date('2026-10-03T10:00:00.000Z'), deliveredAt: new Date('2026-10-04T10:00:00.000Z') },
  ];
  const summary = toOrderSummary({ ...order, items: [{ quantity: 2 }, { quantity: 3 }], shipments });
  assert.deepEqual(Object.keys(summary), ['id', 'status', 'totalCents', 'subtotalCents', 'shippingCents', 'taxCents', 'currency', 'createdAt', 'itemCount', 'carrier', 'trackingNumber']);
  assert.equal(summary.itemCount, 5);
  assert.equal(summary.subtotalCents, null);
  assert.equal(summary.carrier, 'DHL', 'the latest shipment is advertised');
  const detail = toOrderDetail(
    { ...order, shippingAddress: null, items: [{ productId: 'p9', lotCode: 'L', quantity: 1, unitCents: 100 }], shipments, events: [] },
    new Map(),
    null,
  );
  assert.deepEqual(Object.keys(detail), ['id', 'status', 'totalCents', 'subtotalCents', 'shippingCents', 'taxCents', 'currency', 'createdAt', 'shippingAddress', 'items', 'shipments', 'timeline']);
  assert.deepEqual(Object.keys(detail.items[0]), ['productId', 'slug', 'name', 'lotCode', 'quantity', 'unitCents']);
  assert.deepEqual(Object.keys(detail.shipments[0]), ['carrier', 'trackingNumber', 'trackingUrl', 'shippedAt', 'deliveredAt']);
  assert.equal(detail.shippingAddress, null);
  assert.equal(detail.items[0].slug, null, 'a product that no longer exists degrades instead of failing');
  assert.deepEqual(detail.shipments.map((s) => s.carrier), ['UPS', 'DHL'], 'detail shipments are oldest first');
});
