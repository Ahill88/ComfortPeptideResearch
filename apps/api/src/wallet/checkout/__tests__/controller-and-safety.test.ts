import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import { CheckoutController } from '../checkout.controller';

function controller(calls: string[] = []) {
  const service: any = {
    findCustomerIdByEmail: async (email: string) => (email === 'researcher@example.com' ? 'cust_1' : null),
    prepare: async (c: string, o: string) => (calls.push(`prepare:${c}:${o}`), { ok: true }),
    submit: async (c: string, o: string, b: string) => (calls.push(`submit:${c}:${o}:${b}`), { ok: true }),
    status: async (c: string, o: string) => (calls.push(`status:${c}:${o}`), { ok: true }),
  };
  return new CheckoutController(service);
}

test('x-customer-email is honored only outside production', async () => {
  const previous = process.env.NODE_ENV;
  try {
    const calls: string[] = [];
    const c = controller(calls);
    process.env.NODE_ENV = 'development';
    await c.prepare('o1', 'researcher@example.com');
    await c.status('o1', 'researcher@example.com');
    await c.submit('o1', { signedTransactionBase64: 'AAAA' }, 'researcher@example.com');
    assert.deepEqual(calls, ['prepare:cust_1:o1', 'status:cust_1:o1', 'submit:cust_1:o1:AAAA']);
    await assert.rejects(c.prepare('o1', undefined), UnauthorizedException);
    await assert.rejects(c.prepare('o1', 'unknown@example.com'), UnauthorizedException);
    await assert.rejects(c.prepare('o1', ['a@b.c', 'd@e.f']), UnauthorizedException);

    process.env.NODE_ENV = 'production';
    for (const call of [() => c.prepare('o1', 'researcher@example.com'), () => c.status('o1', 'researcher@example.com'), () => c.submit('o1', { signedTransactionBase64: 'AAAA' }, 'researcher@example.com')]) {
      await assert.rejects(call(), UnauthorizedException);
    }
    assert.equal(calls.length, 3, 'no service call in production');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('route metadata: wallet/checkout with prepare/submit/status', () => {
  assert.equal(Reflect.getMetadata('path', CheckoutController), 'wallet/checkout');
  const paths = ['prepare', 'submit', 'status'].map((m) => Reflect.getMetadata('path', (CheckoutController.prototype as any)[m]));
  assert.deepEqual(paths, [':orderId/prepare', ':orderId/submit', ':orderId/status']);
});

test('non-test checkout code never signs or touches secret keys', () => {
  const dir = join(__dirname, '..');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /secretKey/i, file);
    assert.doesNotMatch(source, /fromSecretKey/, file);
    assert.doesNotMatch(source, /Keypair/, file);
    assert.doesNotMatch(source, /\.sign\(|partialSign|\bsign\(/, file);
  }
});
