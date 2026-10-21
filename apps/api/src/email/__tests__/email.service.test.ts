import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { EmailValidationError } from '../email.errors';
import { EmailService } from '../email.service';
import { InMemoryEmailPrisma, TOKEN, verificationData } from './email-support';

const make = () => {
  const prisma = new InMemoryEmailPrisma();
  return { prisma, service: new EmailService(prisma as any) };
};

test('enqueue stores one PENDING row with normalised data and never touches a provider', async () => {
  const { prisma, service } = make();
  await service.enqueue({ to: 'buyer@example.com', template: 'email_verification', data: verificationData, dedupeKey: 'verify:1' });
  assert.equal(prisma.rows.length, 1);
  const row = prisma.rows[0];
  assert.equal(row.status, 'PENDING');
  assert.equal(row.attempts, 0);
  assert.equal(row.toEmail, 'buyer@example.com');
  assert.equal(row.template, 'email_verification');
  assert.deepEqual(row.data, verificationData);
  assert.equal(row.dedupeKey, 'verify:1');
  assert.ok(row.nextAttemptAt.getTime() <= Date.now());
});

test('enqueue keeps only known data keys: extra keys are refused, not stored', async () => {
  const { prisma, service } = make();
  await assert.rejects(() => service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x', password: 'hunter2' } }), EmailValidationError);
  assert.equal(prisma.rows.length, 0);
});

test('enqueue without a dedupeKey creates a row per call', async () => {
  const { prisma, service } = make();
  for (let i = 0; i < 3; i += 1) await service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x' } });
  assert.equal(prisma.rows.length, 3);
  assert.ok(prisma.rows.every((r) => r.dedupeKey === null));
});

test('idempotent on dedupeKey: 10 parallel calls create ONE row and none throws; the first payload wins', async () => {
  const { prisma, service } = make();
  const calls = Array.from({ length: 10 }, (_, i) =>
    service.enqueue({ to: 'a@example.com', template: 'order_confirmation', data: { orderId: `o${i}`, totalCents: 100 + i, currency: 'USD' }, dedupeKey: 'order_confirmation:o' }),
  );
  const results = await Promise.allSettled(calls);
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  assert.equal(prisma.rows.length, 1);
  await service.enqueue({ to: 'a@example.com', template: 'order_confirmation', data: { orderId: 'again', totalCents: 1, currency: 'USD' }, dedupeKey: 'order_confirmation:o' });
  assert.equal(prisma.rows.length, 1);
});

test('different dedupe keys are independent', async () => {
  const { prisma, service } = make();
  await service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x' }, dedupeKey: 'k1' });
  await service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x' }, dedupeKey: 'k2' });
  assert.equal(prisma.rows.length, 2);
});

test('validation: bad address, CRLF in address, over-long address, unknown template, bad data, bad dedupeKey all throw EmailValidationError and store nothing', async () => {
  const { prisma, service } = make();
  const ok = { link: 'https://a.example/x' };
  const attempts: any[] = [
    { to: 'not-an-address', template: 'password_reset', data: ok },
    { to: 'a@example.com\r\nBcc: evil@example.net', template: 'password_reset', data: ok },
    { to: `${'a'.repeat(250)}@example.com`, template: 'password_reset', data: ok },
    { to: 'a@example.com', template: 'newsletter', data: ok },
    { to: 'a@example.com', template: '__proto__', data: ok },
    { to: 'a@example.com', template: 'password_reset', data: { link: 'javascript:alert(1)' } },
    { to: 'a@example.com', template: 'password_reset', data: null },
    { to: 'a@example.com', template: 'password_reset', data: ok, dedupeKey: 'x\ny' },
    { to: 'a@example.com', template: 'order_confirmation', data: { orderId: 'o1', totalCents: 1.5, currency: 'USD' } },
    null,
  ];
  for (const input of attempts) await assert.rejects(() => service.enqueue(input), EmailValidationError);
  assert.equal(prisma.rows.length, 0);
});

test('validation messages never contain the address or any data value', async () => {
  const { service } = make();
  try {
    await service.enqueue({ to: 'victim@private.example\r\nBcc: x@y.co', template: 'password_reset', data: { link: `https://a.example/x?token=${TOKEN}` } });
    assert.fail('should throw');
  } catch (error) {
    assert.ok(!(error as Error).message.includes('victim'));
  }
  try {
    await service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: `javascript:${TOKEN}` } });
    assert.fail('should throw');
  } catch (error) {
    assert.ok(!(error as Error).message.includes(TOKEN));
  }
});

test('a real database failure is NOT swallowed (the message was not recorded); a duplicate WITHOUT a dedupeKey is not swallowed either', async () => {
  const { prisma, service } = make();
  prisma.failNextCreate = new Error('connection refused');
  await assert.rejects(() => service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x' }, dedupeKey: 'k' }), /connection refused/);
  prisma.failNextCreate = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
  await assert.rejects(() => service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x' } }), /unique/);
  prisma.failNextCreate = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
  await service.enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://a.example/x' }, dedupeKey: 'k' });
});
