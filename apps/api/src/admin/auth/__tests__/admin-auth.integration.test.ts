/**
 * Admin auth over HTTP against REAL PostgreSQL (the same scenarios as the unit suite, plus races and the create-admin CLI).
 *
 *   TEST_DATABASE_URL='postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_auth' \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/admin/auth/__tests__/admin-auth.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset. Refuses non-local databases. It does not
 * truncate: every admin it creates uses the unique email domain `<tag>.example.test` and is deleted in `after`.
 * The last-OWNER scenarios deactivate OTHER active owners in the target schema, so point it at a scratch schema.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
}
if (['public', 'dev', null].includes(parsed.searchParams.get('schema')) && !process.env.ALLOW_SHARED_SCHEMA) {
  throw new Error('Refusing to run: this suite deactivates owners and deletes admin rows; use a scratch schema (set ALLOW_SHARED_SCHEMA=1 to override).');
}
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

import type { Harness } from './harness';
import { registerScenarios } from './scenarios';

let harness: Harness;
let prisma: import('../../../prisma.service').PrismaService;
const startedAt = new Date();

before(async () => {
  const { PrismaService } = await import('../../../prisma.service');
  const { startHarness } = await import('./harness');
  prisma = new PrismaService();
  await prisma.$connect();
  harness = await startHarness(prisma);
});

after(async () => {
  await harness?.close();
  if (prisma && harness) {
    const admins = await prisma.adminUser.findMany({ where: { email: { endsWith: `@${harness.tag}.example.test` } }, select: { id: true } });
    const ids = admins.map((a) => a.id);
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ adminId: { in: ids } }, { adminId: null, createdAt: { gte: startedAt } }] } });
    await prisma.adminSession.deleteMany({ where: { adminId: { in: ids } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma?.$disconnect();
});

registerScenarios('postgres', () => harness);

test('postgres: two owners deactivating each other at the same time never leaves zero active owners', async () => {
  for (let round = 0; round < 6; round += 1) {
    const a = await harness.makeAdmin('OWNER', `race-a${round}`);
    const b = await harness.makeAdmin('OWNER', `race-b${round}`);
    await prisma.adminUser.updateMany({ where: { role: 'OWNER', active: true, id: { notIn: [a.id, b.id] } }, data: { active: false } });
    const sa = await harness.freshLogin(a);
    const sb = await harness.freshLogin(b);
    const [ra, rb] = await Promise.all([
      harness.call('POST', `/admin/users/${b.id}/deactivate`, { token: sa.token }),
      harness.call('POST', `/admin/users/${a.id}/deactivate`, { token: sb.token }),
    ]);
    const active = await prisma.adminUser.count({ where: { role: 'OWNER', active: true } });
    assert.ok(active >= 1, `round ${round}: statuses ${ra.status}/${rb.status}, active owners ${active}`);
    assert.ok([ra.status, rb.status].includes(204), `round ${round}: one deactivation must win (${ra.status}/${rb.status})`);
    assert.ok([ra.status, rb.status].every((s) => [204, 409, 401].includes(s)), `round ${round}: ${ra.status}/${rb.status}`);
  }
});

test('postgres: audit rows persist the foundation columns (adminId, ip, detail JSON) for sign-in', async () => {
  const admin = await harness.makeAdmin('STAFF', 'audit-cols');
  await harness.freshLogin(admin);
  const row = await prisma.adminAuditEvent.findFirst({ where: { adminId: admin.id, action: 'admin.login' } });
  assert.ok(row);
  assert.equal(row.targetType, 'admin');
  assert.equal(row.targetId, admin.id);
  assert.ok(row.ip);
  assert.ok((row.detail as { sessionId?: string }).sessionId);
});

// ------------------------------------------------------------------------------------------------------ create-admin CLI

const apiDir = path.resolve(__dirname, '../../../..');
const repoRoot = path.resolve(apiDir, '../..');

function runCli(args: string[], env: Record<string, string | undefined>, viaPnpm = false) {
  const base: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URL: url, ...env };
  for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
  const result = viaPnpm
    ? spawnSync('pnpm', ['--filter', '@helix-field/api', 'admin:create', '--', ...args], { cwd: repoRoot, env: base, encoding: 'utf8' })
    : spawnSync('pnpm', ['exec', 'ts-node', '--project', 'tsconfig.json', '--transpile-only', 'scripts/create-admin.ts', ...args], { cwd: apiDir, env: base, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const field = (out: string, name: string) => new RegExp(`^${name.replace(/[()]/g, '\\$&')}\\s*:\\s*(.+)$`, 'm').exec(out)?.[1]?.trim() ?? '';

test('postgres: create-admin CLI (pnpm admin:create, NODE_ENV=production) makes an account that signs in end to end over HTTP', { timeout: 120_000 }, async () => {
  const email = `cli-owner@${harness.tag}.example.test`;
  const run = runCli(['--email', email, '--name', 'CLI Owner', '--role', 'OWNER'], {}, true);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const password = field(run.stdout, 'Temporary password');
  const uri = field(run.stdout, 'MFA otpauth URI');
  const seed = field(run.stdout, 'MFA seed (base32)');
  assert.ok(password.length >= 20 && uri.startsWith('otpauth://totp/') && /^[A-Z2-7]{32}$/.test(seed), run.stdout);
  assert.ok(uri.includes(seed));
  assert.ok(!(run.stdout + run.stderr).includes(process.env.ADMIN_MFA_ENCRYPTION_KEY as string), 'the encryption key is never printed');

  const row = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
  assert.equal(row.role, 'OWNER');
  assert.equal(row.active, true);
  assert.match(row.passwordHash, /^scrypt\$32768\$8\$1\$/);
  assert.match(row.mfaSeedEnc, /^v1\./);
  assert.ok(!row.mfaSeedEnc.includes(seed) && !row.passwordHash.includes(password));
  const created = await prisma.adminAuditEvent.findFirst({ where: { action: 'admin.user.create', targetId: row.id } });
  assert.deepEqual(created?.detail, { role: 'OWNER', via: 'cli' });

  const admin = { id: row.id, email, password, seed, role: 'OWNER' as const };
  const signIn = await harness.login(admin);
  assert.equal(signIn.status, 200, signIn.text);
  const me = await harness.call('GET', '/admin/auth/me', { token: signIn.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.admin.email, email);
  assert.equal((await harness.call('GET', '/admin/users', { token: signIn.body.token })).status, 200, 'OWNER role works');
  assert.equal((await harness.login(admin)).status, 401, 'and its code cannot be replayed');
});

test('postgres: create-admin CLI refuses an existing email, a missing or short key, and bad arguments (nothing is created)', { timeout: 120_000 }, async () => {
  const existing = await harness.makeAdmin('STAFF', 'cli-existing');
  const dup = runCli(['--email', existing.email.toUpperCase(), '--name', 'Dup', '--role', 'STAFF'], {});
  assert.equal(dup.status, 2, dup.stderr);
  assert.match(dup.stderr, /already exists/);
  assert.equal(dup.stdout, '');

  const email = `cli-nokey@${harness.tag}.example.test`;
  for (const key of [undefined, '', 'x'.repeat(31)]) {
    const run = runCli(['--email', email, '--name', 'No Key', '--role', 'STAFF'], { ADMIN_MFA_ENCRYPTION_KEY: key });
    assert.equal(run.status, 2, `${JSON.stringify(key)}: ${run.stderr}`);
    assert.match(run.stderr, /ADMIN_MFA_ENCRYPTION_KEY/);
    assert.equal(run.stdout, '');
  }
  const bad = runCli(['--email', email, '--name', 'Bad Role', '--role', 'ROOT'], {});
  assert.equal(bad.status, 1);
  assert.equal(runCli(['--email', 'not-an-email', '--name', 'X', '--role', 'STAFF'], {}).status, 1);
  assert.equal(await prisma.adminUser.count({ where: { email } }), 0, 'no account is created on any refusal');
});
