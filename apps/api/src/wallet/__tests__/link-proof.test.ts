import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  LINK_CHALLENGE_ENV, LINK_CHALLENGE_TTL_MS, buildLinkMessage, issueLinkChallenge, resolveLinkChallengeKey, verifyEd25519, verifyLinkProof,
} from '../link-proof';
import { UNABLE_TO_LINK_MESSAGE, WalletService } from '../wallet.service';
import { linkRequest, makeConfig, makeHarness, rejection, signLinkMessage } from './helpers';

const GENERIC = UNABLE_TO_LINK_MESSAGE;
const A = 'a@example.com';
const B = 'b@example.com';

/** A signed body for `address`, as a wallet holding `signer` (which may NOT be the address owner) would produce it. */
function proofFor(h: ReturnType<typeof makeHarness>, email: string, address: string, signer: Keypair, provider = 'sandbox') {
  const { message, challenge } = h.wallets.createLinkChallenge(email, { address });
  return { address, provider, challenge, signature: signLinkMessage(signer, message), message };
}

async function assertRefused(h: ReturnType<typeof makeHarness>, email: string, body: unknown, label: string) {
  const err = await rejection(h.wallets.associateWallet(email, body));
  assert.equal(err.status, 400, label);
  assert.equal(err.message, GENERIC, `${label}: refusal must be the single generic message`);
}

// ------------------------------------------------------------------ challenge shape

test('link challenge: fixed human-readable message, stateless signed token, 5 minute expiry, nothing stored', () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  const address = kp.publicKey.toBase58();
  h.wallets.clock = () => Date.parse('2030-01-01T00:00:00.000Z');
  const issued = h.wallets.createLinkChallenge(' A@Example.com ', { address });

  assert.equal(issued.expiresAt, '2030-01-01T00:05:00.000Z');
  const [body, mac] = issued.challenge.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['address', 'email', 'exp', 'nonce']);
  assert.equal(payload.email, A, 'email is normalized');
  assert.equal(payload.address, address);
  assert.equal(payload.exp, Date.parse(issued.expiresAt));
  assert.match(mac, /^[A-Za-z0-9_-]{43}$/, 'base64url HMAC-SHA256');
  assert.equal(
    issued.message,
    `Helix & Field wallet link\nAccount: ${A}\nAddress: ${address}\nNonce: ${payload.nonce}\nExpires: 2030-01-01T00:05:00.000Z`,
  );
  assert.equal(LINK_CHALLENGE_TTL_MS, 5 * 60 * 1000);
  // stateless: no customer, wallet or audit row is created by asking for a challenge
  assert.equal(h.prisma.customer.rows.length, 0);
  assert.equal(h.prisma.customerWallet.rows.length, 0);
  assert.equal(h.prisma.walletAuditEvent.rows.length, 0);
  // fresh nonce every time
  assert.notEqual(h.wallets.createLinkChallenge(A, { address }).challenge, h.wallets.createLinkChallenge(A, { address }).challenge);
});

test('link challenge: rejects invalid addresses, the treasury and secret-looking fields; reveals nothing about linked state', async () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  const h = makeHarness({ config: { treasuryAddress: treasury } });
  for (const bad of [undefined, '', 'not-base58-!!', 42, '1111']) {
    assert.throws(() => h.wallets.createLinkChallenge(A, { address: bad }), (e: any) => e.getStatus() === 400, String(bad));
  }
  assert.throws(() => h.wallets.createLinkChallenge(A, { address: treasury }), (e: any) => e.getStatus() === 400);
  const kp = Keypair.generate();
  assert.throws(() => h.wallets.createLinkChallenge(A, { address: kp.publicKey.toBase58(), secretKey: 'x' }), (e: any) => e.getStatus() === 400);
  // an address already linked to someone else gets a challenge of exactly the same shape
  await h.wallets.associateWallet(B, linkRequest(h, B, kp));
  const issued = h.wallets.createLinkChallenge(A, { address: kp.publicKey.toBase58() });
  assert.deepEqual(Object.keys(issued).sort(), ['challenge', 'expiresAt', 'message']);
});

// ------------------------------------------------------------------ valid link and idempotence

