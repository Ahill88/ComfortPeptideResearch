/**
 * Customer accounts over HTTP against the in-memory Prisma double (no database), plus unit tests of the pure pieces.
 * The same scenarios run on PostgreSQL in customer-auth.integration.test.ts.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { Logger, type LoggerService } from '@nestjs/common';
import { NODE_ENV_MATRIX, envOf, isAllowed, label } from '../../config/__tests__/node-env-matrix';
import { selectRateLimitBucket } from '../../config/rate-limit';
import { buildClearedSessionCookie, buildSessionCookie, customerOtpauthUri, loadCustomerMfaKey, parseStorefrontUrl, sha256Hex, storefrontBaseUrl } from '../auth.config';
import { parseAddress, parseLogin, parseRegister, parseResetConfirm } from '../auth.validation';
import { CustomerSessionMiddleware, CustomerSessionService } from '../customer-session.service';
import { ORIGIN, TEST_PASSWORD, startHarness, type Harness } from './harness';
import { createInMemoryCustomerPrisma } from './in-memory-customer-prisma';
import { registerScenarios } from './scenarios';

let harness: Harness;
let throttled: Harness;
let noEmail: Harness;
before(async () => {
  harness = await startHarness(createInMemoryCustomerPrisma());
  throttled = await startHarness(createInMemoryCustomerPrisma(), { throttleAuthLimit: 3 });
  noEmail = await startHarness(createInMemoryCustomerPrisma(), { noEmailPort: true });
});
after(async () => {
  await harness?.close();
  await throttled?.close();
  await noEmail?.close();
});

registerScenarios('in-memory', () => harness);

/** Collects every Nest log line so tests can prove what is (not) logged. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const sink: LoggerService = {
    log: (m: unknown) => void lines.push(String(m)),
    warn: (m: unknown) => void lines.push(String(m)),
    error: (m: unknown) => void lines.push(String(m)),
    debug: (m: unknown) => void lines.push(String(m)),
    verbose: (m: unknown) => void lines.push(String(m)),
  };
  Logger.overrideLogger(sink);
  return { lines, restore: () => Logger.overrideLogger(false) };
}

describe('wiring', () => {
  test('every contract route exists and refuses an anonymous caller (never 404/500)', async () => {
    const routes: [string, string, number[]][] = [
      ['POST', '/auth/register', [400]], ['POST', '/auth/email-verification/confirm', [400]], ['POST', '/auth/login', [401]], ['POST', '/auth/logout', [204]],
      ['GET', '/auth/session', [401]], ['POST', '/auth/password-reset/request', [400]], ['POST', '/auth/password-reset/confirm', [400]],
      ['POST', '/auth/mfa/enroll', [401]], ['POST', '/auth/mfa/enroll/confirm', [401]], ['POST', '/auth/mfa/disable', [401]],
      ['GET', '/auth/profile', [401]], ['PATCH', '/auth/profile', [401]], ['GET', '/auth/addresses', [401]], ['POST', '/auth/addresses', [401]],
      ['PATCH', '/auth/addresses/x', [401]], ['DELETE', '/auth/addresses/x', [401]],
    ];
    for (const [method, path, statuses] of routes) {
      const res = await harness.call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.ok(statuses.includes(res.status), `${method} ${path}: ${res.status} ${res.text}`);
    }
  });

  test('GET /account/eligibility is served through the same cookie identity (SessionGuard on AccountController)', async () => {
    const customer = await harness.makeCustomer('account-route');
    const cookie = await harness.signIn(customer);
    const res = await harness.call('GET', '/account/eligibility', { cookie });
    assert.notEqual(res.status, 401, res.text);
    assert.equal((await harness.call('GET', '/account/eligibility')).status, 401);
  });

  test('no 503 stubs remain: nothing answers "persistence is not configured"', async () => {
    const res = await harness.call('POST', '/auth/login', { body: { email: 'a@example.test', password: TEST_PASSWORD } });
    assert.equal(res.status, 401);
    assert.ok(!/persistence|unavailable/i.test(res.text));
  });
});

describe('startup and API documentation', () => {
  test('AuthModule initialises (module init gate included) in every production-like NODE_ENV with the features in place, and its routes are documented', async () => {
    const { Global, Module } = await import('@nestjs/common');
    const { Test } = await import('@nestjs/testing');
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const { PrismaService } = await import('../../prisma.service');
    const { AuthModule } = await import('../auth.module');
    const { withNodeEnv } = await import('../../config/__tests__/node-env-matrix');
    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: createInMemoryCustomerPrisma() }], exports: [PrismaService] })
    class PrismaStub {}
    for (const value of NODE_ENV_MATRIX) {
      await withNodeEnv(value, async () => {
        const logs = captureLogs();
        try {
          const moduleRef = await Test.createTestingModule({ imports: [PrismaStub, AuthModule] }).compile();
          const app = moduleRef.createNestApplication({ logger: false });
          await app.init();
          if (value === 'production') {
            const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('t').build());
            for (const path of ['/auth/register', '/auth/login', '/auth/logout', '/auth/session', '/auth/password-reset/request', '/auth/password-reset/confirm', '/auth/email-verification/confirm', '/auth/mfa/enroll', '/auth/mfa/enroll/confirm', '/auth/mfa/disable', '/auth/profile', '/auth/addresses', '/auth/addresses/{id}']) {
              assert.ok(document.paths[path], `${path} is documented`);
            }
          }
          await app.close();
        } finally {
          logs.restore();
        }
      });
    }
  });
});

describe('rate limiting (real throttler)', () => {
  test('credential routes share the strict "auth" bucket; session/profile/addresses/logout do not', async () => {
    for (const path of ['/v1/auth/register', '/v1/auth/login', '/v1/auth/password-reset/request', '/v1/auth/password-reset/confirm', '/v1/auth/email-verification/confirm', '/v1/auth/mfa/disable']) {
      assert.equal(selectRateLimitBucket(path), 'auth', path);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await throttled.call('POST', '/auth/login', { body: { email: 'a@example.test', password: 'wrong password 1234!' } })).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    assert.ok((await throttled.call('POST', '/auth/register', { body: {} })).status === 429, 'register shares the bucket with login');
    assert.equal((await throttled.call('GET', '/auth/session')).status, 401, 'session checks are not throttled by the credential bucket');
    const customer = await throttled.makeCustomer('throttle-session');
    assert.equal((await throttled.call('GET', '/auth/profile')).status, 401);
    assert.ok(customer.id);
  });
});

describe('email port and logging', () => {
  test('without an email port registration and reset still answer the same 202 bodies and log a warning', async () => {
    const logs = captureLogs();
    try {
      const reference = await harness.call('POST', '/auth/register', { body: { email: harness.email('noport-ref'), password: TEST_PASSWORD } });
      const res = await noEmail.call('POST', '/auth/register', { body: { email: noEmail.email('noport'), password: TEST_PASSWORD } });
      assert.equal(res.status, 202);
      assert.equal(res.text, reference.text);
      const known = await noEmail.makeCustomer('noport-known');
      const reset = await noEmail.call('POST', '/auth/password-reset/request', { body: { email: known.email } });
      assert.equal(reset.status, 202);
      assert.ok(logs.lines.some((l) => /email port is not bound: email_verification was not sent/.test(l)));
      assert.ok(logs.lines.some((l) => /email port is not bound: password_reset was not sent/.test(l)));
    } finally {
      logs.restore();
    }
    assert.equal(noEmail.emails.length, 0);
  });

  test('a failing email port does not change the response or leak', async () => {
    const original = harness.emails.push;
    const customer = await harness.makeCustomer('mailfail');
    (harness.emails as any).push = () => { throw new Error('provider down'); };
    try {
      const res = await harness.call('POST', '/auth/password-reset/request', { body: { email: customer.email } });
      assert.equal(res.status, 202);
      assert.equal(res.body.message, (await harness.call('POST', '/auth/password-reset/request', { body: { email: 'nobody-here@example.test' } })).body.message);
    } finally {
      (harness.emails as any).push = original;
    }
  });

  test('security events are logged with event name and customer id only: never an email address, password, token, code or cookie', async () => {
    const logs = captureLogs();
    const email = harness.email('logs');
    const password = 'a very distinctive password 31337!';
    try {
      await harness.call('POST', '/auth/register', { body: { email, password, name: 'Log Tester' } });
      const verifyToken = harness.tokenFor(email, 'email_verification');
      await harness.call('POST', '/auth/email-verification/confirm', { body: { token: verifyToken } });
      await harness.call('POST', '/auth/login', { body: { email, password: 'wrong password 1234!' } });
      const login = await harness.call('POST', '/auth/login', { body: { email, password } });
      const cookie = login.cookies[0].split(';')[0];
      await harness.call('POST', '/auth/password-reset/request', { body: { email } });
      const resetToken = harness.tokenFor(email, 'password_reset');
      await harness.call('POST', '/auth/password-reset/confirm', { body: { token: resetToken, newPassword: 'another distinctive pass 4242!' } });
      await harness.call('POST', '/auth/login', { body: { email: harness.email('logs-unknown'), password } });
      const joined = logs.lines.join('\n');
      assert.ok(/security_event=register\.requested customer=\S+/.test(joined));
      assert.ok(/security_event=email\.verified/.test(joined));
      assert.ok(/security_event=login\.succeeded/.test(joined));
      assert.ok(/security_event=login\.failed customer=\S+ reason=bad_password/.test(joined));
      assert.ok(/security_event=password_reset\.completed/.test(joined));
      for (const secretish of [email, email.split('@')[0], password, 'another distinctive pass', verifyToken, resetToken, cookie.split('=')[1], 'Log Tester', '@']) {
        assert.ok(!joined.includes(secretish), `log output must not contain ${secretish.slice(0, 12)}...`);
      }
    } finally {
      logs.restore();
    }
  });
});

describe('config helpers', () => {
  test('storefrontBaseUrl: STOREFRONT_PUBLIC_URL, localhost fallback only in development/test', () => {
    for (const value of NODE_ENV_MATRIX) {
      assert.equal(storefrontBaseUrl(envOf(value, { STOREFRONT_PUBLIC_URL: 'https://shop.example.com/' })), 'https://shop.example.com', label(value));
      assert.equal(storefrontBaseUrl(envOf(value)), isAllowed(value) ? 'http://localhost:3000' : null, label(value));
      assert.equal(storefrontBaseUrl(envOf(value, { STOREFRONT_PUBLIC_URL: '  ' })), isAllowed(value) ? 'http://localhost:3000' : null, label(value));
      assert.equal(storefrontBaseUrl(envOf(value, { STOREFRONT_PUBLIC_URL: 'garbage' })), null, `${label(value)}: a broken value never falls back`);
    }
    for (const bad of ['ftp://x.example.com', 'https://u:p@x.example.com', 'https://x.example.com/?a=1', 'https://x.example.com/#f', 'javascript:alert(1)', '//x.example.com']) assert.equal(parseStorefrontUrl(bad), null, bad);
    assert.equal(parseStorefrontUrl('https://x.example.com/app/'), 'https://x.example.com/app');
  });

  test('cookie builders: exact attribute strings; Secure follows the allowlist', () => {
    const token = 'A'.repeat(43);
    for (const value of NODE_ENV_MATRIX) {
      const secure = isAllowed(value) ? '' : '; Secure';
      assert.equal(buildSessionCookie(token, envOf(value)), `hf_session=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax${secure}`, label(value));
      assert.equal(buildClearedSessionCookie(envOf(value)), `hf_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${secure}`, label(value));
    }
  });

  test('CUSTOMER_MFA_ENCRYPTION_KEY: >= 32 characters, domain-separated from the admin key', async () => {
    assert.equal(loadCustomerMfaKey({}), null);
    assert.equal(loadCustomerMfaKey({ CUSTOMER_MFA_ENCRYPTION_KEY: 'x'.repeat(31) }), null);
    const key = loadCustomerMfaKey({ CUSTOMER_MFA_ENCRYPTION_KEY: 'x'.repeat(32) }) as Buffer;
    assert.equal(key.length, 32);
    const admin = (await import('../../admin/auth/credentials')).loadMfaKey({ ADMIN_MFA_ENCRYPTION_KEY: 'x'.repeat(32) }) as Buffer;
    assert.notDeepEqual(key, admin, 'the same material yields different keys for admins and customers');
  });

  test('otpauth URI uses the customer issuer and never the admin one', () => {
    const uri = customerOtpauthUri('a+b@example.com', 'JBSWY3DPEHPK3PXP');
    assert.ok(uri.startsWith('otpauth://totp/Helix%20%26%20Field:a%2Bb%40example.com?'));
    assert.ok(!/Admin/.test(uri));
    assert.ok(uri.includes('digits=6') && uri.includes('period=30'));
  });

  test('sha256Hex matches the standard digest', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('validation', () => {
  test('parseRegister / parseLogin / parseResetConfirm / parseAddress edge cases', () => {
    assert.deepEqual(parseRegister({ email: ' A@Example.COM ', password: 'p'.repeat(12) }), { email: 'a@example.com', password: 'p'.repeat(12), name: null });
    assert.throws(() => parseRegister(null), { status: 400 });
    assert.throws(() => parseRegister([]), { status: 400 });
    assert.equal(parseLogin({ email: 'a@example.com', password: 'x', totp: ' 123456 ' })?.totp, '123456');
    assert.equal(parseLogin({ email: 'a@example.com', password: '' }), null);
    assert.equal(parseLogin('string'), null);
    assert.throws(() => parseResetConfirm({ token: 'x'.repeat(43), newPassword: 'short' }), /at least 12/);
    assert.throws(() => parseAddress({ isDefault: true, city: 'x' }, false), { status: 400 });
    assert.deepEqual(parseAddress({ city: ' Rome ' }, true), { city: 'Rome' });
    assert.throws(() => parseAddress({ unknown: 1 }, true), /Nothing to update/);
  });
});

describe('CustomerSessionMiddleware', () => {
  const token = 'B'.repeat(43);
  const run = async (sessions: Partial<CustomerSessionService>, req: Record<string, unknown>) => {
    let called = 0;
    await new CustomerSessionMiddleware(sessions as CustomerSessionService).use(req as never, {}, () => { called += 1; });
    assert.equal(called, 1, 'always continues');
    return req;
  };

  test('attaches the identity for a valid cookie and discards any client-supplied value', async () => {
    const identity = { customerId: 'c1', email: 'a@example.com', sessionId: 's1' };
    const req = await run({ resolveQuietly: async (t: string) => (t === token ? identity : null) }, { headers: { cookie: `hf_session=${token}` }, customerSession: { customerId: 'evil', email: 'evil@example.com', sessionId: 'x' } });
    assert.deepEqual(req.customerSession, identity);
    const none = await run({ resolveQuietly: async () => null }, { headers: { cookie: `hf_session=${token}` }, customerSession: { customerId: 'evil' } });
    assert.equal(none.customerSession, undefined);
    const noCookie = await run({ resolveQuietly: async () => { throw new Error('must not be called'); } }, { headers: {}, customerSession: { customerId: 'evil' } });
    assert.equal(noCookie.customerSession, undefined);
  });

  test('an unreachable session store means anonymous, not a 500', async () => {
    const service = new CustomerSessionService({ customerSession: { findUnique: async () => { throw new Error('db down'); } } } as never);
    const logs = captureLogs();
    try {
      assert.equal(await service.resolveQuietly(token), null);
    } finally {
      logs.restore();
    }
    await assert.rejects(service.resolve(token));
  });
});
