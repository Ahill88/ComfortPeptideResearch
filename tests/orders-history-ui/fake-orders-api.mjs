// Cookie-scoped FAKE API for isolated browser QA. All customer/order/tracking data is fictional.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { detail, fixtureOrders, summary, SHIPPED } from './fixtures.mjs';

export function createFakeOrdersApi() {
  const orders = fixtureOrders();
  const firstPage = [...orders.values()].slice(0, 7).map((order) => summary(order.id, { status: order.status, carrier: order.shipments.length ? 'UPS' : null, trackingNumber: order.shipments.length ? 'TEST123456' : null }));
  for (let i = 0; i < 13; i++) firstPage.push(summary(`order-older-${i}`, { status: 'DELIVERED', carrier: null, trackingNumber: null }));
  const secondPage = ['order-legacy', 'order-hostile', 'order-empty-timeline'].map((id) => summary(id));
  let state = {};
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:3590');
    const path = url.pathname;
    const cookie = Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((part) => part.trim().split('=')));
    const mode = cookie.orders_qa ?? 'default';
    const signedIn = cookie.hf_session === 'orders-ui-fixture';
    const cors = {
      'Access-Control-Allow-Origin': 'http://localhost:3591', 'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin',
    };
    const json = (status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (path === '/__qa/requests') return json(200, requests);
    if (path === '/__qa/reset') { state = {}; requests.length = 0; return json(200, { ok: true }); }
    if (path === '/__qa/state' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      state = { ...state, ...JSON.parse(body) }; return json(200, { ok: true });
    }
    requests.push({ path: `${path}${url.search}`, signedIn, hasEmailHeader: Boolean(req.headers['x-customer-email']), mode });
    if (path === '/v1/auth/session') {
      if (!signedIn) return json(401, { message: 'Invalid session.' });
      if (mode === 'session-error') return json(503, { message: 'PRIVATE BACKEND MESSAGE' });
      return json(200, { customer: { id: 'fixture-customer', email: 'orders@example.test', name: 'Fixture Customer', emailVerified: true, mfaEnabled: false } });
    }
    if (path === '/v1/account/eligibility') return json(200, { status: 'APPROVED' });
    if (path === '/v1/auth/logout') { res.setHeader('Set-Cookie', 'hf_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); res.writeHead(204, cors); res.end(); return; }
    if (path === '/v1/orders' || path.startsWith('/v1/orders/')) {
      if (!signedIn || mode === 'orders-401' || state.expiredOrders) return json(401, { message: 'PRIVATE BACKEND MESSAGE' });
      if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 1200));
      if (path === '/v1/orders') {
        if (mode === 'error' || state.failList) return json(503, { message: 'PRIVATE BACKEND MESSAGE' });
        if (mode === 'broken') return json(200, { items: 'invalid', nextCursor: null });
        if (mode === 'empty') return json(200, { items: [], nextCursor: null });
        if (url.searchParams.get('limit') !== '20') return json(400, { message: 'Invalid limit.' });
        return json(200, url.searchParams.get('cursor') ? { items: secondPage, nextCursor: null } : { items: firstPage, nextCursor: 'cGFnZTI' });
      }
      const id = decodeURIComponent(path.slice('/v1/orders/'.length));
      if (id === 'order-error' || state.failDetail) return json(503, { message: 'PRIVATE BACKEND MESSAGE' });
      if (id === 'order-401') return json(401, { message: 'PRIVATE BACKEND MESSAGE' });
      if (id === 'order-broken') return json(200, detail(id, { totalCents: -1 }));
      if (id === 'order-polling') {
        const status = state.status ?? 'PROCESSING';
        const order = detail(id, { status, shipments: [] });
        if (status === 'DELIVERED') order.timeline.push({ status, at: '2026-10-03T12:00:00.000Z' });
        return json(200, order);
      }
      if (id === 'order-delivered') {
        const order = orders.get(id); order.shipments[0].deliveredAt = '2026-10-03T12:00:00.000Z';
        order.timeline = [...order.timeline.filter((entry) => entry.status !== 'DELIVERED'), { status: 'DELIVERED', at: order.shipments[0].deliveredAt }];
      }
      if (id === 'order-other-carrier') return json(200, detail(id, { shipments: [{ carrier: 'OTHER', trackingNumber: 'TEST-OTHER-123', trackingUrl: null, shippedAt: SHIPPED, deliveredAt: null }] }));
      return orders.has(id) ? json(200, orders.get(id)) : json(404, { message: 'Order not found.' });
    }
    return json(404, { message: 'Not found.' });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 3590);
  if (port !== 3590) throw new Error('Order UI fake API is restricted to port 3590.');
  createFakeOrdersApi().listen(port, '127.0.0.1', () => console.log(`Fictional orders API on http://localhost:${port}`));
}