test('link proof: a valid proof links the wallet and stores only the public address and audit data (no proof material)', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  const body = linkRequest(h, A, kp);
  const result = await h.wallets.associateWallet(A, body);
  assert.equal(result.created, true);
  assert.equal(result.wallet.address, kp.publicKey.toBase58());
  assert.deepEqual(Object.keys(h.prisma.customerWallet.rows[0]).sort(), ['address', 'createdAt', 'customerId', 'id', 'network', 'provider']);
  const stored = JSON.stringify([h.prisma.customerWallet.rows, h.prisma.walletAuditEvent.rows]);
  assert.ok(!stored.includes(body.signature) && !stored.includes(body.challenge), 'proof material is not persisted');
});

test('link proof: idempotent re-link of the same address by the same account (fresh or re-used proof) stays successful', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  const body = linkRequest(h, A, kp);
  assert.equal((await h.wallets.associateWallet(A, body)).created, true);
  assert.equal((await h.wallets.associateWallet(A, linkRequest(h, A, kp))).created, false);
  assert.equal((await h.wallets.associateWallet(A, body)).created, false, 'same proof re-sent by the same account inside the window');
  assert.equal(h.prisma.customerWallet.rows.length, 1);
  assert.equal(h.prisma.walletAuditEvent.rows.filter((e) => e.action === 'WALLET_ASSOCIATED').length, 1);
});

// ------------------------------------------------------------------ rejections

test('link proof: a signature from a different key is rejected with the generic message and nothing is linked', async () => {
  const h = makeHarness();
  const owner = Keypair.generate();
  const other = Keypair.generate();
  await assertRefused(h, A, proofFor(h, A, owner.publicKey.toBase58(), other), 'wrong key');
  assert.equal(h.prisma.customerWallet.rows.length, 0);
  const audit = h.prisma.walletAuditEvent.rows.find((e) => e.action === 'WALLET_LINK_REJECTED');
  assert.equal(audit?.detail.reason, 'bad-signature', 'the reason is recorded internally only');
});

test('link proof: tampered message, tampered signature and garbage signatures are rejected', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  const address = kp.publicKey.toBase58();
  const good = proofFor(h, A, address, kp);

  // signed a slightly different message (nonce changed / different account / different expiry / extra text)
  const variants = [
    good.message.replace(/Nonce: .*/, 'Nonce: AAAAAAAAAAAAAAAAAAAAAA'),
    good.message.replace(`Account: ${A}`, `Account: ${B}`),
    good.message.replace(/Expires: .*/, 'Expires: 2099-01-01T00:00:00.000Z'),
    `${good.message}\n`,
    good.message.toLowerCase(),
  ];
  for (const [i, message] of variants.entries()) {
    await assertRefused(h, A, { ...good, signature: signLinkMessage(kp, message) }, `tampered message ${i}`);
  }
  // flipped bit in an otherwise valid signature, all-zero signature, and wrong-length signature
  const sig = Buffer.from(good.signature, 'base64');
  sig[10] ^= 1;
  await assertRefused(h, A, { ...good, signature: sig.toString('base64') }, 'flipped bit');
  await assertRefused(h, A, { ...good, signature: Buffer.alloc(64).toString('base64') }, 'zero signature');
  await assertRefused(h, A, { ...good, signature: Buffer.alloc(63).toString('base64') }, 'short signature');
  // tampered token: payload swapped to a different nonce with the old MAC, MAC truncated, no dot, junk
  const [payloadPart, macPart] = good.challenge.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  const swapped = Buffer.from(JSON.stringify({ ...payload, nonce: 'zzzzzzzzzzzzzzzzzzzzzz' })).toString('base64url');
  for (const challenge of [`${swapped}.${macPart}`, `${payloadPart}.${macPart.slice(0, -2)}`, payloadPart, 'a.b', '.', '', 'x'.repeat(5000)]) {
    await assertRefused(h, A, { ...good, challenge }, `bad token ${challenge.slice(0, 12)}`);
  }
  for (const missing of ['challenge', 'signature']) {
    await assertRefused(h, A, { ...good, [missing]: undefined }, `missing ${missing}`);
  }
  // a token MACed with another key is not accepted (forged by someone without the server key)
  const forgedBody = Buffer.from(JSON.stringify({ ...payload })).toString('base64url');
  const forgedMac = createHmac('sha256', 'not-the-server-key-not-the-server-key').update(forgedBody).digest('base64url');
  await assertRefused(h, A, { ...good, challenge: `${forgedBody}.${forgedMac}` }, 'forged mac');
  assert.equal(h.prisma.customerWallet.rows.length, 0);
});

