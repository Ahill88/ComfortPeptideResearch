import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ALLOWED_NODE_ENVS, DENIED_NODE_ENVS, NODE_ENV_MATRIX, envOf, isAllowed, label, withNodeEnv } from '../../config/__tests__/node-env-matrix';
import {
  assertAllowedOrigin, assertHeaderIdentityClosedInProductionLike, isHeaderIdentityAllowed, readCustomerEmail, readSessionCookieToken, resolveHeaderCustomer, resolveHeaderEmail, resolveRequestCustomer, resolveRequestIdentity,
} from '../customer-identity';

const HEADERS = { 'x-customer-email': ' Buyer@Example.com ' };

describe('shared header identity resolver: NODE_ENV matrix', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: header identity ${isAllowed(value) ? 'honored' : 'denied (401)'}`, async () => {
      const env = envOf(value);
      assert.equal(isHeaderIdentityAllowed(env), isAllowed(value));
      let lookups = 0;
      const lookup = async (email: string) => (lookups++, email === 'buyer@example.com' ? { id: 'cus_1' } : null);
      if (isAllowed(value)) {
        assert.equal(resolveHeaderEmail(HEADERS, env), 'buyer@example.com');
        assert.equal(readCustomerEmail(HEADERS, value), 'buyer@example.com');
        assert.deepEqual(await resolveHeaderCustomer(HEADERS, lookup, env), { email: 'buyer@example.com', customer: { id: 'cus_1' } });
        assert.equal(await withNodeEnv(value, () => readCustomerEmail(HEADERS)), 'buyer@example.com', 'process.env default');
      } else {
        assert.throws(() => resolveHeaderEmail(HEADERS, env), UnauthorizedException);
        assert.throws(() => readCustomerEmail(HEADERS, value), UnauthorizedException);
        await assert.rejects(resolveHeaderCustomer(HEADERS, lookup, env), UnauthorizedException);
        await withNodeEnv(value, () => assert.throws(() => readCustomerEmail(HEADERS), UnauthorizedException));
        assert.equal(lookups, 0, 'a denied runtime never reaches the customer lookup');
      }
    });
  }

  test('allowed runtimes still require a single, well-formed header and an existing customer', async () => {
    for (const value of ALLOWED_NODE_ENVS) {
      const env = envOf(value);
      for (const headers of [{}, { 'x-customer-email': '' }, { 'x-customer-email': '   ' }, { 'x-customer-email': 'nope' }, { 'x-customer-email': ['a@example.com'] }, { 'x-customer-email': 'a b@example.com' }, { 'x-customer-email': `${'a'.repeat(250)}@example.com` }]) {
        assert.throws(() => resolveHeaderEmail(headers, env), UnauthorizedException, `${label(value)} ${JSON.stringify(headers)}`);
      }
      assert.throws(() => resolveHeaderEmail(undefined, env), UnauthorizedException);
      await assert.rejects(resolveHeaderCustomer(HEADERS, async () => null, env), UnauthorizedException);
    }
  });

  test('explicit undefined nodeEnv is evaluated as unset (not silently replaced by process.env)', async () => {
    await withNodeEnv('test', () => {
      assert.equal(readCustomerEmail(HEADERS), 'buyer@example.com');
      assert.throws(() => readCustomerEmail(HEADERS, undefined), UnauthorizedException);
    });
  });
});

describe('startup assertion: header identity unreachable in production-like runtimes', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: assertion passes (gate closed by construction)`, () => {
      assert.doesNotThrow(() => assertHeaderIdentityClosedInProductionLike(envOf(value)));
    });
  }

  test('a weakened gate (resolver that accepts the probe header) fails startup for every denied runtime', () => {
    const weakened = (() => 'startup-probe@example.com') as typeof resolveHeaderEmail;
    for (const value of DENIED_NODE_ENVS) {
      assert.throws(() => assertHeaderIdentityClosedInProductionLike(envOf(value), weakened), /header identity is reachable/, label(value));
    }
    for (const value of ALLOWED_NODE_ENVS) assert.doesNotThrow(() => assertHeaderIdentityClosedInProductionLike(envOf(value), weakened));
  });

  test('unexpected resolver errors are not swallowed', () => {
    const broken = (() => { throw new TypeError('boom'); }) as typeof resolveHeaderEmail;
    assert.throws(() => assertHeaderIdentityClosedInProductionLike({ NODE_ENV: 'production' }, broken), TypeError);
  });
});

