import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { ALLOWED_NODE_ENVS, DENIED_NODE_ENVS, NODE_ENV_MATRIX, envOf, isAllowed, label, withNodeEnv } from '../../config/__tests__/node-env-matrix';
import { assertHeaderIdentityClosedInProductionLike, isHeaderIdentityAllowed, readCustomerEmail, resolveHeaderCustomer, resolveHeaderEmail } from '../customer-identity';

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
