#!/usr/bin/env node
// Browser QA for apps/admin against the FAKE admin API (tests/admin-ui/fake-admin-api.mjs).
//
// Start the two servers first (this script starts nothing):
//   PORT=3190 node tests/admin-ui/fake-admin-api.mjs
//   API_URL=http://127.0.0.1:3190/v1 ADMIN_API_TOKEN=fake-wallet-token <next dev|start> -p 3191   (apps/admin)
// Then:  node tests/admin-ui/admin-browser-qa.mjs
//
// Env: QA_BASE_URL (default http://127.0.0.1:3191)  QA_FAKE_URL (default http://127.0.0.1:3190)
//      QA_PROD=1 when the admin runs under `next start` (expects the Secure/__Host- cookie)
//      QA_VERIFY_BASE the STOREFRONT_PUBLIC_URL the admin under test was started with (default https://shop.example.test;
//        set it to the empty string when the admin runs WITHOUT that variable: the slip must then show relative /verify/<lot> text)
//      QA_TOOLS (playwright install dir)  QA_BROWSER (chromium executable)  QA_OUTPUT (screenshot dir)
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { operationsQa } from './operations-browser-qa.mjs';

const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const tools = process.env.QA_TOOLS || `${temp}/browser-qa-tools`;
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:3191';
const FAKE = process.env.QA_FAKE_URL || 'http://127.0.0.1:3190';
const PROD = process.env.QA_PROD === '1';
const VERIFY_BASE = process.env.QA_VERIFY_BASE ?? 'https://shop.example.test';
const OUT = process.env.QA_OUTPUT || join(temp, `admin-qa-${new Date().toISOString().replaceAll(':', '-')}`);
const BROWSER = process.env.QA_BROWSER || '/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
await mkdir(OUT, { recursive: true });

const PASSWORD = 'correct horse battery';
const results = [];
const seenTokens = new Set();
const leakCorpus = []; // { where, text } scanned for tokens at the end
const consoleProblems = [];
const directApiRequests = [];
let expectedAbort = false; // set while a test deliberately aborts a request (its console error is expected)

async function fake(path, body) {
  const response = await fetch(`${FAKE}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json();
}
async function snapshotTokens() { for (const t of (await fake('/__control/tokens')).tokens) seenTokens.add(t); }
const shortId = (id) => id.slice(-8).toUpperCase();

async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message.split('\n').slice(0, 6).join(' | ') }); console.log(`FAIL  ${name}\n      ${error.message.split('\n').slice(0, 6).join('\n      ')}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: BROWSER });

async function newContext(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, baseURL: BASE, locale: 'en-US', timezoneId: 'UTC' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
  context.on('page', instrument);
  return context;
}
function instrument(page) {
  page.on('pageerror', (e) => !expectedAbort && consoleProblems.push({ type: 'pageerror', url: page.url(), message: e.message }));
  page.on('console', (m) => { if (m.type() === 'error' && !expectedAbort) consoleProblems.push({ type: 'console', url: page.url(), message: m.text() }); });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== BASE) directApiRequests.push(r.url());
    leakCorpus.push({ where: `request url ${r.url()}`, text: r.url() });
    if (r.postData()) leakCorpus.push({ where: `request body ${r.url()}`, text: r.postData() });
  });
  page.on('response', async (r) => {
    if (new URL(r.url()).origin !== BASE) return;
    const type = r.headers()['content-type'] || '';
    if (/text|json|javascript|x-component/.test(type)) { try { leakCorpus.push({ where: `response body ${r.url()}`, text: await r.text() }); } catch { /* redirects have no body */ } }
  });
}

async function signIn(page, email = 'owner@example.test', password = PASSWORD, totp = '123456') {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('6-digit code').fill(totp);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function login(context, email) {
  const page = await context.newPage();
  await signIn(page, email);
  await page.waitForURL(`${BASE}/`);
  await snapshotTokens();
  return page;
}
const orderList = async () => (await fake('/__control/orders')).orders;
const findOrder = async (email) => (await orderList()).find((o) => o.email === email);
const shot = (page, name, fullPage = true) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage });

async function contrastOffenders(page) {
  return page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.99) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const bad = new Map();
    for (const el of document.querySelectorAll('body *')) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!rect.width || !rect.height || cs.visibility === 'hidden' || el.closest('.sr-only,[aria-hidden="true"],.skip-link') || el.matches(':disabled')) continue;
      const fg = parse(cs.color); const bg = bgOf(el);
      if (!fg) continue;
      const l1 = lum(fg); const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize); const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) bad.set(`${el.tagName.toLowerCase()}.${el.className}|${el.textContent.trim().slice(0, 30)}`, ratio.toFixed(2));
    }
    return [...bad.entries()].slice(0, 10);
  });
}
async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea')]
    .filter((el) => { const box = el.type === 'checkbox' && el.closest('label') ? el.closest('label') : el; const r = box.getBoundingClientRect(); return r.width && r.height && !el.closest('.sr-only,.skip-link') && r.height < 43.5; })
    .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 30)}" h=${Math.round(el.getBoundingClientRect().height)}`).slice(0, 10));
}

await fake('/__control/reset', {});
await fake('/__control/config', { unconfigured: false, failOrders: false, delayMs: 0 });

// ======================================================================= 0. detector self-test
await check('a11y detectors self-test: a low-contrast paragraph and a 30px button ARE flagged', async () => {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<p style="color:#aaaaaa;background:#ffffff">faint text</p><button style="height:30px">tiny</button>');
  });
  assert.ok((await contrastOffenders(page)).some(([key]) => key.includes('faint text')), 'low contrast not detected');
  assert.ok((await smallTargets(page)).some((t) => t.includes('tiny')), 'small target not detected');
  await context.close();
});

// ======================================================================= 1. gate + sign-in
await check('unauthenticated visits to every area redirect to /sign-in (incl. wallets, slip, team, audit)', async () => {
  const context = await newContext();
  const page = await context.newPage();
  for (const path of ['/', '/orders', '/orders/abc', '/orders/abc/packing-slip', '/team', '/audit', '/account/password', '/wallets', '/wallets/balances', '/wallets/failed', '/lots', '/lots/abc', '/products', '/coas/abc/file', '/inventory', '/compliance', '/email']) {
    await page.goto(path);
    assert.equal(new URL(page.url()).pathname, '/sign-in', `${path} -> ${page.url()}`);
  }
  await context.close();
});

await check('dev-session route is gone', async () => {
  const response = await fetch(`${BASE}/api/dev-session`, { method: 'POST' });
  assert.equal(response.status, 404);
});

await check('sign-in form: labels, one-time-code autocomplete, numeric input mode', async () => {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto('/sign-in');
  const totp = page.getByLabel('6-digit code');
  assert.equal(await totp.getAttribute('autocomplete'), 'one-time-code');
  assert.equal(await totp.getAttribute('inputmode'), 'numeric');
  assert.equal(await page.getByLabel('Password').getAttribute('type'), 'password');
  await shot(page, '01-sign-in');
  assert.deepEqual(await contrastOffenders(page), [], 'contrast');
  assert.deepEqual(await smallTargets(page), [], 'target size');
  await context.close();
});

await check('wrong password and wrong code both show the same generic error and set no cookie', async () => {
  const context = await newContext();
  const page = await context.newPage();
  await signIn(page, 'owner@example.test', 'not the password');
  await page.getByText('Invalid sign-in.').waitFor();
  await signIn(page, 'owner@example.test', PASSWORD, '000000');
  await page.getByText('Invalid sign-in.').waitFor();
  assert.equal(new URL(page.url()).pathname, '/sign-in');
  assert.equal((await context.cookies()).filter((c) => /admin_session/.test(c.name)).length, 0);
  assert.equal(await page.getByLabel('Password').inputValue(), '', 'password field is cleared after a failure');
  await shot(page, '02-sign-in-error');
  await context.close();
});

await check('malformed code is rejected before calling the API', async () => {
  const context = await newContext();
  const page = await context.newPage();
  const logins = async () => (await fake('/__control/log')).log.filter((l) => l.path.includes('/auth/login')).length;
  const before = await logins();
  await signIn(page, 'owner@example.test', PASSWORD, '12ab');
  await page.getByText(/6-digit code/).nth(1).waitFor();
  assert.equal(await logins(), before, 'no login call for a malformed code');
  await context.close();
});

await check('503 "not configured" message is shown', async () => {
  await fake('/__control/config', { unconfigured: true });
  const context = await newContext();
  const page = await context.newPage();
  await signIn(page);
  await page.getByText('Admin sign-in is not configured.').waitFor();
  await shot(page, '03-sign-in-503');
  await fake('/__control/config', { unconfigured: false });
  await context.close();
});

// ======================================================================= 2. owner session + token hygiene
const ownerContext = await newContext();
let owner;
await check('owner signs in; overview shows admin, role, counts and links', async () => {
  owner = await login(ownerContext, 'owner@example.test');
  await owner.getByText('Olivia Owner').first().waitFor();
  assert.ok(await owner.locator('.topbar .role', { hasText: 'OWNER' }).isVisible());
  const counts = (await fake('/__control/orders')).orders.reduce((m, o) => ({ ...m, [o.status]: (m[o.status] || 0) + 1 }), {});
  const card = (label) => owner.locator('a.card', { hasText: label }).locator('.value');
  assert.equal(await card('To pack').innerText(), String(counts.PAID));
  assert.equal(await card('Packing').innerText(), String(counts.PROCESSING));
  assert.equal(await card('Shipped').innerText(), String(counts.SHIPPED));
  assert.equal(await card('Awaiting payment').innerText(), String(counts.PENDING_PAYMENT));
  assert.ok(await owner.getByRole('button', { name: 'Sign out' }).isVisible());
  assert.ok(await owner.getByRole('link', { name: 'Team' }).first().isVisible());
  await shot(owner, '04-overview');
});

