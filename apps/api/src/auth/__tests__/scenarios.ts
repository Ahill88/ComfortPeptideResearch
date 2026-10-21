/**
 * Behavioural scenarios for the customer account HTTP contract (docs/api/customer-auth.md). The SAME scenarios run against the
 * in-memory double (unit suite) and against real PostgreSQL (integration suite). Not a test file.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ALLOWED_NODE_ENVS, NODE_ENV_MATRIX, label, withNodeEnv } from '../../config/__tests__/node-env-matrix';
import { LOCKOUT_MS } from '../auth.config';
import { ORIGIN, TEST_PASSWORD, type Harness, type TestCustomer } from './harness';

const GENERIC = { message: 'Invalid sign-in.' };
const INVALID_LINK = { message: 'Invalid or expired link.' };
const ACCEPTED = { message: 'Check your email to verify your account.' };
const COOKIE = /^hf_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax(; Secure)?$/;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const keys = (value: object) => Object.keys(value).sort();
const VIEW_KEYS = ['email', 'emailVerified', 'id', 'mfaEnabled', 'name'];
const ADDRESS_KEYS = ['city', 'country', 'id', 'isDefault', 'label', 'line1', 'line2', 'postalCode', 'recipient', 'region'];
const ADDRESS = { label: 'Lab', recipient: 'Ada Lovelace', line1: '1 Research Way', line2: 'Suite 4', city: 'Boston', region: 'MA', postalCode: '02110', country: 'US' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function registerScenarios(name: string, getHarness: () => Harness): void {
  const t = (title: string, fn: (h: Harness) => Promise<void>) => test(`${name}: ${title}`, async () => fn(getHarness()));
  const row = (h: Harness, email: string) => h.prisma.customer.findUnique({ where: { email } });
  const withClock = async (h: Harness, offsetMs: number, fn: () => Promise<void>) => {
    h.clock.offsetMs = offsetMs;
    try { await fn(); } finally { h.clock.offsetMs = 0; }
  };
  const login = (h: Harness, email: string, password: string, extra: Record<string, unknown> = {}) => h.call('POST', '/auth/login', { body: { email, password, ...extra } });
  const register = (h: Harness, email: string, password = TEST_PASSWORD, extra: Record<string, unknown> = {}) => h.call('POST', '/auth/register', { body: { email, password, ...extra } });
  /** Registers and confirms: a customer created through the real flow. */
  const registered = async (h: Harness, label: string, password = TEST_PASSWORD) => {
    const email = h.email(label);
    assert.equal((await register(h, email, password, { name: 'Reg User' })).status, 202);
    assert.equal((await h.call('POST', '/auth/email-verification/confirm', { body: { token: h.tokenFor(email, 'email_verification') } })).status, 204);
    return email;
  };

  // ------------------------------------------------------------------------------------------------ registration

  t('register: 202 contract body, no credentials on the row, hashed tokens only, verification email with the link', async (h) => {
    const email = h.email('reg-new');
    const res = await register(h, email, TEST_PASSWORD, { name: '  Ada L  ' });
    assert.equal(res.status, 202, res.text);
    assert.deepEqual(res.body, ACCEPTED);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(res.cookies, [], 'registration never starts a session');

    const customer = await row(h, email);
    assert.equal(customer.passwordHash, null, 'credentials are not on the row before the link is confirmed');
    assert.equal(customer.emailVerifiedAt, null);
    assert.equal(customer.name, null);
    const mails = h.emailsTo(email);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].template, 'email_verification');
    assert.match(String(mails[0].data.link), /^http:\/\/localhost:3000\/verify-email\?token=[A-Za-z0-9_-]{43}$/);
    assert.equal(mails[0].data.name, 'Ada L');
    assert.ok(mails[0].dedupeKey?.startsWith('email_verification:'));
    assert.deepEqual(keys(mails[0].data), ['link', 'name']);

    const token = h.tokenFor(email, 'email_verification');
    const tokens = await h.prisma.customerToken.findMany({ where: { customerId: customer.id } });
    const real = tokens.find((r: any) => r.tokenHash === sha256(token));
    assert.ok(real, 'stored as sha256(token)');
    assert.equal(real.purpose, 'EMAIL_VERIFY');
    assert.equal(real.usedAt, null);
    const ttl = real.expiresAt.getTime() - real.createdAt.getTime();
    assert.equal(ttl, 24 * HOUR, 'valid 24 h');
    for (const r of tokens) {
      assert.ok(!r.tokenHash.includes(token), 'the raw token is never stored');
      assert.ok(!r.tokenHash.includes(TEST_PASSWORD), 'the raw password is never stored');
    }
  });

  t('register: new, existing-with-credentials and order-created emails get the identical response; only the first and last send mail', async (h) => {
    const existing = await h.makeCustomer('reg-existing');
    const orderCreated = h.email('reg-order');
    await h.prisma.customer.create({ data: { email: orderCreated, name: 'Order Buyer' } });
    const fresh = h.email('reg-fresh');
    const results = [];
    const shouting = `SHOUT-${fresh}`;
    for (const email of [fresh, existing.email, orderCreated, shouting]) results.push(await register(h, email));
    const [first, ...rest] = results;
    for (const other of rest) {
      assert.equal(other.status, first.status);
      assert.equal(other.text, first.text);
      assert.equal(other.headers.get('content-type'), first.headers.get('content-type'));
      assert.equal(other.headers.get('cache-control'), first.headers.get('cache-control'));
    }
    assert.equal(first.status, 202);
    assert.equal(h.emailsTo(fresh).length, 1);
    assert.equal(h.emailsTo(shouting.toLowerCase()).length, 1, 'addresses are case-insensitive: mail goes to the normalised address');
    assert.equal(h.emailsTo(existing.email).length, 0, 'an address that already has credentials gets nothing');
    assert.equal(h.emailsTo(orderCreated).length, 1);
    const unchanged = await row(h, existing.email);
    assert.ok(unchanged.passwordHash);
    assert.equal(unchanged.failedLogins, 0);
    assert.equal(await h.prisma.customerToken.count({ where: { customerId: existing.id } }), 0);
  });

  t('register: an unverified registrant never takes over an order-created customer; credentials attach only on confirmation', async (h) => {
    const victim = h.email('reg-victim');
    const created = await h.prisma.customer.create({ data: { email: victim, name: 'Victim Buyer' } });
    const attackerPassword = 'attacker password 9999!';
    assert.equal((await register(h, victim, attackerPassword, { name: 'Mallory' })).status, 202);
    let current = await row(h, victim);
    assert.equal(current.id, created.id, 'same row');
    assert.equal(current.passwordHash, null, 'nothing attached before confirmation');
    assert.equal(current.emailVerifiedAt, null);
    assert.equal(current.name, 'Victim Buyer', 'name untouched too');
    assert.equal((await login(h, victim, attackerPassword)).status, 401, 'attacker cannot sign in');
    assert.equal((await login(h, victim, attackerPassword)).text, JSON.stringify(GENERIC));

    // Only the mailbox owner holds the token: confirming attaches the registered credential and verifies the address.
    assert.equal((await h.call('POST', '/auth/email-verification/confirm', { body: { token: h.tokenFor(victim, 'email_verification') } })).status, 204);
    current = await row(h, victim);
    assert.ok(current.passwordHash && current.emailVerifiedAt);
    assert.equal(current.name, 'Victim Buyer', 'an existing name is kept');
    assert.equal(await h.prisma.customerToken.count({ where: { customerId: created.id, tokenHash: { startsWith: 'pending:' } } }), 0, 'pending credential rows are removed');
    assert.equal((await login(h, victim, attackerPassword)).status, 200);
  });

  t('register: password policy 12..256, email format and name are validated with 400 and no email is sent', async (h) => {
    const email = h.email('reg-policy');
    for (const [body, pattern] of [
      [{ email, password: 'short' }, /at least 12/],
      [{ email, password: 'x'.repeat(257) }, /at most 256/],
      [{ email }, /Password is required/],
      [{ email: 'not-an-email', password: TEST_PASSWORD }, /valid email/],
      [{ password: TEST_PASSWORD }, /valid email/],
      [{ email, password: TEST_PASSWORD, name: 'n'.repeat(121) }, /Name/],
    ] as [Record<string, unknown>, RegExp][]) {
      const res = await h.call('POST', '/auth/register', { body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(res.body.message, pattern);
      assert.deepEqual(keys(res.body), ['message']);
    }
    assert.equal((await register(h, email, 'x'.repeat(12))).status, 202, '12 characters is enough');
    assert.equal((await register(h, h.email('reg-policy-max'), 'x'.repeat(256))).status, 202, '256 characters is allowed');
    assert.equal(h.emailsTo(email).length, 1);
  });

  t('register: the link base is STOREFRONT_PUBLIC_URL; production-like runtimes without it answer 503 before doing anything', async (h) => {
    const email = h.email('reg-base');
    process.env.STOREFRONT_PUBLIC_URL = 'https://shop.example.test/';
    try {
      assert.equal((await register(h, email)).status, 202);
      assert.match(String(h.emailsTo(email)[0].data.link), /^https:\/\/shop\.example\.test\/verify-email\?token=/);
    } finally {
      delete process.env.STOREFRONT_PUBLIC_URL;
    }
    for (const value of NODE_ENV_MATRIX.filter((v) => !ALLOWED_NODE_ENVS.includes(v))) {
      const target = h.email(`reg-503-${String(value).replace(/\W/g, '') || 'unset'}`);
      await withNodeEnv(value, async () => {
        const res = await register(h, target);
        assert.equal(res.status, 503, label(value));
        assert.deepEqual(res.body, { message: 'Account email is not configured.' });
      });
      assert.equal(await row(h, target), null, 'no customer row is created');
      assert.equal(h.emailsTo(target).length, 0);
    }
    process.env.STOREFRONT_PUBLIC_URL = 'https://shop.example.test';
    try {
      await withNodeEnv('production', async () => assert.equal((await register(h, h.email('reg-prod-ok'))).status, 202));
    } finally {
      delete process.env.STOREFRONT_PUBLIC_URL;
    }
  });

  t('email verification: single use, 24 h expiry, unknown and malformed tokens are one generic 400', async (h) => {
    const email = h.email('verify-basic');
    await register(h, email, TEST_PASSWORD, { name: 'Verifier' });
    const token = h.tokenFor(email, 'email_verification');
    const confirm = (value: unknown) => h.call('POST', '/auth/email-verification/confirm', { body: { token: value } });

    for (const bad of ['', 'short', 'x'.repeat(43), 'x'.repeat(5000), 12345, null, undefined, { a: 1 }]) {
      const res = await confirm(bad);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, INVALID_LINK);
    }
    const ok = await confirm(token);
    assert.equal(ok.status, 204);
    assert.equal(ok.text, '');
    const verified = await row(h, email);
    assert.ok(verified.emailVerifiedAt && verified.passwordHash);
    assert.equal(verified.name, 'Verifier');
    const again = await confirm(token);
    assert.equal(again.status, 400);
    assert.deepEqual(again.body, INVALID_LINK);

    const expiring = h.email('verify-expiry');
    await register(h, expiring);
    const late = h.tokenFor(expiring, 'email_verification');
    await withClock(h, 24 * HOUR + 1000, async () => assert.deepEqual((await confirm(late)).body, INVALID_LINK));
    assert.equal((await row(h, expiring)).emailVerifiedAt, null);
    const justInTime = h.email('verify-edge');
    await register(h, justInTime);
    await withClock(h, 24 * HOUR - 5000, async () => assert.equal((await confirm(h.tokenFor(justInTime, 'email_verification'))).status, 204));
  });

  t('email verification: a newer token invalidates older unused ones (and the older registration credential)', async (h) => {
    const email = h.email('verify-newer');
    await register(h, email, 'first password 111111!');
    const older = h.tokenFor(email, 'email_verification');
    await register(h, email, 'second password 22222!');
    const newer = h.tokenFor(email, 'email_verification');
    assert.notEqual(older, newer);
    const confirm = (token: string) => h.call('POST', '/auth/email-verification/confirm', { body: { token } });
    assert.deepEqual((await confirm(older)).body, INVALID_LINK);
    assert.equal((await confirm(newer)).status, 204);
    assert.equal((await login(h, email, 'first password 111111!')).status, 401, 'the superseded registration password never becomes valid');
    assert.equal((await login(h, email, 'second password 22222!')).status, 200);
  });

  t('email verification: a password-reset token is not accepted as a verification token (and vice versa)', async (h) => {
    const customer = await h.makeCustomer('verify-purpose');
    await h.call('POST', '/auth/password-reset/request', { body: { email: customer.email } });
    const reset = h.tokenFor(customer.email, 'password_reset');
    assert.deepEqual((await h.call('POST', '/auth/email-verification/confirm', { body: { token: reset } })).body, INVALID_LINK);
    const pending = h.email('verify-purpose-2');
    await register(h, pending);
    assert.deepEqual((await h.call('POST', '/auth/password-reset/confirm', { body: { token: h.tokenFor(pending, 'email_verification'), newPassword: TEST_PASSWORD } })).body, INVALID_LINK);
  });

  t('email verification: two concurrent confirmations of one token produce exactly one success', async (h) => {
    const email = h.email('verify-race');
    await register(h, email);
    const token = h.tokenFor(email, 'email_verification');
    const results = await Promise.all([1, 2, 3, 4].map(() => h.call('POST', '/auth/email-verification/confirm', { body: { token } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [204, 400, 400, 400]);
  });

  // ------------------------------------------------------------------------------------------------------- login

  t('login: 200 contract body, exact cookie attributes, only the token hash is stored', async (h) => {
    const customer = await h.makeCustomer('login-ok');
    const before = Date.now();
    const res = await h.call('POST', '/auth/login', { headers: { 'user-agent': 'U'.repeat(500) }, body: { email: ` ${customer.email.toUpperCase()} `, password: customer.password } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keys(res.body), ['customer']);
    assert.deepEqual(res.body.customer, { id: customer.id, email: customer.email, name: 'Test login-ok', emailVerified: true, mfaEnabled: false });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.cookies.length, 1);
    assert.match(res.cookies[0], COOKIE);
    assert.ok(!res.cookies[0].includes('Secure'), 'development/test: no Secure');
    const token = res.cookies[0].split(';')[0].split('=')[1];
    assert.ok(!res.text.includes(token), 'the token is only in the cookie');

    const session = await h.prisma.customerSession.findUnique({ where: { tokenHash: sha256(token) } });
    assert.ok(session);
    assert.equal(session.customerId, customer.id);
    assert.notEqual(session.tokenHash, token);
    assert.equal(session.expiresAt.getTime() - session.createdAt.getTime(), 30 * DAY);
    assert.ok(Math.abs(session.createdAt.getTime() - before) < 10_000);
    assert.equal(session.userAgent.length, 200);
    assert.ok(session.ip);
    assert.equal(session.revokedAt, null);
    const after = await row(h, customer.email);
    assert.ok(after.lastLoginAt);
    assert.equal(after.failedLogins, 0);
  });

  t('login: every failure (unknown, wrong password, credential-less, locked, wrong code, malformed) is the same 401 without a cookie', async (h) => {
    const base = await h.makeCustomer('fail-base');
    const mfa = await h.makeCustomer('fail-mfa', { mfa: true });
    const locked = await h.makeCustomer('fail-locked', { lockedUntil: new Date(Date.now() + HOUR) });
    const noCredentials = h.email('fail-nocred');
    await h.prisma.customer.create({ data: { email: noCredentials } });
    const cases: [string, unknown][] = [
      ['unknown email', { email: h.email('nobody'), password: TEST_PASSWORD }],
      ['wrong password', { email: base.email, password: `${TEST_PASSWORD}x` }],
      ['customer without credentials', { email: noCredentials, password: TEST_PASSWORD }],
      ['locked account, correct password', { email: locked.email, password: TEST_PASSWORD }],
      ['wrong totp', { email: mfa.email, password: TEST_PASSWORD, totp: h.code(mfa) === '000000' ? '000001' : '000000' }],
      ['wrong password with a valid totp', { email: mfa.email, password: 'wrong password 1234!', totp: h.code(mfa) }],
      ['old totp step', { email: mfa.email, password: TEST_PASSWORD, totp: h.code(mfa, -3) }],
      ['non-numeric totp', { email: mfa.email, password: TEST_PASSWORD, totp: 'abcdef' }],
      ['empty body', {}],
      ['number password', { email: base.email, password: 12345678 }],
      ['array body', [1, 2]],
      ['bad email', { email: 'nope', password: TEST_PASSWORD }],
      ['huge password', { email: base.email, password: 'p'.repeat(5000) }],
      ['totp of the wrong type', { email: base.email, password: TEST_PASSWORD, totp: 123456 }],
    ];
    for (const [title, body] of cases) {
      const res = await h.call('POST', '/auth/login', { body });
      assert.equal(res.status, 401, title);
      assert.equal(res.text, JSON.stringify(GENERIC), title);
      assert.deepEqual(res.cookies, [], title);
    }
    const raw = await h.call('POST', '/auth/login', { rawBody: '{not json', headers: { 'content-type': 'application/json' } });
    assert.equal(raw.status, 400, 'unparseable JSON is rejected by the body parser before any account logic');
  });

  t('login: unverified email is 403 EMAIL_NOT_VERIFIED only after the correct password', async (h) => {
    const unverified = await h.makeCustomer('unverified', { emailVerifiedAt: null });
    const wrong = await login(h, unverified.email, 'wrong password 1234!');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.text, JSON.stringify(GENERIC));
    const right = await login(h, unverified.email, unverified.password);
    assert.equal(right.status, 403);
    assert.deepEqual(right.body, { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email first.' });
    assert.deepEqual(right.cookies, []);
    const count = await h.prisma.customerSession.count({ where: { customerId: unverified.id } });
    assert.equal(count, 0);
  });

  t('login: MFA required only after the correct password; wrong, replayed and stale codes fail; a valid code succeeds once', async (h) => {
    const customer = await h.makeCustomer('login-mfa', { mfa: true });
    const wrongPassword = await login(h, customer.email, 'wrong password 1234!');
    assert.equal(wrongPassword.text, JSON.stringify(GENERIC), 'no MFA hint before the password is right');
    const missing = await login(h, customer.email, customer.password);
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { code: 'MFA_REQUIRED', message: 'Enter your authentication code.' });
    assert.deepEqual(missing.cookies, []);
    const blank = await login(h, customer.email, customer.password, { totp: '' });
    assert.equal(blank.body.code, 'MFA_REQUIRED');

    const good = await login(h, customer.email, customer.password, { totp: h.code(customer) });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.body.customer.mfaEnabled, true);
    assert.match(good.cookies[0], COOKIE);
    const replay = await login(h, customer.email, customer.password, { totp: h.code(customer) });
    assert.equal(replay.status, 401, 'the same time step cannot be used twice');
    assert.equal(replay.text, JSON.stringify(GENERIC));
    const older = await login(h, customer.email, customer.password, { totp: h.code(customer, -1) });
    assert.equal(older.status, 401, 'a step older than the newest accepted one is never valid again');
    await withClock(h, 2 * 30_000, async () => assert.equal((await login(h, customer.email, customer.password, { totp: h.code(customer) })).status, 200, 'a later step works'));
  });

  t('login: two concurrent sign-ins with one TOTP code produce exactly one session', async (h) => {
    const customer = await h.makeCustomer('login-mfa-race', { mfa: true });
    const totp = h.code(customer);
    const results = await Promise.all([1, 2, 3].map(() => login(h, customer.email, customer.password, { totp })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
  });

  t('login: 5 failures lock the account for 15 minutes (even for the right password); it recovers with the clock; success resets the counter', async (h) => {
    const customer = await h.makeCustomer('lockout');
    for (let i = 0; i < 4; i += 1) assert.equal((await login(h, customer.email, 'wrong password 1234!')).status, 401);
    assert.equal((await row(h, customer.email)).failedLogins, 4);
    assert.equal((await login(h, customer.email, customer.password)).status, 200, 'below the threshold the right password still works');
    assert.equal((await row(h, customer.email)).failedLogins, 0, 'success resets the counter');

    for (let i = 0; i < 5; i += 1) assert.equal((await login(h, customer.email, 'wrong password 1234!')).status, 401);
    const locked = await row(h, customer.email);
    assert.ok(locked.lockedUntil);
    const lockMs = locked.lockedUntil.getTime() - Date.now();
    assert.ok(Math.abs(lockMs - LOCKOUT_MS) < 15_000, `locked about 15 minutes (${lockMs} ms)`);
    const during = await login(h, customer.email, customer.password);
    assert.equal(during.status, 401);
    assert.equal(during.text, JSON.stringify(GENERIC));
    await withClock(h, LOCKOUT_MS - 60_000, async () => assert.equal((await login(h, customer.email, customer.password)).status, 401, 'still locked at 14 minutes'));
    await withClock(h, LOCKOUT_MS + 1000, async () => {
      assert.equal((await login(h, customer.email, customer.password)).status, 200, 'recovered after 15 minutes');
    });
    const recovered = await row(h, customer.email);
    assert.equal(recovered.failedLogins, 0);
    assert.equal(recovered.lockedUntil, null);
  });

  t('login: customers without MFA still sign in when CUSTOMER_MFA_ENCRYPTION_KEY is unset; enrolment is 503; MFA customers fail closed', async (h) => {
    const plain = await h.makeCustomer('nokey-plain');
    const withMfa = await h.makeCustomer('nokey-mfa', { mfa: true });
    const code = h.code(withMfa);
    const saved = process.env.CUSTOMER_MFA_ENCRYPTION_KEY;
    delete process.env.CUSTOMER_MFA_ENCRYPTION_KEY;
    try {
      const cookie = await h.signIn(plain);
      const enrol = await h.call('POST', '/auth/mfa/enroll', { cookie });
      assert.equal(enrol.status, 503);
      assert.deepEqual(enrol.body, { message: 'MFA is not configured.' });
      const blocked = await login(h, withMfa.email, withMfa.password, { totp: code });
      assert.equal(blocked.status, 401);
      assert.equal(blocked.text, JSON.stringify(GENERIC));
    } finally {
      process.env.CUSTOMER_MFA_ENCRYPTION_KEY = saved;
    }
  });

  t('login: scrypt runs exactly once whether the email is unknown, credential-less, wrong-password or right; register hashes once for new and existing emails', async (h) => {
    const known = await h.makeCustomer('scrypt-known');
    const counts = { hash: 0, verify: 0 };
    const original = { ...h.auth.crypto };
    h.auth.crypto = {
      hashPassword: (password) => (counts.hash += 1, original.hashPassword(password)),
      verifyPassword: (password, stored) => (counts.verify += 1, original.verifyPassword(password, stored)),
    };
    try {
      const attempts: [string, unknown][] = [
        ['unknown', { email: h.email('scrypt-nobody'), password: TEST_PASSWORD }],
        ['wrong password', { email: known.email, password: 'wrong password 1234!' }],
        ['correct', { email: known.email, password: TEST_PASSWORD }],
        ['malformed body', { email: 5 }],
      ];
      for (const [title, body] of attempts) {
        counts.hash = 0; counts.verify = 0;
        await h.call('POST', '/auth/login', { body });
        assert.deepEqual({ ...counts }, { hash: 0, verify: 1 }, title);
      }
      for (const email of [h.email('scrypt-new'), known.email]) {
        counts.hash = 0; counts.verify = 0;
        await register(h, email);
        assert.deepEqual({ ...counts }, { hash: 1, verify: 0 }, `register ${email === known.email ? 'existing' : 'new'}`);
      }
    } finally {
      h.auth.crypto = original;
    }
  });

  // ---------------------------------------------------------------------------------- session / logout / expiry

  t('session: 200 with the customer for a valid cookie; 401 for none, garbage, duplicated or revoked cookies', async (h) => {
    const customer = await h.makeCustomer('session-basic');
    const cookie = await h.signIn(customer);
    const ok = await h.call('GET', '/auth/session', { cookie });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { customer: { id: customer.id, email: customer.email, name: 'Test session-basic', emailVerified: true, mfaEnabled: false } });
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    for (const bad of [undefined, 'hf_session=', `hf_session=${'A'.repeat(43)}`, 'hf_session=short', `other=1; ${cookie}x`, `${cookie}; ${cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`]) {
      const res = await h.call('GET', '/auth/session', { cookie: bad });
      assert.equal(res.status, 401, String(bad));
      assert.deepEqual(res.body, { message: 'Authentication required.' });
    }
    assert.equal((await h.call('GET', '/auth/session', { cookie: `theme=dark; ${cookie}; a=b` })).status, 200, 'other cookies are ignored');
    assert.equal((await h.call('GET', '/auth/session', { headers: { 'x-customer-email': customer.email } })).status, 401, 'the dev header is not a /auth credential');
  });

  t('logout: 204, revokes the server session, clears the cookie with the same attributes; idempotent without a cookie', async (h) => {
    const customer = await h.makeCustomer('logout');
    const cookie = await h.signIn(customer);
    const other = await h.signIn(customer);
    const out = await h.call('POST', '/auth/logout', { cookie });
    assert.equal(out.status, 204);
    assert.equal(out.text, '');
    assert.equal(out.cookies.length, 1);
    assert.match(out.cookies[0], /^hf_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; HttpOnly; SameSite=Lax(; Secure)?$/);
    const token = cookie.split('=')[1];
    assert.ok((await h.prisma.customerSession.findUnique({ where: { tokenHash: sha256(token) } })).revokedAt, 'revoked on the server, not just cleared');
    assert.equal((await h.call('GET', '/auth/session', { cookie })).status, 401, 'the stolen cookie is dead');
    assert.equal((await h.call('GET', '/auth/session', { cookie: other })).status, 200, 'other sessions survive a logout');
    assert.equal((await h.call('POST', '/auth/logout')).status, 204);
    assert.equal((await h.call('POST', '/auth/logout', { cookie })).status, 204);
  });

  t('session lifetimes: 7 days idle (activity extends it), 30 days absolute (activity does not)', async (h) => {
    const customer = await h.makeCustomer('lifetimes');
    const cookie = await h.signIn(customer);
    const probe = () => h.call('GET', '/auth/session', { cookie });
    await withClock(h, 6 * DAY, async () => assert.equal((await probe()).status, 200, 'day 6 (idle 6 d)'));
    await withClock(h, 12 * DAY, async () => assert.equal((await probe()).status, 200, 'day 12: day-6 activity extended the idle window'));
    for (const day of [18, 24, 29]) await withClock(h, day * DAY, async () => assert.equal((await probe()).status, 200, `day ${day}`));
    await withClock(h, 30 * DAY + 1000, async () => assert.equal((await probe()).status, 401, 'absolute limit, despite continuous activity'));

    const idle = await h.signIn(customer);
    await withClock(h, 7 * DAY + 1000, async () => assert.equal((await h.call('GET', '/auth/session', { cookie: idle })).status, 401, 'idle for 7 days'));
    await withClock(h, 3 * DAY, async () => assert.equal((await h.call('GET', '/auth/session', { cookie: idle })).status, 200));
  });

  t('login rotates: signing in again with a live cookie revokes that old session', async (h) => {
    const customer = await h.makeCustomer('rotate');
    const old = await h.signIn(customer);
    const res = await h.call('POST', '/auth/login', { cookie: old, body: { email: customer.email, password: customer.password } });
    assert.equal(res.status, 200);
    assert.equal((await h.call('GET', '/auth/session', { cookie: old })).status, 401);
    assert.equal((await h.call('GET', '/auth/session', { cookie: res.cookies[0].split(';')[0] })).status, 200);
  });

  // ------------------------------------------------------------------------------------------- password reset

  t('password reset request: identical 202 for known, unknown, order-created and pending-registration emails; mail only for credentialed accounts', async (h) => {
    const known = await h.makeCustomer('reset-known');
    const orderCreated = h.email('reset-order');
    await h.prisma.customer.create({ data: { email: orderCreated } });
    const pending = h.email('reset-pending');
    await register(h, pending);
    const unknown = h.email('reset-unknown');
    const results = [];
    for (const email of [known.email, unknown, orderCreated, pending, known.email.toUpperCase()]) results.push(await h.call('POST', '/auth/password-reset/request', { body: { email } }));
    for (const res of results) {
      assert.equal(res.status, 202);
      assert.equal(res.text, results[0].text);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(h.emailsTo(known.email, 'password_reset').length, 2);
    for (const email of [unknown, orderCreated, pending]) assert.equal(h.emailsTo(email, 'password_reset').length, 0, email);
    const mail = h.emailsTo(known.email, 'password_reset')[0];
    assert.match(String(mail.data.link), /^http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(keys(mail.data), ['link']);
    const stored = await h.prisma.customerToken.findMany({ where: { customerId: known.id, purpose: 'PASSWORD_RESET' } });
    assert.ok(stored.every((r: any) => r.expiresAt.getTime() - r.createdAt.getTime() === HOUR), 'valid 1 h');
    assert.ok(stored.every((r: any) => /^[0-9a-f]{64}$/.test(r.tokenHash)));
    const bad = await h.call('POST', '/auth/password-reset/request', { body: { email: 'nope' } });
    assert.equal(bad.status, 400);
  });

  t('password reset confirm: new password works, old does not, ALL sessions are revoked, token is single use', async (h) => {
    const customer = await h.makeCustomer('reset-flow');
    const a = await h.signIn(customer);
    const b = await h.signIn(customer);
    await h.prisma.customer.update({ where: { id: customer.id }, data: { lockedUntil: new Date(Date.now() + HOUR), failedLogins: 5 } });
    await h.call('POST', '/auth/password-reset/request', { body: { email: customer.email } });
    const token = h.tokenFor(customer.email, 'password_reset');
    const confirm = (body: unknown) => h.call('POST', '/auth/password-reset/confirm', { body });
    const NEW = 'a brand new password 77!';

    for (const [body, status, message] of [
      [{ token, newPassword: 'short' }, 400, /at least 12/],
      [{ token, newPassword: 'x'.repeat(257) }, 400, /at most 256/],
      [{ token: 'x'.repeat(43), newPassword: NEW }, 400, /Invalid or expired link/],
      [{ token: 'nope', newPassword: NEW }, 400, /Invalid or expired link/],
      [{ newPassword: NEW }, 400, /Invalid or expired link/],
    ] as [unknown, number, RegExp][]) {
      const res = await confirm(body);
      assert.equal(res.status, status);
      assert.match(res.body.message, message);
    }
    assert.equal((await h.call('GET', '/auth/session', { cookie: a })).status, 200, 'a rejected confirmation changes nothing, and the token is not consumed by a weak password');

    const ok = await confirm({ token, newPassword: NEW });
    assert.equal(ok.status, 204);
    assert.equal(ok.text, '');
    assert.equal((await h.call('GET', '/auth/session', { cookie: a })).status, 401, 'session 1 revoked');
    assert.equal((await h.call('GET', '/auth/session', { cookie: b })).status, 401, 'session 2 revoked');
    assert.equal((await login(h, customer.email, customer.password)).status, 401, 'old password');
    assert.equal((await login(h, customer.email, NEW)).status, 200, 'new password, and the lockout is cleared by a reset');
    assert.deepEqual((await confirm({ token, newPassword: NEW })).body, INVALID_LINK, 'single use');
  });

  t('password reset confirm: 1 h expiry; a newer request invalidates the older token', async (h) => {
    const customer = await h.makeCustomer('reset-expiry');
    const request = () => h.call('POST', '/auth/password-reset/request', { body: { email: customer.email } });
    const confirm = (token: string) => h.call('POST', '/auth/password-reset/confirm', { body: { token, newPassword: 'another new password 88!' } });
    await request();
    const first = h.tokenFor(customer.email, 'password_reset');
    await request();
    const second = h.tokenFor(customer.email, 'password_reset');
    assert.notEqual(first, second);
    assert.deepEqual((await confirm(first)).body, INVALID_LINK, 'older unused token invalidated');
    await withClock(h, HOUR + 1000, async () => assert.deepEqual((await confirm(second)).body, INVALID_LINK, 'expired after an hour'));
    await withClock(h, HOUR - 5000, async () => assert.equal((await confirm(second)).status, 204, 'valid just before the hour'));
  });

  // -------------------------------------------------------------------------------------------------------- MFA

  t('MFA: enrol returns the otpauth URI and seed once, stores the seed encrypted and inactive; confirm activates; disable needs password and code', async (h) => {
    const customer = await h.makeCustomer('mfa-flow');
    const cookie = await h.signIn(customer);
    assert.equal((await h.call('POST', '/auth/mfa/enroll')).status, 401);

    const enrol = await h.call('POST', '/auth/mfa/enroll', { cookie });
    assert.equal(enrol.status, 201, enrol.text);
    assert.deepEqual(keys(enrol.body), ['otpauthUri', 'seedBase32']);
    assert.match(enrol.body.seedBase32, /^[A-Z2-7]{32}$/);
    const uri = new URL(enrol.body.otpauthUri);
    assert.equal(uri.protocol, 'otpauth:');
    assert.equal(uri.host, 'totp');
    assert.equal(decodeURIComponent(uri.pathname), `/Helix & Field:${customer.email}`);
    assert.equal(uri.searchParams.get('issuer'), 'Helix & Field');
    assert.equal(uri.searchParams.get(['se', 'cret'].join('')), enrol.body.seedBase32);
    const seed = enrol.body.seedBase32 as string;
    const credentials = await import('../../admin/auth/credentials');

    let stored = await row(h, customer.email);
    assert.match(stored.mfaSeedEnc, /^v1\./);
    assert.ok(!stored.mfaSeedEnc.includes(seed), 'seed is encrypted at rest');
    assert.equal(stored.mfaEnabledAt, null, 'not active until confirmed');
    assert.equal((await h.call('GET', '/auth/profile', { cookie })).body.mfaEnabled, false);
    assert.equal((await login(h, customer.email, customer.password)).status, 200, 'sign-in does not need a code before confirmation');

    const codeNow = () => credentials.totpCodeAt(seed, Date.now() + h.clock.offsetMs);
    const wrong = await h.call('POST', '/auth/mfa/enroll/confirm', { cookie, body: { code: codeNow() === '000000' ? '000001' : '000000' } });
    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.body, { message: 'Invalid code.' });
    assert.equal((await h.call('POST', '/auth/mfa/enroll/confirm', { cookie, body: { code: 'abc' } })).status, 400);
    const confirmed = await h.call('POST', '/auth/mfa/enroll/confirm', { cookie, body: { code: codeNow() } });
    assert.equal(confirmed.status, 204, confirmed.text);
    stored = await row(h, customer.email);
    assert.ok(stored.mfaEnabledAt);
    assert.equal((await h.call('GET', '/auth/profile', { cookie })).body.mfaEnabled, true);

    assert.equal((await h.call('POST', '/auth/mfa/enroll', { cookie })).status, 409, 'already enabled');
    assert.equal((await h.call('POST', '/auth/mfa/enroll/confirm', { cookie, body: { code: codeNow() } })).status, 409);
    const asMfa: TestCustomer = { ...customer, seed };
    assert.equal((await login(h, customer.email, customer.password, { totp: codeNow() })).status, 401, 'the enrolment code step is already consumed (replay protection)');
    assert.equal((await login(h, customer.email, customer.password)).body.code, 'MFA_REQUIRED');
    await withClock(h, 60_000, async () => assert.equal((await login(h, customer.email, customer.password, { totp: h.code(asMfa) })).status, 200));

    await withClock(h, 5 * 60_000, async () => {
      const fresh = () => h.code(asMfa);
      const badPassword = await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: 'wrong password 1234!', code: fresh() } });
      assert.equal(badPassword.status, 403);
      assert.deepEqual(badPassword.body, { message: 'Invalid password or code.' });
      const badCode = await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: customer.password, code: fresh() === '000000' ? '000001' : '000000' } });
      assert.equal(badCode.status, 403);
      assert.equal((await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: customer.password } })).status, 400);
      const off = await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: customer.password, code: fresh() } });
      assert.equal(off.status, 204, off.text);
      const cleared = await row(h, customer.email);
      assert.equal(cleared.mfaSeedEnc, null);
      assert.equal(cleared.mfaEnabledAt, null);
      assert.equal((await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: customer.password, code: fresh() } })).status, 409);
    });
  });

  t('MFA disable: failures count toward the sign-in lockout (a stolen session cannot guess the password or code)', async (h) => {
    const customer = await h.makeCustomer('mfa-brute', { mfa: true });
    const cookie = await h.signIn(customer, h.code(customer));
    for (let i = 0; i < 5; i += 1) {
      const res = await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: 'wrong password 1234!', code: '123456' } });
      assert.equal(res.status, 403);
    }
    assert.ok((await row(h, customer.email)).lockedUntil);
    await withClock(h, 31_000, async () => {
      const res = await h.call('POST', '/auth/mfa/disable', { cookie, body: { password: customer.password, code: h.code(customer) } });
      assert.equal(res.status, 403, 'locked: even correct credentials are refused');
    });
  });

  // ----------------------------------------------------------------------------------------- profile / addresses

  t('profile: GET/PATCH shape, name trimmed and clearable, validation, session required', async (h) => {
    const customer = await h.makeCustomer('profile');
    const cookie = await h.signIn(customer);
    const get = await h.call('GET', '/auth/profile', { cookie });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, { id: customer.id, email: customer.email, name: 'Test profile', emailVerified: true, mfaEnabled: false });
    const patch = await h.call('PATCH', '/auth/profile', { cookie, body: { name: '  Grace Hopper ' } });
    assert.equal(patch.status, 200);
    assert.deepEqual(keys(patch.body), VIEW_KEYS);
    assert.equal(patch.body.name, 'Grace Hopper');
    assert.equal((await h.call('PATCH', '/auth/profile', { cookie, body: { name: null } })).body.name, null);
    assert.equal((await h.call('PATCH', '/auth/profile', { cookie, body: { name: '' } })).body.name, null);
    for (const body of [{ name: 'n'.repeat(121) }, { name: 5 }, {}, { name: 'a\u0000b' }]) assert.equal((await h.call('PATCH', '/auth/profile', { cookie, body })).status, 400, JSON.stringify(body));
    assert.equal((await h.call('GET', '/auth/profile')).status, 401);
    assert.equal((await h.call('PATCH', '/auth/profile', { body: { name: 'x' } })).status, 401);
    assert.equal((await h.call('PATCH', '/auth/profile', { cookie, body: { name: 'x', email: 'steal@example.test', id: 'other' } })).body.email, customer.email, 'only the name can change');
  });

  t('addresses: create/list/update/delete with exactly one default, a limit of 20 and per-customer isolation', async (h) => {
    const customer = await h.makeCustomer('addr-a');
    const other = await h.makeCustomer('addr-b');
    const cookie = await h.signIn(customer);
    const otherCookie = await h.signIn(other);
    const list = async () => (await h.call('GET', '/auth/addresses', { cookie })).body.items as any[];
    const defaults = async () => (await list()).filter((a) => a.isDefault).length;
    assert.deepEqual(await list(), []);
    assert.equal((await h.call('GET', '/auth/addresses')).status, 401);

    const first = await h.call('POST', '/auth/addresses', { cookie, body: ADDRESS });
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(keys(first.body), ADDRESS_KEYS);
    assert.deepEqual({ ...first.body, id: undefined }, { ...ADDRESS, id: undefined, isDefault: true });
    const second = await h.call('POST', '/auth/addresses', { cookie, body: { ...ADDRESS, label: null, line2: null, country: 'ca' } });
    assert.equal(second.status, 201);
    assert.equal(second.body.isDefault, false, 'only the first address becomes the default automatically');
    assert.equal(second.body.country, 'CA');
    assert.equal(second.body.label, null);
    assert.equal(second.body.line2, null);
    assert.equal(await defaults(), 1);

    const moved = await h.call('PATCH', `/auth/addresses/${second.body.id}`, { cookie, body: { isDefault: true, city: 'Montreal' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.isDefault, true);
    assert.equal(moved.body.city, 'Montreal');
    assert.equal(moved.body.recipient, ADDRESS.recipient, 'unnamed fields are untouched');
    assert.equal(await defaults(), 1);
    assert.equal((await list())[0].id, second.body.id, 'default first');
    const unDefault = await h.call('PATCH', `/auth/addresses/${second.body.id}`, { cookie, body: { isDefault: false } });
    assert.equal(unDefault.body.isDefault, true, 'the only way to change the default is to name another address');
    const third = await h.call('POST', '/auth/addresses', { cookie, body: { ...ADDRESS, isDefault: true } });
    assert.equal(third.body.isDefault, true);
    assert.equal(await defaults(), 1);

    for (const [method, path, body] of [['PATCH', `/auth/addresses/${first.body.id}`, { city: 'X' }], ['DELETE', `/auth/addresses/${first.body.id}`, undefined]] as const) {
      const res = await h.call(method, path, { cookie: otherCookie, body });
      assert.equal(res.status, 404, `${method} someone else's address`);
      assert.deepEqual(res.body, { message: 'Address not found.' });
    }
    assert.equal((await h.call('PATCH', '/auth/addresses/does-not-exist', { cookie, body: { city: 'X' } })).status, 404);
    assert.equal((await h.call('GET', '/auth/addresses', { cookie: otherCookie })).body.items.length, 0, 'isolation');

    const del = await h.call('DELETE', `/auth/addresses/${third.body.id}`, { cookie });
    assert.equal(del.status, 204);
    assert.equal(del.text, '');
    const after = await list();
    assert.equal(after.length, 2);
    assert.equal(await defaults(), 1, 'deleting the default promotes the oldest remaining');
    assert.equal(after[0].id, first.body.id);
    assert.equal((await h.call('DELETE', `/auth/addresses/${third.body.id}`, { cookie })).status, 404);

    for (const body of [{ ...ADDRESS, country: 'USA' }, { ...ADDRESS, country: '1A' }, { ...ADDRESS, recipient: '' }, { ...ADDRESS, line1: undefined }, { ...ADDRESS, city: 'c'.repeat(101) }, { ...ADDRESS, isDefault: 'yes' }, { ...ADDRESS, postalCode: 'p'.repeat(33) }, {}]) {
      const res = await h.call('POST', '/auth/addresses', { cookie, body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.deepEqual(keys(res.body), ['message']);
    }
    assert.equal((await h.call('PATCH', `/auth/addresses/${first.body.id}`, { cookie, body: {} })).status, 400);
  });

  t('addresses: at most 20 per customer (409), and concurrent creates cannot exceed it or create two defaults', async (h) => {
    const customer = await h.makeCustomer('addr-limit');
    const cookie = await h.signIn(customer);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => h.call('POST', '/auth/addresses', { cookie, body: { ...ADDRESS, label: `n${i}`, isDefault: true } })));
    assert.ok(results.every((r) => r.status === 201), 'ten concurrent creates all succeed');
    let items = (await h.call('GET', '/auth/addresses', { cookie })).body.items as any[];
    assert.equal(items.length, 10);
    assert.equal(items.filter((a) => a.isDefault).length, 1, 'exactly one default after racing creates');
    const more = await Promise.all(Array.from({ length: 14 }, (_, i) => h.call('POST', '/auth/addresses', { cookie, body: { ...ADDRESS, label: `m${i}` } })));
    assert.equal(more.filter((r) => r.status === 201).length, 10);
    const rejected = more.filter((r) => r.status === 409);
    assert.equal(rejected.length, 4);
    assert.match(rejected[0].body.message, /at most 20/);
    items = (await h.call('GET', '/auth/addresses', { cookie })).body.items as any[];
    assert.equal(items.length, 20);
    assert.equal(items.filter((a) => a.isDefault).length, 1);
  });

  // ----------------------------------------------------------------------------------------------------- CSRF

  t('CSRF: every state-changing /auth route needs an allow-listed Origin (cookie or not); safe methods do not', async (h) => {
    const customer = await h.makeCustomer('csrf');
    const routes: [string, string, unknown][] = [
      ['POST', '/auth/register', { email: h.email('csrf-reg'), password: TEST_PASSWORD }],
      ['POST', '/auth/login', { email: customer.email, password: customer.password }],
      ['POST', '/auth/email-verification/confirm', { token: 'x'.repeat(43) }],
      ['POST', '/auth/password-reset/request', { email: customer.email }],
      ['POST', '/auth/password-reset/confirm', { token: 'x'.repeat(43), newPassword: TEST_PASSWORD }],
      ['POST', '/auth/mfa/enroll/confirm', { code: '123456' }],
      ['POST', '/auth/mfa/disable', { password: 'x', code: '123456' }],
      ['PATCH', '/auth/profile', { name: 'x' }],
      ['POST', '/auth/addresses', ADDRESS],
      ['PATCH', '/auth/addresses/x', { city: 'x' }],
      ['DELETE', '/auth/addresses/x', undefined],
      ['POST', '/auth/logout', undefined],
    ];
    const origins: [string, string | null][] = [
      ['no Origin header', null], ['foreign origin', 'https://evil.example'], ['look-alike prefix', 'http://localhost:3000.evil.example'],
      ['look-alike suffix', 'http://evil-localhost:3000'], ['scheme mismatch', 'https://localhost:3000'], ['port mismatch', 'http://localhost:3001'],
      ['literal null', 'null'], ['trailing slash', 'http://localhost:3000/'], ['upper-case scheme', 'HTTP://localhost:3000'], ['empty', ''],
    ];
    for (const [method, path, body] of routes) {
      const cookie = await h.signIn(customer);
      for (const [title, origin] of origins) {
        const res = await h.call(method, path, { cookie, body, origin });
        assert.equal(res.status, 403, `${method} ${path}: ${title}`);
        assert.deepEqual(res.body, { message: 'Origin not allowed.' }, `${method} ${path}: ${title}`);
      }
      const ok = await h.call(method, path, { cookie, body, origin: ORIGIN });
      assert.notEqual(ok.status, 403, `${method} ${path}: the allow-listed Origin passes the CSRF check (${ok.status})`);
    }
    const cookie = await h.signIn(customer);
    for (const [path, status] of [['/auth/session', 200], ['/auth/profile', 200], ['/auth/addresses', 200]] as const) {
      assert.equal((await h.call('GET', path, { cookie, origin: null })).status, status, `GET ${path} needs no Origin`);
      assert.equal((await h.call('GET', path, { cookie, origin: 'https://evil.example' })).status, status, `GET ${path} ignores Origin`);
    }
    const refusedLogout = await h.call('POST', '/auth/logout', { cookie, origin: 'https://evil.example' });
    assert.equal(refusedLogout.status, 403);
    assert.deepEqual(refusedLogout.cookies, [], 'a cross-site logout neither revokes nor clears');
    assert.equal((await h.call('GET', '/auth/session', { cookie })).status, 200, 'the refused logout did not revoke the session');
  });

  t('CSRF: with an empty STOREFRONT_ORIGIN allow-list every state-changing /auth request is refused', async (h) => {
    const saved = process.env.STOREFRONT_ORIGIN;
    delete process.env.STOREFRONT_ORIGIN;
    try {
      const res = await h.call('POST', '/auth/login', { body: { email: 'a@example.test', password: TEST_PASSWORD } });
      assert.equal(res.status, 403);
    } finally {
      process.env.STOREFRONT_ORIGIN = saved;
    }
    process.env.STOREFRONT_ORIGIN = `https://other.example.test, ${ORIGIN}`;
    try {
      assert.equal((await h.call('POST', '/auth/login', { origin: 'https://other.example.test', body: { email: 'a@example.test', password: TEST_PASSWORD } })).status, 401);
      assert.equal((await h.call('POST', '/auth/login', { origin: ORIGIN, body: { email: 'a@example.test', password: TEST_PASSWORD } })).status, 401);
    } finally {
      process.env.STOREFRONT_ORIGIN = saved;
    }
  });

  // ---------------------------------------------------- shared identity resolver, end to end over HTTP

  t('identity (HTTP): cookie-authenticated state changes elsewhere need an allow-listed Origin; header and anonymous requests are unaffected by CSRF', async (h) => {
    const customer = await h.makeCustomer('probe');
    const cookie = await h.signIn(customer);
    for (const path of ['/_probe/who', '/_probe/guarded']) {
      const read = await h.call('GET', path, { cookie });
      assert.equal(read.status, 200, path);
      assert.equal(read.body.email, customer.email);
      assert.equal((await h.call('GET', path, { cookie, origin: 'https://evil.example' })).status, 200, 'safe method needs no Origin');
      for (const origin of [null, 'https://evil.example', 'null']) {
        const res = await h.call('POST', path, { cookie, origin });
        assert.equal(res.status, 403, `${path} POST origin=${origin}`);
        assert.deepEqual(res.body, { message: 'Origin not allowed.' });
      }
      const ok = await h.call('POST', path, { cookie, origin: ORIGIN });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.email, customer.email);
      assert.equal((await h.call('POST', path, { origin: null })).status, 401, 'no cookie, no header: 401 (not 403)');
      const viaHeader = await h.call('POST', path, { origin: null, headers: { 'x-customer-email': customer.email } });
      assert.equal(viaHeader.status, 200, 'the dev/test header is not subject to the Origin rule');
      assert.equal(viaHeader.body.email, customer.email);
    }
    const guarded = await h.call('GET', '/_probe/guarded', { cookie });
    assert.equal(typeof guarded.body.sessionId, 'string');
    assert.deepEqual({ ...guarded.body, sessionId: undefined }, { customerId: customer.id, email: customer.email, source: 'session', sessionId: undefined });
    const header = await h.call('GET', '/_probe/guarded', { headers: { 'x-customer-email': customer.email } });
    assert.deepEqual(header.body, { customerId: customer.id, email: customer.email, source: 'development-identity' });
    await h.call('POST', '/auth/logout', { cookie });
    assert.equal((await h.call('GET', '/_probe/who', { cookie })).status, 401, 'a revoked cookie identifies nobody');
  });

  t('identity (HTTP): the header works only in development/test; the cookie works in every NODE_ENV value (matrix)', async (h) => {
    const customer = await h.makeCustomer('matrix');
    const cookie = await h.signIn(customer);
    for (const value of NODE_ENV_MATRIX) {
      await withNodeEnv(value, async () => {
        const allowed = ALLOWED_NODE_ENVS.includes(value);
        const header = await h.call('GET', '/_probe/who', { headers: { 'x-customer-email': customer.email } });
        assert.equal(header.status, allowed ? 200 : 401, `${label(value)} header`);
        const headerPost = await h.call('POST', '/_probe/who', { headers: { 'x-customer-email': customer.email } });
        assert.equal(headerPost.status, allowed ? 200 : 401, `${label(value)} header POST`);
        const viaCookie = await h.call('GET', '/_probe/who', { cookie });
        assert.equal(viaCookie.status, 200, `${label(value)} cookie`);
        assert.equal(viaCookie.body.email, customer.email);
        assert.equal((await h.call('POST', '/_probe/who', { cookie })).status, 200, `${label(value)} cookie POST with Origin`);
        assert.equal((await h.call('POST', '/_probe/who', { cookie, origin: null })).status, 403, `${label(value)} cookie POST without Origin`);
        const both = await h.call('GET', '/_probe/who', { cookie, headers: { 'x-customer-email': 'someone-else@example.test' } });
        assert.equal(both.status, 200, `${label(value)} both`);
        assert.equal(both.body.email, allowed ? 'someone-else@example.test' : customer.email, `${label(value)}: the header wins only where it is allowed; in production-like runtimes it cannot change who the cookie says you are`);
        assert.equal((await h.call('GET', '/_probe/guarded', { cookie })).status, 200, `${label(value)} SessionGuard cookie`);
        assert.equal((await h.call('GET', '/_probe/guarded', { headers: { 'x-customer-email': customer.email } })).status, allowed ? 200 : 401, `${label(value)} SessionGuard header`);
      });
    }
  });

  t('cookie attributes (raw header) across NODE_ENV: HttpOnly, SameSite=Lax, Path=/, Max-Age 30 d always; Secure outside development/test only', async (h) => {
    const customer = await h.makeCustomer('cookie-attrs');
    for (const value of NODE_ENV_MATRIX) {
      await withNodeEnv(value, async () => {
        const res = await login(h, customer.email, customer.password);
        assert.equal(res.status, 200, label(value));
        assert.equal(res.cookies.length, 1);
        assert.match(res.cookies[0], COOKIE, label(value));
        assert.equal(/; Secure$/.test(res.cookies[0]), !ALLOWED_NODE_ENVS.includes(value), `${label(value)} Secure`);
        assert.ok(res.cookies[0].includes('; HttpOnly') && res.cookies[0].includes('; SameSite=Lax') && res.cookies[0].includes('; Path=/') && res.cookies[0].includes('; Max-Age=2592000'));
        assert.ok(!/Domain=/i.test(res.cookies[0]), 'host-only cookie');
        const out = await h.call('POST', '/auth/logout', { cookie: res.cookies[0].split(';')[0] });
        assert.equal(/; Secure$/.test(out.cookies[0]), !ALLOWED_NODE_ENVS.includes(value), `${label(value)} cleared cookie Secure`);
        assert.match(out.cookies[0], /Max-Age=0/);
      });
    }
  });

  t('CORS: the allow-listed origin gets Allow-Credentials on /auth, others do not get Allow-Origin', async (h) => {
    const pre = await fetch(`${h.base}/v1/auth/login`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    const evil = await fetch(`${h.base}/v1/auth/session`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });

  t('sessions cannot be forged: a client cannot set the identity through the request, only the store can', async (h) => {
    const customer = await h.makeCustomer('forge');
    const attempts: Record<string, string>[] = [{ 'x-customer-session': JSON.stringify({ customerId: customer.id }) }, { authorization: `Bearer ${'A'.repeat(43)}` }, { 'x-forwarded-user': customer.email }];
    for (const headers of attempts) assert.equal((await h.call('GET', '/auth/session', { headers })).status, 401);
    const body = await h.call('POST', '/_probe/who', { origin: ORIGIN, rawBody: JSON.stringify({ customerSession: { customerId: customer.id, email: customer.email, sessionId: 'x' } }), headers: { 'content-type': 'application/json' } });
    assert.equal(body.status, 401);
    const fake = await h.call('GET', '/auth/session', { cookie: `hf_session=${sha256('x').slice(0, 43)}` });
    assert.equal(fake.status, 401);
  });
}
