import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CustomerOrdersError, customerOrdersErrorStatus, fetchCustomerOrder, fetchCustomerOrders } from '../../apps/storefront/lib/orders/customer-orders-api';
// @ts-ignore Node fixture shared with browser QA.
import { detail, summary } from './fixtures.mjs';

test('reads use shared apiRequest with cookies, no email header, no-store, encoded cursor and AbortSignal', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(String(url).includes('?') ? { items: [summary()], nextCursor: null } : detail()), { status: 200 });
  });
  const controller = new AbortController();
  await fetchCustomerOrders('opaque_cursor-1', controller.signal);
  await fetchCustomerOrder('order-shipped', controller.signal);
  assert.match(calls[0].url, /\/orders\?limit=20&cursor=opaque_cursor-1$/);
  assert.match(calls[1].url, /\/orders\/order-shipped$/);
  for (const call of calls) {
    assert.equal(call.init?.credentials, 'include');
    assert.equal(call.init?.cache, 'no-store');
    assert.equal(call.init?.method, 'GET');
    assert.equal(call.init?.signal, controller.signal);
    assert.equal(new Headers(call.init?.headers).has('x-customer-email'), false);
  }
});

test('bad IDs/cursors fail locally, malformed success and mismatched IDs cannot become order data', async (t) => {
  let calls = 0;
  let body: unknown = detail('different-order');
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(body)); });
  await assert.rejects(fetchCustomerOrder('../other'), (error: unknown) => customerOrdersErrorStatus(error) === 404);
  await assert.rejects(fetchCustomerOrders('//evil.invalid'), CustomerOrdersError);
  assert.equal(calls, 0);
  await assert.rejects(fetchCustomerOrder('order-shipped'), CustomerOrdersError);
  body = { items: [summary()], nextCursor: 'same-cursor' };
  await assert.rejects(fetchCustomerOrders('same-cursor'), CustomerOrdersError);
  body = { items: 'bad', nextCursor: null };
  await assert.rejects(fetchCustomerOrders(null), CustomerOrdersError);
});

test('401/404/500 remain distinct for UI routing; raw messages are never required by the UI', async (t) => {
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'PRIVATE BACKEND MESSAGE' }), { status }));
  for (const code of [401, 404, 500]) {
    status = code;
    await assert.rejects(fetchCustomerOrder('order-shipped'), (error: unknown) => customerOrdersErrorStatus(error) === code);
  }
  assert.equal(customerOrdersErrorStatus(new Error('ordinary error')), null);
});

test('aborted navigation does not turn into a fabricated response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(fetchCustomerOrders(null), { name: 'AbortError' });
});
