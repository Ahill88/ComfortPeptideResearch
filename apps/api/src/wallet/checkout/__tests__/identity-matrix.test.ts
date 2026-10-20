import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { NODE_ENV_MATRIX, isAllowed, label, withNodeEnv } from '../../../config/__tests__/node-env-matrix';
import { CheckoutController } from '../checkout.controller';

function controller() {
  const calls: string[] = [];
  const lookups: string[] = [];
  const service: any = {
    findCustomerIdByEmail: async (email: string) => (lookups.push(email), email === 'researcher@example.com' ? 'cust_1' : null),
    prepare: async (c: string, o: string) => (calls.push(`prepare:${c}:${o}`), { ok: true }),
    submit: async (c: string, o: string, b: string) => (calls.push(`submit:${c}:${o}:${b}`), { ok: true }),
    status: async (c: string, o: string) => (calls.push(`status:${c}:${o}`), { ok: true }),
  };
  return { calls, lookups, c: new CheckoutController(service) };
}

describe('CheckoutController header identity: NODE_ENV matrix', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: ${isAllowed(value) ? 'x-customer-email honored' : '401 on prepare/submit/status, no service call'}`, async () => {
      await withNodeEnv(value, async () => {
        const { c, calls, lookups } = controller();
        const email = ' Researcher@Example.com ';
        const run = [
          () => c.prepare('o1', email),
          () => c.submit('o1', { signedTransactionBase64: 'AAAA' }, email),
          () => c.status('o1', email),
        ];
        if (isAllowed(value)) {
          for (const call of run) await call();
          assert.deepEqual(calls, ['prepare:cust_1:o1', 'submit:cust_1:o1:AAAA', 'status:cust_1:o1']);
          await assert.rejects(c.prepare('o1', undefined), UnauthorizedException);
          await assert.rejects(c.prepare('o1', 'unknown@example.com'), UnauthorizedException);
          await assert.rejects(c.prepare('o1', ['researcher@example.com']), UnauthorizedException);
          assert.equal(calls.length, 3);
        } else {
          for (const call of run) await assert.rejects(call(), UnauthorizedException);
          assert.deepEqual(calls, []);
          assert.deepEqual(lookups, [], 'customer lookup never reached');
        }
      });
    });
  }
});