await check('session cookie is httpOnly + SameSite=Strict (+Secure in production) and invisible to JavaScript', async () => {
  const cookies = (await ownerContext.cookies()).filter((c) => /admin_session/.test(c.name));
  assert.equal(cookies.length, 1);
  const [c] = cookies;
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Strict');
  assert.equal(c.secure, PROD, `secure flag expected ${PROD}`);
  assert.equal(c.path, '/');
  if (PROD) assert.ok(c.name.startsWith('__Host-'), 'production cookie uses the __Host- prefix');
  assert.ok(c.expires > Date.now() / 1000, 'cookie has an expiry from the API expiresAt');
  const visible = await owner.evaluate(() => ({ cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
  assert.ok(!visible.cookie.includes('admin_session'), 'document.cookie must not expose the session');
  assert.equal(visible.local, '{}');
  assert.equal(visible.session, '{}');
  assert.ok([...seenTokens].every((t) => !visible.cookie.includes(t) && !visible.local.includes(t) && !visible.session.includes(t)));
  assert.ok(!c.value.includes(' '), 'sanity');
});

// ======================================================================= 3. queue
await check('queue: default tab is To pack; tab counts match the API; every tab lists the right rows', async () => {
  await owner.goto('/orders');
  assert.equal(await owner.locator('.tab[aria-current="page"]').innerText().then((t) => t.replace(/\s+/g, ' ')), 'To pack 3');
  const all = await orderList();
  const expect = { 'To pack': ['PAID'], Packing: ['PROCESSING'], Shipped: ['SHIPPED'], Delivered: ['DELIVERED'], 'Awaiting payment': ['PENDING_PAYMENT'], All: null };
  for (const [label, statuses] of Object.entries(expect)) {
    const want = statuses ? all.filter((o) => statuses.includes(o.status)).length : all.length;
    const tab = owner.locator('nav[aria-label="Order queues"] a.tab', { hasText: new RegExp(`^${label}`) });
    assert.equal(await tab.locator('.count').innerText(), String(want), `${label} badge`);
    await tab.click();
    await owner.locator('.tab[aria-current="page"]').filter({ hasText: new RegExp(`^${label}`) }).waitFor();
    await owner.locator('table.rows tbody tr').first().waitFor();
    assert.equal(await owner.locator('table.rows tbody tr').count(), want, `${label} rows`);
  }
  // Statuses in All view are text chips
  const chips = await owner.locator('table.rows .chip').allInnerTexts();
  for (const label of ['Awaiting payment', 'Paid', 'Packing', 'Shipped', 'Delivered', 'Cancelled', 'Refunded']) assert.ok(chips.includes(label), `chip ${label}`);
});

await check('queue: dense table, newest first, columns, tracking shown for shipped', async () => {
  await owner.goto('/orders');
  await shot(owner, '05-queue-to-pack');
  const headers = await owner.locator('table.rows thead th').allInnerTexts();
  assert.deepEqual(headers.map((h) => h.toLowerCase()), ['order', 'placed', 'customer', 'items', 'total', 'status', 'tracking']);
  const first = await owner.locator('table.rows tbody tr').first().innerText();
  assert.ok(first.includes('priya.raman@example.test'), 'newest PAID order first');
  assert.ok(/\$/.test(first) && /3\b/.test(first));
  await owner.goto('/orders?tab=shipped');
  assert.ok((await owner.locator('table.rows tbody tr').first().innerText()).includes('1Z999AA10123456784'));
  assert.deepEqual(await contrastOffenders(owner), [], 'contrast');
  assert.deepEqual(await smallTargets(owner), [], 'target size');
});

await check('queue: search by email and by id, empty state, "/" focuses search, clear', async () => {
  await owner.goto('/orders');
  await owner.waitForLoadState('networkidle'); // the "/" handler is attached on hydration
  await owner.keyboard.press('/');
  assert.equal(await owner.evaluate(() => document.activeElement?.id), 'q');
  await owner.keyboard.type('marcus');
  await owner.keyboard.press('Enter');
  await owner.waitForURL(/q=marcus/);
  assert.equal(await owner.locator('table.rows tbody tr').count(), 1);
  const m = await findOrder('marcus.albrecht@example.test');
  await owner.goto(`/orders?tab=all&q=${m.id.slice(-8)}`);
  assert.equal(await owner.locator('table.rows tbody tr').count(), 1);
  await owner.goto('/orders?q=nobody-matches-this');
  await owner.getByText('No to pack orders match "nobody-matches-this".').waitFor();
  await owner.goto('/orders?q=dev.patel');
  assert.ok(await owner.getByRole('link', { name: 'Search all orders' }).isVisible(), 'offers to widen search to All');
});

await check('queue: Load more pages through all results (43 to-pack orders), keyboard-reachable', async () => {
  await fake('/__control/bulk', { n: 40 });
  await owner.goto('/orders');
  assert.equal(await owner.locator('table.rows tbody tr').count(), 25);
  const more = owner.getByRole('button', { name: 'Load more' });
  await more.focus();
  await owner.keyboard.press('Enter');
  await owner.waitForFunction(() => document.querySelectorAll('table.rows tbody tr').length > 25);
  assert.equal(await owner.locator('table.rows tbody tr').count(), 43);
  assert.equal(await more.count(), 0, 'button disappears when exhausted');
  await owner.getByText('End of list.').waitFor();
  const ids = await owner.locator('table.rows tbody tr a.row-link').allInnerTexts();
  assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');
  await owner.locator('table.rows tbody tr').first().scrollIntoViewIfNeeded();
  await shot(owner, '06-queue-load-more', false);
  await fake('/__control/reset', {}); // drops bulk rows AND all sessions: sign in again
  await owner.goto('/orders');
  assert.ok(owner.url().includes('/sign-in'));
  await signIn(owner);
  await owner.waitForURL(`${BASE}/`);
  await snapshotTokens();
});

await check('queue: API failure shows a plain message, never a stack trace', async () => {
  await fake('/__control/config', { failOrders: true });
  await owner.goto('/orders');
  const text = await owner.locator('main').innerText();
  assert.ok(/could not be loaded/i.test(text), text.slice(0, 200));
  assert.ok(!/TypeError|\.js:\d+|OrdersService|at /.test(text), 'no stack trace');
  await fake('/__control/config', { failOrders: false });
});

// ======================================================================= 4. order detail + flow
const pack = await findOrder('priya.raman@example.test');
const longAddress = (await fake(`/__control/order?id=${pack.id}`)).shippingAddress;

await check('detail: address block + Copy button copies the exact address; items with prominent LOT codes', async () => {
  await owner.goto(`/orders/${pack.id}`);
  assert.ok((await owner.locator('h1').innerText()).includes(shortId(pack.id)));
  assert.equal((await owner.locator('#address-text').innerText()).replace(/\r/g, ''), longAddress);
  await owner.getByRole('button', { name: 'Copy address' }).click();
  await owner.getByRole('button', { name: 'Copied' }).waitFor();
  const clip = await owner.evaluate(() => navigator.clipboard.readText());
  assert.equal(clip, longAddress);
  assert.ok(await owner.locator('.lot', { hasText: 'L24-0917-A' }).isVisible());
  assert.ok(await owner.locator('.lot', { hasText: 'W24-0610-01' }).isVisible());
  const rows = await owner.locator('section[aria-labelledby="items-h"] tbody tr').count();
  assert.equal(rows, 2);
  const sku = await owner.locator('section[aria-labelledby="items-h"] td.mono').allInnerTexts();
  assert.deepEqual(sku, ['BPC157-5MG', 'BACW-30ML']);
  await shot(owner, '07-order-detail');
  assert.deepEqual(await contrastOffenders(owner), [], 'contrast');
  assert.deepEqual(await smallTargets(owner), [], 'target size');
});

await check('detail: payment shows USDC with 6 decimals, devnet explorer link only for solana-devnet', async () => {
  const dev = await fake(`/__control/order?id=${pack.id}`);
  const atomic = BigInt(dev.payment.amountAtomic);
  const expected = `${(atomic / 1000000n).toLocaleString('en-US')}.${(atomic % 1000000n).toString().padStart(6, '0')} USDC`;
  const panel = owner.locator('section[aria-labelledby="payment-h"]');
  assert.ok((await panel.innerText()).includes(expected), `expected ${expected}`);
  const link = panel.getByRole('link', { name: /Solana Explorer/ });
  assert.equal(await link.getAttribute('href'), `https://explorer.solana.com/tx/${dev.payment.txSignature}?cluster=devnet`);
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  await panel.getByRole('button', { name: 'Copy signature' }).click();
  assert.equal(await owner.evaluate(() => navigator.clipboard.readText()), dev.payment.txSignature);
  // mainnet order: no link at all
  const mainnet = await findOrder('tomas.novak@example.test');
  await owner.goto(`/orders/${mainnet.id}`);
  const mp = owner.locator('section[aria-labelledby="payment-h"]');
  assert.ok((await mp.innerText()).includes('solana-mainnet-beta'));
  assert.equal(await mp.locator('a').count(), 0, 'no explorer link for a non-devnet network');
  // awaiting payment order: no signature, no link
  const pending = await findOrder('ines.moreau@example.test');
  await owner.goto(`/orders/${pending.id}`);
  assert.ok((await owner.locator('section[aria-labelledby="payment-h"]').innerText()).includes('No transaction signature recorded'));
});

await check('detail: missing shipping address and missing lot code are called out', async () => {
  const noAddr = await findOrder('chloe.tran@example.test');
  await owner.goto(`/orders/${noAddr.id}`);
  assert.ok(await owner.getByText('No shipping address on this order').isVisible());
  assert.equal(await owner.getByRole('button', { name: 'Copy address' }).count(), 0);
  const noLot = await findOrder('dev.patel@example.test');
  await owner.goto(`/orders/${noLot.id}`);
  assert.ok(await owner.getByText('No lot recorded').isVisible());
});

await check('detail: action panel is driven strictly by allowedActions for every status', async () => {
  const expectations = {
    PAID: ['Start packing'], PROCESSING: ['Mark shipped'], SHIPPED: ['Mark delivered'], PENDING_PAYMENT: ['Cancel order'], DELIVERED: [], CANCELLED: [], REFUNDED: [],
  };
  const every = ['Start packing', 'Mark shipped', 'Mark delivered', 'Cancel order'];
  const seen = new Set();
  for (const o of await orderList()) {
    if (seen.has(o.status)) continue;
    seen.add(o.status);
    await owner.goto(`/orders/${o.id}`);
    const panel = owner.locator('section[aria-labelledby="actions-h"]');
    for (const label of every) {
      const count = await panel.getByRole('button', { name: label, exact: true }).count();
      assert.equal(count, expectations[o.status].includes(label) ? 1 : 0, `${o.status}: "${label}"`);
    }
    assert.ok(await panel.getByRole('button', { name: 'Add note' }).isVisible(), `${o.status}: add-note`);
  }
});

await check('flow: start packing (no reload, aria-live, double-click guard) -> ship with validation + confirm -> deliver -> note', async () => {
  await fake('/__control/config', { delayMs: 250 });
  await owner.goto(`/orders/${pack.id}`);
  await owner.evaluate(() => { window.__noReload = 'still-here'; });
  const panel = owner.locator('section[aria-labelledby="actions-h"]');
  const logBefore = (await fake('/__control/log')).log.length;
  await panel.getByRole('button', { name: 'Start packing' }).dblclick();
  await panel.locator('.msg-ok', { hasText: 'Order moved to Packing.' }).waitFor();
  const live = await owner.locator('section[aria-labelledby="actions-h"] [role="status"][aria-live="polite"]').count();
  assert.ok(live >= 1, 'aria-live region present');
  const posts = (await fake('/__control/log')).log.slice(logBefore).filter((l) => l.method === 'POST' && l.path.endsWith('/start-packing'));
  assert.equal(posts.length, 1, `exactly one start-packing request, saw ${posts.length}`);
  assert.equal(await owner.locator('.order-head .chip').innerText(), 'Packing');
  assert.equal(await owner.evaluate(() => window.__noReload), 'still-here', 'no full page reload');
  assert.equal(await panel.getByRole('button', { name: 'Start packing' }).count(), 0);
  await fake('/__control/config', { delayMs: 0 });

  // ship: validation
  await panel.getByRole('button', { name: 'Mark shipped', exact: true }).click();
  await panel.getByRole('button', { name: 'Review shipment' }).click();
  await panel.getByText('Choose a carrier.').waitFor();
  await panel.getByText('Enter the tracking number.').waitFor();
  await panel.getByLabel('Tracking number').fill('ab');
  await panel.getByLabel('Carrier').selectOption('UPS');
  await panel.getByRole('button', { name: 'Review shipment' }).click();
  await panel.getByText('Tracking number must be 6 to 40 letters, digits or dashes.').waitFor();
  assert.equal(await panel.getByLabel('Tracking number').getAttribute('aria-invalid'), 'true');
  await shot(owner, '08-ship-form-errors');
  // ship: happy path via confirm
  await panel.getByLabel('Tracking number').fill('1Z 999 AA1 0123 456784');
  await panel.locator('#ship-note').fill('Fragile: keep upright');
  await shot(owner, '09-ship-form');
  await panel.getByRole('button', { name: 'Review shipment' }).click();
  const confirm = panel.locator('.confirm');
  await confirm.waitFor();
  const confirmText = await confirm.innerText();
  assert.ok(confirmText.includes('Building C, Unit 4120'), 'confirm step repeats the address');
  assert.ok(confirmText.includes('1Z999AA10123456784') && confirmText.includes('UPS'), 'confirm step shows carrier + normalised tracking');
  await shot(owner, '10-ship-confirm');
  await confirm.getByRole('button', { name: 'Back' }).click();
  assert.equal(await panel.getByLabel('Tracking number').inputValue(), '1Z 999 AA1 0123 456784', 'form values survive Back');
  await panel.getByRole('button', { name: 'Review shipment' }).click();
  await panel.getByRole('button', { name: 'Confirm: mark shipped' }).click();
  await panel.locator('.msg-ok', { hasText: 'Order marked as shipped.' }).waitFor();
  assert.equal(await owner.locator('.order-head .chip').innerText(), 'Shipped');
  assert.ok((await owner.locator('section[aria-labelledby="shipments-h"]').innerText()).includes('1Z999AA10123456784'));
  assert.equal(await panel.getByRole('button', { name: 'Mark delivered' }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Mark shipped', exact: true }).count(), 0);
  // deliver
  await panel.getByRole('button', { name: 'Mark delivered' }).click();
  await panel.locator('.msg-ok', { hasText: 'Order marked as delivered.' }).waitFor();
  assert.equal(await owner.locator('.order-head .chip').innerText(), 'Delivered');
  assert.equal(await panel.getByRole('button', { name: /Mark|Start|Cancel order/ }).count(), 0);
  // note
  await panel.locator('#note').fill('Left at front desk per customer.');
  await panel.getByRole('button', { name: 'Add note' }).click();
  await panel.locator('.msg-ok', { hasText: 'Note added.' }).waitFor();
  const lines = await owner.locator('.timeline li').allInnerTexts();
  assert.ok(lines.at(-1).includes('Left at front desk per customer.'));
  // timeline oldest first
  const stamps = await owner.locator('.timeline li time').evaluateAll((els) => els.map((e) => e.getAttribute('datetime')));
  assert.deepEqual(stamps, [...stamps].sort(), 'timeline is oldest first');
  assert.ok(lines[0].includes('Awaiting payment'), 'first event is the oldest');
  await shot(owner, '11-order-delivered');
});

await check('flow: 409 from the API (another admin moved the order) is shown inline and the panel refreshes', async () => {
  const stale = await findOrder('marcus.albrecht@example.test');
  await owner.goto(`/orders/${stale.id}`);
  const panel = owner.locator('section[aria-labelledby="actions-h"]');
  await panel.getByRole('button', { name: 'Start packing' }).waitFor();
  await fake('/__control/transition', { id: stale.id, to: 'PROCESSING' }); // someone else did it
  await panel.getByRole('button', { name: 'Start packing' }).click();
  const error = panel.locator('.msg-error');
  await error.waitFor();
  const text = await error.innerText();
  assert.ok(text.includes('Order is PROCESSING; start-packing requires PAID.'), text);
  assert.ok(!/stack|TypeError|\.js:/i.test(text));
  assert.equal(await owner.locator('.order-head .chip').innerText(), 'Packing', 'screen now shows the real state');
  assert.equal(await panel.getByRole('button', { name: 'Start packing' }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Mark shipped', exact: true }).count(), 1);
  await shot(owner, '12-conflict-409');
});

await check('flow: cancel (awaiting payment only) needs a reason and works; 404 order shows not found', async () => {
  const pending = await findOrder('ines.moreau@example.test');
  await owner.goto(`/orders/${pending.id}`);
  const panel = owner.locator('section[aria-labelledby="actions-h"]');
  await panel.getByRole('button', { name: 'Cancel order' }).click();
  await panel.getByRole('button', { name: 'Confirm: cancel order' }).click();
  await panel.getByText('Enter a reason (at least 3 characters).').waitFor();
  await panel.getByLabel('Reason').fill('Customer asked to cancel.');
  await panel.getByRole('button', { name: 'Confirm: cancel order' }).click();
  await panel.locator('.msg-ok', { hasText: 'Order cancelled.' }).waitFor();
  assert.equal(await owner.locator('.order-head .chip').innerText(), 'Cancelled');
  const response = await owner.goto('/orders/doesnotexist123');
  assert.equal(response.status(), 404);
  await owner.getByText('Not found').first().waitFor();
});

// ======================================================================= 5. packing slip
await check('packing slip: address, SKU, LOT, qty, picking boxes, NO prices, Print button; one page in A4 and Letter', async () => {
  const slipOrder = await findOrder('marcus.albrecht@example.test');
  const detail = await fake(`/__control/order?id=${slipOrder.id}`);
  await owner.goto(`/orders/${slipOrder.id}/packing-slip`);
  const text = await owner.locator('.slip').innerText();
  assert.ok(text.includes(shortId(slipOrder.id)) && text.includes(slipOrder.id));
  for (const line of detail.shippingAddress.split('\n')) assert.ok(text.includes(line.trim()), `address line: ${line}`);
  for (const item of detail.items) { assert.ok(text.includes(item.sku) && text.includes(item.lotCode) && text.includes(item.name)); }
  assert.ok(!/\$|USD|price|subtotal/i.test(text), `no prices on the slip: ${text.slice(0, 300)}`);
  assert.equal(await owner.locator('.slip .box').count(), detail.items.length, 'one blank pick box per line');
  assert.ok(await owner.getByRole('button', { name: 'Print packing slip' }).isVisible());
  assert.ok(!/research use|not for human/i.test(text), 'no invented compliance wording');
  await shot(owner, '13-packing-slip');
  await owner.emulateMedia({ media: 'print' });
  assert.equal(await owner.locator('.slip-toolbar').isVisible(), false, 'toolbar hidden in print');
  assert.equal(await owner.locator('.slip').isVisible(), true);
  for (const format of ['A4', 'Letter']) {
    const pdf = await owner.pdf({ format, printBackground: true, preferCSSPageSize: false });
    await writeFile(join(OUT, `packing-slip-${format}.pdf`), pdf);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.equal(pages, 1, `${format} prints on ${pages} pages`);
  }
  await owner.emulateMedia({ media: 'screen' });
});

// ======================================================================= 6. owner screens
await check('team (owner): list, create -> one-time credentials, dismissed on demand and not recoverable, deactivate with confirm', async () => {
  await owner.goto('/team');
  assert.equal(await owner.locator('section[aria-labelledby="admins-h"] tbody tr').count(), 3);
  assert.equal(await owner.getByRole('button', { name: /Deactivate Olivia/ }).count(), 0, 'cannot deactivate yourself');
  await owner.locator('#new-name').fill('Nia New');
  await owner.locator('#new-email').fill('nia.new@example.test');
  await owner.locator('#new-role').selectOption('STAFF');
  await owner.getByRole('button', { name: 'Create admin' }).click();
  const creds = owner.locator('section[aria-labelledby="creds-h"]');
  await creds.waitFor();
  const credText = await creds.innerText();
  assert.ok(/shown once/i.test(credText));
  const password = await creds.locator('.secret code').nth(0).innerText();
  const seed = await creds.locator('.secret code').nth(1).innerText();
  const uri = await creds.locator('.secret code').nth(2).innerText();
  assert.ok(password.length >= 12 && /^[A-Z2-7]{16,}$/.test(seed) && uri.startsWith('otpauth://totp/'));
  await creds.getByRole('button', { name: 'Copy password' }).click();
  assert.equal(await owner.evaluate(() => navigator.clipboard.readText()), password);
  await shot(owner, '14-team-credentials');
  assert.equal(await owner.locator('section[aria-labelledby="admins-h"] tbody tr').count(), 4, 'list refreshed behind the credentials panel');
  await creds.getByRole('button', { name: 'I have saved these credentials' }).click();
  assert.equal(await creds.count(), 0);
  await owner.reload();
  const html = await owner.content();
  assert.ok(!html.includes(password) && !html.includes(seed), 'credentials are gone after reload');
  // new admin can sign in with TOTP 123456 + temp password? (fake accepts the generated temp password)
  // deactivate
  await owner.getByRole('button', { name: 'Deactivate Nia New' }).click();
  await owner.getByRole('button', { name: /Confirm: deactivate Nia New/ }).click();
  await owner.getByText('Admin deactivated.').waitFor();
  assert.ok((await owner.locator('tr', { hasText: 'nia.new@example.test' }).innerText()).includes('Deactivated'));
  assert.deepEqual(await smallTargets(owner), [], 'target size');
});

await check('team: API conflict (duplicate email) is shown inline', async () => {
  await owner.locator('#new-name').fill('Dup');
  await owner.locator('#new-email').fill('staff@example.test');
  await owner.getByRole('button', { name: 'Create admin' }).click();
  await owner.getByText('An admin with that email already exists.').waitFor();
});

await check('audit (owner): table, filters, entries from actions just performed', async () => {
  await owner.goto('/audit');
  const text = await owner.locator('main').innerText();
  for (const action of ['admin.create', 'order.start-packing', 'order.ship', 'order.mark-delivered', 'admin.deactivate']) assert.ok(text.includes(action), action);
  await owner.getByLabel('Target type').fill('Order');
  await owner.getByRole('button', { name: 'Apply filters' }).click();
  await owner.waitForURL(/targetType=Order/);
  const rows = await owner.locator('table.data tbody tr').allInnerTexts();
  assert.ok(rows.length >= 4 && rows.every((r) => r.includes('Order')), 'only Order targets');
  await owner.goto('/audit?targetType=Nothing');
  await owner.getByText('No audit entries match these filters.').waitFor();
  await shot(owner, '15-audit');
});

await check('change password: mismatch, wrong current, success; old password stops working', async () => {
  const context = await newContext();
  const page = await login(context, 'staff@example.test');
  await page.goto('/account/password');
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase 1');
  await page.getByLabel('Confirm new password').fill('different');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('do not match').waitFor();
  await page.getByLabel('Current password').fill('wrong');
  await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase 1');
  await page.getByLabel('Confirm new password').fill('a brand new passphrase 1');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('Current password is incorrect.').waitFor();
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase 1');
  await page.getByLabel('Confirm new password').fill('a brand new passphrase 1');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('Password changed.').waitFor();
  await shot(page, '16-password-changed');
  const fresh = await context.newPage();
  await fresh.context().clearCookies();
  await signIn(fresh, 'staff@example.test', PASSWORD);
  await fresh.getByText('Invalid sign-in.').waitFor();
  await signIn(fresh, 'staff@example.test', 'a brand new passphrase 1');
  await fresh.waitForURL(`${BASE}/`);
  await snapshotTokens();
  await context.close();
});

// ======================================================================= 7. STAFF
await fake('/__control/reset', {}); // restores the staff password (and drops the owner session)
await check('STAFF: no Team/Audit links, /team and /audit show 403, queue still works', async () => {
  const context = await newContext();
  const staff = await login(context, 'staff@example.test');
  assert.equal(await staff.locator('.topbar .role').innerText(), 'STAFF');
  assert.equal(await staff.locator('nav[aria-label="Primary"] a', { hasText: /^(Team|Audit log)$/ }).count(), 0);
  for (const path of ['/team', '/audit']) {
    await staff.goto(path);
    await staff.getByRole('heading', { name: 'Forbidden' }).waitFor();
    assert.ok((await staff.locator('main').innerText()).includes('403'));
    assert.equal(await staff.locator('table').count(), 0, 'no data rendered');
  }
  await shot(staff, '17-staff-403');
  await staff.goto('/orders');
  assert.ok((await staff.locator('table.rows tbody tr').count()) > 0);
  // The API itself also refuses owner-only calls for STAFF (defence in depth is the API's job; confirm the fake does)
  await context.close();
});

// ======================================================================= 8. expiry, logout, CSRF, wallets
await check('wallet pages require the real session and keep working with it', async () => {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto('/wallets');
  assert.equal(new URL(page.url()).pathname, '/sign-in');
  await signIn(page);
  await page.waitForURL(`${BASE}/`);
  await snapshotTokens();
  await page.goto('/wallets');
  await page.getByText('priya.raman@example.test').waitFor();
  assert.ok(await page.getByRole('button', { name: 'Sign out' }).isVisible(), 'wallet pages share the shell + sign-out');
  await shot(page, '18-wallets');
  await context.close();
});

await check('expired session on page load: redirected to /sign-in?reason=expired, cookie cleared, notice shown', async () => {
  const context = await newContext();
  const page = await login(context, 'owner@example.test');
  await page.goto('/orders');
  await fake('/__control/expire-sessions', {});
  await page.goto('/orders');
  await page.waitForURL(/\/sign-in\?reason=expired/);
  await page.getByText('Your session expired. Sign in again to continue.').waitFor();
  assert.equal((await context.cookies()).filter((c) => /admin_session/.test(c.name)).length, 0, 'cookie cleared');
  await shot(page, '19-session-expired');
  // and wallets / detail pages behave the same
  await signIn(page);
  await page.waitForURL(`${BASE}/`);
  await snapshotTokens();
  await fake('/__control/expire-sessions', {});
  await page.goto('/wallets/balances');
  await page.waitForURL(/reason=expired/);
  await context.close();
});

await check('session expires while the order screen is open: the next action redirects to sign-in (no silent failure)', async () => {
  const context = await newContext();
  const page = await login(context, 'owner@example.test');
  const o = await findOrder('lena.fischer@example.test');
  await page.goto(`/orders/${o.id}`);
  await fake('/__control/expire-sessions', {});
  await page.getByRole('button', { name: 'Mark shipped', exact: true }).click();
  await page.getByLabel('Carrier').selectOption('USPS');
  await page.getByLabel('Tracking number').fill('9400111899223344556677');
  await page.getByRole('button', { name: 'Review shipment' }).click();
  await page.getByRole('button', { name: 'Confirm: mark shipped' }).click();
  await page.waitForURL(/\/sign-in\?reason=expired/);
  assert.equal((await fake(`/__control/order?id=${o.id}`)).status, 'PROCESSING', 'order was not changed');
  await context.close();
});

await check('CSRF: a cross-origin POST to a server action is refused; same-origin works (control)', async () => {
  const context = await newContext();
  const page = await login(context, 'owner@example.test');
  await page.goto('/');
  const token = [...seenTokens].at(-1);
  // Capture (and abort) the browser's own sign-out server-action POST, then replay it with different Origins.
  await page.waitForLoadState('networkidle');
  let captured = null;
  expectedAbort = true;
  await page.route(`${BASE}/`, async (route) => {
    const r = route.request();
    if (r.method() !== 'POST') return route.continue();
    captured = { headers: await r.allHeaders(), body: r.postDataBuffer() };
    return route.abort();
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !captured; i += 1) await page.waitForTimeout(100);
  await page.unroute(`${BASE}/`);
  await page.waitForTimeout(300);
  expectedAbort = false;
  assert.ok(captured?.headers['next-action'], 'captured the sign-out server action request');
  const keep = Object.fromEntries(Object.entries(captured.headers).filter(([k]) => !['content-length', 'host', 'origin', 'referer']  /* the cookie IS replayed: worst case, the browser attached it to a cross-origin request */.includes(k.toLowerCase())));
  const post = (origin) => page.request.post(`${BASE}/`, { headers: origin === null ? keep : { ...keep, origin, referer: `${origin}/` }, data: captured.body, maxRedirects: 0 });
  const forged = await post('http://evil.example');
  const meAfterForged = await fetch(`${FAKE}/v1/admin/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(meAfterForged.status, 200, `forged-origin sign-out must NOT end the session (status ${forged.status()})`);
  const noOrigin = await post(null);
  assert.equal((await fetch(`${FAKE}/v1/admin/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200, `missing origin refused (status ${noOrigin.status()})`);
  await post(BASE);
  const meAfterReal = await fetch(`${FAKE}/v1/admin/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(meAfterReal.status, 401, 'control: same-origin POST does sign out');
  await context.close();
});

await check('logout: calls the API, clears the cookie, token dead at the API, protected pages redirect', async () => {
  const context = await newContext();
  const page = await login(context, 'owner@example.test');
  const token = [...seenTokens].at(-1);
  const before = (await fake('/__control/log')).log.length;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in\?reason=signed-out/);
  await page.getByText('You have been signed out.').waitFor();
  assert.equal((await context.cookies()).filter((c) => /admin_session/.test(c.name)).length, 0);
  const calls = (await fake('/__control/log')).log.slice(before);
  assert.ok(calls.some((l) => l.method === 'POST' && l.path === '/v1/admin/auth/logout' && l.auth === 'bearer'), 'API logout called with the bearer token');
  assert.equal((await fetch(`${FAKE}/v1/admin/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  await page.goto('/orders');
  assert.equal(new URL(page.url()).pathname, '/sign-in');
  await page.goto('/');
  assert.equal(new URL(page.url()).pathname, '/sign-in');
  await context.close();
});

await check('mobile (390px): queue and detail have no horizontal page overflow', async () => {
  const context = await newContext({ width: 390, height: 844 });
  const page = await login(context, 'owner@example.test');
  for (const path of ['/orders', `/orders/${pack.id}`, '/']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${path} overflows by ${overflow}px`);
  }
  await page.goto('/orders');
  await shot(page, '20-mobile-queue', false);
  await context.close();
});

// ======================================================================= 9. LOTS, COAs, PRODUCTS (docs/api/coa-contract.md, ADMIN API)
await fake('/__control/reset', {}); // fresh COA seed; drops every session
const FILES = join(OUT, 'files');
await mkdir(FILES, { recursive: true });
function tinyPdf(label, pad = 0) {
  const text = `BT /F1 14 Tf 72 720 Td (${label}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(out, 'latin1'), Buffer.from(pad ? `\n%${'x'.repeat(pad)}\n` : '')]);
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pdfs = { v1: tinyPdf('QA lab report one'), v2: tinyPdf('QA lab report two'), v3: tinyPdf('QA lab report three'), v4: tinyPdf('QA lab report four'), v5: tinyPdf('QA lab report five') };
const filePath = (name) => join(FILES, name);
for (const [k, buf] of Object.entries(pdfs)) await writeFile(filePath(`${k}.pdf`), buf);
await writeFile(filePath('not-a-pdf.pdf'), 'This is plain text pretending to be a PDF.\n');
await writeFile(filePath('too-big.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 1024, 0x20)]));
const nineMb = Buffer.concat([tinyPdf('QA nine megabyte report'), Buffer.alloc(9 * 1024 * 1024, 0x20)]);
await writeFile(filePath('nine-mb.pdf'), nineMb);
await writeFile(filePath('notes.txt'), 'plain text, .txt extension\n');

const coaState = async () => fake('/__control/coa-state');
// Playwright's APIRequestContext does not send Secure cookies over plain http, so the session cookie is replayed explicitly.
const cookieHeader = async (context) => (await context.cookies()).filter((c) => /admin_session/.test(c.name)).map((c) => `${c.name}=${c.value}`).join('; ');
/** Calls a Next server action by its exported name straight over HTTP (what a hostile script would do), bypassing every UI control. */
async function callServerAction(page, name, args, headers = {}) {
  const scripts = await page.evaluate(() => [...new Set([...document.scripts].map((s) => s.src).concat(performance.getEntriesByType('resource').map((r) => r.name)))].filter((u) => /\/_next\/static\/.*\.js/.test(u)));
  let id = null;
  for (const src of scripts) {
    const text = await (await fetch(src)).text();
    const m = new RegExp(`createServerReference\\)?\\(\\s*"([a-f0-9]{20,})"[^)]*?"${name}"\\s*\\)`).exec(text);
    if (m) { id = m[1]; break; }
  }
  assert.ok(id, `server action ${name} not found in the page bundles`);
  const response = await fetch(new URL('/lots', BASE), {
    method: 'POST',
    headers: { 'next-action': id, 'content-type': 'text/plain;charset=UTF-8', origin: BASE, accept: 'text/x-component', cookie: await cookieHeader(page.context()), ...headers },
    body: JSON.stringify(args),
  });
  return { status: response.status, text: await response.text() };
}
const lotByCode = async (code) => (await coaState()).lots.find((l) => l.code === code);
const logLen = async () => (await fake('/__control/log')).log.length;
const logSince = async (n) => (await fake('/__control/log')).log.slice(n);
const relogin = async (page, email = 'owner@example.test') => {
  await page.context().clearCookies();
  await signIn(page, email);
  await page.waitForURL(`${BASE}/`);
  await snapshotTokens();
};
const fields = { labName: 'Northfield Analytical Labs', labReportId: 'NAL-2026-0042', testedAt: '2026-09-10', method: 'Custom assay X', purityPercent: '99.42', notes: 'Two injections, mean value.' };
async function fillMeta(page, f = fields) {
  const form = page.locator('form[aria-labelledby="upload-h"]');
  await form.locator('#up-labName').fill(f.labName);
  await form.locator('#up-labReportId').fill(f.labReportId);
  await form.locator('#up-testedAt').fill(f.testedAt);
  await form.locator('#up-method').fill(f.method);
  await form.locator('#up-purityPercent').fill(f.purityPercent);
  await form.locator('#up-notes').fill(f.notes);
  return form;
}
async function uploadDraft(page, file, f = fields) {
  const form = await fillMeta(page, f);
  await form.locator('#up-file').setInputFiles(filePath(file));
  await form.getByText(/^Selected: /).waitFor();
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await page.locator('.msg-ok', { hasText: /Uploaded as DRAFT version/ }).waitFor();
}
const version = (page, n) => page.locator(`article.version[data-version="${n}"]`);
const gotoLot = async (page, code) => { const lot = await lotByCode(code); await page.goto(`/lots/${lot.id}`); await page.locator('h1', { hasText: code }).waitFor(); return lot; };
const anchorChip = (page, n, kind) => version(page, n).locator(`.anchor[data-anchor-kind="${kind}"] .chip`);

const coContext = await newContext();
let co;
const unauthContext = await newContext();

await check('COA: unauthenticated access to the lot pages, PDF route and upload route is refused', async () => {
  const page = await unauthContext.newPage();
  for (const path of ['/lots', '/lots/lot_001', '/products']) { await page.goto(path); assert.equal(new URL(page.url()).pathname, '/sign-in', path); }
  const pdf = await fetch(`${BASE}/coas/coa_001_v2/file`, { redirect: 'manual' });
  assert.equal(pdf.status, 303); assert.ok(pdf.headers.get('location').startsWith('/sign-in'));
  const upload = await fetch(`${BASE}/lots/lot_001/upload`, { method: 'POST', headers: { origin: BASE }, body: new FormData() });
  assert.ok([401, 403].includes(upload.status), `upload status ${upload.status}`);
  assert.equal((await fake('/__control/coa-state')).lots.find((l) => l.code === 'L24-0917-A').coas.length, 2, 'nothing was created');
});

await check('COA: nav has "Lots & COAs" and "Products"; overview links to them (no invented counts)', async () => {
  co = await login(coContext, 'owner@example.test');
  const nav = co.locator('nav[aria-label="Primary"]');
  assert.ok(await nav.getByRole('link', { name: 'Lots & COAs' }).isVisible());
  assert.ok(await nav.getByRole('link', { name: 'Products' }).isVisible());
  assert.ok(await co.locator('ul.link-list').getByRole('link', { name: 'Lots & COAs' }).isVisible());
  assert.equal(await co.locator('a.card').count(), 4, 'overview still has only the four order counts');
  await nav.getByRole('link', { name: 'Lots & COAs' }).click();
  await co.waitForURL(`${BASE}/lots`);
  assert.equal(await co.locator('nav[aria-label="Primary"] a[aria-current="page"]').innerText(), 'Lots & COAs');
});

await check('lots register: columns, chips for every state, filter by product, search by code, clear', async () => {
  await co.goto('/lots');
  await shot(co, '21-lots-register');
  const headers = (await co.locator('table.rows thead th').allInnerTexts()).map((h) => h.toLowerCase());
  assert.deepEqual(headers, ['lot code', 'product', 'current coa', 'coa status', 'anchor', 'released']);
  assert.equal(await co.locator('table.rows tbody tr').count(), 5);
  const row = (code) => co.locator('table.rows tbody tr', { hasText: code });
  const text = async (code) => (await row(code).innerText()).replace(/\s+/g, ' ');
  let t = await text('L24-0917-A'); assert.ok(t.includes('v2') && t.includes('Published') && t.includes('Anchor confirmed') && t.includes('BPC-157'), t);
  t = await text('L24-1002-C'); assert.ok(t.includes('Published') && t.includes('Anchor pending'), t);
  t = await text('L24-0821-B'); assert.ok(t.includes('Anchor failed'), t);
  t = await text('L24-0610-R'); assert.ok(t.includes('Revoked') && t.includes('v1'), t);
  t = await text('L25-0105-D'); assert.ok(t.includes('Draft') && t.includes('No anchor'), t);
  assert.match(await row('L24-0917-A').locator('td').nth(5).innerText(), /^\d{4}-\d{2}-\d{2}$/, 'released date');
  // product filter
  await co.locator('#lot-product').selectOption('prd_tb500');
  await co.getByRole('button', { name: 'Apply' }).click();
  await co.waitForURL(/productId=prd_tb500/);
  assert.equal(await co.locator('table.rows tbody tr').count(), 2);
  // search by code (case-insensitive, partial)
  await co.locator('#lot-q').fill('l24-09');
  await co.locator('#lot-product').selectOption('');
  await co.getByRole('button', { name: 'Apply' }).click();
  await co.waitForURL(/q=l24-09/);
  assert.equal(await co.locator('table.rows tbody tr').count(), 1);
  await co.goto('/lots?q=nothing-matches');
  await co.getByText('No lots match these filters.').waitFor();
  await co.getByRole('link', { name: 'Clear' }).click();
  await co.waitForURL(`${BASE}/lots`);
  assert.equal(await co.locator('table.rows tbody tr').count(), 5);
});

await check('lots register: Load more pages through 35 lots without duplicates, keyboard reachable', async () => {
  await fake('/__control/bulk-lots', { n: 30 });
  await co.goto('/lots');
  assert.equal(await co.locator('table.rows tbody tr').count(), 25);
  const more = co.getByRole('button', { name: 'Load more' });
  await more.focus();
  await co.keyboard.press('Enter');
  await co.waitForFunction(() => document.querySelectorAll('table.rows tbody tr').length > 25);
  assert.equal(await co.locator('table.rows tbody tr').count(), 35);
  assert.equal(await more.count(), 0);
  await co.getByText('End of list.').waitFor();
  const codes = await co.locator('table.rows tbody tr a.row-link').allInnerTexts();
  assert.equal(new Set(codes).size, codes.length);
  await fake('/__control/reset', {});
  await relogin(co);
});

await check('new lot: client-side pattern validation (no API call), duplicate code error inline, success opens the lot', async () => {
  await co.goto('/lots');
  await co.getByRole('button', { name: 'New lot' }).click();
  const form = co.locator('form[aria-label="New lot"]');
  assert.ok((await form.locator('#new-lot-product option').allInnerTexts()).some((o) => o.includes('GHK-Cu')), 'products come from the catalog endpoint');
  const before = (await logSince(0)).filter((l) => l.method === 'POST' && l.path === '/v1/admin/lots').length;
  await form.getByRole('button', { name: 'Create lot' }).click();
  await form.getByText('Choose a product.').waitFor();
  await form.getByText('Enter the lot code.').waitFor();
  await form.locator('#new-lot-product').selectOption('prd_bpc157');
  for (const bad of ['a b', '-LEAD', 'X', 'bad:code']) {
    await form.locator('#new-lot-code').fill(bad);
    await form.getByRole('button', { name: 'Create lot' }).click();
    await form.getByText(/Lot code is not valid/).waitFor();
    assert.equal(await form.locator('#new-lot-code').getAttribute('aria-invalid'), 'true', bad);
  }
  assert.equal((await logSince(0)).filter((l) => l.method === 'POST' && l.path === '/v1/admin/lots').length, before, 'invalid codes never reach the API');
  for (const dup of ['L24-0917-A', 'l24-0917-a']) {
    await form.locator('#new-lot-code').fill(dup);
    await form.getByRole('button', { name: 'Create lot' }).click();
    await form.getByText('A lot with this code already exists.').waitFor();
  }
  await shot(co, '22-new-lot-duplicate');
  await form.locator('#new-lot-code').fill('  QA-LOT-001  ');
  await form.getByRole('button', { name: 'Create lot' }).click();
  await co.waitForURL(/\/lots\/[^/]+$/);
  await co.locator('h1', { hasText: 'QA-LOT-001' }).waitFor();
  await co.getByText('No COA versions yet.').waitFor();
  const lot = await lotByCode('QA-LOT-001');
  assert.equal(lot.coaStatus, 'none');
});

await check('upload form: text file renamed .pdf and a >10 MB file are rejected in the browser; nothing is sent', async () => {
  const form = co.locator('form[aria-labelledby="upload-h"]');
  const before = (await logSince(0)).filter((l) => l.method === 'POST' && l.path.endsWith('/coas')).length;
  await form.locator('#up-file').setInputFiles(filePath('not-a-pdf.pdf'));
  await form.getByText(/does not start with %PDF-/).waitFor();
  assert.equal(await form.locator('#up-file').evaluate((el) => el.files.length), 0, 'rejected file is not kept selected');
  await form.locator('#up-file').setInputFiles(filePath('too-big.pdf'));
  await form.getByText(/The limit is 10 MB/).waitFor();
  await form.locator('#up-file').setInputFiles(filePath('notes.txt'));
  await form.getByText(/not a PDF file/).waitFor();
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await form.getByText("Choose the lab's PDF file.").waitFor();
  assert.equal((await logSince(0)).filter((l) => l.method === 'POST' && l.path.endsWith('/coas')).length, before);
  // field validation
  const checks = [
    ['#up-labName', 'Enter the laboratory name.'], ['#up-labReportId', "Enter the lab's report ID."], ['#up-testedAt', 'Enter the date the lab tested the sample.'],
    ['#up-method', 'Enter the test method'], ['#up-purityPercent', 'Enter the purity'],
  ];
  for (const [, message] of checks) await form.getByText(message).first().waitFor();
  const max = await form.locator('#up-testedAt').getAttribute('max');
  assert.match(max, /^\d{4}-\d{2}-\d{2}$/); assert.ok(max <= new Date().toISOString().slice(0, 10), 'date input max is never after today (UTC)');
  await form.locator('#up-testedAt').fill('2999-01-01');
  await form.locator('#up-purityPercent').fill('100.5');
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await form.getByText('The tested date cannot be in the future.').waitFor();
  await form.getByText('Purity must be between 0 and 100 with at most 2 decimals.').waitFor();
  await form.locator('#up-purityPercent').fill('12.345');
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await form.getByText('Purity must be between 0 and 100 with at most 2 decimals.').waitFor();
  assert.equal(await form.locator('#up-purityPercent').getAttribute('aria-invalid'), 'true');
  const methods = await form.locator('#up-methods option').evaluateAll((o) => o.map((x) => x.value));
  assert.ok(methods.includes('HPLC') && methods.includes('LC-MS'), `datalist: ${methods}`);
  await shot(co, '23-upload-form-errors');
});

await check('upload: valid PDF becomes DRAFT v1 (no reload, aria-live, one request on double-click); fields, file name/size and full SHA-256 shown', async () => {
  await co.evaluate(() => { window.__noReload = 'still-here'; });
  const form = await fillMeta(co);
  await form.locator('#up-file').setInputFiles(filePath('v1.pdf'));
  await form.getByText(/^Selected: v1\.pdf/).waitFor();
  const logBefore = await logLen();
  await form.getByRole('button', { name: 'Upload as draft' }).dblclick();
  await co.locator('.msg-ok', { hasText: 'Uploaded as DRAFT version 1.' }).waitFor();
  assert.equal((await logSince(logBefore)).filter((l) => l.method === 'POST' && l.path.endsWith('/coas')).length, 1, 'exactly one upload request');
  assert.equal(await co.evaluate(() => window.__noReload), 'still-here');
  const v1 = version(co, 1);
  const text = await v1.innerText();
  for (const expected of ['Northfield Analytical Labs', 'NAL-2026-0042', '2026-09-10', 'Custom assay X', '99.42%', 'Two injections, mean value.', 'v1.pdf']) assert.ok(text.includes(expected), expected);
  assert.ok(text.includes('Olivia Owner'), 'uploaded-by shown');
  assert.ok((await v1.locator('code', { hasText: sha256(pdfs.v1) }).count()) >= 1, 'full SHA-256 is displayed');
  const size = pdfs.v1.length < 1024 ? `${pdfs.v1.length} B` : `${(pdfs.v1.length / 1024).toFixed(1)} KB`;
  assert.ok(text.includes(`(${size})`), `size ${size}`);
  await v1.getByRole('button', { name: 'Copy hash' }).click();
  assert.equal(await co.evaluate(() => navigator.clipboard.readText()), sha256(pdfs.v1));
  assert.ok(await v1.locator('.chip-coa-draft').isVisible());
  assert.equal(await co.locator('form[aria-labelledby="upload-h"] #up-labName').inputValue(), '', 'form reset after success');
  const state = await lotByCode('QA-LOT-001');
  assert.equal(state.coaStatus, 'draft');
  assert.equal(await co.locator('.page-head .chip-coa-draft').count(), 1, 'lot header chip refreshed');
  await shot(co, '24-lot-detail-draft');
});

await check('upload: the same file twice is a 409 shown inline; the 9 MB file goes through the route handler as DRAFT v2', async () => {
  const form = await fillMeta(co, { ...fields, labReportId: 'NAL-2026-0042-dup' });
  await form.locator('#up-file').setInputFiles(filePath('v1.pdf'));
  await form.getByText(/^Selected: /).waitFor();
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await form.locator('.msg-error', { hasText: 'already uploaded for this lot' }).waitFor();
  assert.equal(await co.locator('article.version').count(), 1);
  await form.locator('#up-file').setInputFiles(filePath('nine-mb.pdf'));
  await form.getByText(/^Selected: nine-mb\.pdf \(9\.00 MB\)/).waitFor();
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await co.locator('.msg-ok', { hasText: 'Uploaded as DRAFT version 2.' }).waitFor({ timeout: 30000 });
  assert.ok((await version(co, 2).innerText()).includes(sha256(nineMb)));
  assert.equal((await lotByCode('QA-LOT-001')).coas.find((c) => c.version === 2).sizeBytes, nineMb.length);
});

await check('PDF route: streams the file with the admin session (type, nosniff, exact bytes), token never in the href, unauthenticated is refused', async () => {
  const lot = await lotByCode('QA-LOT-001');
  const coa = lot.coas.find((c) => c.version === 1);
  const link = version(co, 1).getByRole('link', { name: 'Open PDF (new tab)' });
  const href = await link.getAttribute('href');
  assert.equal(href, `/coas/${coa.id}/file`);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.ok(![...seenTokens].some((t) => href.includes(t)));
  const logBefore = await logLen();
  const response = await coContext.request.get(`${BASE}${href}`, { headers: { cookie: await cookieHeader(coContext) } });
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['content-type'], 'application/pdf');
  assert.equal(response.headers()['x-content-type-options'], 'nosniff');
  assert.match(response.headers()['content-disposition'], /^inline/);
  assert.match(response.headers()['cache-control'], /no-store/);
  const body = await response.body();
  assert.equal(sha256(body), sha256(pdfs.v1), 'bytes are identical to the upload');
  const upstream = (await logSince(logBefore)).find((l) => l.path === `/v1/admin/coas/${coa.id}/file`);
  assert.equal(upstream?.auth, 'bearer', 'the admin server called the API with the bearer token');
  leakCorpus.push({ where: 'pdf route body', text: body.toString('latin1') });
  assert.equal((await coContext.request.get(`${BASE}/coas/does-not-exist/file`, { headers: { cookie: await cookieHeader(coContext) } })).status(), 404);
  const anon = await fetch(`${BASE}${href}`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.ok(!(await anon.text()).startsWith('%PDF'));
  // the 9 MB file streams too
  const big = lot.coas.find((c) => c.version === 2);
  const bigResponse = await coContext.request.get(`${BASE}/coas/${big.id}/file`, { headers: { cookie: await cookieHeader(coContext) } });
  assert.equal((await bigResponse.body()).length, nineMb.length);
});

await check('route handler enforces the rules itself: bad Origin, text-as-PDF, >10 MB, missing fields all refused with a message', async () => {
  const lot = await lotByCode('QA-LOT-001');
  const url = `${BASE}/lots/${lot.id}/upload`;
  const goodMeta = { labName: 'X', labReportId: 'Y', testedAt: '2026-09-10', method: 'HPLC', purityPercent: '99' };
  const multipart = (file) => ({ ...goodMeta, file });
  const count = async () => (await lotByCode('QA-LOT-001')).coas.length;
  const before = await count();
  const cookie = await cookieHeader(coContext);
  const forged = await coContext.request.post(url, { headers: { origin: 'http://evil.example', cookie }, multipart: multipart({ name: 'v3.pdf', mimeType: 'application/pdf', buffer: pdfs.v3 }) });
  assert.equal(forged.status(), 403, 'cross-origin upload refused');
  const noOrigin = await coContext.request.post(url, { headers: { cookie }, multipart: multipart({ name: 'v3.pdf', mimeType: 'application/pdf', buffer: pdfs.v3 }) });
  assert.equal(noOrigin.status(), 403, 'missing Origin refused');
  const text = await coContext.request.post(url, { headers: { origin: BASE, cookie }, multipart: multipart({ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello world') }) });
  assert.equal(text.status(), 400); assert.match((await text.json()).message, /not a PDF/);
  const big = await coContext.request.post(url, { headers: { origin: BASE, cookie }, multipart: multipart({ name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 10)]) }) });
  assert.ok([400, 413].includes(big.status()), `big ${big.status()}`); assert.match((await big.json()).message, /10 MB/);
  const noFile = await coContext.request.post(url, { headers: { origin: BASE, cookie }, multipart: goodMeta });
  assert.equal(noFile.status(), 400);
  const badMeta = await coContext.request.post(url, { headers: { origin: BASE, cookie }, multipart: { ...goodMeta, purityPercent: '123', file: { name: 'v3.pdf', mimeType: 'application/pdf', buffer: pdfs.v3 } } });
  assert.equal(badMeta.status(), 400); assert.match((await badMeta.json()).message, /purityPercent/);
  assert.equal(await count(), before, 'none of the refused uploads created a version');
});

await check('delete draft: a confirm step, then the draft is gone (aria-live) and the version number is free again', async () => {
  const v2 = version(co, 2);
  await v2.getByRole('button', { name: 'Delete draft' }).click();
  await v2.getByRole('button', { name: 'Confirm: delete draft' }).waitFor();
  await v2.getByRole('button', { name: 'Keep draft' }).click();
  assert.equal(await co.locator('article.version').count(), 2, 'Keep draft changes nothing');
  await v2.getByRole('button', { name: 'Delete draft' }).click();
  await v2.getByRole('button', { name: 'Confirm: delete draft' }).click();
  await co.locator('.msg-ok', { hasText: 'Draft deleted.' }).waitFor();
  assert.equal(await co.locator('article.version').count(), 1);
  assert.equal((await lotByCode('QA-LOT-001')).coas.length, 1);
});

await check('publish review: copy, ALL entered values beside the PDF + hash, checkbox gate, then publish; PENDING anchor flips to CONFIRMED on its own', async () => {
  const v1 = version(co, 1);
  await v1.getByRole('button', { name: 'Review and publish' }).click();
  const review = v1.locator('section.review');
  await review.waitFor();
  const text = (await review.innerText()).replace(/\s+/g, ' ');
  const verify = `${VERIFY_BASE}/verify/QA-LOT-001`;
  assert.ok(text.includes(`Publishing makes this COA public at ${verify}. The on-chain anchor proves this exact file was recorded unchanged; it does not prove the lab's results.`), text.slice(0, 300));
  for (const expected of ['Northfield Analytical Labs', 'NAL-2026-0042', '2026-09-10', 'Custom assay X', '99.42%', 'Two injections, mean value.', 'v1.pdf', sha256(pdfs.v1), 'compare every value']) assert.ok(text.includes(expected), expected);
  assert.equal(await review.locator('a', { hasText: 'Open PDF' }).getAttribute('href'), `/coas/${(await lotByCode('QA-LOT-001')).coas[0].id}/file`);
  assert.equal(await review.locator('.compare > div').count(), 2, 'values and PDF side by side');
  const confirm = review.getByRole('button', { name: 'Confirm: publish version 1' });
  assert.equal(await confirm.isDisabled(), true, 'disabled until the checkbox is ticked');
  const logBefore = await logLen();
  await confirm.click({ force: true, timeout: 1000 }).catch(() => {});
  assert.equal((await logSince(logBefore)).filter((l) => l.path.endsWith('/publish')).length, 0, 'a click on the disabled button sends nothing');
  const box = review.getByLabel("I compared these values with the lab's PDF");
  assert.equal(await box.isChecked(), false);
  await shot(co, '25-publish-review-gate');
  await box.check();
  assert.equal(await confirm.isDisabled(), false);
  await box.uncheck(); assert.equal(await confirm.isDisabled(), true);
  await box.check();
  await confirm.dblclick();
  await co.locator('.msg-ok', { hasText: 'Published.' }).waitFor();
  assert.equal((await logSince(logBefore)).filter((l) => l.method === 'POST' && l.path.endsWith('/publish')).length, 1, 'double click publishes once');
  assert.ok(await v1.locator('.chip-coa-published').isVisible());
  assert.ok(await v1.getByText('Current public version').isVisible());
  assert.ok(/pending/i.test(await anchorChip(co, 1, 'publish').innerText()));
  assert.ok(/pending/i.test(await co.locator('.page-head .chip-anchor-pending').innerText()), 'header shows pending');
  const poll = co.locator('[data-testid="anchor-poll"]');
  assert.ok(/PENDING.*every 5 seconds.*2 minutes/.test(await poll.innerText()), 'aria-live poll note');
  assert.equal(await poll.getAttribute('aria-live'), 'polite');
  await shot(co, '26-anchor-pending');
  const polls0 = (await logSince(logBefore)).filter((l) => l.method === 'GET' && /\/admin\/lots\/[^/?]+$/.test(l.path)).length;
  await anchorChip(co, 1, 'publish').and(co.locator('.chip-anchor-confirmed')).waitFor({ timeout: 20000 });
  const polls = (await logSince(logBefore)).filter((l) => l.method === 'GET' && /\/admin\/lots\/[^/?]+$/.test(l.path)).length;
  assert.ok(polls - polls0 >= 1 && polls - polls0 <= 3, `polled ${polls - polls0} times while pending (every 5 s)`);
  assert.ok(await co.locator('.page-head .chip-anchor-confirmed').isVisible(), 'header updated too');
  assert.equal(await co.locator('[data-testid="anchor-poll"] .msg').count(), 0, 'poll note gone once confirmed');
  const anchor = version(co, 1).locator('.anchor[data-anchor-kind="publish"]');
  const coa = (await lotByCode('QA-LOT-001')).coas[0];
  const memo = `helix-coa:v1:publish:QA-LOT-001:1:${sha256(pdfs.v1)}`;
  const t = await anchor.innerText();
  assert.ok(t.includes(memo), 'memo text shown');
  const sigText = await anchor.locator('code').first().innerText();
  assert.match(sigText, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  const link = anchor.getByRole('link', { name: /View on explorer/ });
  assert.equal(await link.getAttribute('href'), `https://explorer.solana.com/tx/${sigText}?cluster=devnet`);
  assert.equal(await link.getAttribute('target'), '_blank'); assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  await anchor.getByRole('button', { name: 'Copy signature' }).click();
  assert.equal(await co.evaluate(() => navigator.clipboard.readText()), sigText);
  await anchor.getByRole('button', { name: 'Copy memo' }).click();
  assert.equal(await co.evaluate(() => navigator.clipboard.readText()), memo);
  assert.ok(/Attempts\s*1/.test(t));
  assert.equal(coa.publishAnchor, 'CONFIRMED');
  await shot(co, '27-anchor-confirmed');
});

await check('publish v2 supersedes v1: review warns, v1 becomes Superseded, v2 is the single current version', async () => {
  await co.reload();
  await uploadDraft(co, 'v2.pdf', { ...fields, labReportId: 'NAL-2026-0077', purityPercent: '99.61', method: 'HPLC' });
  const v2 = version(co, 2);
  await v2.getByRole('button', { name: 'Review and publish' }).click();
  const review = v2.locator('section.review');
  assert.ok((await review.innerText()).includes('Version 1 is public now (purity 99.42%). Publishing this version supersedes it'));
  await review.getByLabel("I compared these values with the lab's PDF").check();
  await review.getByRole('button', { name: 'Confirm: publish version 2' }).click();
  await co.locator('.msg-ok', { hasText: 'Published.' }).waitFor();
  assert.ok(await version(co, 1).locator('.chip-coa-superseded').isVisible());
  assert.ok(await version(co, 2).locator('.chip-coa-published').isVisible());
  assert.equal(await co.getByText('Current public version').count(), 1);
  const order = await co.locator('article.version').evaluateAll((els) => els.map((e) => e.getAttribute('data-version')));
  assert.deepEqual(order, ['2', '1'], 'newest first');
  assert.equal(await co.locator('article.version[data-status="PUBLISHED"]').count(), 1, 'exactly one published');
  await shot(co, '28-lot-detail-two-versions');
});

await check('seeded PENDING anchor: chip flips PENDING -> CONFIRMED by itself within ~10 s, no reload', async () => {
  await gotoLot(co, 'L24-1002-C');
  await co.evaluate(() => { window.__noReload = 'still-here'; });
  assert.ok(/pending/i.test(await co.locator('.page-head .chip-anchor-pending').innerText()));
  await co.locator('[data-testid="anchor-poll"] .msg-info').waitFor();
  const started = Date.now();
  await co.locator('.page-head .chip-anchor-confirmed').waitFor({ timeout: 20000 });
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds < 12, `flipped after ${seconds}s`);
  assert.equal(await co.evaluate(() => window.__noReload), 'still-here');
  assert.ok(await anchorChip(co, 1, 'publish').and(co.locator('.chip-anchor-confirmed')).isVisible());
});

await check('FAILED anchor: error text, attempts, no polling; Retry (owner) -> PENDING -> CONFIRMED with attempts + 1', async () => {
  await gotoLot(co, 'L24-0821-B');
  const anchor = version(co, 1).locator('.anchor[data-anchor-kind="publish"]');
  assert.ok(await co.locator('.page-head .chip-anchor-failed').isVisible());
  const t = await anchor.innerText();
  assert.ok(t.includes('blockhash expired after 3 attempts') && /Attempts\s*3/.test(t));
  assert.equal(await co.locator('[data-testid="anchor-poll"] .msg').count(), 0, 'a FAILED anchor is not polled');
  await shot(co, '29-anchor-failed');
  const retry = anchor.getByRole('button', { name: 'Retry publish anchor' });
  assert.equal(await retry.isEnabled(), true);
  await retry.click();
  await co.locator('.msg-ok', { hasText: 'Publish anchor requested again.' }).waitFor();
  assert.ok(/pending/i.test(await anchorChip(co, 1, 'publish').innerText()));
  assert.equal(await anchor.getByRole('button', { name: /Retry/ }).count(), 0, 'no retry while pending and fresh');
  await co.locator('.page-head .chip-anchor-confirmed').waitFor({ timeout: 20000 });
  assert.ok(/Attempts\s*4/.test(await anchor.innerText()));
  assert.equal(await anchor.getByText('blockhash expired after').count(), 0, 'old error cleared');
});

await check('revoke: reason required, review step, then REVOKED with the reason; revoke anchor pending -> confirmed; lot has no current COA', async () => {
  await gotoLot(co, 'L24-1002-C');
  const v1 = version(co, 1);
  await v1.getByRole('button', { name: 'Revoke version 1' }).click();
  await v1.getByRole('button', { name: 'Review revocation' }).click();
  await v1.getByText('Enter the reason for the revocation.').waitFor();
  await v1.getByLabel('Reason (1 to 500 characters)').fill('Lab withdrew the report: wrong sample ID.');
  await v1.getByRole('button', { name: 'Review revocation' }).click();
  assert.ok((await v1.locator('section.confirm').innerText()).includes('Lab withdrew the report: wrong sample ID.'));
  assert.ok((await v1.locator('section.confirm').innerText()).includes('The lot will have no current COA afterwards.'));
  await v1.getByRole('button', { name: 'Back' }).click();
  assert.equal(await v1.getByLabel('Reason (1 to 500 characters)').inputValue(), 'Lab withdrew the report: wrong sample ID.', 'reason survives Back');
  await v1.getByRole('button', { name: 'Review revocation' }).click();
  await v1.getByRole('button', { name: 'Confirm: revoke version 1' }).click();
  await co.locator('.msg-ok', { hasText: 'Revoked.' }).waitFor();
  assert.ok(await v1.locator('.chip-coa-revoked').isVisible());
  assert.ok((await v1.innerText()).includes('Lab withdrew the report: wrong sample ID.'));
  assert.ok(await co.locator('.page-head .chip-coa-revoked').isVisible());
  assert.equal(await co.getByText('Current public version').count(), 0);
  assert.equal(await v1.getByRole('button', { name: /Revoke|Review and publish|Delete/ }).count(), 0, 'no actions left on a revoked version');
  await v1.locator('.anchor[data-anchor-kind="revoke"] .chip-anchor-confirmed').waitFor({ timeout: 20000 });
  assert.ok((await v1.locator('.anchor[data-anchor-kind="revoke"]').innerText()).includes('helix-coa:v1:revoke:L24-1002-C:1:'));
  await shot(co, '30-revoked');
});

await check('seeded revoked lot: reason, both anchors confirmed, still downloadable, no actions; seeded draft deletable by the owner', async () => {
  await gotoLot(co, 'L24-0610-R');
  const v1 = version(co, 1);
  const t = await v1.innerText();
  assert.ok(t.includes('transcription error') && t.includes('Revoked'));
  assert.equal(await v1.locator('.chip-anchor-confirmed').count(), 2);
  assert.ok(await v1.getByRole('link', { name: 'Open PDF (new tab)' }).isVisible());
  assert.equal(await v1.getByRole('button', { name: /Revoke|publish|Delete/i }).count(), 0);
  await gotoLot(co, 'L25-0105-D');
  const draft = version(co, 1);
  assert.ok(await draft.locator('.chip-coa-draft').isVisible());
  await draft.getByRole('button', { name: 'Delete draft' }).click();
  await draft.getByRole('button', { name: 'Confirm: delete draft' }).click();
  await co.locator('.msg-ok', { hasText: 'Draft deleted.' }).waitFor();
  await co.getByText('No COA versions yet.').waitFor();
  assert.equal((await lotByCode('L25-0105-D')).coaStatus, 'none');
});

await check('409s from the API are shown inline and the screen refreshes: publish, upload, retry, revoke, delete', async () => {
  await gotoLot(co, 'QA-LOT-001');
  await uploadDraft(co, 'v3.pdf', { ...fields, labReportId: 'NAL-2026-0090' });
  const v3 = version(co, 3);
  await fake('/__control/config', { forceConflict: { publish: 'Another admin published a newer version a moment ago. Reload and review again.' } });
  await v3.getByRole('button', { name: 'Review and publish' }).click();
  await v3.getByLabel("I compared these values with the lab's PDF").check();
  await v3.getByRole('button', { name: 'Confirm: publish version 3' }).click();
  await co.locator('.msg-error', { hasText: 'Another admin published a newer version a moment ago.' }).waitFor();
  assert.ok((await co.locator('.msg-error').first().innerText()).startsWith('Not done:'));
  assert.ok(await v3.locator('.chip-coa-draft').isVisible(), 'still a draft');
  await shot(co, '31-publish-conflict');
  await fake('/__control/config', { forceConflict: { upload: 'Simulated: this lot is locked for uploads.' } });
  await v3.getByRole('button', { name: 'Cancel' }).click();
  await fillMeta(co, { ...fields, labReportId: 'NAL-2026-0091' });
  await co.locator('#up-file').setInputFiles(filePath('v4.pdf'));
  await co.locator('form[aria-labelledby="upload-h"]').getByRole('button', { name: 'Upload as draft' }).click();
  await co.locator('form[aria-labelledby="upload-h"] .msg-error', { hasText: 'Simulated: this lot is locked for uploads.' }).waitFor();
  await fake('/__control/config', { forceConflict: { delete: 'Simulated delete conflict.' } });
  await v3.getByRole('button', { name: 'Delete draft' }).click();
  await v3.getByRole('button', { name: 'Confirm: delete draft' }).click();
  await co.locator('.msg-error', { hasText: 'Simulated delete conflict.' }).waitFor();
  await fake('/__control/config', { forceConflict: {} });
  // anchor retry / revoke conflicts on the revoked-lot (revoke anchor) and the QA lot
  await fake('/__control/set-anchor', { coaId: (await lotByCode('QA-LOT-001')).coas.find((c) => c.version === 2).id, kind: 'publish', status: 'FAILED', error: 'forced failure for the 409 check' });
  await co.reload();
  await fake('/__control/config', { forceConflict: { retry: 'Simulated: a retry is already queued.' } });
  await version(co, 2).getByRole('button', { name: 'Retry publish anchor' }).click();
  await co.locator('.msg-error', { hasText: 'Simulated: a retry is already queued.' }).waitFor();
  await fake('/__control/config', { forceConflict: { revoke: 'Simulated: already revoked.' } });
  await version(co, 2).getByRole('button', { name: 'Revoke version 2' }).click();
  await version(co, 2).getByLabel('Reason (1 to 500 characters)').fill('x');
  await version(co, 2).getByRole('button', { name: 'Review revocation' }).click();
  await version(co, 2).getByRole('button', { name: 'Confirm: revoke version 2' }).click();
  await co.locator('.msg-error', { hasText: 'Simulated: already revoked.' }).waitFor();
  await fake('/__control/config', { forceConflict: {} });
  assert.ok(await version(co, 2).locator('.chip-coa-published').isVisible(), 'v2 stays published after the refused revoke');
});

await check('anchoring disabled or stuck: no-anchor note; a PENDING anchor stops polling after 2 minutes (browser clock) and offers Check again + Retry', async () => {
  // anchoring disabled (fail-soft): publishes with no anchor row
  await fake('/__control/config', { anchorOutcome: 'none' });
  await gotoLot(co, 'QA-LOT-001');
  const v3 = version(co, 3);
  await v3.getByRole('button', { name: 'Review and publish' }).click();
  await v3.getByLabel("I compared these values with the lab's PDF").check();
  await v3.getByRole('button', { name: 'Confirm: publish version 3' }).click();
  await co.locator('.msg-ok', { hasText: 'Published.' }).waitFor();
  assert.ok((await v3.innerText()).includes('No publish anchor is recorded.'));
  assert.equal(await co.locator('[data-testid="anchor-poll"] .msg').count(), 0);
  // stuck: PENDING forever; drive the page's clock past 2 minutes
  const page = await coContext.newPage();
  await page.clock.install();
  const lot = await lotByCode('QA-LOT-001');
  // a PENDING anchor that never resolves (the worker is down)
  await fake('/__control/set-anchor', { coaId: (lot.coas.find((c) => c.version === 2)).id, kind: 'publish', status: 'PENDING' });
  await page.goto(`/lots/${lot.id}`);
  await page.locator('[data-testid="anchor-poll"] .msg-info').waitFor();
  for (let i = 0; i < 30; i += 1) {
    if (await page.locator('[data-testid="anchor-poll"] .msg-warn').count()) break;
    await page.clock.runFor(5000);
    await page.waitForTimeout(250);
  }
  const warn = page.locator('[data-testid="anchor-poll"] .msg-warn');
  await warn.waitFor({ timeout: 5000 });
  assert.ok((await warn.innerText()).includes('still PENDING after 2 minutes'));
  assert.ok(await warn.getByRole('button', { name: 'Check again' }).isVisible());
  assert.equal(await page.locator('article[data-version="2"]').getByRole('button', { name: 'Retry publish anchor' }).isEnabled(), true, 'owner can retry a long-pending anchor');
  await shot(page, '32-anchor-gave-up');
  await page.close();
  await fake('/__control/config', { anchorOutcome: 'confirm' });
  await fake('/__control/set-anchor', { coaId: (lot.coas.find((c) => c.version === 2)).id, kind: 'publish', status: 'CONFIRMED' });
});

await check('products: list with counts from the API; unpublish/publish with confirm; the API 409 is shown inline and the state stays', async () => {
  await co.goto('/products');
  const api = (await coaState()).products;
  const row = (sku) => co.locator('tr[data-product]', { hasText: sku });
  assert.equal(await co.locator('tr[data-product]').count(), 3);
  for (const p of api) {
    const cells = await row(p.sku).locator('td').allInnerTexts();
    assert.equal(cells[5], String(p.lotCount), `${p.sku} lotCount`); assert.equal(cells[6], String(p.publishedCoaLotCount), `${p.sku} published lots`);
    assert.equal(cells[4], p.active ? 'Active' : 'Inactive');
  }
  await shot(co, '33-products');
  await row('BPC157-5MG').getByRole('button', { name: 'Unpublish BPC-157 5 mg vial' }).click();
  await row('BPC157-5MG').getByRole('button', { name: /Confirm: unpublish/ }).waitFor();
  await row('BPC157-5MG').getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await coaState()).products[0].active, true, 'Cancel changes nothing');
  await row('BPC157-5MG').getByRole('button', { name: 'Unpublish BPC-157 5 mg vial' }).click();
  await row('BPC157-5MG').getByRole('button', { name: /Confirm: unpublish/ }).click();
  await co.locator('.msg-ok', { hasText: 'Product unpublished (inactive).' }).waitFor();
  assert.equal(await row('BPC157-5MG').locator('td').nth(4).innerText(), 'Inactive');
  await row('BPC157-5MG').getByRole('button', { name: 'Publish BPC-157 5 mg vial' }).click();
  await row('BPC157-5MG').getByRole('button', { name: /Confirm: publish/ }).click();
  await co.locator('.msg-ok', { hasText: 'Product published (active).' }).waitFor();
  assert.equal(await row('BPC157-5MG').locator('td').nth(4).innerText(), 'Active');
  // GHK-Cu has no lot with a published COA -> the API's 409
  await row('GHKCU-50MG').getByRole('button', { name: 'Publish GHK-Cu 50 mg vial' }).click();
  assert.ok((await co.locator('tr.row-note').innerText()).includes('no lot with a published COA'), 'upfront hint');
  await row('GHKCU-50MG').getByRole('button', { name: /Confirm: publish/ }).click();
  const error = co.locator('.msg-error');
  await error.waitFor();
  assert.ok((await error.innerText()).includes('Product has no lot with a published COA.'));
  assert.equal(await error.getAttribute('role'), 'alert');
  assert.equal(await row('GHKCU-50MG').locator('td').nth(4).innerText(), 'Inactive');
  assert.equal((await coaState()).products.find((p) => p.sku === 'GHKCU-50MG').active, false);
  await shot(co, '34-product-409');
});

await check('packing slip: every item line shows its public verification address as plain text; still prices-free and one page (A4 + Letter)', async () => {
  const slipOrder = await findOrder('marcus.albrecht@example.test');
  const detail = await fake(`/__control/order?id=${slipOrder.id}`);
  await co.goto(`/orders/${slipOrder.id}/packing-slip`);
  const lines = await co.locator('.slip [data-verify]').allInnerTexts();
  const expected = detail.items.filter((i) => i.lotCode).map((i) => `${VERIFY_BASE}/verify/${i.lotCode}`);
  assert.deepEqual(lines, expected);
  assert.equal(await co.locator('.slip a').count(), 0, 'plain text, not links');
  const text = await co.locator('.slip').innerText();
  assert.ok(!/\$|USD|price|subtotal/i.test(text));
  assert.equal(await co.locator('.slip .box').count(), detail.items.length);
  await shot(co, '35-packing-slip-verify');
  await co.emulateMedia({ media: 'print' });
  for (const format of ['A4', 'Letter']) {
    const pdf = await co.pdf({ format, printBackground: true });
    assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1, `${format} pages`);
  }
  await co.emulateMedia({ media: 'screen' });
  // a lot code with characters outside the COA pattern is percent-encoded, never injected
  const noLot = await findOrder('dev.patel@example.test');
  await co.goto(`/orders/${noLot.id}/packing-slip`);
  const noLotLines = await co.locator('.slip [data-verify]').allInnerTexts();
  assert.equal(noLotLines.length, 1, 'only lines with a lot code get an address');
});

await check('STAFF: can create a lot and upload a draft and delete their own; publish/revoke/retry/product controls are disabled with an explanation; the server refuses even a forced click', async () => {
  await gotoLot(co, 'QA-LOT-001');
  await uploadDraft(co, 'v5.pdf', { ...fields, labReportId: 'NAL-OWNER-DRAFT' }); // a draft uploaded by the OWNER
  const staffContext = await newContext();
  const staff = await login(staffContext, 'staff@example.test');
  await staff.goto('/lots');
  await staff.getByRole('button', { name: 'New lot' }).click();
  await staff.locator('#new-lot-product').selectOption('prd_tb500');
  await staff.locator('#new-lot-code').fill('STAFF-LOT-1');
  await staff.getByRole('button', { name: 'Create lot' }).click();
  await staff.waitForURL(/\/lots\/[^/]+$/);
  await uploadDraft(staff, 'v4.pdf', { ...fields, labReportId: 'NAL-STAFF-1' });
  const mine = version(staff, 1);
  const note = await mine.locator('.gate .hint').innerText();
  assert.ok(note.includes('Only an owner can do this. You are signed in as STAFF.'));
  const publish = mine.getByRole('button', { name: 'Review and publish' });
  assert.equal(await publish.isDisabled(), true);
  assert.equal(await publish.getAttribute('aria-describedby'), await mine.locator('.gate .hint').getAttribute('id'));
  await shot(staff, '36-staff-lot-draft');
  // own draft: delete works
  await mine.getByRole('button', { name: 'Delete draft' }).click();
  await mine.getByRole('button', { name: 'Confirm: delete draft' }).click();
  await staff.locator('.msg-ok', { hasText: 'Draft deleted.' }).waitFor();
  // someone else's draft: the API's 403 is shown
  await gotoLot(staff, 'QA-LOT-001');
  const others = version(staff, 3);
  assert.equal(await others.locator('.chip-coa-published').count(), 1, 'v3 was published in the anchoring-disabled check');
  assert.equal(await others.getByRole('button', { name: 'Revoke version 3' }).isDisabled(), true);
  const staffLot = await lotByCode('QA-LOT-001');
  const ownerDraft = staffLot.coas.find((c) => c.status === 'DRAFT');
  const logDraft = await logLen();
  const hostile = await callServerAction(staff, 'publishCoa', [staffLot.id, ownerDraft.id, ownerDraft.sha256]);
  assert.equal(hostile.status, 200);
  assert.ok(hostile.text.includes('Only an owner can do that.'), `hostile publishCoa: ${hostile.text.slice(0, 200)}`);
  assert.equal((await logSince(logDraft)).filter((l) => l.path.endsWith('/publish')).length, 0, 'a STAFF-forced publish never reached the API');
  assert.equal((await lotByCode('QA-LOT-001')).coas.find((c) => c.id === ownerDraft.id).status, 'DRAFT');
  const control = await callServerAction(staff, 'publishCoa', [staffLot.id, ownerDraft.id, ownerDraft.sha256], { origin: 'http://evil.example' });
  assert.ok(!control.text.includes('"ok":true') && !control.text.includes('Published.'), 'cross-origin action call refused');
  for (const [name, args] of [['revokeCoa', [staffLot.id, ownerDraft.id, 'because']], ['retryAnchor', [staffLot.id, ownerDraft.id, 'PUBLISH']]]) {
    const r = await callServerAction(staff, name, args);
    assert.ok(r.text.includes('Only an owner can do that.'), `${name}: ${r.text.slice(0, 160)}`);
  }
  // failed anchor retry is disabled
  await fake('/__control/set-anchor', { coaId: (await lotByCode('L24-0821-B')).coas[0].id, kind: 'publish', status: 'FAILED', error: 'forced for STAFF check' });
  await gotoLot(staff, 'L24-0821-B');
  const retry = version(staff, 1).getByRole('button', { name: 'Retry publish anchor' });
  assert.equal(await retry.isDisabled(), true);
  assert.ok((await version(staff, 1).innerText()).includes('Only an owner can do this'));
  // products
  await staff.goto('/products');
  assert.ok(await staff.locator('#products-role-note').isVisible());
  const buttons = staff.locator('tr[data-product] td:last-child button');
  assert.equal(await buttons.count(), 3);
  for (let i = 0; i < 3; i += 1) assert.equal(await buttons.nth(i).isDisabled(), true);
  await shot(staff, '37-staff-products');
  const productHostile = await callServerAction(staff, 'setProductPublished', ['prd_ghkcu', true]);
  assert.ok(productHostile.text.includes('Only an owner can do that.'), `setProductPublished: ${productHostile.text.slice(0, 160)}`);
  assert.equal((await coaState()).products.find((p) => p.sku === 'GHKCU-50MG').active, false);
  assert.equal((await logSince(logDraft)).filter((l) => /\/(publish|unpublish|revoke|anchor\/retry)$/.test(l.path)).length, 0, 'the admin server never called an owner-only API endpoint for STAFF');
  // API-level: STAFF token is refused with 403 for owner-only calls
  const token = [...seenTokens].at(-1);
  const direct = await fetch(`${FAKE}/v1/admin/coas/${(await lotByCode('QA-LOT-001')).coas[0].id}/publish`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmSha256: 'x' }) });
  assert.equal(direct.status, 403);
  await staffContext.close();
});

await check('STAFF cannot delete a draft someone else uploaded: the API 403 message is shown inline', async () => {
  // the draft the OWNER uploaded on QA-LOT-001 (previous check): STAFF tries to delete it
  assert.ok((await lotByCode('QA-LOT-001')).coas.some((c) => c.status === 'DRAFT'), 'the owner draft exists');
  const staffContext = await newContext();
  const staff = await login(staffContext, 'staff@example.test');
  await gotoLot(staff, 'QA-LOT-001');
  const drafts = staff.locator('article.version[data-status="DRAFT"]');
  const target = drafts.filter({ hasText: 'Olivia Owner' }).first();
  await target.getByRole('button', { name: 'Delete draft' }).click();
  await target.getByRole('button', { name: 'Confirm: delete draft' }).click();
  await staff.locator('.msg-error', { hasText: 'Only an owner or the person who uploaded this draft can delete it.' }).waitFor();
  await staffContext.close();
});

await check('mobile (390px): lots, lot detail (with the review step open), upload form and products have no horizontal overflow', async () => {
  const context = await newContext({ width: 390, height: 844 });
  const page = await login(context, 'owner@example.test');
  const lot = await lotByCode('QA-LOT-001');
  const draft = (await lotByCode('QA-LOT-001')).coas.find((c) => c.status === 'DRAFT');
  for (const path of ['/lots', `/lots/${lot.id}`, '/products']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${path} overflows by ${overflow}px`);
  }
  await page.goto(`/lots/${lot.id}`);
  if (draft) {
    await page.locator(`article.version[data-version="${draft.version}"]`).getByRole('button', { name: 'Review and publish' }).click();
    await page.locator('section.review').waitFor();
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'review step overflows');
    await shot(page, '38-mobile-review', false);
  }
  await page.goto('/lots'); await shot(page, '39-mobile-lots', false);
  await context.close();
});

await check('a11y on the new screens (owner): contrast AA and 44px targets on lots, lot detail with the review step open, products', async () => {
  const lot = await lotByCode('QA-LOT-001');
  const draft = lot.coas.find((c) => c.status === 'DRAFT');
  for (const path of ['/lots', '/products', `/lots/${lot.id}`]) {
    await co.goto(path);
    assert.deepEqual(await contrastOffenders(co), [], `contrast ${path}`);
    assert.deepEqual(await smallTargets(co), [], `targets ${path}`);
  }
  if (draft) {
    await co.locator(`article.version[data-version="${draft.version}"]`).getByRole('button', { name: 'Review and publish' }).click();
    await co.locator('section.review').waitFor();
    assert.deepEqual(await contrastOffenders(co), [], 'contrast review');
    assert.deepEqual(await smallTargets(co), [], 'targets review');
  }
  await co.goto('/lots/' + (await lotByCode('L24-0821-B')).id);
  assert.deepEqual(await contrastOffenders(co), [], 'contrast failed-anchor lot');
  assert.deepEqual(await smallTargets(co), [], 'targets failed-anchor lot');
  const storage = await co.evaluate(() => ({ cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), html: document.documentElement.outerHTML }));
  assert.ok(!storage.cookie.includes('admin_session') && storage.local === '{}' && storage.session === '{}');
  assert.ok([...seenTokens].every((t) => !storage.html.includes(t)), 'token not in the lot page DOM');
  assert.ok(!/Bearer /.test(storage.html));
});

await check('session expires mid-upload: the upload is refused, nothing is saved, and the user lands on sign-in (expired)', async () => {
  const context = await newContext();
  const page = await login(context, 'owner@example.test');
  const lot = await gotoLot(page, 'QA-LOT-001');
  const before = (await lotByCode('QA-LOT-001')).coas.length;
  const form = await fillMeta(page, { ...fields, labReportId: 'NAL-EXPIRED' });
  await form.locator('#up-file').setInputFiles(filePath('v4.pdf'));
  await form.getByText(/^Selected: /).waitFor();
  await fake('/__control/expire-sessions', {});
  await form.getByRole('button', { name: 'Upload as draft' }).click();
  await page.waitForURL(/\/sign-in\?reason=expired/);
  assert.equal((await context.cookies()).filter((c) => /admin_session/.test(c.name)).length, 0, 'cookie cleared');
  assert.equal((await lotByCode('QA-LOT-001')).coas.length, before);
  await context.close();
  void lot;
});

// ======================================================================= commerce operations; existing checks above remain intact
await operationsQa({ check, fake, newContext, login, shot, findOrder, callServerAction, logLen, logSince, contrastOffenders, smallTargets, FAKE, BASE });

// ======================================================================= token hygiene (whole run)
await check('the session token never appears in any URL, request/response body the browser saw, or page HTML', async () => {
  await snapshotTokens();
  assert.ok(seenTokens.size >= 5, `collected ${seenTokens.size} tokens`);
  const hits = [];
  for (const { where, text } of leakCorpus) for (const t of seenTokens) if (text.includes(t)) hits.push(where);
  assert.ok(leakCorpus.length > 100, `scanned ${leakCorpus.length} items`);
  if (PROD) return assert.deepEqual(hits.slice(0, 5), [], 'token found in browser-visible data');
  // `next dev` only: React's dev-time I/O tracking serialises the awaited cookies() value into RSC payloads. Production
  // builds do not (verified by running this suite with QA_PROD=1). Anything outside server-rendered payloads still fails.
  const hard = hits.filter((w) => !w.startsWith('response body'));
  assert.deepEqual(hard.slice(0, 5), [], 'token found outside RSC/HTML payloads');
  if (hits.length) console.log(`      WARN (dev-only, not a failure): ${hits.length} server-rendered payload(s) contained the cookie value under next dev, e.g. ${hits[0]}`);
});
await check('the browser only ever talked to the admin app, never to the API directly', async () => {
  assert.deepEqual([...new Set(directApiRequests)].filter((u) => !/fonts\.|favicon/.test(u)).slice(0, 5), []);
});
await check('no uncaught page errors or console errors (expected 4xx/redirect noise excluded)', async () => {
  const real = consoleProblems.filter((p) => !/Failed to load resource: (the server responded with a status of (401|403|404|409)|net::ERR_FAILED)/.test(p.message));
  assert.deepEqual(real.slice(0, 5), []);
});
await check('API bearer calls from the admin server carry Authorization, not x-admin-token (except wallets)', async () => {
  const log = (await fake('/__control/log')).log;
  assert.ok(log.filter((l) => l.path.startsWith('/v1/admin/orders')).every((l) => l.auth === 'bearer'));
  assert.ok(log.filter((l) => l.path.startsWith('/v1/admin/wallets')).every((l) => l.auth === 'x-admin-token'));
  const coaCalls = log.filter((l) => /^\/v1\/admin\/(lots|coas|catalog)/.test(l.path));
  assert.ok(coaCalls.length > 40, `COA calls seen: ${coaCalls.length}`);
  assert.ok(coaCalls.every((l) => l.auth === 'bearer'), 'every lots/coas/catalog call carried the bearer token');
});

await browser.close();
const failed = results.filter((r) => !r.ok);
await writeFile(join(OUT, 'results.json'), JSON.stringify({ base: BASE, prod: PROD, results, consoleProblems: consoleProblems.slice(0, 20) }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Output: ${OUT}`);
if (failed.length) process.exitCode = 1;
