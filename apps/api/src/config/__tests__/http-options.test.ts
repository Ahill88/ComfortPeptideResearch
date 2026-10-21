import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CORS_ALLOWED_HEADERS, CORS_METHODS, buildCorsOptions, parseCorsOrigins, parseTrustProxy, shouldEnableDocs } from '../http-options';

test('parseCorsOrigins: comma list, trimmed, normalised and de-duplicated', () => {
  const parsed = parseCorsOrigins(' http://localhost:3000 , https://Shop.Example.com/ ,https://shop.example.com,, ');
  assert.deepEqual(parsed.origins, ['http://localhost:3000', 'https://shop.example.com']);
  assert.deepEqual(parsed.invalid, []);
  assert.deepEqual(parseCorsOrigins(undefined), { origins: [], invalid: [] });
  assert.deepEqual(parseCorsOrigins('  '), { origins: [], invalid: [] });
});

test('parseCorsOrigins rejects wildcards, null, paths, credentials, non-http schemes, junk', () => {
  const bad = ['*', 'https://*.example.com', 'null', 'https://shop.example.com/path', 'https://shop.example.com?x=1', 'https://u:p@shop.example.com', 'ftp://shop.example.com', 'shop.example.com', 'javascript:alert(1)'];
  for (const entry of bad) {
    const parsed = parseCorsOrigins(`https://ok.example.com,${entry}`);
    assert.deepEqual(parsed.origins, ['https://ok.example.com'], entry);
    assert.equal(parsed.invalid.length, 1, entry);
    assert.equal(parsed.invalid[0].entry, entry);
  }
});

test('buildCorsOptions: explicit allowlist, explicit methods/headers, no wildcard, credentials true (cookie sessions)', () => {
  const cors = buildCorsOptions({ STOREFRONT_ORIGIN: 'http://localhost:3000,https://shop.example.com' });
  assert.deepEqual(cors.origin, ['http://localhost:3000', 'https://shop.example.com']);
  // Cookie sessions: credentials are allowed, but only because the origin list is exact (an `Access-Control-Allow-Origin: *` with credentials would be refused by browsers and is never produced).
  assert.equal(cors.credentials, true);
  assert.ok(Array.isArray(cors.origin) && cors.origin.every((origin) => origin !== '*'));
  assert.ok(!JSON.stringify(cors).includes('*'));
  for (const header of ['Content-Type', 'Idempotency-Key', 'x-customer-email']) assert.ok(cors.allowedHeaders.map((h) => h.toLowerCase()).includes(header.toLowerCase()), header);
  assert.ok(!CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase()).includes('x-admin-token'));
  assert.deepEqual(cors.methods, CORS_METHODS);
  assert.ok(!cors.methods.includes('*'));
});

test('buildCorsOptions: unset or all-invalid STOREFRONT_ORIGIN disables CORS (never falls back to *)', () => {
  assert.equal(buildCorsOptions({}).origin, false);
  assert.equal(buildCorsOptions({ STOREFRONT_ORIGIN: '*' }).origin, false);
});

test('parseTrustProxy: default false; hop counts, keywords and IP/CIDR lists; "true" is rejected', () => {
  for (const raw of [undefined, '', '  ', 'false', 'FALSE', '0']) assert.deepEqual(parseTrustProxy(raw), { value: false }, String(raw));
  assert.deepEqual(parseTrustProxy('1'), { value: 1 });
  assert.deepEqual(parseTrustProxy(' 2 '), { value: 2 });
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8 ,2001:db8::/32,192.168.1.1'), { value: ['loopback', '10.0.0.0/8', '2001:db8::/32', '192.168.1.1'] });
  for (const raw of ['true', 'TRUE', '11', '999', '10.0.0.0/33', '::1/129', 'nonsense', '1.2.3', '10.0.0.0/8/8', 'loopback,evil']) {
    const parsed = parseTrustProxy(raw);
    assert.ok(parsed.error, raw);
    assert.equal(parsed.value, false, `${raw} must fail closed`);
  }
});

test('docs gating: exact development/test, or ENABLE_API_DOCS=true; production and unknown envs hide docs', () => {
  assert.equal(shouldEnableDocs({ NODE_ENV: 'development' }), true);
  assert.equal(shouldEnableDocs({ NODE_ENV: 'test' }), true);
  assert.equal(shouldEnableDocs({ NODE_ENV: 'production' }), false);
  assert.equal(shouldEnableDocs({ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' }), true);
  for (const flag of ['false', 'TRUE', '1', 'yes', '', undefined]) assert.equal(shouldEnableDocs({ NODE_ENV: 'production', ENABLE_API_DOCS: flag }), false, String(flag));
  for (const NODE_ENV of [undefined, 'staging', 'prod', 'Production', '']) {
    assert.equal(shouldEnableDocs({ NODE_ENV }), false, `NODE_ENV=${NODE_ENV}`);
    assert.equal(shouldEnableDocs({ NODE_ENV, ENABLE_API_DOCS: 'true' }), true);
  }
});
