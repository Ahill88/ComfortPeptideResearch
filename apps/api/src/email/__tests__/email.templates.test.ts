import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EmailValidationError } from '../email.errors';
import { escapeHtml, formatMoney, renderEmail } from '../email.templates';
import { EMAIL_TEMPLATES } from '../email.types';

const NOTICE = 'Helix & Field is a research-use-only storefront. Products are sold for laboratory research only. Not for human or veterinary use.';
const VERIFY = 'https://shop.example.com/verify-email?token=abc123';
const RESET = 'https://shop.example.com/reset-password?token=xyz789';
const TRACK = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400&x=1';

test('snapshot: email_verification (with and without a name)', () => {
  const named = renderEmail('email_verification', { link: VERIFY, name: 'Ada' });
  assert.equal(named.subject, 'Confirm your email address');
  assert.equal(
    named.text,
    `Hello Ada,

This address was used to create an account at Helix & Field. Open the link below to confirm it. The link is single-use and time-limited.

Confirm your email address:
${VERIFY}

If you did not create an account, ignore this message. No account is activated until the link is opened.

--
${NOTICE}
`,
  );
  const anonymous = renderEmail('email_verification', { link: VERIFY });
  assert.ok(anonymous.text.startsWith('This address was used'), 'no greeting without a name');
});

test('snapshot: password_reset', () => {
  const r = renderEmail('password_reset', { link: RESET });
  assert.equal(r.subject, 'Reset your password');
  assert.equal(
    r.text,
    `A password reset was requested for your Helix & Field account. Open the link below to choose a new password. The link is single-use and time-limited.

Choose a new password:
${RESET}

If you did not request this, ignore this message. Your password stays the same until the link is used.

--
${NOTICE}
`,
  );
});

test('snapshot: order_confirmation formats money from integer cents', () => {
  const r = renderEmail('order_confirmation', { orderId: 'ord_42', totalCents: 123456, currency: 'USD' });
  assert.equal(r.subject, 'Order confirmation ord_42');
  assert.equal(
    r.text,
    `This message confirms that Helix & Field has recorded your order. It is a record of the order, not a shipping notice. A separate email with tracking details is sent when the order ships.

Order number: ord_42
Order total: $1,234.56 USD

--
${NOTICE}
`,
  );
  assert.match(r.html, /<dd[^>]*>\$1,234\.56 USD<\/dd>/);
});

test('snapshot: order_shipped with and without a tracking URL', () => {
  const withUrl = renderEmail('order_shipped', { orderId: 'ord_7', carrier: 'USPS', trackingNumber: '9400111899', trackingUrl: TRACK });
  assert.equal(withUrl.subject, 'Order ord_7 has shipped');
  assert.equal(
    withUrl.text,
    `Order ord_7 has been handed to the carrier listed below.

Order number: ord_7
Carrier: USPS
Tracking number: 9400111899

Track this shipment:
${TRACK}

--
${NOTICE}
`,
  );
  assert.ok(withUrl.html.includes(`<a href="${escapeHtml(TRACK)}">Track this shipment</a>`), 'anchor present');
  assert.ok(withUrl.html.includes(`<span style="word-break:break-all">${escapeHtml(TRACK)}</span>`), 'link also shown as text');
  const without = renderEmail('order_shipped', { orderId: 'ord_7', carrier: 'OTHER', trackingNumber: 'ABC-1', trackingUrl: null });
  assert.doesNotMatch(without.text, /https?:/);
  assert.doesNotMatch(without.html, /<a /);
  assert.match(without.text, /No tracking link is available/);
  assert.match(without.text, /Tracking number: ABC-1/);
});

test('links appear as an anchor AND as visible text in HTML, and as text in plain text', () => {
  for (const [template, data, url] of [['email_verification', { link: VERIFY }, VERIFY], ['password_reset', { link: RESET }, RESET]] as const) {
    const r = renderEmail(template, data);
    assert.ok(r.html.includes(`href="${url}"`));
    assert.ok(r.html.includes(`>${url}</span>`));
    assert.ok(r.text.includes(`\n${url}\n`));
  }
});

