import { strict as assert } from 'node:assert';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  SCRYPT_PARAMS, base32Decode, base32Encode, createAdminCredentials, decryptSeed, encryptSeed, generatePassword, generateSessionToken, generateTotpSeed, hashPassword, hotp,
  loadMfaKey, otpauthUri, passwordPolicyError, totpCodeAt, totpStep, verifyPassword, verifyTotp,
} from '../credentials';

// ------------------------------------------------------------------------------------------------- scrypt passwords

test('scrypt: self-describing format scrypt$N$r$p$saltb64$hashb64 with 16-byte random salt', async () => {
  const hash = await hashPassword('correct horse battery');
  const parts = hash.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', String(2 ** 15), '8', '1']);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16);
  assert.equal(Buffer.from(parts[5], 'base64').length, 64);
  assert.deepEqual(SCRYPT_PARAMS, { N: 32768, r: 8, p: 1 });
  assert.notEqual(hash, await hashPassword('correct horse battery'), 'fresh salt every time');
});

test('scrypt: round trip, wrong password, unicode normalisation, malformed stored values', async () => {
  const hash = await hashPassword('p\u00e4ssword-with-ümlauts');
  assert.equal(await verifyPassword('p\u00e4ssword-with-ümlauts', hash), true);
  assert.equal(await verifyPassword('pa\u0308ssword-with-ümlauts', hash), true, 'NFKC: composed and decomposed forms agree');
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  for (const junk of ['', 'plain', 'scrypt$1$8$1$AAAA$AAAA', 'scrypt$32768$8$1$AAAA', 'bcrypt$32768$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', `scrypt$${2 ** 30}$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA`]) {
    assert.equal(await verifyPassword('x', junk), false, junk);
  }
});

test('scrypt: verification honours the parameters stored in the hash (upgradeable)', async () => {
  const weaker = await hashPassword('another password 1', { N: 1 << 14, r: 8, p: 1 });
  assert.ok(weaker.startsWith('scrypt$16384$8$1$'));
  assert.equal(await verifyPassword('another password 1', weaker), true);
  assert.equal(await verifyPassword('another password 2', weaker), false);
});

test('scrypt: a verification stays under the 300 ms login budget', async () => {
  const hash = await hashPassword('timing check password');
  await verifyPassword('warm up', hash);
  const times: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const start = process.hrtime.bigint();
    await verifyPassword('timing check password', hash);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  assert.ok(Math.min(...times) < 300, `scrypt verify took ${times.map((x) => x.toFixed(0)).join('/')} ms`);
});

test('password policy: 12..256 characters; generated passwords satisfy it and differ', () => {
  assert.equal(passwordPolicyError('x'.repeat(11)) !== null, true);
  assert.equal(passwordPolicyError('x'.repeat(12)), null);
  assert.equal(passwordPolicyError('x'.repeat(256)), null);
  assert.equal(passwordPolicyError('x'.repeat(257)) !== null, true);
  assert.equal(passwordPolicyError(undefined) !== null, true);
  assert.equal(passwordPolicyError(123456789012) !== null, true);
  const a = generatePassword();
  assert.equal(a.length, 24);
  assert.equal(passwordPolicyError(a), null);
  assert.notEqual(a, generatePassword());
  assert.throws(() => generatePassword(8), RangeError);
});

// ------------------------------------------------------------------------------------------------------------ TOTP

const RFC_SEED = Buffer.from('12345678901234567890', 'ascii'); // RFC 6238 Appendix B, SHA-1

test('base32: RFC 4648 vectors and round trip', () => {
  const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
  }
  const random = randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(random)), random);
  assert.equal(base32Decode('mzxw6ytboi').toString(), 'foobar', 'case-insensitive');
  assert.throws(() => base32Decode('MZXW1'), /invalid base32/);
  assert.match(generateTotpSeed(), /^[A-Z2-7]{32}$/, '20 random bytes = 32 base32 chars');
});

test('TOTP: RFC 6238 SHA-1 test vectors (8 digits) and the same HMAC truncated to our 6 digits', () => {
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [seconds, expected8] of vectors) {
    const counter = Math.floor(seconds / 30);
    assert.equal(hotp(RFC_SEED, counter, 8), expected8, `T=${seconds}`);
    assert.equal(hotp(RFC_SEED, counter, 6), expected8.slice(-6), `T=${seconds} (6 digits = last 6 of the same truncated value)`);
    assert.equal(totpCodeAt(base32Encode(RFC_SEED), seconds * 1000), expected8.slice(-6));
  }
  // Independent re-derivation of the T=59 truncated value: 0x4a... -> 1094287082 -> mod 1e8 / 1e6.
  const mac = createHmac('sha1', RFC_SEED).update(Buffer.from('0000000000000001', 'hex')).digest();
  const offset = mac[19] & 15;
  const truncated = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  assert.equal(truncated, 1094287082);
  assert.equal(truncated % 1_000_000, 287082);
});

test('TOTP window: current step and +-1 accepted, +-2 refused, 30 s step arithmetic', () => {
  const seed = base32Encode(RFC_SEED);
  const now = 1_700_000_015_000;
  const step = totpStep(now);
  assert.equal(step, Math.floor(1_700_000_015 / 30));
  const at = (s: number) => hotp(RFC_SEED, s);
  assert.equal(verifyTotp(seed, at(step), now), step);
  assert.equal(verifyTotp(seed, at(step - 1), now), step - 1);
  assert.equal(verifyTotp(seed, at(step + 1), now), step + 1);
  assert.equal(verifyTotp(seed, at(step - 2), now), null);
  assert.equal(verifyTotp(seed, at(step + 2), now), null);
  assert.equal(verifyTotp(seed, at(step + 2), now + 30_000), step + 2, 'accepted once the clock reaches it');
});

