import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assertAuthReadyForEnvironment, authStartupWarnings } from '../auth-startup.check';
import { AccountController } from '../account.controller';
import { AuthModule } from '../auth.module';
import { SessionGuard } from '../session.guard';

const ctx = (headers: Record<string, unknown>) => {
  const request: Record<string, unknown> = { headers };
  return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as never };
};
const prismaWith = (emails: Record<string, string>) =>
  ({ customer: { findUnique: async ({ where }: { where: { email: string } }) => (emails[where.email] ? { id: emails[where.email] } : null) } }) as never;

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
});

describe('SessionGuard', () => {
  it('fails closed in production even with a valid dev identity header', async () => {
    process.env.NODE_ENV = 'production';
    const guard = new SessionGuard(prismaWith({ 'a@example.com': 'cus_1' }));
    await assert.rejects(guard.canActivate(ctx({ 'x-customer-email': 'a@example.com' }).context), UnauthorizedException);
    await assert.rejects(guard.canActivate(ctx({}).context), UnauthorizedException);
  });

  it('accepts the dev identity outside production for an existing customer only', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new SessionGuard(prismaWith({ 'a@example.com': 'cus_1' }));
    const ok = ctx({ 'x-customer-email': '  A@Example.com ' });
    assert.equal(await guard.canActivate(ok.context), true);
    assert.deepEqual(ok.request.session, { customerId: 'cus_1', email: 'a@example.com', source: 'development-identity' });
    await assert.rejects(guard.canActivate(ctx({ 'x-customer-email': 'nobody@example.com' }).context), UnauthorizedException);
  });

  it('rejects missing, malformed, and repeated identity headers', async () => {
    process.env.NODE_ENV = 'test';
    const guard = new SessionGuard(prismaWith({ 'a@example.com': 'cus_1' }));
    for (const headers of [{}, { 'x-customer-email': '' }, { 'x-customer-email': 'not-an-email' }, { 'x-customer-email': ['a@example.com'] }]) {
      await assert.rejects(guard.canActivate(ctx(headers).context), UnauthorizedException);
    }
  });
});

describe('AccountController', () => {
  it('is guarded by SessionGuard', () => {
    assert.ok((Reflect.getMetadata(GUARDS_METADATA, AccountController) as unknown[]).includes(SessionGuard));
    assert.equal(Reflect.getMetadata('path', AccountController), 'account');
  });
});

describe('production startup check', () => {
  it('boots in production with the features implemented and nothing configured (registration then answers 503)', () => {
    assert.doesNotThrow(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production' }));
    assert.doesNotThrow(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', STOREFRONT_PUBLIC_URL: 'https://shop.example.com', CUSTOMER_MFA_ENCRYPTION_KEY: 'x'.repeat(40) }));
  });

  it('refuses a configured-but-broken email link base or MFA key in production', () => {
    assert.throws(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', STOREFRONT_PUBLIC_URL: 'javascript:alert(1)' }), /STOREFRONT_PUBLIC_URL/);
    assert.throws(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', STOREFRONT_PUBLIC_URL: 'https://u:p@shop.example.com' }), /STOREFRONT_PUBLIC_URL/);
    assert.throws(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', CUSTOMER_MFA_ENCRYPTION_KEY: 'too short' }), /CUSTOMER_MFA_ENCRYPTION_KEY/);
    assert.doesNotThrow(() => assertAuthReadyForEnvironment({ NODE_ENV: 'development', CUSTOMER_MFA_ENCRYPTION_KEY: 'too short' }));
  });

  it('warnings never contain configured values', () => {
    const warnings = authStartupWarnings({ NODE_ENV: 'production', STOREFRONT_PUBLIC_URL: 'http://shop.example.com', CUSTOMER_MFA_ENCRYPTION_KEY: 'k'.repeat(40) }, false);
    assert.ok(warnings.some((w) => /plain http/.test(w)));
    assert.ok(warnings.some((w) => /No email port/.test(w)));
    assert.ok(!warnings.join('\n').includes('k'.repeat(40)));
    assert.deepEqual(authStartupWarnings({ NODE_ENV: 'test', STOREFRONT_ORIGIN: 'http://localhost:3000', CUSTOMER_MFA_ENCRYPTION_KEY: 'k'.repeat(40) }, true), []);
    assert.ok(authStartupWarnings({ NODE_ENV: 'production' }).some((w) => /STOREFRONT_PUBLIC_URL is unset/.test(w)));
  });

  it('AuthModule.onModuleInit enforces it using process.env', () => {
    const original = { url: process.env.STOREFRONT_PUBLIC_URL, key: process.env.CUSTOMER_MFA_ENCRYPTION_KEY };
    try {
      process.env.NODE_ENV = 'production';
      process.env.STOREFRONT_PUBLIC_URL = 'nope';
      assert.throws(() => new AuthModule().onModuleInit(), /STOREFRONT_PUBLIC_URL/);
      process.env.NODE_ENV = 'development';
      assert.doesNotThrow(() => new AuthModule().onModuleInit());
    } finally {
      if (original.url === undefined) delete process.env.STOREFRONT_PUBLIC_URL;
      else process.env.STOREFRONT_PUBLIC_URL = original.url;
      if (original.key === undefined) delete process.env.CUSTOMER_MFA_ENCRYPTION_KEY;
      else process.env.CUSTOMER_MFA_ENCRYPTION_KEY = original.key;
    }
  });
});