test('accessible, plain HTML: lang, title, heading, no images, no tracking, no scripts, no remote resources', () => {
  const samples = [
    renderEmail('email_verification', { link: VERIFY, name: 'Ada' }), renderEmail('password_reset', { link: RESET }),
    renderEmail('order_confirmation', { orderId: 'o1', totalCents: 5, currency: 'USD' }),
    renderEmail('order_shipped', { orderId: 'o1', carrier: 'UPS', trackingNumber: '1Z', trackingUrl: TRACK }),
  ];
  for (const { html, subject } of samples) {
    assert.match(html, /^<!doctype html>\n<html lang="en">/);
    assert.ok(html.includes(`<title>${escapeHtml(subject)}</title>`));
    assert.match(html, /<h1[ >]/);
    assert.doesNotMatch(html, /<img|<script|<iframe|<link|<style|<video|<audio|<object|<embed|<form|<input|src=|url\(|@import|srcset|\son\w+=/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    for (const href of hrefs) assert.match(href, /^https?:\/\//);
  }
});

test('honest copy: research-use notice in every template; no efficacy, purity or guarantee claims', () => {
  const banned = /guarantee|certified|verified purity|cure|treat|heal|therap|safe for|clinically|proven|FDA|dose|dosage|medical|results/i;
  for (const [template, data] of [
    ['email_verification', { link: VERIFY, name: 'Ada' }], ['password_reset', { link: RESET }],
    ['order_confirmation', { orderId: 'o1', totalCents: 5, currency: 'USD' }],
    ['order_shipped', { orderId: 'o1', carrier: 'UPS', trackingNumber: '1Z', trackingUrl: null }],
  ] as const) {
    const r = renderEmail(template, data);
    assert.ok(r.text.includes('research-use-only'), template);
    assert.ok(r.text.includes('Not for human or veterinary use'), template);
    assert.doesNotMatch(`${r.subject}\n${r.text}`, banned, template);
  }
});

test('hostile input is HTML-escaped everywhere it is interpolated', () => {
  const hostile = `<script>alert(1)</script> "quoted" 'single' & \`tick\``;
  const r = renderEmail('email_verification', { link: 'https://shop.example.com/v?a=1&b=2', name: hostile });
  assert.doesNotMatch(r.html, /<script>/);
  assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &#39;single&#39; &amp; &#96;tick&#96;'));
  assert.ok(r.html.includes('href="https://shop.example.com/v?a=1&amp;b=2"'), 'ampersands in hrefs are escaped');
  assert.ok(r.text.includes(`Hello ${hostile},`), 'plain text keeps the characters verbatim');

  const shipped = renderEmail('order_shipped', { orderId: 'o1', carrier: '<b onmouseover=x>UPS</b>', trackingNumber: '"><img src=x onerror=alert(1)>', trackingUrl: null });
  assert.doesNotMatch(shipped.html, /<b onmouseover|<img/);
  assert.ok(shipped.html.includes('&lt;b onmouseover=x&gt;UPS&lt;/b&gt;'));
  assert.ok(shipped.html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
});

test('header injection: CR/LF in subject-bound or header-ish fields is refused, and no subject ever holds a line break', () => {
  for (const orderId of ['o1\r\nBcc: evil@example.net', 'o1\nX: y', 'o1\r']) {
    assert.throws(() => renderEmail('order_confirmation', { orderId, totalCents: 1, currency: 'USD' }), EmailValidationError);
    assert.throws(() => renderEmail('order_shipped', { orderId, carrier: 'UPS', trackingNumber: '1' }), EmailValidationError);
  }
  assert.throws(() => renderEmail('email_verification', { link: VERIFY, name: 'Ada\r\nSubject: spoof' }), EmailValidationError);
  assert.throws(() => renderEmail('order_shipped', { orderId: 'o1', carrier: 'UPS\r\nBcc: x@y.co', trackingNumber: '1' }), EmailValidationError);
  for (const template of EMAIL_TEMPLATES) {
    const data = { email_verification: { link: VERIFY }, password_reset: { link: RESET }, order_confirmation: { orderId: 'o1', totalCents: 1, currency: 'USD' }, order_shipped: { orderId: 'o1', carrier: 'UPS', trackingNumber: '1' } }[template];
    assert.doesNotMatch(renderEmail(template, data).subject, /[\r\n]/);
  }
});

test('link schemes: javascript:, data: and relative links never render', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', '/verify-email?token=x', '//evil.example/x', 'ftp://example.com/x']) {
    assert.throws(() => renderEmail('password_reset', { link }), EmailValidationError, link);
    assert.throws(() => renderEmail('order_shipped', { orderId: 'o1', carrier: 'UPS', trackingNumber: '1', trackingUrl: link }), EmailValidationError, link);
  }
});

test('unknown templates and non-object data are refused', () => {
  assert.throws(() => renderEmail('marketing_blast', {}), EmailValidationError);
  assert.throws(() => renderEmail('__proto__', {}), EmailValidationError);
  assert.throws(() => renderEmail('constructor', {}), EmailValidationError);
  assert.throws(() => renderEmail('password_reset', undefined), EmailValidationError);
});

test('money: integer arithmetic, grouping, other currencies, edge values', () => {
  assert.equal(formatMoney(0, 'USD'), '$0.00 USD');
  assert.equal(formatMoney(5, 'USD'), '$0.05 USD');
  assert.equal(formatMoney(100, 'USD'), '$1.00 USD');
  assert.equal(formatMoney(199999, 'USD'), '$1,999.99 USD');
  assert.equal(formatMoney(2_147_483_647, 'USD'), '$21,474,836.47 USD');
  assert.equal(formatMoney(1050, 'EUR'), '10.50 EUR');
  assert.throws(() => formatMoney(1.5, 'USD'), EmailValidationError);
  assert.throws(() => formatMoney(-1, 'USD'), EmailValidationError);
});

test('escapeHtml covers & < > " \' and backtick', () => {
  assert.equal(escapeHtml(`&<>"'\``), '&amp;&lt;&gt;&quot;&#39;&#96;');
  assert.equal(escapeHtml('plain text'), 'plain text');
});
