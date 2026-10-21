/**
 * Behavioural scenarios for the admin auth HTTP contract. The SAME scenarios run against the in-memory double (unit suite)
 * and against real PostgreSQL (integration suite), which also proves the double behaves like the database. Not a test file.
 */
import { strict as assert } from 'node:assert';
import { mock, test } from 'node:test';
import { hashSessionToken } from '../../admin-session.guard';
import { LOCKOUT_MS } from '../admin-auth.service';
import { TEST_PASSWORD, type Harness, type TestAdmin } from './harness';

const GENERIC = { message: 'Invalid sign-in.' };
const GUARD_401 = 'Admin sign-in required.';
const ADMIN_KEYS = ['email', 'id', 'name', 'role'];
const keys = (value: object) => Object.keys(value).sort();

export function registerScenarios(label: string, getHarness: () => Harness): void {
  const t = (name: string, fn: (h: Harness) => Promise<void>) => test(`${label}: ${name}`, async () => fn(getHarness()));
  const credentials = require('../credentials') as typeof import('../credentials');

  t('login success returns the contract shape and stores only the token hash', async (h) => {
    const owner = await h.makeAdmin('OWNER', 'login-ok');
    const before = Date.now();
    const res = await h.call('POST', '/admin/auth/login', {
      headers: { 'user-agent': 'U'.repeat(500) },
      body: { email: owner.email.toUpperCase(), password: owner.password, totp: h.code(owner) },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keys(res.body), ['admin', 'expiresAt', 'token']);
    assert.deepEqual(keys(res.body.admin), ADMIN_KEYS);
    assert.deepEqual(res.body.admin, { id: owner.id, email: owner.email, name: 'Test login-ok', role: 'OWNER' });
    assert.match(res.body.token, /^[A-Za-z0-9_-]{43}$/);
    const expires = Date.parse(res.body.expiresAt);
    assert.ok(Math.abs(expires - (before + 8 * 3600_000)) < 10_000, 'absolute expiry is 8 hours out');
    assert.equal(new Date(expires).toISOString(), res.body.expiresAt);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const session = await h.prisma.adminSession.findUnique({ where: { tokenHash: hashSessionToken(res.body.token) } });
    assert.ok(session, 'session is found by sha256(token)');
    assert.notEqual(session.tokenHash, res.body.token);
    assert.equal(session.userAgent.length, 200);
    assert.ok(session.ip, 'ip recorded from req.ip');
    assert.equal(session.revokedAt, null);
    assert.equal(session.expiresAt.toISOString(), res.body.expiresAt);
    const row = await h.prisma.adminUser.findUnique({ where: { id: owner.id } });
    assert.ok(row.lastLoginAt && row.lastTotpStep !== null);
    assert.equal(row.failedLogins, 0);
  });

  t('every login failure mode returns the identical 401 body', async (h) => {
    const base = await h.makeAdmin('STAFF', 'fail-base');
    const inactive = await h.makeAdmin('STAFF', 'fail-inactive', { active: false });
    const locked = await h.makeAdmin('STAFF', 'fail-locked', { lockedUntil: new Date(Date.now() + 3600_000) });
    const replayed = await h.makeAdmin('STAFF', 'fail-replay');
    await h.freshLogin(replayed);
    const cases: [string, unknown][] = [
      ['unknown email', { email: `nobody@${h.tag}.example.test`, password: TEST_PASSWORD, totp: h.code(base) }],
      ['wrong password', { email: base.email, password: `${TEST_PASSWORD}x`, totp: h.code(base) }],
      ['wrong totp', { email: base.email, password: TEST_PASSWORD, totp: h.code(base) === '000000' ? '000001' : '000000' }],
      ['old totp step', { email: base.email, password: TEST_PASSWORD, totp: h.code(base, -3) }],
      ['replayed totp', { email: replayed.email, password: TEST_PASSWORD, totp: h.code(replayed) }],
      ['inactive account (valid credentials)', { email: inactive.email, password: TEST_PASSWORD, totp: h.code(inactive) }],
      ['locked account (valid credentials)', { email: locked.email, password: TEST_PASSWORD, totp: h.code(locked) }],
      ['missing totp (no password-only login)', { email: base.email, password: TEST_PASSWORD }],
      ['short totp', { email: base.email, password: TEST_PASSWORD, totp: '12345' }],
      ['numeric totp type', { email: base.email, password: TEST_PASSWORD, totp: 123456 }],
      ['empty object', {}],
      ['array body', []],
      ['oversized password', { email: base.email, password: 'p'.repeat(5000), totp: '123456' }],
    ];
    for (const [name, body] of cases) {
      const res = await h.call('POST', '/admin/auth/login', { body });
      assert.equal(res.status, 401, `${name}: ${res.text}`);
      assert.deepEqual(res.body, GENERIC, name);
      assert.equal(res.text, JSON.stringify(GENERIC), `${name}: byte-identical body`);
    }
    const notJson = await h.call('POST', '/admin/auth/login', { headers: { 'content-type': 'text/plain' }, rawBody: 'x' });
    assert.equal(notJson.status, 401);
    assert.equal(notJson.text, JSON.stringify(GENERIC));
    // The failed attempts were audited, with a reason that never reaches the HTTP response.
    const audits = h.prisma.adminAuditEvent;
    const failed = await audits.findMany({ where: { action: 'admin.login.failed' } });
    assert.ok(failed.length >= cases.length);
  });

  t('an unknown email still runs a full scrypt verification (same code path)', async (h) => {
    const known = await h.makeAdmin('STAFF', 'path-known');
    const spy = mock.method(credentials, 'verifyPassword');
    try {
      await h.call('POST', '/admin/auth/login', { body: { email: `ghost@${h.tag}.example.test`, password: 'whatever-password', totp: '123456' } });
      assert.equal(spy.mock.callCount(), 1, 'verifyPassword ran for the unknown email');
      const stored = spy.mock.calls[0].arguments[1] as string;
      assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, 'verified against a full-cost dummy hash');
      await h.call('POST', '/admin/auth/login', { body: { email: known.email, password: 'whatever-password', totp: '123456' } });
      assert.equal(spy.mock.callCount(), 2);
      await h.call('POST', '/admin/auth/login', { body: { garbage: true } });
      assert.equal(spy.mock.callCount(), 3, 'even a malformed body pays the same verification');
    } finally {
      spy.mock.restore();
    }
  });

  t('totp replay: the same code cannot sign in twice, concurrent use admits exactly one', async (h) => {
    const admin = await h.makeAdmin('STAFF', 'replay');
    const code = h.code(admin);
    const first = await h.login(admin, { totp: code });
    assert.equal(first.status, 200);
    const again = await h.login(admin, { totp: code });
    assert.equal(again.status, 401);
    assert.deepEqual(again.body, GENERIC);
    const earlier = await h.login(admin, { totp: h.code(admin, -1) });
    assert.equal(earlier.status, 401, 'an older step than the last accepted one is refused too');

    const racer = await h.makeAdmin('STAFF', 'replay-race');
    const racerCode = h.code(racer);
    const results = await Promise.all([1, 2, 3, 4].map(() => h.login(racer, { totp: racerCode })));
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join(','));
    assert.ok(results.every((r) => r.status === 200 || r.text === JSON.stringify(GENERIC)));
  });

  t('lockout after 5 failures for 15 minutes, generic 401 while locked, recovery after the clock passes', async (h) => {
    const admin = await h.makeAdmin('STAFF', 'lockout');
    for (let i = 0; i < 4; i += 1) assert.equal((await h.login(admin, { password: 'wrong-password-123' })).status, 401);
    // A success before the threshold resets the counter.
    assert.equal((await h.freshLogin(admin)).admin.email, admin.email);
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: admin.id } })).failedLogins, 0);

    for (let i = 0; i < 5; i += 1) {
      const res = await h.login(admin, { password: 'wrong-password-123' });
      assert.equal(res.text, JSON.stringify(GENERIC));
    }
    let row = await h.prisma.adminUser.findUnique({ where: { id: admin.id } });
    assert.equal(row.failedLogins, 5);
    assert.ok(row.lockedUntil);
    const lockedUntil = row.lockedUntil.getTime();
    assert.ok(Math.abs(lockedUntil - (Date.now() + LOCKOUT_MS)) < 10_000);

    await h.prisma.adminUser.updateMany({ where: { id: admin.id }, data: { lastTotpStep: null } });
    const blocked = await h.login(admin); // correct password + valid code, but locked
    assert.equal(blocked.status, 401);
    assert.equal(blocked.text, JSON.stringify(GENERIC));
    row = await h.prisma.adminUser.findUnique({ where: { id: admin.id } });
    assert.equal(row.lockedUntil.getTime(), lockedUntil, 'attempts while locked do not extend the lock');

    h.clock.offsetMs = LOCKOUT_MS - 60_000; // 14 min: still locked
    assert.equal((await h.login(admin)).status, 401);
    h.clock.offsetMs = LOCKOUT_MS + 60_000; // 16 min: lock expired
    try {
      const ok = await h.login(admin);
      assert.equal(ok.status, 200, ok.text);
      row = await h.prisma.adminUser.findUnique({ where: { id: admin.id } });
      assert.equal(row.failedLogins, 0);
      assert.equal(row.lockedUntil, null);
    } finally {
      h.clock.offsetMs = 0;
    }
    const events = await h.prisma.adminAuditEvent.findMany({ where: { adminId: admin.id, action: 'admin.login.failed' } });
    assert.ok(events.some((e: any) => e.detail?.lockedForMinutes === 15), 'the lock itself is audited');
    assert.ok(events.some((e: any) => e.detail?.reason === 'locked'));
  });

  t('GET /me returns admin and session; logout revokes the session', async (h) => {
    const admin = await h.makeAdmin('OWNER', 'session');
    const { token, expiresAt } = await h.freshLogin(admin);
    const me = await h.call('GET', '/admin/auth/me', { token });
    assert.equal(me.status, 200);
    assert.deepEqual(keys(me.body), ['admin', 'session']);
    assert.deepEqual(keys(me.body.admin), ADMIN_KEYS);
    assert.deepEqual(me.body.session, { expiresAt, idleTimeoutSeconds: 1800 });
    assert.equal((await h.call('GET', '/admin/auth/me')).status, 401);

    const out = await h.call('POST', '/admin/auth/logout', { token });
    assert.equal(out.status, 204);
    assert.equal(out.text, '');
    const row = await h.prisma.adminSession.findUnique({ where: { tokenHash: hashSessionToken(token) } });
    assert.ok(row.revokedAt, 'revokedAt set');
    const after = await h.call('GET', '/admin/auth/me', { token });
    assert.equal(after.status, 401);
    assert.equal(after.body.message, GUARD_401);
    assert.equal((await h.call('POST', '/admin/auth/logout', { token })).status, 401);
  });

  t('guard rejects revoked, expired, idle, over-absolute and deactivated sessions', async (h) => {
    const admin = await h.makeAdmin('STAFF', 'guard');
    const variants: [string, Record<string, unknown>][] = [
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['idle > 30 min', { lastSeenAt: new Date(Date.now() - 31 * 60_000) }],
      ['absolute > 8 h', { createdAt: new Date(Date.now() - 8 * 3600_000 - 60_000), lastSeenAt: new Date() }],
      ['revoked', { revokedAt: new Date() }],
    ];
    for (const [name, patch] of variants) {
      const { token } = await h.freshLogin(admin);
      assert.equal((await h.call('GET', '/admin/auth/me', { token })).status, 200, `${name}: valid before tampering`);
      await h.prisma.adminSession.updateMany({ where: { tokenHash: hashSessionToken(token) }, data: patch });
      const res = await h.call('GET', '/admin/auth/me', { token });
      assert.equal(res.status, 401, name);
      assert.equal(res.body.message, GUARD_401, name);
    }
    // 29 minutes idle is still fine; and a deactivated admin's otherwise-valid token stops working.
    const { token } = await h.freshLogin(admin);
    await h.prisma.adminSession.updateMany({ where: { tokenHash: hashSessionToken(token) }, data: { lastSeenAt: new Date(Date.now() - 29 * 60_000) } });
    assert.equal((await h.call('GET', '/admin/auth/me', { token })).status, 200);
    await h.prisma.adminUser.updateMany({ where: { id: admin.id }, data: { active: false } });
    assert.equal((await h.call('GET', '/admin/auth/me', { token })).status, 401);
  });

  t('change-password: needs the current password, revokes OTHER sessions, audits, enforces length', async (h) => {
    const admin = await h.makeAdmin('STAFF', 'chpw');
    const a = await h.freshLogin(admin);
    const b = await h.freshLogin(admin);
    const newPassword = 'a brand new password 42?';
    const path = '/admin/auth/change-password';

    const wrong = await h.call('POST', path, { token: a.token, body: { currentPassword: 'not the password!!', newPassword } });
    assert.equal(wrong.status, 403);
    for (const bad of ['short', 'x'.repeat(11), 'y'.repeat(257)]) {
      const res = await h.call('POST', path, { token: a.token, body: { currentPassword: admin.password, newPassword: bad } });
      assert.equal(res.status, 400, `length ${bad.length}`);
    }
    assert.equal((await h.call('POST', path, { token: a.token, body: { currentPassword: admin.password, newPassword: admin.password } })).status, 400);
    assert.equal((await h.call('POST', path, { body: { currentPassword: admin.password, newPassword } })).status, 401);
    assert.equal((await h.call('GET', '/admin/auth/me', { token: b.token })).status, 200, 'nothing changed yet');

    const ok = await h.call('POST', path, { token: a.token, body: { currentPassword: admin.password, newPassword } });
    assert.equal(ok.status, 204);
    assert.equal((await h.call('GET', '/admin/auth/me', { token: a.token })).status, 200, 'current session survives');
    assert.equal((await h.call('GET', '/admin/auth/me', { token: b.token })).status, 401, 'other session revoked');
    await h.prisma.adminUser.updateMany({ where: { id: admin.id }, data: { lastTotpStep: null } });
    assert.equal((await h.login(admin)).status, 401, 'old password no longer works');
    assert.equal((await h.login(admin, { password: newPassword })).status, 200, 'new password works');
    const events = await h.prisma.adminAuditEvent.findMany({ where: { adminId: admin.id, action: 'admin.password.change' } });
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`${newPassword}|${admin.password}`.replace(/[?]/g, '\\?')));
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: admin.id } })).passwordHash.startsWith('scrypt$'), true);
  });

  t('OWNER creates an admin: temporary password + MFA shown once, working account, hashes and ciphertext at rest', async (h) => {
    const owner = await h.makeAdmin('OWNER', 'creator');
    const { token } = await h.freshLogin(owner);
    const email = `New.Hire@${h.tag}.example.test`;
    const res = await h.call('POST', '/admin/users', { token, body: { email, name: '  New Hire ', role: 'STAFF' } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(keys(res.body), ['admin', 'mfa', 'temporaryPassword']);
    assert.deepEqual(keys(res.body.admin), ADMIN_KEYS);
    assert.deepEqual(res.body.admin, { id: res.body.admin.id, email: email.toLowerCase(), name: 'New Hire', role: 'STAFF' });
    assert.deepEqual(keys(res.body.mfa), ['otpauthUri', 'seedBase32']);
    assert.ok(res.body.temporaryPassword.length >= 20);
    assert.match(res.body.mfa.seedBase32, /^[A-Z2-7]{32}$/);
    assert.match(res.body.mfa.otpauthUri, /^otpauth:\/\/totp\/.+\?.*issuer=.*&algorithm=SHA1&digits=6&period=30$/);
    assert.ok(res.body.mfa.otpauthUri.includes(res.body.mfa.seedBase32));

    const row = await h.prisma.adminUser.findUnique({ where: { id: res.body.admin.id } });
    assert.match(row.passwordHash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!row.passwordHash.includes(res.body.temporaryPassword));
    assert.match(row.mfaSeedEnc, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!row.mfaSeedEnc.includes(res.body.mfa.seedBase32));

    const hire: TestAdmin = { id: row.id, email: row.email, password: res.body.temporaryPassword, seed: res.body.mfa.seedBase32, role: 'STAFF' };
    const signIn = await h.login(hire);
    assert.equal(signIn.status, 200, signIn.text);
    assert.equal(signIn.body.admin.role, 'STAFF');

    assert.equal((await h.call('POST', '/admin/users', { token, body: { email, name: 'Dup', role: 'STAFF' } })).status, 409);
    for (const bad of [{ email: 'nope', name: 'x', role: 'STAFF' }, { email: `a@${h.tag}.example.test`, name: '', role: 'STAFF' }, { email: `a@${h.tag}.example.test`, name: 'x', role: 'ROOT' }, {}]) {
      assert.equal((await h.call('POST', '/admin/users', { token, body: bad })).status, 400, JSON.stringify(bad));
    }
    const audit = await h.prisma.adminAuditEvent.findMany({ where: { action: 'admin.user.create', targetId: row.id } });
    assert.equal(audit.length, 1);
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(`${res.body.temporaryPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${res.body.mfa.seedBase32}`));

    const list = await h.call('GET', '/admin/users', { token });
    assert.equal(list.status, 200);
    const item = list.body.items.find((i: any) => i.id === row.id);
    assert.deepEqual(keys(item), ['active', 'createdAt', 'email', 'id', 'lastLoginAt', 'name', 'role']);
    assert.equal(item.active, true);
    assert.ok(item.lastLoginAt, 'lastLoginAt reflects the sign-in above');
    assert.ok(!list.text.includes('passwordHash') && !list.text.includes('mfaSeedEnc'));
  });

  t('STAFF gets 403 on every OWNER route; unauthenticated gets 401', async (h) => {
    const staff = await h.makeAdmin('STAFF', 'staff403');
    const owner = await h.makeAdmin('OWNER', 'owner403');
    const { token } = await h.freshLogin(staff);
    const routes: [string, string, unknown?][] = [
      ['GET', '/admin/users'],
      ['POST', '/admin/users', { email: `x@${h.tag}.example.test`, name: 'X', role: 'STAFF' }],
      ['POST', `/admin/users/${owner.id}/deactivate`],
      ['GET', '/admin/audit'],
    ];
    for (const [method, path, body] of routes) {
      const res = await h.call(method, path, { token, body });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((await h.call(method, path, { body })).status, 401, `${method} ${path} unauthenticated`);
    }
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: owner.id } })).active, true);
    assert.equal((await h.call('GET', '/admin/auth/me', { token })).status, 200, 'STAFF may use the non-owner routes');
  });

  t('deactivation revokes all sessions, blocks sign-in, forbids self and unknown targets', async (h) => {
    const owner = await h.makeAdmin('OWNER', 'deact-owner');
    const target = await h.makeAdmin('STAFF', 'deact-target');
    const { token } = await h.freshLogin(owner);
    const s1 = await h.freshLogin(target);
    const s2 = await h.freshLogin(target);

    const self = await h.call('POST', `/admin/users/${owner.id}/deactivate`, { token });
    assert.equal(self.status, 400);
    assert.equal((await h.call('POST', '/admin/users/does-not-exist/deactivate', { token })).status, 404);
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: owner.id } })).active, true);

    const res = await h.call('POST', `/admin/users/${target.id}/deactivate`, { token });
    assert.equal(res.status, 204);
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: target.id } })).active, false);
    for (const session of [s1, s2]) assert.equal((await h.call('GET', '/admin/auth/me', { token: session.token })).status, 401);
    const sessions = await h.prisma.adminSession.findMany({ where: { adminId: target.id } });
    assert.ok(sessions.length >= 2 && sessions.every((s: any) => s.revokedAt));
    await h.prisma.adminUser.updateMany({ where: { id: target.id }, data: { lastTotpStep: null } });
    const blocked = await h.login(target);
    assert.equal(blocked.status, 401);
    assert.equal(blocked.text, JSON.stringify(GENERIC));
    assert.equal((await h.call('POST', `/admin/users/${target.id}/deactivate`, { token })).status, 204, 'idempotent');
    const audit = await h.prisma.adminAuditEvent.findMany({ where: { action: 'admin.user.deactivate', targetId: target.id } });
    assert.ok(audit.length >= 1);
  });

  t('the last active OWNER can never be deactivated (even by another actor id)', async (h) => {
    const sole = await h.makeAdmin('OWNER', 'sole-owner');
    const other = await h.makeAdmin('OWNER', 'other-owner');
    await h.prisma.adminUser.updateMany({ where: { role: 'OWNER', active: true, id: { not: sole.id } }, data: { active: false } });
    const actor = { id: other.id, email: other.email, name: 'x', role: 'OWNER' as const };
    await assert.rejects(() => h.service.deactivateUser(actor, sole.id, { ip: null, userAgent: null }), (error: any) => error.getStatus?.() === 409 && /last active OWNER/.test(error.message));
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: sole.id } })).active, true);
    // With a second active owner it is allowed.
    await h.prisma.adminUser.updateMany({ where: { id: other.id }, data: { active: true } });
    await h.service.deactivateUser(actor, sole.id, { ip: null, userAgent: null });
    assert.equal((await h.prisma.adminUser.findUnique({ where: { id: sole.id } })).active, false);
  });

  t('sign-in answers 503 {message} when ADMIN_MFA_ENCRYPTION_KEY is unset or too short, and recovers when set', async (h) => {
    const admin = await h.makeAdmin('STAFF', 'nokey');
    const saved = process.env.ADMIN_MFA_ENCRYPTION_KEY;
    try {
      for (const value of [undefined, '', 'x'.repeat(31)]) {
        if (value === undefined) delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
        else process.env.ADMIN_MFA_ENCRYPTION_KEY = value;
        const res = await h.login(admin);
        assert.equal(res.status, 503);
        assert.equal(res.text, JSON.stringify({ message: 'Admin sign-in is not configured.' }));
        const unknown = await h.call('POST', '/admin/auth/login', { body: { email: 'a@b.example.test', password: 'x', totp: '123456' } });
        assert.equal(unknown.status, 503, 'the same for every request, so it reveals nothing about accounts');
      }
    } finally {
      process.env.ADMIN_MFA_ENCRYPTION_KEY = saved;
    }
    assert.equal((await h.login(admin)).status, 200);
  });

  t('GET /admin/audit: shape, newest first, cursor pagination, filters, validation, nothing sensitive', async (h) => {
    const owner = await h.makeAdmin('OWNER', 'auditor');
    const { token } = await h.freshLogin(owner);
    const target = await h.makeAdmin('STAFF', 'audit-target');
    for (let i = 0; i < 3; i += 1) await h.login(target, { password: 'bad-password-for-audit' });
    await h.call('POST', '/admin/auth/login', { body: { email: `ghost@${h.tag}.example.test`, password: 'pw-for-ghost-12345', totp: '123456' } });

    const all = await h.call('GET', '/admin/audit?limit=200', { token });
    assert.equal(all.status, 200);
    assert.deepEqual(keys(all.body), ['items', 'nextCursor']);
    assert.deepEqual(keys(all.body.items[0]), ['action', 'adminEmail', 'createdAt', 'detail', 'id', 'ip', 'targetId', 'targetType']);
    assert.ok(all.body.items.some((i: any) => i.action === 'admin.login' && i.adminEmail === owner.email));
    assert.ok(all.body.items.some((i: any) => i.action === 'admin.login.failed' && i.adminEmail === null), 'unknown-account failure has adminEmail null');
    const times = all.body.items.map((i: any) => i.createdAt);
    assert.deepEqual([...times].sort().reverse(), times, 'newest first');
    assert.doesNotMatch(all.text, /bad-password-for-audit|pw-for-ghost|passwordHash|mfaSeedEnc/);

    const filtered = await h.call('GET', `/admin/audit?targetType=admin&targetId=${target.id}&limit=2`, { token });
    assert.equal(filtered.body.items.length, 2);
    assert.ok(filtered.body.items.every((i: any) => i.targetId === target.id && i.targetType === 'admin'));
    assert.ok(filtered.body.nextCursor, 'a third failure exists, so there is a next page');
    const page2 = await h.call('GET', `/admin/audit?targetType=admin&targetId=${target.id}&limit=2&cursor=${filtered.body.nextCursor}`, { token });
    assert.equal(page2.body.items.length, 1);
    assert.equal(page2.body.nextCursor, null);
    const ids = [...filtered.body.items, ...page2.body.items].map((i: any) => i.id);
    assert.equal(new Set(ids).size, 3, 'no duplicates across pages');
    assert.equal((await h.call('GET', '/admin/audit', { token })).body.items.length <= 50, true, 'default limit 50');
    for (const bad of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=1&limit=2']) assert.equal((await h.call('GET', `/admin/audit?${bad}`, { token })).status, 400, bad);
  });
}
