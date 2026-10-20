import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assertAuthReadyForEnvironment } from '../auth-startup.check';
import { AccountController } from '../account.controller';
import { AuthModule } from '../auth.module';
import { AuthService } from '../auth.service';
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
  it('throws in production unless AUTH_BACKEND=configured', () => {
    assert.throws(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production' }), /email verification, password reset, and MFA/);
    assert.throws(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', AUTH_BACKEND: 'true' }));
    assert.throws(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', AUTH_BACKEND: '' }));
  });

  it('allows development/test (unset NODE_ENV is production-like, see identity-gates-matrix) and an explicit production assertion', () => {
    assert.doesNotThrow(() => assertAuthReadyForEnvironment({ NODE_ENV: 'development' }));
    assert.doesNotThrow(() => assertAuthReadyForEnvironment({ NODE_ENV: 'test' }));
    assert.doesNotThrow(() => assertAuthReadyForEnvironment({ NODE_ENV: 'production', AUTH_BACKEND: 'configured' }));
  });

  it('AuthModule.onModuleInit enforces it using process.env', () => {
    const original = process.env.AUTH_BACKEND;
    delete process.env.AUTH_BACKEND;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => new AuthModule().onModuleInit());
      process.env.NODE_ENV = 'development';
      assert.doesNotThrow(() => new AuthModule().onModuleInit());
    } finally {
      if (original === undefined) delete process.env.AUTH_BACKEND;
      else process.env.AUTH_BACKEND = original;
    }
  });
});

describe('AuthService', () => {
  it('still reports credential-backed operations unavailable (nothing is faked)', () => {
    const auth = new AuthService();
    assert.throws(() => auth.login({ email: 'a@example.com', password: 'x' }), { status: 503 });
    assert.throws(() => auth.register({ email: 'a@example.com', password: 'x' }), { status: 503 });
  });
});
