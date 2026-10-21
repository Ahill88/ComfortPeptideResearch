/**
 * Customer accounts over HTTP against REAL PostgreSQL: the same scenarios as the unit suite (which also proves the in-memory
 * double behaves like the database), plus database-level checks.
 *
 *   TEST_DATABASE_URL='postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_auth2' \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/auth/__tests__/customer-auth.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset. Refuses non-local databases and the shared
 * `public`/`dev` schemas. It does not truncate: every row it creates uses the unique email domain `<tag>.example.test` and is
 * deleted in `after`.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
}
if (['public', 'dev', null].includes(parsed.searchParams.get('schema')) && !process.env.ALLOW_SHARED_SCHEMA) {
  throw new Error('Refusing to run: use a scratch schema (set ALLOW_SHARED_SCHEMA=1 to override).');
}
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

import type { Harness } from './harness';
import { registerScenarios } from './scenarios';

let harness: Harness;
let prisma: import('../../prisma.service').PrismaService;

before(async () => {
  const { PrismaService } = await import('../../prisma.service');
  const { startHarness } = await import('./harness');
  prisma = new PrismaService();
  await prisma.$connect();
  harness = await startHarness(prisma);
});

after(async () => {
  await harness?.close();
  if (prisma && harness) {
    const customers = await prisma.customer.findMany({ where: { email: { endsWith: `@${harness.tag}.example.test` } }, select: { id: true } });
    const ids = customers.map((c) => c.id);
    await prisma.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customerSession.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customerToken.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma?.$disconnect();
});

registerScenarios('postgres', () => harness);

test('postgres: the schema-level shape the service relies on (unique token hashes, session cascade-free revocation, address ordering)', async () => {
  const customer = await harness.makeCustomer('pg-shape');
  const cookie = await harness.signIn(customer);
  const token = cookie.split('=')[1];
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const session = await prisma.customerSession.findUnique({ where: { tokenHash: hash } });
  assert.ok(session);
  await assert.rejects(prisma.customerSession.create({ data: { customerId: customer.id, tokenHash: hash, expiresAt: new Date(Date.now() + 1000) } }), { code: 'P2002' });
  const columns = Object.keys(session!).sort();
  assert.ok(!columns.includes('token'), 'there is no plaintext token column');
});

test('postgres: concurrent first registrations of one new email create exactly one customer and one live verification token', async () => {
  const email = harness.email('pg-register-race');
  const results = await Promise.all([1, 2, 3, 4].map(() => harness.call('POST', '/auth/register', { body: { email, password: 'concurrent password 12345!' } })));
  assert.ok(results.every((r) => r.status === 202), results.map((r) => r.status).join());
  const customers = await prisma.customer.findMany({ where: { email } });
  assert.equal(customers.length, 1);
  const live = await prisma.customerToken.count({ where: { customerId: customers[0].id, purpose: 'EMAIL_VERIFY', usedAt: null } });
  assert.equal(live, 1, 'only the newest verification token is unused');
});
