// Deliberately fictional records for order-history QA only; no customer data or live shipments.
export const CREATED = '2026-10-01T12:00:00.000Z';
export const PAID = '2026-10-01T12:10:00.000Z';
export const SHIPPED = '2026-10-02T13:00:00.000Z';
export const STATUSES = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
export const PRIVATE_TEXT = 'PRIVATE-STAFF-NOTE-NEVER-RENDER';
export const HOSTILE_TEXT = '<img src=x onerror="window.__orderXss=1">Hostile product';

export function detail(id = 'order-shipped', changes = {}) {
  return {
    id, status: 'SHIPPED', currency: 'USD', subtotalCents: 12000, shippingCents: 500, taxCents: 960, totalCents: 13460, createdAt: CREATED,
    shippingAddress: 'Example Research Lab\n123 Fictional Street\nBoston, MA 02110\nUS',
    items: [{ productId: 'product-1', slug: 'ghk-cu', name: 'GHK-Cu 5mg', lotCode: 'TEST-LOT-001', quantity: 2, unitCents: 6000 }],
    shipments: [{ carrier: 'UPS', trackingNumber: 'TEST123456', trackingUrl: 'https://www.ups.com/track?tracknum=TEST123456', shippedAt: SHIPPED, deliveredAt: null }],
    timeline: [{ status: 'PENDING_PAYMENT', at: CREATED }, { status: 'PAID', at: PAID }, { status: 'SHIPPED', at: SHIPPED }],
    ...changes,
  };
}

export function summary(id = 'order-shipped', changes = {}) {
  const { items, shipments, timeline, shippingAddress, ...base } = detail(id);
  return { ...base, itemCount: 2, carrier: 'UPS', trackingNumber: 'TEST123456', ...changes };
}

export function fixtureOrders() {
  const orders = new Map(STATUSES.map((status) => {
    const id = `order-${status.toLowerCase().replaceAll('_', '-')}`;
    return [id, detail(id, { status, ...(status === 'SHIPPED' || status === 'DELIVERED' ? {} : { shipments: [] }) })];
  }));
  orders.set('order-legacy', detail('order-legacy', {
    status: 'DELIVERED', subtotalCents: null, shippingCents: 0, taxCents: 0, totalCents: 12000,
    shippingAddress: null, shipments: [], timeline: [{ status: 'PENDING_PAYMENT', at: CREATED }],
    items: [{ productId: 'deleted-product', slug: null, name: 'Unavailable product', lotCode: 'LEGACY-LOT', quantity: 2, unitCents: 6000 }],
  }));
  orders.set('order-hostile', detail('order-hostile', {
    shippingAddress: '<script>window.__orderXss=2</script>\n' + 'long-address-'.repeat(30),
    items: [{ productId: 'product-2', slug: '//evil.invalid', name: HOSTILE_TEXT, lotCode: '<b>LOT</b>' + 'x'.repeat(180), quantity: 2, unitCents: 6000 }],
    shipments: [{ carrier: 'UPS', trackingNumber: '"<svg onload=window.__orderXss=3>' + 'x'.repeat(100), trackingUrl: 'https://www.ups.com.evil.invalid/track?tracknum=x', shippedAt: SHIPPED, deliveredAt: null, note: PRIVATE_TEXT }],
    timeline: [{ status: 'PENDING_PAYMENT', at: CREATED, note: PRIVATE_TEXT, adminName: PRIVATE_TEXT }, { kind: 'NOTE', status: 'PAID', at: PAID, note: PRIVATE_TEXT }, { status: '<script>alert(1)</script>', at: SHIPPED }],
    events: [{ kind: 'NOTE', note: PRIVATE_TEXT }], admin: { name: PRIVATE_TEXT }, note: PRIVATE_TEXT,
  }));
  orders.set('order-empty-timeline', detail('order-empty-timeline', { timeline: [], status: 'PAID', shipments: [] }));
  orders.set('order-unknown-status', detail('order-unknown-status', { status: '<b>NEW_INTERNAL_STATUS</b>', timeline: [] }));
  return orders;
}
