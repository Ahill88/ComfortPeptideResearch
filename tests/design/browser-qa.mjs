import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Dependencies and all generated artifacts live outside the workspace.
const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const tools = process.env.QA_TOOLS || `${temp}/browser-qa-tools`;
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const baseURL = process.env.QA_BASE_URL || 'http://localhost:3000';
const output = process.env.QA_OUTPUT || join(temp, `browser-qa-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(output, { recursive: true });
const results = [];
const events = [];
const retriedNavigations = [];
const routes = ['/', '/access', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/catalog', '/catalog/ghk-cu', '/catalog/bpc-157', '/catalog/tb-500', '/cart', '/checkout', '/account', '/account/addresses', '/orders', '/orders/qa-missing-order', '/research', '/quality', '/about', '/contact', '/shipping', '/returns', '/terms', '/privacy'];
const walletRoutes = ['/account/wallet', '/account/wallet/add', '/account/wallet/send'];
// QA_SUITE=all (default) | legacy | wallet. The wallet suite covers the wallet pages, /privacy, /research and checkout credits.
const suite = process.env.QA_SUITE || 'all';
const SESSION_KEY = 'helix-field-local-preview-session';
const SESSION = { name: 'Browser QA', email: 'browser-qa@example.test', verified: true, eligible: true, mfaEnabled: false };
const API_ORIGIN = process.env.QA_API_ORIGIN || 'http://localhost:3001';
const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER || undefined });
const browserVersion = browser.version();
const startedAt = new Date().toISOString();


function attachListeners(page, width, phase) {
  page.on('pageerror', error => events.push({ phase, width, type: 'pageerror', url: page.url(), message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') events.push({ phase, width, type: 'console', url: page.url(), resource: message.location()?.url, message: message.text() });
  });
  page.on('requestfailed', request => events.push({ phase, width, type: 'requestfailed', url: request.url(), pageURL: page.url(), message: request.failure()?.errorText }));
  page.on('response', response => {
    if (response.status() >= 400) events.push({ phase, width, type: 'http', url: response.url(), pageURL: page.url(), message: `HTTP ${response.status()}` });
  });
}

async function check(page, width, name, action) {
  try {
    const detail = await action();
    results.push({ width, name, status: 'pass', detail });
    console.log(`PASS ${width} ${name}`);
  } catch (error) {
    const screenshot = `${width}-${name.replaceAll(/[^a-z0-9]+/gi, '-')}-failure.png`;
    await page.screenshot({ path: join(output, screenshot), fullPage: true }).catch(() => {});
    results.push({ width, name, status: 'fail', error: error.message, screenshot });
    console.log(`FAIL ${width} ${name}: ${error.message}`);
  }
}

async function visit(page, route) {
  let response;
  try { response = await page.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' }); } catch (error) {
    // Next dev can abort the first navigation to a freshly compiled route (HMR reload). Retry once and record it.
    if (!/ERR_ABORTED/.test(error.message)) throw error;
    retriedNavigations.push({ route, error: error.message.split('\n')[0] });
    response = await page.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' });
  }
  assert(response && response.status() < 400, `HTTP ${response?.status()} at ${route}`);
  await page.locator('main').waitFor();
  return { status: response.status(), finalURL: page.url() };
}

async function visible(locator) {
  await locator.first().waitFor({ state: 'visible' });
}

async function focused(page, locator) {
  // Radix restores focus during its deferred close-auto-focus cleanup.
  await page.waitForFunction(el => el === document.activeElement, await locator.elementHandle(), { timeout: 2000 });
}

async function overflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width && (r.right > innerWidth + 1 || r.left < -1);
    }).slice(0, 12).map(el => ({ tag: el.tagName, class: el.className, text: el.textContent?.slice(0, 80) })),
  }));
  assert(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions));
  return dimensions;
}

// ---------------------------------------------------------------------------
// Wallet / privacy / research / checkout-credits suite.
// ---------------------------------------------------------------------------
const apiUp = await fetch(`${API_ORIGIN}/v1/products`, { signal: AbortSignal.timeout(4000) }).then(() => true, () => false);
console.log(`API ${API_ORIGIN} reachable: ${apiUp}`);
const PAID_WORDS = /\b(paid|confirmed)\b/gi;
// "paid"/"confirmed" in a sentence about network FEES is not a claim that an order/payment/deposit succeeded.
// These are allowlisted but always listed in the result detail so a reviewer can see them.
const FEE_CONTEXT = /network fees?\b[^.]{0,80}\bpaid\b/i;
function paidWordHits(text) {
  const all = [...text.matchAll(PAID_WORDS)].map(m => ({ word: m[0], context: text.slice(Math.max(0, m.index - 70), m.index + 40).replace(/\s+/g, ' ') }));
  return { claims: all.filter(h => !FEE_CONTEXT.test(h.context)), feeStatements: all.filter(h => FEE_CONTEXT.test(h.context)) };
}

// Known-noise classification. Everything classified is still listed in results.json under `noise`.
function classify(event) {
  if (event.type === 'requestfailed' && event.message === 'net::ERR_ABORTED' && /[?&]_rsc=/.test(event.url)) return 'aborted-rsc-prefetch';
  if (!apiUp && event.type === 'requestfailed' && event.message === 'net::ERR_CONNECTION_REFUSED' && event.url.startsWith(API_ORIGIN)) return 'api-unreachable-request';
  if (event.type === 'requestfailed') return 'requestfailed-other';
  if (!apiUp && event.type === 'console' && /Failed to load resource/.test(event.message) && String(event.resource || '').startsWith(API_ORIGIN)) return 'api-unreachable-console';
  return null;
}
const noise = [];
function failingEvents(since, width, label) {
  const slice = events.slice(since).filter(e => e.phase === 'wallet' && e.width === width);
  const failing = [];
  for (const event of slice) {
    const kind = classify(event);
    if (kind) noise.push({ width, label, kind, type: event.type, url: event.url, message: event.message });
    else failing.push(event);
  }
  return failing;
}

async function visibleText(page) {
  return page.evaluate(() => document.querySelector('main')?.innerText ?? '');
}

async function focusOrder(page, { limit = 140 } = {}) {
  await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  const sequence = [];
  let devOverlayStops = 0;
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      if (el.tagName === 'NEXTJS-PORTAL') return { devOverlay: true };
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const doc = document.scrollingElement.scrollTop;
      return {
        tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
        name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.id || el.getAttribute('href') || '').trim().replace(/\s+/g, ' ').slice(0, 48),
        inMain: Boolean(el.closest('main')), inHeader: Boolean(el.closest('header')), inFooter: Boolean(el.closest('footer')),
        domIndex: [...document.querySelectorAll('*')].indexOf(el), top: Math.round(r.top + doc), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height),
        hidden: r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0,
        outline: `${s.outlineStyle} ${s.outlineWidth}`, hasOutline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0, hasShadow: s.boxShadow !== 'none',
      };
    });
    if (info?.devOverlay) { devOverlayStops += 1; break; } // Next dev indicator, not application UI
    if (!info) { if (sequence.length) break; continue; }
    if (sequence.length && sequence.at(-1).domIndex === info.domIndex) break; // stuck
    if (sequence.some(item => item.domIndex === info.domIndex)) break; // wrapped
    sequence.push(info);
  }
  sequence.devOverlayStops = devOverlayStops;
  return sequence;
}

function assertFocusOrder(sequence, { expectMainNames = [] } = {}) {
  assert(sequence.length >= 3, `Only ${sequence.length} focusable stops reached by Tab`);
  assert(sequence.every(item => !item.tabindex || Number(item.tabindex) <= 0), `Positive tabindex found: ${JSON.stringify(sequence.filter(i => Number(i.tabindex) > 0))}`);
  assert(sequence.every(item => !item.hidden), `Focus landed on invisible element: ${JSON.stringify(sequence.filter(i => i.hidden))}`);
  const backwards = sequence.filter((item, i) => i > 0 && item.domIndex < sequence[i - 1].domIndex);
  assert.equal(backwards.length, 0, `Tab order differs from DOM order: ${JSON.stringify(backwards)}`);
  const noIndicator = sequence.filter(item => !item.hasOutline && !item.hasShadow);
  assert.equal(noIndicator.length, 0, `No visible focus indicator on: ${JSON.stringify(noIndicator.map(i => `${i.tag}:${i.name}`))}`);
  const main = sequence.filter(item => item.inMain).map(item => item.name);
  let cursor = -1;
  for (const expected of expectMainNames) {
    const found = main.findIndex((name, index) => index > cursor && name.toLowerCase().includes(expected.toLowerCase()));
    assert(found > cursor, `Expected main focus stop "${expected}" in order; got ${JSON.stringify(main)}`);
    cursor = found;
  }
  // Visual reading order (informational, returned in detail): main stops whose top jumps >60px upward.
  const mainStops = sequence.filter(item => item.inMain);
  const visualInversions = mainStops.filter((item, i) => i > 0 && item.top < mainStops[i - 1].top - 60).map(i => `${i.tag}:${i.name}`);
  return { stops: sequence.length, mainStops: main, visualInversions, devOverlayStops: sequence.devOverlayStops };
}

async function settleWallet(page) {
  await page.locator('main').waitFor();
  await page.waitForFunction(() => /Wallet service unavailable|Sandbox wallet unavailable|Updated \d|Not yet updated/.test(document.querySelector('main')?.innerText ?? '') || document.querySelector('[data-testid="research-credits"]'), null, { timeout: 15000 });
}

async function addGhkCu(page) {
  await visit(page, '/catalog/ghk-cu');
  await page.evaluate(() => localStorage.removeItem('helix-field-research-cart'));
  await visit(page, '/catalog/ghk-cu');
  await page.getByRole('button', { name: 'Add to research bag', exact: true }).click();
  await visit(page, '/cart');
  await visible(page.getByLabel('1 GHK-Cu', { exact: true }));
}

async function walletSuite(browser, width) {
  const viewport = { width, height: width === 390 ? 844 : 1000 };
  const shot = (page, name, fullPage = true) => page.screenshot({ path: join(output, `${width}-${name}.png`), fullPage });

  // ---- signed out -------------------------------------------------------
  const outCtx = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
  const out = await outCtx.newPage();
  out.setDefaultTimeout(10000); out.setDefaultNavigationTimeout(45000);
  attachListeners(out, width, 'wallet');
  for (const route of walletRoutes) {
    await check(out, width, `signed-out ${route} redirects to /login`, async () => {
      await out.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' });
      await out.waitForURL(/\/login(\?|$)/, { timeout: 10000 });
      const text = await visibleText(out);
      assert(!/Sandbox wallet|Research Credits balance|Wallet address/i.test(text), `Wallet content leaked while signed out: ${text.slice(0, 200)}`);
      const walletKeys = await out.evaluate(() => Object.keys(localStorage).filter(k => k.includes('SANDBOX-devnet-wallet')));
      assert.equal(walletKeys.length, 0, `Sandbox wallet key created while signed out: ${walletKeys}`);
      await shot(out, `signed-out${route.replaceAll('/', '_')}`, false);
      return { finalURL: out.url() };
    });
  }
  await check(out, width, 'signed-out checkout shows Pay with Research Credits and sign-in prompt', async () => {
    await addGhkCu(out);
    await visit(out, '/checkout');
    const pay = out.getByRole('button', { name: 'Pay with Research Credits', exact: true });
    await pay.waitFor({ state: 'visible' });
    await out.getByRole('textbox', { name: 'Email address', exact: true }).fill('browser-qa@example.test');
    await out.getByRole('textbox', { name: 'Shipping address', exact: true }).fill('123 QA Laboratory Way');
    await out.getByRole('checkbox').check();
    await pay.click();
    await visible(out.getByText('Sign in to pay with Research Credits.', { exact: true }));
    await overflow(out);
  });
  await outCtx.close();

  // ---- signed in (local preview session) ---------------------------------
  const ctx = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
  await ctx.addInitScript(([key, value]) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, [SESSION_KEY, JSON.stringify(SESSION)]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(45000);
  attachListeners(page, width, 'wallet');

  for (const route of walletRoutes) {
    const slug = route.replaceAll('/', '_');
    let mark = events.length;
    await check(page, width, `wallet ${route} renders wallet UI or honest unavailable state`, async () => {
      mark = events.length;
      const response = await visit(page, route);
      assert.equal(new URL(page.url()).pathname, route, `Unexpected redirect to ${page.url()}`);
      await settleWallet(page);
      await shot(page, `wallet${slug}`);
      await shot(page, `wallet${slug}-viewport`, false);
      const text = await visibleText(page);
      await visible(page.getByRole('heading', { level: 1 }));
      await visible(page.getByRole('navigation', { name: 'Wallet' }));
      if (!apiUp) {
        await visible(page.getByText('Wallet service unavailable', { exact: false }));
        assert.equal(await page.locator('[data-testid="research-credits"]').count(), 0, 'A credits balance is rendered although the API is down');
        assert(!/Actual balance|Finalized on-chain|Updated \d/.test(text), `Balance/timestamp text rendered with API down: ${text.slice(0, 300)}`);
        if (route === '/account/wallet') await visible(page.getByLabel('Balance not available', { exact: true }));
        if (route === '/account/wallet/send') {
          await visible(page.getByText('unknown (balance unavailable)', { exact: false }));
          assert(await page.getByRole('button', { name: 'Review transfer' }).isDisabled(), 'Review transfer should be disabled while service is unavailable');
        }
        if (route === '/account/wallet/add') assert(await page.getByRole('button', { name: 'Get quote' }).isDisabled(), 'Get quote should be disabled without a loaded balance');
      }
      return { status: response.status, apiUp, honestUnavailable: !apiUp };
    });
    await check(page, width, `wallet ${route} sandbox label`, async () => {
      const text = await visibleText(page);
      assert(text.includes('Sandbox wallet'), `"Sandbox wallet" label missing. Heading text: ${text.slice(0, 200)}`);
      assert(/SANDBOX/.test(text), 'SANDBOX banner missing');
    });
    await check(page, width, `wallet ${route} no unfinalized paid/confirmed wording`, async () => {
      const text = await visibleText(page);
      const { claims, feeStatements } = paidWordHits(text);
      const finalized = await page.locator('main').getByText(/Deposit finalized|Payment finalized/).count() + await page.locator('main span').filter({ hasText: /^finalized$/ }).count();
      assert(claims.length === 0 || finalized > 0, `Found ${JSON.stringify(claims)} without a finalized state on page`);
      return { claims, feeStatementsAllowlisted: feeStatements, finalizedStates: finalized };
    });
    await check(page, width, `wallet ${route} no horizontal overflow`, () => overflow(page));
    await check(page, width, `wallet ${route} keyboard focus order`, async () => {
      const sequence = await focusOrder(page);
      return assertFocusOrder(sequence, { expectMainNames: ['Wallet', 'Add credits', 'Send funds', 'Profile'] });
    });
    await check(page, width, `wallet ${route} no console or page errors`, async () => {
      await page.waitForTimeout(500);
      const failing = failingEvents(mark, width, route);
      assert.equal(failing.length, 0, JSON.stringify(failing));
    });
  }

  await check(page, width, 'wallet /account/wallet/send form validation is reachable and honest', async () => {
    await visit(page, '/account/wallet/send');
    await settleWallet(page);
    const dest = page.getByLabel('Recipient Solana address');
    await dest.fill('not-a-solana-address');
    await page.getByLabel('Amount (USDC)').fill('1');
    await dest.blur();
    await visible(page.getByText('This is not a valid Solana address.', { exact: true }));
    assert.equal(await page.getByRole('heading', { name: 'Transfer submitted' }).count(), 0);
    await overflow(page);
    await shot(page, 'wallet_send-invalid');
  });

  // ---- checkout: Pay with Research Credits -----------------------------------
  let checkoutMark = events.length;
  await check(page, width, 'checkout shows Pay with Research Credits with non-empty cart', async () => {
    await addGhkCu(page);
    checkoutMark = events.length;
    await visit(page, '/checkout');
    const pay = page.getByRole('button', { name: 'Pay with Research Credits', exact: true });
    await pay.waitFor({ state: 'visible' });
    await shot(page, 'review-checkout');
    await overflow(page);
    // Keyboard reachable
    await pay.focus();
    assert(await pay.evaluate(el => el === document.activeElement));
    await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(SESSION.email);
    await page.getByRole('textbox', { name: 'Shipping address', exact: true }).fill('123 QA Laboratory Way');
    await page.getByRole('checkbox').check();
    await pay.click();
    const panel = page.getByRole('region', { name: 'Pay with Research Credits' });
    await panel.waitFor({ state: 'visible' });
    await panel.getByText('Sandbox wallet', { exact: false }).first().waitFor();
    await page.waitForFunction(() => /Wallet service unavailable|Spendable credits/.test(document.querySelector('[aria-label="Pay with Research Credits"]')?.innerText ?? ''), null, { timeout: 15000 });
    const text = await panel.innerText();
    if (!apiUp) {
      assert(/Wallet service unavailable/.test(text), `Expected honest unavailable state, got: ${text.slice(0, 300)}`);
      assert(/Not available/.test(text), 'Spendable credits should read "Not available"');
      assert(await panel.getByRole('button', { name: 'Create order and review authorization' }).isDisabled(), 'Order creation must be disabled without a balance');
    }
    assert(!/finalized|Payment finalized/i.test(text.replace(/not marked paid until the transfer is finalized on-chain/i, '')), 'Panel claims finalization without a finalized state');
    await overflow(page);
    await shot(page, 'checkout-credits-panel');
    return { panelPaidWordHits: paidWordHits(text) };
  });
  await check(page, width, 'checkout no console or page errors', async () => {
    await page.waitForTimeout(500);
    const failing = failingEvents(checkoutMark, width, '/checkout');
    assert.equal(failing.length, 0, JSON.stringify(failing));
  });

  // ---- /privacy and /research -----------------------------------------------
  for (const route of ['/privacy', '/research']) {
    const slug = route.replaceAll('/', '_');
    const mark = events.length;
    await check(page, width, `${route} renders content`, async () => {
      const response = await visit(page, route);
      await visible(page.getByRole('heading', { level: 1 }));
      const text = await visibleText(page);
      assert(text.length > 400, `${route} has only ${text.length} characters of main content`);
      await shot(page, `review${slug}`);
      return { status: response.status, characters: text.length };
    });
    await check(page, width, `${route} no horizontal overflow`, () => overflow(page));
    await check(page, width, `${route} keyboard focus order`, async () => assertFocusOrder(await focusOrder(page)));
    await check(page, width, `${route} no console or page errors`, async () => {
      await page.waitForTimeout(500);
      const failing = failingEvents(mark, width, route);
      assert.equal(failing.length, 0, JSON.stringify(failing));
    });
  }

  // ---- screenshots for the written visual review --------------------------------
  for (const [route, name] of [['/', 'home'], ['/catalog', 'catalog'], ['/catalog/ghk-cu', 'product']]) {
    const mark = events.length;
    await check(page, width, `${route} screenshot capture and no console or page errors`, async () => {
      await visit(page, route);
      await page.waitForTimeout(600);
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 60)); } scrollTo({ top: 0, behavior: 'instant' }); await new Promise(r => setTimeout(r, 400)); }); // trigger lazy images
      await page.waitForLoadState('networkidle');
      await shot(page, `review-${name}`);
      await shot(page, `review-${name}-viewport`, false);
      const failing = failingEvents(mark, width, route);
      assert.equal(failing.length, 0, JSON.stringify(failing));
    });
  }
  await check(page, width, 'populated bag drawer capture', async () => {
    await addGhkCu(page);
    await visit(page, '/catalog');
    const toggle = page.locator('header button[aria-label^="Open bag"]');
    await toggle.click();
    await visible(page.getByRole('dialog'));
    await page.waitForTimeout(500);
    await shot(page, 'review-bag-drawer-populated', false);
    await overflow(page);
    await page.keyboard.press('Escape');
  });
  await ctx.close();
}

try {
  for (const width of [1440, 390, 768]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(45000);
    attachListeners(page, width, 'legacy');
    if (suite !== 'wallet') {
    for (const route of routes) {
      await check(page, width, `route ${route}`, async () => {
        const response = await visit(page, route);
        await page.screenshot({ path: join(output, `${width}-${route.replaceAll('/', '_') || 'root'}.png`), fullPage: true });
        if (route === '/') await page.screenshot({ path: join(output, `${width}-home-viewport.png`) });
        return response;
      });
      await check(page, width, `overflow ${route}`, () => overflow(page));
    }

    await check(page, width, 'product gallery keyboard selection and zoom', async () => {
      await visit(page, '/catalog/ghk-cu');
      const views = page.getByRole('group', { name: /Product (illustration|image) views/ });
      const overview = views.getByRole('button', { name: 'Show vial overview for GHK-Cu' });
      const detail = views.getByRole('button', { name: 'Show label detail for GHK-Cu' });
      const alternate = views.getByRole('button', { name: 'Show alternate angle for GHK-Cu' });
      await overview.focus();
      await page.keyboard.press('Tab');
      assert(await detail.evaluate(el => el === document.activeElement));
      await page.keyboard.press('Enter');
      assert.equal(await detail.getAttribute('aria-pressed'), 'true');
      assert.equal(await overview.getAttribute('aria-pressed'), 'false');
      await page.keyboard.press('Tab');
      assert(await alternate.evaluate(el => el === document.activeElement));
      await page.keyboard.press('Space');
      assert.equal(await alternate.getAttribute('aria-pressed'), 'true');
      const enlarge = page.locator('button[aria-label^="Enlarge GHK-Cu"][aria-label$="Alternate angle"]'); // label: "Enlarge GHK-Cu 3D concept render: Alternate angle"
      await enlarge.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: /GHK-Cu.*Alternate angle/ });
      await visible(dialog);
      const close = dialog.getByRole('button', { name: 'Close enlarged product render' });
      assert(await close.evaluate(el => el === document.activeElement), 'Zoom should focus close control');
      await page.keyboard.press('Tab');
      assert(await close.evaluate(el => el === document.activeElement), 'Zoom should contain Tab');
      await page.keyboard.press('Shift+Tab');
      assert(await close.evaluate(el => el === document.activeElement), 'Zoom should contain Shift+Tab');
      await overflow(page);
      await page.screenshot({ path: join(output, `${width}-gallery-zoom.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await focused(page, enlarge);
      await overview.focus();
      await page.keyboard.press('Enter');
      assert.equal(await overview.getAttribute('aria-pressed'), 'true');
    });

    await check(page, width, 'product images load', async () => {
      for (const slug of ['ghk-cu', 'bpc-157', 'tb-500']) {
        await visit(page, `/catalog/${slug}`);
        const images = page.locator('main img');
        assert(await images.count() > 0, `Expected product images on ${slug}`);
        for (const image of await images.all()) {
          await image.scrollIntoViewIfNeeded();
          await page.waitForFunction(el => el.complete && el.naturalWidth > 0, await image.elementHandle(), { timeout: 7000 });
        }
      }
    });

    await check(page, width, 'cart add and reload persistence', async () => {
      await visit(page, '/catalog/ghk-cu');
      await page.getByRole('button', { name: 'Add to research bag', exact: true }).click();
      await visit(page, '/cart');
      await visible(page.getByLabel('1 GHK-Cu', { exact: true }));
      await page.reload({ waitUntil: 'networkidle' });
      await visible(page.getByLabel('1 GHK-Cu', { exact: true }));
      await visible(page.getByText('$42.00', { exact: true }));
    });
    await check(page, width, 'cart increase decrease and persistence', async () => {
      await page.getByRole('button', { name: 'Increase GHK-Cu quantity' }).click();
      await visible(page.getByLabel('2 GHK-Cu', { exact: true }));
      await visible(page.getByText('$84.00', { exact: true }));
      await page.reload({ waitUntil: 'networkidle' });
      await visible(page.getByLabel('2 GHK-Cu', { exact: true }));
      await page.getByRole('button', { name: 'Decrease GHK-Cu quantity' }).click();
      await visible(page.getByLabel('1 GHK-Cu', { exact: true }));
      assert(await page.getByRole('button', { name: 'Decrease GHK-Cu quantity' }).isDisabled());
      await overflow(page);
      await page.screenshot({ path: join(output, `${width}-cart-populated.png`), fullPage: true });
    });
    await check(page, width, 'checkout validation and mock preparation', async () => {
      await visit(page, '/checkout');
      await page.getByRole('button', { name: 'Prepare mock devnet payment' }).click();
      for (const text of ['Enter a valid email address.', 'Enter a complete shipping address.', 'Research-use acknowledgement is required.']) await visible(page.getByText(text, { exact: true }));
      await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('browser-qa@example.test');
      await page.getByRole('textbox', { name: 'Shipping address', exact: true }).fill('123 QA Laboratory Way');
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Prepare mock devnet payment' }).click();
      await visible(page.getByText('Mock payment request prepared for review.', { exact: false }));
      await overflow(page);
      await page.screenshot({ path: join(output, `${width}-checkout-prepared.png`), fullPage: true });
    });
    await check(page, width, 'cart removal persists and empty checkout', async () => {
      await visit(page, '/cart');
      await page.getByRole('button', { name: 'Remove GHK-Cu', exact: true }).click();
      await visible(page.getByText(/^Your (research )?bag is empty\.$/));
      await page.reload({ waitUntil: 'networkidle' });
      await visible(page.getByText(/^Your (research )?bag is empty\.$/));
      await visit(page, '/checkout');
      await visible(page.getByText('Your research bag is empty.', { exact: true }));
    });

    for (const kind of ['navigation', 'bag']) {
      await visit(page, '/access');
      const toggle = page.locator(`header button[aria-label^="Open ${kind}"]`);
      if (!(await toggle.isVisible())) {
        results.push({ width, name: `${kind} drawer keyboard`, status: 'skip', detail: 'No visible toggle at this breakpoint.' });
        continue;
      }
      await check(page, width, `${kind} drawer keyboard focus trap Escape`, async () => {
        await toggle.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await visible(dialog);
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'Opening must move focus inside dialog');
        const focusable = dialog.locator('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]');
        await focusable.last().focus();
        await page.keyboard.press('Tab');
        assert(await focusable.first().evaluate(el => el === document.activeElement), 'Tab must wrap to first drawer control');
        await page.keyboard.press('Shift+Tab');
        assert(await focusable.last().evaluate(el => el === document.activeElement), 'Shift+Tab must wrap to last drawer control');
        await overflow(page);
        await page.screenshot({ path: join(output, `${width}-${kind}-drawer.png`), fullPage: true });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        await focused(page, toggle);
      });
    }

    await check(page, width, 'reduced motion access and catalog', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const findings = [];
      for (const route of ['/', '/access', '/catalog', '/catalog/ghk-cu']) {
        await visit(page, route);
        assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
        const motion = await page.evaluate(() => [...document.querySelectorAll('body *')].flatMap(el => {
          const s = getComputedStyle(el);
          const seconds = value => value.split(',').map(v => parseFloat(v) * (v.trim().endsWith('ms') ? .001 : 1));
          if ((s.animationName !== 'none' && Math.max(...seconds(s.animationDuration)) > .01) || Math.max(...seconds(s.transitionDuration)) > .01 || s.scrollBehavior === 'smooth') return [{ tag: el.tagName, class: el.className, animation: s.animationName, duration: s.animationDuration, transition: s.transitionDuration, scroll: s.scrollBehavior }];
          return [];
        }));
        findings.push({ route, motion });
        await page.screenshot({ path: join(output, `${width}-reduced-${route.replaceAll('/', '_')}.png`), fullPage: true });
      }
      assert(findings.every(f => f.motion.length === 0), `Motion styles remain under reduce: ${JSON.stringify(findings)}`);
      return findings;
    });
    }
    if (suite !== 'wallet') await check(page, width, 'console and uncaught errors', async () => {
      const errors = events.filter(e => e.phase === 'legacy' && e.width === width && e.type !== 'requestfailed');
      assert.equal(errors.length, 0, JSON.stringify(errors));
    });
    await context.close();
    if (suite !== 'legacy') await walletSuite(browser, width);
  }
} finally {
  await browser.close();
  const summary = Object.fromEntries(['pass', 'fail', 'skip'].map(status => [status, results.filter(r => r.status === status).length]));
  await writeFile(join(output, 'results.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), baseURL, browser: browserVersion, executable: process.env.QA_BROWSER || 'Playwright bundled Chromium', playwright: '1.58.2', suite, apiReachable: apiUp, summary, results, noise, retriedNavigations, events }, null, 2));
  console.log(JSON.stringify({ output, summary }, null, 2));
  if (summary.fail) process.exitCode = 1;
}