test('link proof: address mismatch is rejected (challenge for X cannot link Y, even if Y signs X\'s message)', async () => {
  const h = makeHarness();
  const x = Keypair.generate();
  const y = Keypair.generate();
  const forX = proofFor(h, A, x.publicKey.toBase58(), x);
  await assertRefused(h, A, { ...forX, address: y.publicKey.toBase58() }, 'X proof sent for Y');
  await assertRefused(h, A, { ...forX, address: y.publicKey.toBase58(), signature: signLinkMessage(y, forX.message) }, 'Y signs X message');
  assert.equal(h.prisma.customerWallet.rows.length, 0);
  assert.equal(h.prisma.walletAuditEvent.rows.at(-1)?.detail.reason, 'address-mismatch');
});

test('link proof: expired challenge is rejected; the last millisecond of validity still works', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  const t0 = Date.parse('2031-06-01T12:00:00.000Z');
  h.wallets.clock = () => t0;
  const body = linkRequest(h, A, kp);
  h.wallets.clock = () => t0 + LINK_CHALLENGE_TTL_MS;
  await assertRefused(h, A, body, 'at expiry instant');
  h.wallets.clock = () => t0 + LINK_CHALLENGE_TTL_MS + 3_600_000;
  await assertRefused(h, A, body, 'an hour later');
  assert.equal(h.prisma.walletAuditEvent.rows.at(-1)?.detail.reason, 'expired');
  assert.equal(h.prisma.customerWallet.rows.length, 0);
  h.wallets.clock = () => t0 + LINK_CHALLENGE_TTL_MS - 1;
  assert.equal((await h.wallets.associateWallet(A, body)).created, true);
});

test('link proof: a challenge issued for another email cannot be used by this account', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  // the wallet owner legitimately signs a challenge issued to B; account A tries to use it
  const forB = proofFor(h, B, kp.publicKey.toBase58(), kp);
  await assertRefused(h, A, forB, 'challenge for B used by A');
  assert.equal(h.prisma.walletAuditEvent.rows.at(-1)?.detail.reason, 'account-mismatch');
  // identity normalization does not let A pass as B or vice versa
  await assertRefused(h, 'a@example.com ', forB, 'whitespace variant');
  assert.equal(h.prisma.customerWallet.rows.length, 0);
});

test('link proof: replaying a captured proof from a different account is rejected', async () => {
  const h = makeHarness();
  const victim = Keypair.generate();
  const captured = linkRequest(h, A, victim); // e.g. sniffed from A's request
  assert.equal((await h.wallets.associateWallet(A, captured)).created, true);
  await assertRefused(h, B, captured, 'replay by B after A linked');

  const h2 = makeHarness();
  const captured2 = linkRequest(h2, A, victim);
  await assertRefused(h2, B, captured2, 'replay by B before A linked');
  assert.equal(h2.prisma.customerWallet.rows.length, 0);
  assert.equal((await h2.wallets.associateWallet(A, captured2)).created, true, 'the rightful account is unaffected');
});

// ------------------------------------------------------------------ the verified attack