/* ------------------------------------------------------------------------------ cookie (session) identity */

const TOKEN = 'T'.repeat(43);
const SESSION = { customerId: 'cus_1', email: 'cookie@example.com', sessionId: 'ses_1' };
const ORIGIN = 'https://shop.example.com';
const withEnv = (value: string | undefined, extra: Record<string, string> = {}) => envOf(value, { STOREFRONT_ORIGIN: `${ORIGIN},http://localhost:3000`, ...extra });
const SAFE = ['GET', 'HEAD', 'OPTIONS'];
const UNSAFE = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('identity resolver matrix: NODE_ENV x {header, cookie, both, none} x method x Origin', () => {
  for (const value of NODE_ENV_MATRIX) {
    const allowed = isAllowed(value);
    const env = withEnv(value);

    test(`NODE_ENV=${label(value)}: header only -> ${allowed ? 'accepted, no Origin needed' : '401 (never read)'}`, () => {
      for (const method of [...SAFE, ...UNSAFE]) {
        const req = { method, headers: HEADERS };
        if (allowed) assert.deepEqual(resolveRequestIdentity(req, env), { source: 'header', email: 'buyer@example.com' }, method);
        else assert.throws(() => resolveRequestIdentity(req, env), UnauthorizedException, method);
      }
    });

    test(`NODE_ENV=${label(value)}: cookie only -> accepted in every runtime; state changes also need an allow-listed Origin`, () => {
      for (const method of SAFE) assert.deepEqual(resolveRequestIdentity({ method, headers: {}, customerSession: SESSION }, env), { source: 'session', ...SESSION }, method);
      for (const method of UNSAFE) {
        assert.deepEqual(resolveRequestIdentity({ method, headers: { origin: ORIGIN }, customerSession: SESSION }, env), { source: 'session', ...SESSION }, method);
        assert.deepEqual(resolveRequestIdentity({ method: method.toLowerCase(), headers: { origin: 'http://localhost:3000' }, customerSession: SESSION }, env).source, 'session', 'method case');
        for (const origin of [undefined, '', 'null', 'https://evil.example', `${ORIGIN}.evil.example`, `${ORIGIN}/`, 'http://shop.example.com', ['https://shop.example.com', 'https://shop.example.com']]) {
          assert.throws(() => resolveRequestIdentity({ method, headers: { origin }, customerSession: SESSION }, env), ForbiddenException, `${method} ${JSON.stringify(origin)}`);
        }
      }
      assert.throws(() => resolveRequestIdentity({ headers: { origin: 'https://evil.example' }, customerSession: SESSION }, env), ForbiddenException, 'a request without a method is treated as state-changing');
    });

    test(`NODE_ENV=${label(value)}: header and cookie together -> ${allowed ? 'the header decides (no CSRF rule)' : 'the cookie decides; the header cannot override it'}`, () => {
      const req = { method: 'POST', headers: HEADERS, customerSession: SESSION };
      if (allowed) assert.deepEqual(resolveRequestIdentity(req, env), { source: 'header', email: 'buyer@example.com' });
      else assert.throws(() => resolveRequestIdentity(req, env), ForbiddenException, 'no Origin');
      assert.deepEqual(resolveRequestIdentity({ ...req, headers: { ...HEADERS, origin: ORIGIN } }, env), allowed ? { source: 'header', email: 'buyer@example.com' } : { source: 'session', ...SESSION });
    });

    test(`NODE_ENV=${label(value)}: neither -> 401, and a malformed header in an allowed runtime is 401 even with a cookie`, () => {
      for (const method of [...SAFE, ...UNSAFE]) assert.throws(() => resolveRequestIdentity({ method, headers: {} }, env), UnauthorizedException);
      assert.throws(() => resolveRequestIdentity(undefined, env), UnauthorizedException);
      if (allowed) assert.throws(() => resolveRequestIdentity({ method: 'GET', headers: { 'x-customer-email': 'nope' }, customerSession: SESSION }, env), UnauthorizedException);
    });

    test(`NODE_ENV=${label(value)}: resolveRequestCustomer maps either identity through the one lookup`, async () => {
      const lookup = async (email: string) => (email === 'cookie@example.com' || email === 'buyer@example.com' ? { id: `id:${email}` } : null);
      assert.deepEqual(await resolveRequestCustomer({ method: 'GET', headers: {}, customerSession: SESSION }, lookup, env), { email: 'cookie@example.com', customer: { id: 'id:cookie@example.com' } });
      await assert.rejects(resolveRequestCustomer({ method: 'GET', headers: {}, customerSession: { ...SESSION, email: 'gone@example.com' } }, lookup, env), UnauthorizedException);
      if (allowed) assert.deepEqual(await resolveRequestCustomer({ method: 'GET', headers: HEADERS }, lookup, env), { email: 'buyer@example.com', customer: { id: 'id:buyer@example.com' } });
      else await assert.rejects(resolveRequestCustomer({ method: 'GET', headers: HEADERS }, lookup, env), UnauthorizedException);
    });
  }

  test('an empty or missing STOREFRONT_ORIGIN allow-list refuses every cookie-authenticated state change', () => {
    for (const origins of [undefined, '', '  ', '*', 'not a url']) {
      const env = envOf('test', origins === undefined ? {} : { STOREFRONT_ORIGIN: origins });
      assert.throws(() => resolveRequestIdentity({ method: 'POST', headers: { origin: ORIGIN }, customerSession: SESSION }, env), ForbiddenException, String(origins));
      assert.equal(resolveRequestIdentity({ method: 'GET', headers: {}, customerSession: SESSION }, env).source, 'session');
    }
  });

  test('the @CustomerEmail decorator path uses the same resolver (cookie in production, header only in development/test)', () => {
    const production = withEnv('production');
    assert.equal(resolveRequestIdentity({ method: 'GET', headers: {}, customerSession: SESSION }, production).email, 'cookie@example.com');
    assert.throws(() => readCustomerEmail(HEADERS, 'production'), UnauthorizedException, 'header-only wrapper stays closed in production');
  });
});