test('TOTP rejects malformed codes (length, non-digits, whitespace, type confusion)', () => {
  const seed = base32Encode(RFC_SEED);
  const now = 59_000;
  const good = totpCodeAt(seed, now);
  for (const bad of ['', '12345', '1234567', ` ${good}`, `${good} `, 'abcdef', `${good}\n`, '١٢٣٤٥٦']) assert.equal(verifyTotp(seed, bad, now), null, JSON.stringify(bad));
  assert.equal(verifyTotp(seed, good, now), totpStep(now));
});

test('TOTP replay protection: a step at or below the last accepted step is refused', () => {
  const seed = base32Encode(RFC_SEED);
  const now = 1_700_000_015_000;
  const step = totpStep(now);
  const code = (s: number) => hotp(RFC_SEED, s);
  assert.equal(verifyTotp(seed, code(step), now, null), step);
  assert.equal(verifyTotp(seed, code(step), now, step), null, 'same code again');
  assert.equal(verifyTotp(seed, code(step - 1), now, step), null, 'older code than the newest accepted');
  assert.equal(verifyTotp(seed, code(step + 1), now, step), step + 1, 'a newer step is fine');
  assert.equal(verifyTotp(seed, code(step), now, step - 1), step);
});

test('otpauth URI carries issuer, label, SHA1/6/30 and the seed', () => {
  const uri = otpauthUri('ada@example.com', 'JBSWY3DPEHPK3PXP');
  assert.ok(uri.startsWith('otpauth://totp/Helix%20%26%20Field%20Admin:ada%40example.com?'));
  assert.ok(uri.includes('JBSWY3DPEHPK3PXP') && uri.endsWith('&issuer=Helix%20%26%20Field%20Admin&algorithm=SHA1&digits=6&period=30'));
});

// ----------------------------------------------------------------------------------------------------- seed encryption

const keyA = loadMfaKey({ ADMIN_MFA_ENCRYPTION_KEY: 'a'.repeat(40) }) as Buffer;
const keyB = loadMfaKey({ ADMIN_MFA_ENCRYPTION_KEY: 'b'.repeat(40) }) as Buffer;

test('MFA key: >= 32 chars required, derived to 32 bytes deterministically, missing/short = null', () => {
  assert.equal(keyA.length, 32);
  assert.deepEqual(keyA, loadMfaKey({ ADMIN_MFA_ENCRYPTION_KEY: 'a'.repeat(40) }));
  assert.notDeepEqual(keyA, keyB);
  for (const value of [undefined, '', '   ', 'x'.repeat(31)]) assert.equal(loadMfaKey({ ADMIN_MFA_ENCRYPTION_KEY: value }), null);
  assert.equal(loadMfaKey({}), null);
  assert.ok(loadMfaKey({ ADMIN_MFA_ENCRYPTION_KEY: 'x'.repeat(32) }));
});

test('seed encryption: v1.iv.ciphertext.tag base64url, random IV, round trip', () => {
  const seed = generateTotpSeed();
  const stored = encryptSeed(seed, keyA);
  const parts = stored.split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.ok(parts.slice(1).every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
  assert.equal(Buffer.from(parts[1], 'base64url').length, 12);
  assert.equal(Buffer.from(parts[3], 'base64url').length, 16);
  assert.ok(!stored.includes(seed));
  assert.equal(decryptSeed(stored, keyA), seed);
  assert.notEqual(stored, encryptSeed(seed, keyA), 'new IV each time');
});

test('seed encryption: wrong key, tampered parts and unknown versions are rejected', () => {
  const stored = encryptSeed('JBSWY3DPEHPK3PXP', keyA);
  assert.throws(() => decryptSeed(stored, keyB));
  const [v, iv, ct, tag] = stored.split('.');
  const flip = (text: string) => `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}`;
  assert.throws(() => decryptSeed([v, iv, flip(ct), tag].join('.'), keyA), 'ciphertext');
  assert.throws(() => decryptSeed([v, iv, ct, flip(tag)].join('.'), keyA), 'tag');
  assert.throws(() => decryptSeed([v, flip(iv), ct, tag].join('.'), keyA), 'iv');
  assert.throws(() => decryptSeed(['v2', iv, ct, tag].join('.'), keyA), 'version');
  assert.throws(() => decryptSeed([v, iv, ct].join('.'), keyA), 'truncated');
  assert.throws(() => decryptSeed('', keyA));
});

test('createAdminCredentials: one coherent set (hash verifies, seed decrypts and matches the URI)', async () => {
  const set = await createAdminCredentials('ada@example.com', keyA);
  assert.equal(await verifyPassword(set.password, set.passwordHash), true);
  assert.equal(decryptSeed(set.mfaSeedEnc, keyA), set.seedBase32);
  assert.ok(set.otpauthUri.includes(set.seedBase32));
});

test('session tokens: 32 random bytes as 43 base64url chars, unique', () => {
  const a = generateSessionToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, generateSessionToken());
});