test('wallet squatting: an attacker without the victim key cannot link the victim address and cannot lock the victim out', async () => {
  const h = makeHarness();
  const victim = Keypair.generate();
  const attackerKey = Keypair.generate();
  const victimAddress = victim.publicKey.toBase58();

  // The attacker asks for a challenge for the victim's PUBLIC address, then can only sign with keys he holds.
  await assertRefused(h, 'attacker@example.com', proofFor(h, 'attacker@example.com', victimAddress, attackerKey), 'attacker signs with own key');
  // ...or with a victim address pre-filled and a challenge for his own address
  const own = proofFor(h, 'attacker@example.com', attackerKey.publicKey.toBase58(), attackerKey);
  await assertRefused(h, 'attacker@example.com', { ...own, address: victimAddress }, 'own proof, victim address');
  assert.equal(h.prisma.customerWallet.rows.length, 0, 'nothing is squatted');

  // The victim is not locked out and links normally.
  const linked = await h.wallets.associateWallet('victim@example.com', linkRequest(h, 'victim@example.com', victim));
  assert.equal(linked.created, true);
  assert.equal(linked.wallet.address, victimAddress);

  // Still no way in for the attacker, and no oracle on whether the address is linked.
  const afterLinked = await rejection(h.wallets.associateWallet('attacker@example.com', proofFor(h, 'attacker@example.com', victimAddress, attackerKey)));
  assert.equal(afterLinked.status, 400);
  assert.equal(afterLinked.message, GENERIC);
  await assert.rejects(h.wallets.getWallet('attacker@example.com'), /No wallet is linked/);
  assert.equal(h.prisma.customerWallet.rows.length, 1);
});

test('"address linked to another account" and "invalid proof" are indistinguishable to the caller', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  await h.wallets.associateWallet(A, linkRequest(h, A, kp));
  // B genuinely holds the same key (e.g. imported it) and presents a perfect proof, but the address is taken.
  const taken = await rejection(h.wallets.associateWallet(B, linkRequest(h, B, kp)));
  const invalid = await rejection(h.wallets.associateWallet(B, proofFor(h, B, kp.publicKey.toBase58(), Keypair.generate())));
  assert.deepEqual(taken, invalid);
  assert.equal(taken.status, 400);
  assert.equal(taken.message, GENERIC);
  assert.equal(h.prisma.customerWallet.rows.length, 1);
  assert.ok(h.prisma.walletAuditEvent.rows.some((e) => e.detail?.reason === 'address-linked-elsewhere'), 'internal audit still records the real reason');
});

test('secret-looking fields are still rejected with 400 even alongside a valid proof, and are never audited', async () => {
  const h = makeHarness();
  for (const field of ['secretKey', 'privateKey', 'seed', 'mnemonic', 'keypair']) {
    const kp = Keypair.generate();
    const err = await rejection(h.wallets.associateWallet(A, { ...linkRequest(h, A, kp), [field]: 'do-not-store-me' }));
    assert.equal(err.status, 400, field);
    assert.notEqual(err.message, GENERIC, `${field}: secret rejection keeps its own explicit message`);
  }
  assert.equal(h.prisma.customerWallet.rows.length, 0);
  assert.ok(!JSON.stringify(h.prisma.walletAuditEvent.rows).includes('do-not-store-me'));
});

// ------------------------------------------------------------------ crypto and key handling

test('verifyEd25519 accepts only a correct detached signature over the exact bytes for the right 32-byte key', () => {
  const kp = Keypair.generate();
  const other = Keypair.generate();
  const sig = Buffer.from(signLinkMessage(kp, 'hello'), 'base64');
  assert.equal(verifyEd25519(kp.publicKey.toBytes(), 'hello', sig), true);
  assert.equal(verifyEd25519(kp.publicKey.toBytes(), 'hello!', sig), false);
  assert.equal(verifyEd25519(other.publicKey.toBytes(), 'hello', sig), false);
  assert.equal(verifyEd25519(kp.publicKey.toBytes().slice(1), 'hello', sig), false);
  assert.equal(verifyEd25519(kp.publicKey.toBytes(), 'hello', sig.subarray(1)), false);
  assert.equal(verifyEd25519(new Uint8Array(32), 'hello', Buffer.alloc(64)), false);
});

