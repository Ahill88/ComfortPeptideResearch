// Uses existing Playwright OUTSIDE the repository. Run via run-browser-qa.mjs; no installation required.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOSTILE_TEXT, PRIVATE_TEXT } from './fixtures.mjs';

const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const { chromium } = createRequire(`${process.env.QA_TOOLS ?? `${temp}/browser-qa-tools`}/package.json`)('playwright');
const output = process.env.QA_OUTPUT ?? join(temp, `orders-history-qa-${Date.now()}`);
await mkdir(output, { recursive: true });
const base = 'http://localhost:3591';
const api = 'http://localhost:3590';
const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER ?? '/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const results = [];
const pageErrors = [];
const requests = async () => (await fetch(`${api}/__qa/requests`)).json();
const reset = async () => fetch(`${api}/__qa/reset`, { method: 'POST' });
const state = async (value) => fetch(`${api}/__qa/state`, { method: 'POST', body: JSON.stringify(value) });
const orderRequests = async (path = '/v1/orders') => (await requests()).filter((request) => request.path.startsWith(path));
const cookie = (name, value, httpOnly = false) => ({ name, value, domain: 'localhost', path: '/', httpOnly, sameSite: 'Lax' });
const mode = async (context, value = 'default') => context.addCookies([cookie('orders_qa', value)]);
const go = async (page, path) => page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
const text = (page) => page.locator('main').innerText();
const shot = (page, width, name) => page.screenshot({ path: join(output, `${width}-${name}.png`), fullPage: true });
const waitText = (page, value) => page.locator('main').getByText(value, { exact: false }).first().waitFor();
async function layout(page) {
  const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert(size.content <= size.viewport, `Horizontal overflow: ${JSON.stringify(size)}`);
  const small = await page.locator('main a, main button').evaluateAll((elements) => elements.map((element) => ({ text: element.textContent, rect: element.getBoundingClientRect() })).filter(({ rect }) => rect.width > 0 && rect.height < 43.9).map(({ text, rect }) => ({ text, height: rect.height })));
  assert.deepEqual(small, [], 'order controls/links have 44px target heights');
  assert.equal(await page.locator('main h1').count(), 1);
}
async function check(width, name, page, fn) {
  try { await reset(); await fn(); await layout(page); results.push({ width, name, status: 'pass' }); console.log(`PASS ${width} ${name}`); }
  catch (error) { results.push({ width, name, status: 'fail', error: error.message }); console.log(`FAIL ${width} ${name}: ${error.message}`); await shot(page, width, `FAIL-${name.replaceAll(/[^a-z0-9]+/gi, '-')}`).catch(() => {}); }
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
    await context.addCookies([cookie('hf_session', 'orders-ui-fixture', true)]);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => pageErrors.push({ width, message: error.message }));

    await check(width, 'list paging all statuses and cookie identity', page, async () => {
      await mode(context); await go(page, '/orders'); await waitText(page, 'Page 1 · 20 orders');
      for (const label of ['Pending payment', 'Paid', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Refunded', 'Oct 1, 2026', '$134.60', '2 items', 'TEST123456']) assert((await text(page)).includes(label), label);
      assert.equal(await page.getByRole('link', { name: /^View order / }).count(), 20);
      await shot(page, width, 'list');
      await page.getByRole('button', { name: 'Next page' }).click(); await waitText(page, 'Page 2 · 3 orders');
      assert.equal(await page.getByRole('button', { name: 'Next page' }).count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'customer-orders-title');
      await page.getByRole('button', { name: 'Previous page' }).click(); await waitText(page, 'Page 1 · 20 orders');
      const calls = await orderRequests();
      assert(calls.some((call) => call.path === '/v1/orders?limit=20&cursor=cGFnZTI'));
      assert(calls.every((call) => call.signedIn && !call.hasEmailHeader));
      assert.equal(await page.evaluate(() => document.cookie.includes('hf_session')), false, 'identity cookie is httpOnly');
    });

    await check(width, 'detail totals items safe tracking copy and recorded timeline', page, async () => {
      await mode(context); await go(page, '/orders/order-shipped'); await waitText(page, 'Order order-shipped');
      const content = await text(page);
      for (const value of ['GHK-Cu 5mg', 'TEST-LOT-001', 'Quantity', '$60.00', '$120.00', '$5.00', '$9.60', '$134.60', 'Example Research Lab', 'Order updates']) assert(content.includes(value), value);
      assert.equal(await page.getByRole('link', { name: 'GHK-Cu 5mg' }).getAttribute('href'), '/catalog/ghk-cu');
      const tracking = page.getByRole('link', { name: /Track shipment/ });
      assert.equal(await tracking.getAttribute('href'), 'https://www.ups.com/track?tracknum=TEST123456');
      assert.equal(await tracking.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await tracking.getAttribute('target'), '_blank');
      await page.getByRole('button', { name: 'Copy tracking number' }).click(); await waitText(page, 'Tracking number copied.');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'TEST123456');
      const timeline = page.getByRole('region', { name: 'Order updates' });
      assert.equal(await timeline.locator('li').count(), 3);
      assert(!(await timeline.innerText()).includes('Delivered'));
      await shot(page, width, 'detail');
    });

    await check(width, 'legacy total only missing slug address and incomplete timeline', page, async () => {
      await go(page, '/orders/order-legacy'); await waitText(page, 'Order order-legacy');
      const totals = page.getByRole('region', { name: 'Order total USD' });
      assert.deepEqual(await totals.locator('dt').allTextContents(), ['Total']);
      assert((await totals.innerText()).includes('$120.00'));
      assert.equal(await page.getByRole('link', { name: 'Unavailable product' }).count(), 0);
      assert((await text(page)).includes('A shipping address isn’t available'));
      const timeline = page.getByRole('region', { name: 'Order updates' });
      assert.equal(await timeline.locator('li').count(), 1);
      assert(!(await timeline.innerText()).includes('Delivered'));
      await shot(page, width, 'legacy');
    });

    await check(width, 'pending payment truthful explanation without bag resume', page, async () => {
      await go(page, '/orders/order-pending-payment'); await waitText(page, 'Payment cannot be resumed from order history.');
      assert.equal(await page.locator('main a[href="/cart"], main a[href="/checkout"]').count(), 0);
      assert((await text(page)).includes('No shipment details have been recorded'));
      await shot(page, width, 'pending');
    });

    await check(width, 'hostile text inert private fields omitted unsafe tracking blocked', page, async () => {
      await go(page, '/orders/order-hostile'); await waitText(page, 'Order order-hostile');
      assert((await text(page)).includes(HOSTILE_TEXT));
      assert(!(await text(page)).includes(PRIVATE_TEXT));
      assert.equal(await page.evaluate(() => window.__orderXss), undefined);
      assert.equal(await page.locator('main img, main script').count(), 0);
      assert.equal(await page.locator('main a[href^="http"], main a[href^="//"]').count(), 0);
      assert.equal(await page.getByRole('region', { name: 'Order updates' }).locator('li').count(), 1);
      await shot(page, width, 'hostile');
    });

    await check(width, 'empty unknown status and other-carrier detail fallbacks', page, async () => {
      await go(page, '/orders/order-empty-timeline'); await waitText(page, 'No status updates have been recorded.');
      await go(page, '/orders/order-unknown-status'); await waitText(page, 'Status unavailable');
      assert(!(await text(page)).includes('NEW_INTERNAL_STATUS'));
      await go(page, '/orders/order-other-carrier'); await waitText(page, 'TEST-OTHER-123');
      assert.equal(await page.getByRole('link', { name: /Track shipment/ }).count(), 0);
      await page.getByRole('button', { name: 'Copy tracking number' }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'TEST-OTHER-123');
      await go(page, '/orders/order-delivered'); await waitText(page, 'Order order-delivered');
      assert((await page.getByRole('region', { name: 'Shipment tracking' }).innerText()).includes('Delivered:'));
    });

    await check(width, '404 missing foreign and invalid ids are indistinguishable', page, async () => {
      const messages = [];
      for (const id of ['missing', 'foreign', 'bad%20id']) { await go(page, `/orders/${id}`); await waitText(page, 'Order not found'); messages.push(await page.locator('main [role="status"]').innerText()); }
      assert.equal(new Set(messages).size, 1);
      assert(!messages[0].includes('another customer'));
      await shot(page, width, 'not-found');
    });

    await check(width, '401 list and detail give safe sign-in return links', page, async () => {
      await mode(context, 'orders-401'); await go(page, '/orders'); await waitText(page, 'Sign in to view your orders');
      assert.equal(await page.locator('main').getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href'), '/login?next=%2Forders');
      await mode(context); await go(page, '/orders/order-401'); await waitText(page, 'Sign in to view your orders');
      assert.equal(await page.locator('main').getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href'), '/login?next=%2Forders%2Forder-401');
      assert(!(await text(page)).includes('PRIVATE BACKEND'));
      await shot(page, width, 'sign-in');
    });

    await check(width, 'signed out does not request or render order data', page, async () => {
      await context.clearCookies(); await go(page, '/orders/order-shipped'); await waitText(page, 'Sign in to view your orders');
      assert.equal((await orderRequests()).length, 0);
      assert(!(await text(page)).includes('Example Research Lab'));
      assert.equal(await page.locator('main').getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href'), '/login?next=%2Forders%2Forder-shipped');
      await context.addCookies([cookie('hf_session', 'orders-ui-fixture', true)]);
    });

    await check(width, 'loading empty error retry and malformed responses', page, async () => {
      await mode(context, 'slow'); await go(page, '/orders'); await waitText(page, 'Loading your orders…');
      assert.equal(await page.locator('main [role="status"][aria-live="polite"]').count(), 1);
      await waitText(page, 'Page 1 · 20 orders');
      await mode(context, 'empty'); await go(page, '/orders'); await waitText(page, 'No orders yet'); await shot(page, width, 'empty');
      await mode(context, 'error'); await go(page, '/orders'); await waitText(page, 'Order information is unavailable');
      assert(!(await text(page)).includes('PRIVATE BACKEND'));
      await mode(context); await page.getByRole('button', { name: 'Try again' }).click(); await waitText(page, 'Page 1 · 20 orders');
      await mode(context, 'broken'); await go(page, '/orders'); await waitText(page, 'Order information is unavailable');
      assert(!(await text(page)).includes('No orders yet'));
      await mode(context); await go(page, '/orders/order-broken'); await waitText(page, 'Order information is unavailable');
      await shot(page, width, 'error');
    });

    await check(width, 'refresh failure keeps last read and 401 clears it', page, async () => {
      await mode(context); await go(page, '/orders/order-shipped'); await waitText(page, 'Order order-shipped');
      await state({ failDetail: true }); await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await waitText(page, 'Couldn’t refresh.');
      assert((await text(page)).includes('Example Research Lab'));
      await state({ failDetail: false, expiredOrders: true }); await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await waitText(page, 'Sign in to view your orders');
      assert(!(await text(page)).includes('Example Research Lab'));
    });

    await check(width, 'clipboard failure remains accessible without losing tracking number', page, async () => {
      await go(page, '/orders/order-shipped'); await waitText(page, 'Order order-shipped');
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); }; });
      await page.getByRole('button', { name: 'Copy tracking number' }).click(); await waitText(page, 'Couldn’t copy.');
      assert((await text(page)).includes('TEST123456'));
    });

    await check(width, '60s visible polling pauses hidden stops terminal and cleans up navigation', page, async () => {
      await page.clock.install();
      await go(page, '/orders/order-polling'); await waitText(page, 'Order order-polling');
      let count = (await orderRequests('/v1/orders/order-polling')).length;
      await page.clock.fastForward(59000);
      assert.equal((await orderRequests('/v1/orders/order-polling')).length, count);
      const refreshed = page.waitForResponse((response) => response.url().endsWith('/orders/order-polling'));
      await page.clock.fastForward(1001); await refreshed; await waitText(page, 'Checks for updates every 60 seconds');
      assert.equal((await orderRequests('/v1/orders/order-polling')).length, ++count);
      // Deterministic visibility event: tests the page lifecycle guard without relying on headless window focus.
      await page.evaluate(() => { window.__ordersVisibility = 'hidden'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__ordersVisibility }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.fastForward(60001);
      assert.equal((await orderRequests('/v1/orders/order-polling')).length, count);
      await state({ status: 'SHIPPED' });
      await page.evaluate(() => { window.__ordersVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => document.querySelector('#order-number-heading')?.parentElement?.parentElement?.textContent?.includes('Shipped'));
      assert.equal((await orderRequests('/v1/orders/order-polling')).length, ++count);
      await state({ status: 'DELIVERED' });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await waitText(page, 'Showing the latest loaded order information.');
      count = (await orderRequests('/v1/orders/order-polling')).length;
      await page.clock.fastForward(120001);
      assert.equal((await orderRequests('/v1/orders/order-polling')).length, count);
      await state({ status: 'PROCESSING' }); await go(page, '/orders/order-polling'); await waitText(page, 'Checks for updates every 60 seconds');
      await go(page, '/orders/order-legacy'); await waitText(page, 'Order order-legacy');
      count = (await orderRequests('/v1/orders/order-polling')).length;
      await page.clock.fastForward(60001);
      assert.equal((await orderRequests('/v1/orders/order-polling')).length, count);
      await page.clock.resume();
    });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
}
console.log(`Browser QA: ${results.filter((result) => result.status === 'pass').length}/${results.length} passed; ${pageErrors.length} page errors. Artifacts: ${output}`);
assert.equal(results.filter((result) => result.status === 'fail').length, 0);
assert.deepEqual(pageErrors, []);
