import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EmailValidationError } from '../email.errors';
import { domainOf, isValidEmailAddress, isValidSender, requireHttpUrl, validateDedupeKey, validateTemplateData } from '../email.validation';

test('addresses: accepts ordinary mailboxes, rejects malformed, over-long and header-injection forms', () => {
  for (const ok of ['a@b.co', 'first.last+tag@sub.example.com', "o'brien@example.org", 'x_y-z@a-b.example.io']) assert.equal(isValidEmailAddress(ok), true, ok);
  const longLocal = `${'a'.repeat(65)}@example.com`;
  const tooLong = `${'a'.repeat(60)}@${`${'b'.repeat(60)}.`.repeat(4)}com`;
  assert.ok(tooLong.length > 254);
  const bad = [
    '', 'plain', '@example.com', 'a@', 'a@b', 'a@@b.co', 'a b@example.com', 'a@exam ple.com', '.a@example.com', 'a.@example.com', 'a..b@example.com',
    'a@-bad.com', 'a@bad-.com', 'a@example..com', 'a@example.123', '<a@example.com>', 'a,b@example.com', 'a;b@example.com', '"a"@example.com',
    'a@example.com\r\nBcc: evil@example.net', 'a@example.com\nBcc: x@y.co', 'a@example.com\r', ' a@example.com', 'a@example.com ', 'a\u0000@example.com',
    'a@exämple.com', 'ä@example.com', 'a@example.com\u2028', longLocal, tooLong,
  ];
  for (const value of bad) assert.equal(isValidEmailAddress(value), false, JSON.stringify(value));
  assert.equal(isValidEmailAddress(undefined), false);
  assert.equal(isValidEmailAddress(42), false);
  const exactly254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  assert.equal(exactly254.length, 254);
  assert.equal(isValidEmailAddress(exactly254), true);
  assert.equal(isValidEmailAddress(`${exactly254}x`), false);
});

test('domainOf returns only the lower-cased domain', () => {
  assert.equal(domainOf('Jane.Doe@Example.COM'), 'example.com');
  assert.equal(domainOf('no-at-sign'), '');
});

test('sender: bare address or Name <address>; nothing else', () => {
  for (const ok of ['shop@example.com', 'Helix & Field <shop@example.com>', 'Helix Field <shop@example.com>']) assert.equal(isValidSender(ok), true, ok);
  for (const bad of ['', 'shop', 'Name <shop>', '<shop@example.com>', 'Na"me <shop@example.com>', 'Name <shop@example.com>\r\nBcc: x@y.co', 'Name <shop@example.com> extra', 'a@b.co, c@d.co', 5]) {
    assert.equal(isValidSender(bad), false, JSON.stringify(bad));
  }
});

test('links: only http(s) without credentials; javascript:, data:, relative, protocol-relative and quote/angle characters are refused', () => {
  assert.equal(requireHttpUrl('link', 'https://shop.example.com/verify-email?token=abc_DEF-123'), 'https://shop.example.com/verify-email?token=abc_DEF-123');
  assert.equal(requireHttpUrl('link', 'http://localhost:3000/reset-password?token=x'), 'http://localhost:3000/reset-password?token=x');
  const bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd',
    '//evil.example.com/x', '/verify-email?token=x', 'verify-email', 'https://', 'https://user:pw@example.com/x', 'https://example.com/x y',
    'https://example.com/"onmouseover="x', 'https://example.com/<script>', "https://example.com/'x", 'https://example.com/a\\b', 'https://example.com/\r\nSet-Cookie: x=1',
    `https://example.com/${'a'.repeat(2100)}`, '', null, undefined, 7,
  ];
  for (const value of bad) assert.throws(() => requireHttpUrl('link', value), EmailValidationError, JSON.stringify(value)?.slice(0, 60));
});