test('verifyLinkProof rejects tokens whose expiry was pushed past the 5 minute window, even when otherwise valid', () => {
  const key = Buffer.alloc(32, 7);
  const kp = Keypair.generate();
  const now = 1_900_000_000_000;
  const issued = issueLinkChallenge(key, { email: A, address: kp.publicKey.toBase58() }, now);
  const input = { email: A, address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), challenge: issued.challenge, signature: signLinkMessage(kp, issued.message) };
  assert.deepEqual(verifyLinkProof(key, input, now), { ok: true });
  assert.deepEqual(verifyLinkProof(key, input, now + LINK_CHALLENGE_TTL_MS), { ok: false, reason: 'expired' });
  // a different server key rejects the token outright
  assert.deepEqual(verifyLinkProof(Buffer.alloc(32, 8), input, now), { ok: false, reason: 'bad-mac' });
  // the message is always rebuilt from the verified payload
  const payload = JSON.parse(Buffer.from(issued.challenge.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(issued.message, buildLinkMessage(payload));
});

test('link challenge key: development/test fall back to a random per-process key; every other runtime requires >=32 chars', () => {
  const key = 'k'.repeat(32);
  for (const nodeEnv of ['development', 'test']) {
    const first = resolveLinkChallengeKey({ NODE_ENV: nodeEnv });
    assert.equal(first.length, 32);
    assert.ok(first.equals(resolveLinkChallengeKey({ NODE_ENV: nodeEnv })), 'stable within a process');
    assert.ok(resolveLinkChallengeKey({ NODE_ENV: nodeEnv, [LINK_CHALLENGE_ENV]: key }).equals(Buffer.from(key)), 'env var wins when set');
    assert.throws(() => resolveLinkChallengeKey({ NODE_ENV: nodeEnv, [LINK_CHALLENGE_ENV]: 'too-short' }), /at least 32/);
  }
  for (const nodeEnv of ['production', undefined, 'prod', 'Production', 'staging', '']) {
    assert.throws(() => resolveLinkChallengeKey({ NODE_ENV: nodeEnv }), new RegExp(LINK_CHALLENGE_ENV), String(nodeEnv));
    assert.throws(() => resolveLinkChallengeKey({ NODE_ENV: nodeEnv, [LINK_CHALLENGE_ENV]: '   ' }), new RegExp(LINK_CHALLENGE_ENV), `blank ${String(nodeEnv)}`);
    assert.throws(() => resolveLinkChallengeKey({ NODE_ENV: nodeEnv, [LINK_CHALLENGE_ENV]: 'x'.repeat(31) }), /at least 32/, `short ${String(nodeEnv)}`);
    assert.ok(resolveLinkChallengeKey({ NODE_ENV: nodeEnv, [LINK_CHALLENGE_ENV]: key }).equals(Buffer.from(key)), `configured ${String(nodeEnv)}`);
  }
});

test('WalletService fails closed at construction in a production-like runtime without the challenge key', () => {
  const h = makeHarness();
  const saved = { NODE_ENV: process.env.NODE_ENV, key: process.env[LINK_CHALLENGE_ENV] };
  try {
    delete process.env[LINK_CHALLENGE_ENV];
    process.env.NODE_ENV = 'production';
    assert.throws(() => new WalletService(h.db, h.chain, makeConfig()), new RegExp(LINK_CHALLENGE_ENV));
    process.env[LINK_CHALLENGE_ENV] = 'p'.repeat(40);
    assert.doesNotThrow(() => new WalletService(h.db, h.chain, makeConfig()));
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.key === undefined) delete process.env[LINK_CHALLENGE_ENV];
    else process.env[LINK_CHALLENGE_ENV] = saved.key;
  }
});

test('two services with different keys do not accept each other\'s challenges', async () => {
  const h = makeHarness();
  const saved = process.env[LINK_CHALLENGE_ENV];
  try {
    process.env[LINK_CHALLENGE_ENV] = 'a'.repeat(32);
    const one = new WalletService(h.db, h.chain, makeConfig());
    process.env[LINK_CHALLENGE_ENV] = 'b'.repeat(32);
    const two = new WalletService(h.db, h.chain, makeConfig());
    const kp = Keypair.generate();
    const { message, challenge } = one.createLinkChallenge(A, { address: kp.publicKey.toBase58() });
    const body = { address: kp.publicKey.toBase58(), provider: 'sandbox', challenge, signature: signLinkMessage(kp, message) };
    assert.equal((await rejection(two.associateWallet(A, body))).message, GENERIC);
    assert.equal((await one.associateWallet(A, body)).created, true);
  } finally {
    if (saved === undefined) delete process.env[LINK_CHALLENGE_ENV];
    else process.env[LINK_CHALLENGE_ENV] = saved;
  }
});