describe('session cookie parsing', () => {
  const read = (cookie: unknown) => readSessionCookieToken({ cookie });
  test('accepts exactly one well-formed 43-character base64url value', () => {
    assert.equal(read(`hf_session=${TOKEN}`), TOKEN);
    assert.equal(read(`a=1; hf_session=${TOKEN}; b=2`), TOKEN);
    assert.equal(read(` hf_session = ${TOKEN} `), TOKEN);
    assert.equal(read([`a=1`, `hf_session=${TOKEN}`]), TOKEN);
    assert.equal(read(`hf_session=${'a-_Z09'.repeat(7)}a`), 'a-_Z09'.repeat(7) + 'a');
  });
  test('rejects missing, duplicated, wrong-length, wrong-alphabet, look-alike names and oversized headers', () => {
    for (const bad of [undefined, '', 'hf_session=', `hf_session=${TOKEN.slice(1)}`, `hf_session=${TOKEN}x`, `hf_session=${TOKEN.slice(1)}+`, `hf_session="${TOKEN}"`, `x_hf_session=${TOKEN}`, `hf_session2=${TOKEN}`, `HF_SESSION=${TOKEN}`, `hf_session=${TOKEN}; hf_session=${TOKEN}`, `hf_session=${TOKEN}; hf_session=${'U'.repeat(43)}`, `hf_session${TOKEN}`, `a=${'x'.repeat(9000)}; hf_session=${TOKEN}`, 5, {}]) {
      assert.equal(read(bad), null, String(bad).slice(0, 60));
    }
    assert.equal(readSessionCookieToken(undefined), null);
  });
});

describe('assertAllowedOrigin', () => {
  test('exact match against the STOREFRONT_ORIGIN allow-list only', () => {
    const env = { STOREFRONT_ORIGIN: 'https://shop.example.com, http://localhost:3000/' };
    assert.doesNotThrow(() => assertAllowedOrigin({ origin: 'https://shop.example.com' }, env));
    assert.doesNotThrow(() => assertAllowedOrigin({ origin: ' http://localhost:3000 ' }, env));
    for (const origin of [undefined, '', 'https://shop.example.com/', 'https://shop.example.com:443', 'https://SHOP.example.com', 'https://shop.example.com.', 'https://evil.example', 'null', '*', ['https://shop.example.com']]) {
      assert.throws(() => assertAllowedOrigin({ origin }, env), ForbiddenException, String(origin));
    }
    assert.throws(() => assertAllowedOrigin(undefined, env), ForbiddenException);
    assert.deepEqual(((): unknown => { try { assertAllowedOrigin({}, env); } catch (e) { return (e as ForbiddenException).getResponse(); } })(), { message: 'Origin not allowed.' });
  });
});
