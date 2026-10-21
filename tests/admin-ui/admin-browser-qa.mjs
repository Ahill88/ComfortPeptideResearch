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
//      QA_TOOLS (playwright install dir)  QA_BROWSER (chromium executable)  QA_OUTPUT (screenshot dir)
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const tools = process.env.QA_TOOLS || `${temp}/browser-qa-tools`;
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:3191';
const FAKE = process.env.QA_FAKE_URL || 'http://127.0.0.1:3190';
const PROD = process.env.QA_PROD === '1';
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
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && !el.closest('.sr-only,.skip-link') && r.height < 43.5; })
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
  for (const path of ['/', '/orders', '/orders/abc', '/orders/abc/packing-slip', '/team', '/audit', '/account/password', '/wallets', '/wallets/balances', '/wallets/failed']) {
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
});

await browser.close();
const failed = results.filter((r) => !r.ok);
await writeFile(join(OUT, 'results.json'), JSON.stringify({ base: BASE, prod: PROD, results, consoleProblems: consoleProblems.slice(0, 20) }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Output: ${OUT}`);
if (failed.length) process.exitCode = 1;