test('template data: exact keys per template, unknown keys rejected, optional keys normalised', () => {
  assert.deepEqual(validateTemplateData('email_verification', { link: 'https://a.example/x?token=1' }), { link: 'https://a.example/x?token=1', name: null });
  assert.deepEqual(validateTemplateData('email_verification', { link: 'https://a.example/x', name: '  Ada  ' }), { link: 'https://a.example/x', name: 'Ada' });
  assert.deepEqual(validateTemplateData('password_reset', { link: 'https://a.example/x' }), { link: 'https://a.example/x' });
  assert.deepEqual(validateTemplateData('order_confirmation', { orderId: 'ord_123', totalCents: 12345, currency: 'USD' }), { orderId: 'ord_123', totalCents: 12345, currency: 'USD' });
  assert.deepEqual(
    validateTemplateData('order_shipped', { orderId: 'o1', carrier: 'USPS', trackingNumber: '9400111899', trackingUrl: null }),
    { orderId: 'o1', carrier: 'USPS', trackingNumber: '9400111899', trackingUrl: null },
  );
  assert.equal((validateTemplateData('order_shipped', { orderId: 'o1', carrier: 'UPS', trackingNumber: '1Z', trackingUrl: 'https://t.example/1Z' }) as any).trackingUrl, 'https://t.example/1Z');

  const rejects: [Parameters<typeof validateTemplateData>[0], unknown][] = [
    ['password_reset', {}], ['password_reset', { link: 'https://a.example/x', extra: 1 }], ['password_reset', null], ['password_reset', []], ['password_reset', 'https://a.example'],
    ['email_verification', { link: 'https://a.example/x', name: 'Ada\r\nBcc: x@y.co' }], ['email_verification', { link: 'https://a.example/x', name: 'x'.repeat(101) }],
    ['email_verification', { link: 'https://a.example/x', name: '' }], ['email_verification', { link: 'https://a.example/x', name: 5 }],
    ['order_confirmation', { orderId: 'o1', totalCents: 12.5, currency: 'USD' }], ['order_confirmation', { orderId: 'o1', totalCents: -1, currency: 'USD' }],
    ['order_confirmation', { orderId: 'o1', totalCents: '100', currency: 'USD' }], ['order_confirmation', { orderId: 'o1', totalCents: 2 ** 31, currency: 'USD' }],
    ['order_confirmation', { orderId: 'o1', totalCents: 100, currency: 'usd' }], ['order_confirmation', { orderId: 'o1', totalCents: 100, currency: 'USDX' }],
    ['order_confirmation', { orderId: 'o\r\n1', totalCents: 100, currency: 'USD' }], ['order_confirmation', { orderId: 'o 1', totalCents: 100, currency: 'USD' }],
    ['order_confirmation', { orderId: '<b>', totalCents: 100, currency: 'USD' }],
    ['order_shipped', { orderId: 'o1', carrier: 'USPS\r\nX: y', trackingNumber: '1' }], ['order_shipped', { orderId: 'o1', carrier: 'USPS', trackingNumber: '1\n2' }],
    ['order_shipped', { orderId: 'o1', carrier: 'USPS', trackingNumber: '1', trackingUrl: 'javascript:alert(1)' }], ['order_shipped', { orderId: 'o1', carrier: '', trackingNumber: '1' }],
    ['order_shipped', { orderId: 'o1', carrier: 'USPS' }],
  ];
  for (const [template, data] of rejects) assert.throws(() => validateTemplateData(template, data), EmailValidationError, `${template} ${JSON.stringify(data)}`);
});

test('validation errors name the field and never echo the value', () => {
  try {
    validateTemplateData('email_verification', { link: 'https://a.example/x', name: 'HIDDENVALUE\r\nvalue' });
    assert.fail('should throw');
  } catch (error) {
    assert.ok(error instanceof EmailValidationError);
    assert.doesNotMatch(error.message, /HIDDENVALUE/);
    assert.match(error.message, /name/);
  }
});

test('dedupe keys: optional, bounded, single line', () => {
  assert.equal(validateDedupeKey(undefined), null);
  assert.equal(validateDedupeKey('order_shipped:o1:1Z'), 'order_shipped:o1:1Z');
  for (const bad of ['', 'x'.repeat(201), 'a\nb', 5]) assert.throws(() => validateDedupeKey(bad), EmailValidationError);
});
