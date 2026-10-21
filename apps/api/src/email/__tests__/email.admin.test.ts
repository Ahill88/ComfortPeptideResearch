import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AdminSessionGuard } from '../../admin/admin-session.guard';
import { ADMIN_ROLES_KEY } from '../../admin/admin.decorators';
import { EmailAdminController } from '../email-admin.controller';
import { EmailAdminService } from '../email-admin.service';
import { InMemoryEmailPrisma, TOKEN } from './email-support';

function setup() {
  const prisma = new InMemoryEmailPrisma();
  const audit: any[] = [];
  const service = new EmailAdminService(prisma as any, { record: async (e: any) => void audit.push(e) } as any);
  return { prisma, audit, service };
}
const ago = (ms: number) => new Date(Date.now() - ms);

test('the controller is guarded by AdminSessionGuard and restricted to OWNER at class level (covers both routes)', () => {
  assert.deepEqual(Reflect.getMetadata(ADMIN_ROLES_KEY, EmailAdminController), ['OWNER']);
  assert.ok((Reflect.getMetadata('__guards__', EmailAdminController) as unknown[]).includes(AdminSessionGuard));
  assert.equal(Reflect.getMetadata('path', EmailAdminController), 'admin/email/outbox');
});

test('list: items carry the documented fields only, with the recipient DOMAIN and never the address, data, link or token', async () => {
  const { prisma, service } = setup();
  prisma.seed({ id: 'row1', toEmail: 'Jane.Doe@Customer.Example', template: 'password_reset', status: 'FAILED', attempts: 3, lastError: `HTTP 500 token=${TOKEN} jane.doe@customer.example`, createdAt: ago(5000) });
  prisma.seed({ id: 'row2', toEmail: 'x@y.example', template: 'order_shipped', status: 'SENT', attempts: 1, sentAt: ago(1000), createdAt: ago(4000), data: { orderId: 'o1', carrier: 'UPS', trackingNumber: '1Z', trackingUrl: null } });
  const page = await service.list({});
  assert.equal(page.nextCursor, null);
  assert.equal(page.items.length, 2);
  for (const item of page.items) assert.deepEqual(Object.keys(item).sort(), ['attempts', 'createdAt', 'id', 'lastError', 'sentAt', 'status', 'template', 'toDomain']);
  const failed = page.items.find((i) => i.id === 'row1')!;
  assert.equal(failed.toDomain, 'customer.example');
  assert.equal(failed.sentAt, null);
  const sent = page.items.find((i) => i.id === 'row2')!;
  assert.equal(sent.lastError, null);
  assert.equal(typeof sent.sentAt, 'string');
  const wire = JSON.stringify(page);
  for (const leaked of ['jane', 'Jane', TOKEN, 'x@y', 'trackingNumber', '1Z', 'reset-password?', 'https']) assert.ok(!wire.includes(leaked), `leaked ${leaked}: ${wire}`);
});

test('list: newest first, status filter, limit and keyset cursor across pages without gaps or repeats (ties on createdAt break by id)', async () => {
  const { prisma, service } = setup();
  const same = ago(10_000);
  for (let i = 0; i < 7; i += 1) prisma.seed({ id: `r${i}`, createdAt: i < 3 ? same : ago(9000 - i * 1000), status: i % 2 ? 'SENT' : 'PENDING' });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await service.list({ limit: 3, cursor });
    seen.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual(seen.slice(0, 4), ['r6', 'r5', 'r4', 'r3']);
  assert.deepEqual(seen.slice(4), ['r2', 'r1', 'r0'], 'ties share createdAt and fall back to id descending');
  assert.deepEqual((await service.list({ status: 'SENT' })).items.map((i) => i.status), ['SENT', 'SENT', 'SENT']);
  assert.equal((await service.list({ status: 'FAILED' })).items.length, 0);
});

test('list: default limit is 50 (51st row is only a cursor probe)', async () => {
  const { prisma, service } = setup();
  for (let i = 0; i < 55; i += 1) prisma.seed({ createdAt: ago(100_000 - i) });
  const page = await service.list({});
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor);
  assert.equal((await service.list({ cursor: page.nextCursor! })).items.length, 5);
});

test('list: malformed cursors answer 400', async () => {
  const { service } = setup();
  for (const cursor of ['!!!', 'e30', Buffer.from('[1,"../x"]').toString('base64url'), Buffer.from('["a","b"]').toString('base64url'), Buffer.from('[99999999999999999,"ab"]').toString('base64url')]) {
    await assert.rejects(() => service.list({ cursor }), (e: any) => e.getStatus?.() === 400, cursor);
  }
});

test('retry: FAILED -> PENDING, attempts reset, due now, audited with the actor and template (no address)', async () => {
  const { prisma, audit, service } = setup();
  const row = prisma.seed({ id: 'f1', status: 'FAILED', attempts: 8, lastError: 'HTTP 403', nextAttemptAt: new Date(Date.now() + 86_400_000), toEmail: 'who@private.example' });
  const item = await service.retry('f1', { id: 'admin1', ip: '203.0.113.9' });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.attempts, 0);
  assert.equal(row.lastError, null);
  assert.ok(row.nextAttemptAt.getTime() <= Date.now() + 5);
  assert.deepEqual({ id: item.id, status: item.status, attempts: item.attempts, toDomain: item.toDomain }, { id: 'f1', status: 'PENDING', attempts: 0, toDomain: 'private.example' });
  assert.deepEqual(audit, [{ adminId: 'admin1', action: 'email.retry', targetType: 'email_outbox', targetId: 'f1', detail: { template: 'password_reset' }, ip: '203.0.113.9' }]);
  assert.ok(!JSON.stringify(audit).includes('private.example'));
});

test('retry: only FAILED rows (409 otherwise, nothing changes, no audit); unknown id 404; a double retry only succeeds once', async () => {
  const { prisma, audit, service } = setup();
  const actor = { id: 'a', ip: null };
  for (const status of ['PENDING', 'SENDING', 'SENT']) {
    const row = prisma.seed({ id: `s-${status}`, status, attempts: 2 });
    await assert.rejects(() => service.retry(row.id, actor), (e: any) => e.getStatus() === 409);
    assert.equal(row.status, status);
    assert.equal(row.attempts, 2);
  }
  await assert.rejects(() => service.retry('nope', actor), (e: any) => e.getStatus() === 404);
  assert.equal(audit.length, 0);
  prisma.seed({ id: 'f', status: 'FAILED', attempts: 8 });
  const results = await Promise.allSettled([service.retry('f', actor), service.retry('f', actor)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(audit.length, 1);
});
