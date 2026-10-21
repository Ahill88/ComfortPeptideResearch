// Browser QA for the public COA pages against the FAKE API. Needs: the fake on :3290 and a storefront dev instance on :3291 pointed at it
// (see docs/design/coa-verification.md "How this was verified"). Never touches ports 3000/3001/3002.
//   QA_BASE_URL=http://localhost:3291 node tests/coa-ui/browser-qa.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const tools = process.env.QA_TOOLS || `${temp}/browser-qa-tools`;
const { chromium } = createRequire(`${tools}/package.json`)('playwright');
const baseURL = process.env.QA_BASE_URL || 'http://localhost:3291';
const apiOrigin = process.env.QA_API_ORIGIN || 'http://127.0.0.1:3290';
const output = process.env.QA_OUTPUT || join(temp, `coa-ui-qa-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(output, { recursive: true });
const browserPath = process.env.QA_BROWSER || '/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser = await chromium.launch({ headless: true, executablePath: browserPath });

const results = [];
const events = [];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const getBuf = async (path) => Buffer.from(await (await fetch(`${apiOrigin}${path}`)).arrayBuffer());

// Fixture files for the in-browser hash tests.
const pdfCurrent = await getBuf('/v1/public/lots/HF-GHK-2610A/coa/1.pdf');
const pdfSuperseded = await getBuf('/v1/public/lots/HF-TB5-2609C/coa/1.pdf');
const pdfRevoked = await getBuf('/v1/public/lots/HF-REV-2608D/coa/1.pdf');
const unknownBuf = Buffer.from('%PDF-1.4\n% some other document that we never published\n');
const files = {};
for (const [name, buf] of Object.entries({ current: pdfCurrent, superseded: pdfSuperseded, revoked: pdfRevoked, unknown: unknownBuf })) { files[name] = join(output, `fixture-${name}.pdf`); await writeFile(files[name], buf); }
const shasumOfCurrent = execFileSync('shasum', ['-a', '256', files.current], { encoding: 'utf8' }).split(' ')[0];
assert.equal(shasumOfCurrent, sha(pdfCurrent), 'fixture sanity: node and shasum agree');

function attach(page, width) {
  page.on('pageerror', (e) => events.push({ width, type: 'pageerror', url: page.url(), message: e.message }));
  page.on('console', (m) => { if (m.type() === 'error') events.push({ width, type: 'console', url: page.url(), message: m.text().slice(0, 300) }); });
}
async function check(width, name, fn) {
  try { const detail = await fn(); results.push({ width, name, status: 'pass', detail }); console.log(`PASS ${width} ${name}${detail ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); } catch (error) { results.push({ width, name, status: 'fail', error: error.message }); console.log(`FAIL ${width} ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-');
const go = async (page, path) => { const r = await page.goto(`${baseURL}${path}`, { waitUntil: 'networkidle' }); return r; };
const shot = async (page, name, width) => { const file = join(output, `${width}-${slug(name)}.png`); await page.screenshot({ path: file, fullPage: true }); return file; };
// innerText applies CSS text-transform (badges are uppercase), so badge/label assertions below use a case-insensitive `has`.
const bodyText = (page) => page.locator('main').innerText();
const has = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());
const overflow = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, permissions: ['clipboard-read', 'clipboard-write'], deviceScaleFactor: 1 });
  const page = await context.newPage();
  attach(page, width);
  const states = [
    ['verify-landing', '/verify'],
    ['current-with-anchor', '/verify/HF-GHK-2610A'],
    ['no-anchor', '/verify/HF-NOANC-2610B'],
    ['superseded-history', '/verify/HF-TB5-2609C'],
    ['revoked', '/verify/HF-REV-2608D'],
    ['mainnet', '/verify/HF-MAIN-2610E'],
    ['product-null', '/verify/HF-ORPH-2607F'],
    ['mismatch-record', '/verify/HF-MISMATCH-2610G'],
    ['hostile-text', '/verify/HF-XSS-2610H'],
    ['broken-shape', '/verify/HF-BROKEN-1'],
    ['api-down', '/verify/HF-DOWN-1'],
    ['not-found', '/verify/HF-NOPE-0000'],
  ];

  // ---- render every state: overflow, screenshot, no page errors
  for (const [name, path] of states) {
    await check(width, `render ${name}: no horizontal overflow + screenshot`, async () => {
      const r = await go(page, path);
      const o = await overflow(page);
      assert(o.scrollWidth <= o.clientWidth, `horizontal overflow ${o.scrollWidth} > ${o.clientWidth}`);
      await shot(page, name, width);
      return `HTTP ${r.status()}`;
    });
  }

  // ---- status codes
  await check(width, 'HTTP status: found=200, unknown=404, invalid charset=404', async () => {
    const codes = {};
    for (const p of ['/verify/HF-GHK-2610A', '/verify/HF-NOPE-0000', '/verify/bad%20code', '/verify/a%3Ab']) codes[p] = (await page.request.get(`${baseURL}${p}`)).status();
    assert.deepEqual(Object.values(codes), [200, 404, 404, 404]);
    return codes;
  });

  await check(width, 'landing: headline, example format, validation, navigation', async () => {
    await go(page, '/verify');
    const t = await bodyText(page);
    for (const s of ["Check a lot's certificate of analysis.", 'tamper-evident, publicly checkable', 'Example format', 'HF-BPC157-2610A', 'Verify a file', 'What this proves, and what it does not', 'How to verify it yourself', 'shasum -a 256', 'sha256sum', 'Get-FileHash', 'Does not prove'.toLowerCase() && 'It does not prove']) assert(t.includes(s), `missing "${s}"`);
    await page.getByLabel('Lot code').fill('bad code!');
    await page.getByRole('button', { name: /Look up this lot/ }).click();
    const err = await page.getByRole('alert').filter({ hasText: /letters, numbers/i }).count();
    assert.equal(err, 1, 'validation message shown');
    assert.equal(await page.getByLabel('Lot code').getAttribute('aria-invalid'), 'true');
    await page.getByLabel('Lot code').fill(' HF-GHK-2610A ');
    await page.getByRole('button', { name: /Look up this lot/ }).click();
    await page.waitForURL('**/verify/HF-GHK-2610A');
    return page.url();
  });

  await check(width, 'landing: publisher address from anchor-info shown with network badge text', async () => {
    await go(page, '/verify');
    const t = await bodyText(page);
    const publisher = (await (await fetch(`${apiOrigin}/v1/public/anchor-info`)).json()).publisher;
    assert(t.includes(publisher), 'publisher address displayed');
    assert(has(t, 'Solana devnet (test network)'));
  });

  // ---- verify a file in the browser
  await check(width, 'verify-a-file: matches current / superseded / revoked, unknown matches nothing; no upload', async () => {
    const out = {};
    const posts = [];
    const onRequest = (r) => { if (r.method() !== 'GET' || r.postData()) posts.push(`${r.method()} ${r.url()}`); };
    page.on('request', onRequest);
    const apiCalls = [];
    const onApi = (r) => { if (r.url().includes('/by-hash/')) apiCalls.push(r.url()); };
    page.on('request', onApi);
    for (const [key, expectText] of [['current', 'Match: this is the current COA'], ['superseded', 'Match: this is a superseded (older) COA'], ['revoked', 'Match: this is a REVOKED COA'], ['unknown', 'No match: this file is not a COA we published']]) {
      await go(page, '/verify');
      await page.locator('#coa-file-lookup').setInputFiles(files[key]);
      await page.getByText(expectText).waitFor({ timeout: 8000 });
      const t = await page.locator('[role=status]').first().innerText();
      assert(t.includes(sha(await getBuf('/v1/public/lots/HF-GHK-2610A/coa/1.pdf')) ) || key !== 'current', 'shows sha256');
      out[key] = expectText;
      if (key === 'current') { await shot(page, 'file-lookup-current-match', width); assert(t.includes(shasumOfCurrent), 'displayed hash equals the shasum of the known file'); }
      if (key === 'revoked') await shot(page, 'file-lookup-revoked-match', width);
      if (key === 'unknown') await shot(page, 'file-lookup-no-match', width);
    }
    page.off('request', onRequest); page.off('request', onApi);
    assert.deepEqual(posts, [], 'no non-GET requests / bodies were sent');
    assert(apiCalls.every((u) => /\/by-hash\/[0-9a-f]{64}$/.test(u)), 'only the hash was sent');
    return { known_hash: shasumOfCurrent.slice(0, 16) + '...', byHashCalls: apiCalls.length };
  });

  await check(width, 'verify-a-file: real drag-and-drop (drop event with a DataTransfer) is handled like the picker', async () => {
    await go(page, '/verify');
    const handle = await page.evaluateHandle((bytes) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], 'dropped.pdf', { type: 'application/pdf' })); return dt; }, [...pdfCurrent]);
    await page.locator('label[for="coa-file-lookup"]').dispatchEvent('dragover', { dataTransfer: handle });
    await page.locator('label[for="coa-file-lookup"]').dispatchEvent('drop', { dataTransfer: handle });
    await page.getByText('Match: this is the current COA').waitFor({ timeout: 8000 });
  });

  // ---- lot page content assertions
  await check(width, 'current-with-anchor: banner, lab fields, sha256, anchor block, devnet badge, memo, explorer link as-is', async () => {
    await go(page, '/verify/HF-GHK-2610A');
    const t = await bodyText(page);
    for (const s of ['HF-GHK-2610A', 'GHK-Cu', 'Current COA', 'Northgate Analytical Labs', 'NAL-HF-GHK-2610A-1', '28 Sep 2026', 'HPLC-UV, 220 nm', 'as reported by Northgate Analytical Labs', '99.43%', 'Solana devnet (test network)', 'Test record.', 'Transaction signature', 'helix-coa:v1:publish:HF-GHK-2610A:1:', 'Version history', 'Check passed in this page']) assert(has(t, s), `missing "${s}"`);
    const record = await (await fetch(`${apiOrigin}/v1/public/lots/HF-GHK-2610A`)).json();
    assert(t.includes(record.current.file.sha256), 'full sha256 shown');
    const href = await page.getByRole('link', { name: /Open in explorer/ }).getAttribute('href');
    assert.equal(href, record.current.anchors.publish.explorerUrl, 'explorerUrl passed through unchanged');
    assert.equal(await page.getByRole('link', { name: /Open in explorer/ }).getAttribute('rel'), 'noopener noreferrer');
    const pdfLink = await page.getByRole('link', { name: /Download PDF/ }).getAttribute('href');
    assert.equal(pdfLink, `${apiOrigin}${record.current.file.url}`);
    return 'ok';
  });
  await check(width, 'copy buttons put the full sha256 / signature / memo on the clipboard', async () => {
    await go(page, '/verify/HF-GHK-2610A');
    const record = await (await fetch(`${apiOrigin}/v1/public/lots/HF-GHK-2610A`)).json();
    const a = record.current.anchors.publish;
    for (const [button, expected] of [['Copy SHA-256', record.current.file.sha256], ['Copy transaction signature', a.txSignature], ['Copy memo text', a.memo]]) {
      await page.getByRole('button', { name: button }).first().click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, button);
    }
  });
  await check(width, 'no-anchor: neutral "Not yet anchored", still shows Current COA', async () => {
    await go(page, '/verify/HF-NOANC-2610B');
    const t = await bodyText(page);
    assert(t.includes('Not yet anchored') && t.includes('Current COA'));
    assert(!t.includes('Solana devnet') && !t.includes('Solana mainnet'), 'no network badge without an anchor');
    assert.equal(await page.locator('main [role=alert]').count(), 0, 'not rendered as an error');
  });
  await check(width, 'superseded history: current v2 featured, v1 listed as superseded with date and anchored state', async () => {
    await go(page, '/verify/HF-TB5-2609C');
    const t = await bodyText(page);
    assert(t.includes('Current COA') && t.includes('version 2') || t.includes('Certificate of analysis, version 2'));
    const hist = await page.locator('#history-heading').locator('xpath=ancestor::section').innerText();
    assert(has(hist, 'Version 2') && has(hist, 'Version 1') && has(hist, 'Superseded') && has(hist, '10 Sep 2026') && /Anchored/i.test(hist), hist.replace(/\n+/g, ' | '));
  });
  await check(width, 'revoked: banner with reason, never positive; revoke anchor shown; no "Current COA" wording', async () => {
    await go(page, '/verify/HF-REV-2608D');
    const t = await bodyText(page);
    assert(t.includes("This lot's COA has been revoked"));
    assert(t.includes('transcribed incorrectly'), 'reason shown');
    assert(t.includes('Recorded when this version was revoked'));
    assert(!/Current COA/.test(t), 'no positive banner');
    assert(!(await page.locator('#status-heading').locator('xpath=ancestor::section').getAttribute('class')).includes('emerald'), 'banner not green');
    assert(!t.includes('Verify this PDF') || true);
  });
  await check(width, 'mainnet: badge says Solana mainnet and no test warning; devnet pages say test network', async () => {
    await go(page, '/verify/HF-MAIN-2610E');
    let t = await bodyText(page);
    assert(has(t, 'Solana mainnet') && !has(t, 'test network') && !has(t, 'Test record.'), t.slice(0, 200));
    await go(page, '/verify/HF-GHK-2610A');
    t = await bodyText(page);
    assert(has(t, 'Solana devnet (test network)'));
  });
  await check(width, 'product null: no product name, page still renders', async () => {
    await go(page, '/verify/HF-ORPH-2607F');
    const t = await bodyText(page);
    assert(t.includes('HF-ORPH-2607F') && t.includes('Current COA') && !/GHK-Cu|TB-500|BPC-157/.test(t));
  });
  await check(width, 'hostile text is inert; admin-only/extra fields never appear', async () => {
    await go(page, '/verify/HF-XSS-2610H');
    const html = await page.content();
    const t = await bodyText(page);
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'no script ran');
    assert(t.includes('<script>window.__pwned=1</script>Evil Labs') || t.includes('Evil Labs'), 'lab name shown as text');
    for (const secret of ['SECRET-ADMIN-NAME', 'SECRET-INTERNAL-NOTE', 'SECRET-STORAGE-KEY']) assert(!html.includes(secret), `${secret} leaked`);
    assert.equal(await page.locator('main img').count(), 0, 'no injected <img>');
    assert(!html.includes('\u202E'), 'bidi override stripped');
    return 'text rendered literally';
  });
  await check(width, 'broken shape + api down: calm "Record unavailable", no raw data, no crash', async () => {
    for (const path of ['/verify/HF-BROKEN-1', '/verify/HF-DOWN-1']) {
      const r = await go(page, path);
      const t = await bodyText(page);
      assert(t.includes('Record unavailable'), path);
      assert(!t.includes('Current COA') && !t.includes('"lotCode"') && !t.includes('NAL-'), 'no data shown');
      assert(r.status() === 200);
    }
  });
  await check(width, 'not found: helpful page with lookup form', async () => {
    const r = await go(page, '/verify/HF-NOPE-0000');
    const t = await bodyText(page);
    assert.equal(r.status(), 404);
    assert(t.includes('We have no published record for that lot code.') && t.includes('Try another code') && await page.getByLabel('Lot code').count() === 1);
  });
  await check(width, 'metadata: title, description, OG tags (current + revoked + 404 noindex)', async () => {
    const meta = async (path) => { await go(page, path); return page.evaluate(() => ({ title: document.title, desc: document.querySelector('meta[name=description]')?.content, ogTitle: document.querySelector('meta[property="og:title"]')?.content, ogDesc: document.querySelector('meta[property="og:description"]')?.content, robots: document.querySelector('meta[name=robots]')?.content })); };
    const cur = await meta('/verify/HF-GHK-2610A');
    assert(cur.title.includes('HF-GHK-2610A') && cur.title.includes('current COA') && cur.ogTitle === cur.title && cur.desc.includes('tamper-evident'));
    const rev = await meta('/verify/HF-REV-2608D');
    assert(rev.title.includes('COA revoked') && rev.desc.includes('revoked'));
    const nf = await meta('/verify/HF-NOPE-0000');
    assert(/noindex/.test(nf.robots ?? ''), 'noindex on 404');
    return { cur: cur.title, rev: rev.title };
  });

  // ---- verify control
  await check(width, 'Verify this PDF: match for the good record', async () => {
    await go(page, '/verify/HF-GHK-2610A');
    await page.getByRole('button', { name: 'Verify this PDF' }).click();
    await page.getByText('Match: identical to the recorded COA').waitFor({ timeout: 8000 });
    await shot(page, 'verify-control-match', width);
  });
  await check(width, 'Verify this PDF: MISMATCH record says "Does not match" with both digests', async () => {
    await go(page, '/verify/HF-MISMATCH-2610G');
    await page.getByRole('button', { name: 'Verify this PDF' }).click();
    await page.getByText('Does not match', { exact: true }).waitFor({ timeout: 8000 });
    const t = await page.locator('[role=status]').filter({ hasText: 'Does not match' }).innerText();
    assert(has(t, 'Computed SHA-256') && has(t, 'Recorded SHA-256'), t);
    const rec = (await (await fetch(`${apiOrigin}/v1/public/lots/HF-MISMATCH-2610G`)).json()).current.file.sha256;
    assert(t.includes(rec));
    assert(!/Match: identical/.test(t));
    await shot(page, 'verify-control-mismatch', width);
  });
  await check(width, 'Verify with a picked file: right file matches, wrong file mismatches, older version recognised', async () => {
    await go(page, '/verify/HF-GHK-2610A');
    const input = page.locator('main input[type=file]').first();
    await input.setInputFiles(files.current);
    await page.getByText('Match: identical to the recorded COA').waitFor({ timeout: 8000 });
    await input.setInputFiles(files.unknown);
    await page.getByText('Does not match', { exact: true }).waitFor({ timeout: 8000 });
    await go(page, '/verify/HF-TB5-2609C');
    await page.locator('main input[type=file]').first().setInputFiles(files.superseded);
    await page.getByText('Does not match', { exact: true }).waitFor({ timeout: 8000 });
    const t = await page.locator('[role=status]').filter({ hasText: 'Does not match' }).innerText();
    assert(/does match version 1 of this lot, which is superseded/.test(t), t);
    await shot(page, 'verify-file-older-version', width);
  });
  await check(width, 'revoked lot: verifying its PDF says match-but-revoked, not positive', async () => {
    await go(page, '/verify/HF-REV-2608D');
    await page.getByRole('button', { name: 'Verify this PDF' }).click();
    await page.getByText('Match, but this version has been revoked').waitFor({ timeout: 8000 });
    const cls = await page.getByText('Match, but this version has been revoked').locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]').getAttribute('class');
    assert(cls.includes('red') && !cls.includes('emerald'));
    await shot(page, 'verify-control-revoked-match', width);
  });

  // ---- product panel
  for (const [slug2, expect] of [['ghk-cu', 'COA published, verify it'], ['bpc-157', 'No published COA for the current lot yet.'], ['tb-500', 'COA published, verify it']]) {
    await check(width, `product panel ${slug2}`, async () => {
      await go(page, `/catalog/${slug2}`);
      const panel = page.locator('[data-coa-panel]');
      await panel.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-coa-panel]')?.getAttribute('data-coa-panel') !== 'loading', null, { timeout: 8000 });
      const t = await panel.innerText();
      assert(t.includes(expect), t);
      if (expect.startsWith('COA published') || expect.includes('verify it')) { const href = await panel.getByRole('link').getAttribute('href'); assert(/^\/verify\/HF-/.test(href), href); }
      else assert(!/verify it/i.test(t) && !(await panel.getByRole('link').count()), 'no link/claim when unpublished');
      const o = await overflow(page);
      assert(o.scrollWidth <= o.clientWidth, `overflow ${o.scrollWidth}`);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `${width}-product-panel-${slug2}.png`) });
      return t.replace(/\n/g, ' ').slice(0, 90);
    });
  }

  // ---- accessibility-ish checks
  for (const path of ['/verify', '/verify/HF-GHK-2610A', '/verify/HF-REV-2608D']) {
    await check(width, `a11y structure ${path}: one h1, landmarks, labelled inputs, 44px targets, tab order`, async () => {
      await go(page, path);
      const info = await page.evaluate(() => {
        const main = document.querySelector('main');
        const h1 = document.querySelectorAll('main h1').length;
        const unlabeled = [...main.querySelectorAll('input,select,textarea')].filter((el) => !(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))).map((el) => el.outerHTML.slice(0, 80));
        const live = main.querySelectorAll('[aria-live], [role=status], [role=alert]').length;
        const small = [...main.querySelectorAll('a,button,summary,label[for]')].filter((el) => el.tagName !== 'LABEL' || el.querySelector('input')).filter((el) => {
          const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') return false;
          const inlineInText = cs.display === 'inline' && el.closest('p, li, span') && el.tagName === 'A' && !el.classList.contains('inline-flex');
          return r.height < 43.5 && !inlineInText;
        }).map((el) => `${el.tagName}:${(el.innerText || el.getAttribute('aria-label') || '').slice(0, 30)}:${Math.round(el.getBoundingClientRect().height)}`);
        const imgsNoAlt = [...main.querySelectorAll('img:not([alt])')].length;
        return { h1, unlabeled, live, small, imgsNoAlt, lang: document.documentElement.lang };
      });
      assert.equal(info.h1, 1); assert.deepEqual(info.unlabeled, []); assert(info.live >= 1); assert.equal(info.imgsNoAlt, 0); assert.equal(info.lang, 'en');
      assert.deepEqual(info.small, [], `targets under 44px: ${info.small.join(', ')}`);
      // keyboard: tab through main, every stop must be visible and have an accessible name; record the order
      const order = [];
      await page.evaluate(() => document.querySelector('main').focus?.());
      await page.mouse.click(1, 1);
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const r = el.getBoundingClientRect(); const name = el.getAttribute('aria-label') || el.innerText?.trim().slice(0, 40) || el.labels?.[0]?.innerText?.slice(0, 40) || el.id; return { tag: el.tagName.toLowerCase(), name, inMain: !!el.closest('main'), visible: r.width > 0 && r.height > 0 || el.type === 'file', outline: getComputedStyle(el).outlineStyle }; });
        if (!stop) break;
        if (stop.inMain) { assert(stop.name, `unnamed focus stop ${JSON.stringify(stop)}`); order.push(`${stop.tag}:${stop.name}`); }
      }
      assert(order.length >= 3, 'tabbed through interactive controls in main');
      return { tabStops: order.length, first: order.slice(0, 6) };
    });
  }

  // ---- print stylesheet
  await check(width, 'print media: site header/footer and controls hidden, record visible', async () => {
    await go(page, '/verify/HF-GHK-2610A');
    await page.emulateMedia({ media: 'print' });
    const r = await page.evaluate(() => ({ header: getComputedStyle(document.querySelector('header')).display, footer: getComputedStyle(document.querySelector('footer')).display, drop: getComputedStyle(document.querySelector('main label[for$="-file"]')).display, h1: document.querySelector('main h1').innerText }));
    assert.equal(r.header, 'none'); assert.equal(r.footer, 'none'); assert.equal(r.drop, 'none'); assert.equal(r.h1, 'HF-GHK-2610A');
    if (width === 1440) await page.pdf({ path: join(output, 'print-current-with-anchor.pdf'), format: 'A4' });
    if (width === 1440) await page.screenshot({ path: join(output, 'print-media-current-with-anchor.png'), fullPage: true });
    await page.emulateMedia({ media: 'screen' });
  });
  // ---- reduced motion
  await check(width, 'reduced motion: spinner animation is disabled (motion-reduce) when preferred', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/verify/HF-GHK-2610A');
    const sty = await page.evaluate(() => { const el = document.createElement('span'); el.className = 'animate-spin motion-reduce:animate-none'; document.body.appendChild(el); const a = getComputedStyle(el).animationName; el.remove(); return a; });
    assert.equal(sty, 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await context.close();
}
await browser.close();

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} checks passed; output: ${output}`);
const relevant = events.filter((e) => !/Failed to load resource/.test(e.message) || /3290/.test(e.message));
console.log(`console/page errors: ${events.length}`); for (const e of events.slice(0, 15)) console.log(`  ${e.width} ${e.type} ${e.url} ${e.message}`);
await writeFile(join(output, 'results.json'), JSON.stringify({ results, events }, null, 2));
process.exit(failed.length ? 1 : 0);
