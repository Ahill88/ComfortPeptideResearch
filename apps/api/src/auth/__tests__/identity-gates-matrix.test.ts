import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { NODE_ENV_MATRIX, envOf, isAllowed, label, withNodeEnv } from '../../config/__tests__/node-env-matrix';
import { AUTH_BACKEND_CONFIGURED, assertAuthReadyForEnvironment, assertSandboxGatesClosed } from '../auth-startup.check';
import { SessionGuard } from '../session.guard';

const request = (headers: Record<string, unknown>) => {
  const req: Record<string, unknown> = { headers };
  return { req, context: { switchToHttp: () => ({ getRequest: () => req }) } as never };
};

function guardWithLookups() {
  const lookups: string[] = [];
  const prisma = { customer: { findUnique: async ({ where }: { where: { email: string } }) => (lookups.push(where.email), where.email === 'a@example.com' ? { id: 'cus_1' } : null) } };
  return { lookups, guard: new SessionGuard(prisma as never) };
}

describe('SessionGuard dev identity: NODE_ENV matrix', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: ${isAllowed(value) ? 'identity header accepted for an existing customer' : 'always 401, database never consulted'}`, async () => {
      await withNodeEnv(value, async () => {
        const { guard, lookups } = guardWithLookups();
        const ok = request({ 'x-customer-email': ' A@Example.com ' });
        if (isAllowed(value)) {
          assert.equal(await guard.canActivate(ok.context), true);
          assert.deepEqual(ok.req.session, { customerId: 'cus_1', email: 'a@example.com', source: 'development-identity' });
          await assert.rejects(guard.canActivate(request({ 'x-customer-email': 'nobody@example.com' }).context), UnauthorizedException);
          await assert.rejects(guard.canActivate(request({}).context), UnauthorizedException);
        } else {
          await assert.rejects(guard.canActivate(ok.context), UnauthorizedException);
          await assert.rejects(guard.canActivate(request({}).context), UnauthorizedException);
          assert.equal(ok.req.session, undefined);
          assert.deepEqual(lookups, []);
        }
      });
    });
  }
});

describe('production-like startup', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: ${isAllowed(value) ? 'starts' : 'refuses to start without AUTH_BACKEND=configured'}`, () => {
      if (isAllowed(value)) {
        assert.doesNotThrow(() => assertAuthReadyForEnvironment(envOf(value)));
      } else {
        assert.throws(() => assertAuthReadyForEnvironment(envOf(value)), /email verification, password reset, and MFA/);
        assert.throws(() => assertAuthReadyForEnvironment(envOf(value, { AUTH_BACKEND: 'true' })), /AUTH_BACKEND=configured required/);
        assert.doesNotThrow(() => assertAuthReadyForEnvironment(envOf(value, { AUTH_BACKEND: AUTH_BACKEND_CONFIGURED })));
      }
    });

    test(`NODE_ENV=${label(value)}: sandbox/identity gates are closed by construction (self-test passes), even with permissive overrides`, () => {
      const hostile = envOf(value, { WALLET_CHAIN_MODE: 'sandbox', WALLET_PREPARED_STORE: 'memory', AUTH_BACKEND: AUTH_BACKEND_CONFIGURED });
      assert.doesNotThrow(() => assertSandboxGatesClosed(hostile));
      assert.doesNotThrow(() => assertAuthReadyForEnvironment(hostile));
    });
  }
});
