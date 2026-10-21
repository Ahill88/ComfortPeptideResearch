import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addressError, InvalidAuthResponse, nameError, normalizeEmail, parseAddress, parseAddresses, parseCustomer, parseEligibility, parseEnrollment, parseSession, passwordError, validCode, validEmail, validToken } from '../../apps/storefront/lib/auth/validation';
import { loginPath, sanitizeNextPath } from '../../apps/storefront/lib/auth/navigation';
import { defaultAddress, formatAddress, formatShippingAddress } from '../../apps/storefront/lib/auth/addresses';
import type { Address } from '../../apps/storefront/lib/auth/types';

const customer = { id: 'customer-1', email: 'researcher@example.org', name: null, emailVerified: true, mfaEnabled: false };
const address: Address = { id: 'address-1', label: 'Lab', recipient: 'A. Researcher', line1: '10 Science Road', line2: null, city: 'Boston', region: 'MA', postalCode: '02110', country: 'US', isDefault: true };

test('password policy boundaries agree with the API without trimming passwords', () => {
  for (const p of ['a'.repeat(12), 'a'.repeat(256), ' '.repeat(12)]) assert.equal(passwordError(p), null);
  for (const p of ['', 'a'.repeat(11), 'a'.repeat(257), undefined, 123]) assert.ok(passwordError(p));
});
test('email normalizes case/whitespace, refuses invalid and oversized addresses', () => {
  assert.equal(normalizeEmail(' Researcher@Example.ORG '), customer.email);
  assert.equal(validEmail(' Researcher@Example.ORG '), true);
  for (const email of ['', 'a@b', 'a@@b.org', 'a b@example.org', `${'a'.repeat(65)}@example.org`, `${'a'.repeat(64)}@${'b'.repeat(190)}.org`, null]) assert.equal(validEmail(email), false);
});
test('name validation supports removal but rejects control characters and overlong names', () => {
  for (const name of ['', 'A. Researcher', 'a'.repeat(120)]) assert.equal(nameError(name), null);
  for (const name of ['a'.repeat(121), 'Name\u0000', 'Line\nBreak']) assert.ok(nameError(name));
});
test('TOTP codes retain leading zeroes; links require the exact opaque token shape', () => {
  assert.equal(validCode(' 012345 '), true);
  for (const code of ['12345', '1234567', '123 456', 'abcdef']) assert.equal(validCode(code), false);
  assert.equal(validToken('a_B-'.repeat(10) + 'abc'), true);
  for (const token of ['', 'a'.repeat(42), 'a'.repeat(44), '.'.repeat(43), null]) assert.equal(validToken(token), false);
});
test('customer parser selects safe fields and accepts nullable names', () => {
  assert.deepEqual(parseCustomer({ ...customer, passwordHash: 'not-public', token: 'not-public' }), customer);
  assert.deepEqual(parseSession({ customer }), customer);
});
test('preview session and malformed customer data cannot establish identity', () => {
  const preview = { name: 'Preview', email: customer.email, verified: true, eligible: true, mfaEnabled: false };
  for (const raw of [preview, null, [], { ...customer, emailVerified: 'true' }, { ...customer, mfaEnabled: 1 }, { ...customer, name: undefined }, { ...customer, id: '' }, { ...customer, email: 'bad' }]) assert.throws(() => parseCustomer(raw), InvalidAuthResponse);
  assert.throws(() => parseSession(customer), InvalidAuthResponse);
});
test('eligibility only accepts the server status enum, never a browser boolean', () => {
  for (const status of ['NOT_REQUESTED', 'PENDING', 'APPROVED', 'REJECTED']) assert.equal(parseEligibility({ status }), status);
  for (const raw of [{ eligible: true }, { status: 'approved' }, { status: true }, null]) assert.throws(() => parseEligibility(raw), InvalidAuthResponse);
});
test('MFA setup must be a TOTP URI whose seed matches the displayed setup key', () => {
  const seedBase32 = 'JBSWY3DPEHPK3PXP';
  const good = { seedBase32, otpauthUri: `otpauth://totp/Helix:researcher?secret=${seedBase32}` };
  assert.deepEqual(parseEnrollment(good), good);
  for (const raw of [{ ...good, otpauthUri: 'javascript:alert(1)' }, { ...good, otpauthUri: 'https://example.org' }, { ...good, otpauthUri: 'otpauth://totp/x?secret=DIFFERENT' }, { ...good, seedBase32: 'bad seed' }, { ...good, otpauthUri: good.otpauthUri.replace('totp', 'hotp') }]) assert.throws(() => parseEnrollment(raw), InvalidAuthResponse);
});
test('address parser requires all fields and limits; public fields only', () => {
  assert.deepEqual(parseAddress({ ...address, customerId: 'private' }), address);
  for (const raw of [{ ...address, recipient: '' }, { ...address, country: 'usa' }, { ...address, label: undefined }, { ...address, line1: 'x'.repeat(161) }, { ...address, postalCode: '02110\n' }, { ...address, isDefault: 'true' }]) assert.throws(() => parseAddress(raw), InvalidAuthResponse);
});
test('address list rejects missing/multiple defaults, duplicates, and more than twenty records', () => {
  assert.deepEqual(parseAddresses({ items: [] }), []);
  assert.deepEqual(parseAddresses({ items: [address] }), [address]);
  for (const items of [[{ ...address, isDefault: false }], [address, { ...address, id: '2' }], [address, { ...address, isDefault: false }], Array.from({ length: 21 }, (_, i) => ({ ...address, id: String(i), isDefault: i === 0 }))]) assert.throws(() => parseAddresses({ items }), InvalidAuthResponse);
});
test('address form validation matches backend lengths, nullable lines, and ISO-2 normalization', () => {
  assert.equal(addressError({ ...address, country: ' us ' }), null);
  assert.equal(addressError({ ...address, label: null, line2: null }), null);
  for (const update of [{ recipient: ' ' }, { line1: 'a'.repeat(161) }, { line2: 'a\nb' }, { postalCode: 'x'.repeat(33) }, { country: 'USA' }]) assert.ok(addressError({ ...address, ...update }));
});
test('formatter preserves fulfillment fields without empty lines or internal label/id', () => {
  assert.equal(formatAddress(address), 'A. Researcher\n10 Science Road\nBoston, MA 02110\nUS');
  assert.equal(formatShippingAddress({ ...address, line2: ' Suite 4 ' }), 'A. Researcher\n10 Science Road\nSuite 4\nBoston, MA 02110\nUS');
  assert.equal(formatAddress({ ...address, country: 'gb', city: 'London', region: 'London', postalCode: 'SW1A 1AA' }).split('\n').at(-1), 'GB');
});
test('checkout chooses only an explicit server default', () => {
  assert.equal(defaultAddress([]), null);
  assert.equal(defaultAddress([{ ...address, isDefault: false }]), null);
  assert.equal(defaultAddress([{ ...address, id: 'other', isDefault: false }, address]), address);
});
test('safe next paths preserve local query/fragment and percent-encoded identifiers', () => {
  for (const path of ['/account', '/orders/order-123?from=account#shipment', '/checkout', '/catalog/ghk%2Dcu']) assert.equal(sanitizeNextPath(path), path);
  assert.equal(loginPath('/orders/order-123?from=account#shipment'), '/login?next=%2Forders%2Forder-123%3Ffrom%3Daccount%23shipment');
});
test('next path rejects absolute, scheme-relative, slash/backslash, control and encoded redirect tricks', () => {
  for (const value of [undefined, [], '', 'https://evil.example', '//evil.example', 'javascript:alert(1)', '\\evil', '/\\evil', '/%5cevil', '/%2fevil', '/%252fevil', '/%255cevil', '/%0d%0aLocation:https://evil', '/\tevil', ' /checkout', '/%zz', '/'.repeat(2050), '/%2525252525252525252fevil']) assert.equal(sanitizeNextPath(value), '/account', String(value));
});
