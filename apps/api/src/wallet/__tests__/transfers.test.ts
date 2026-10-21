import { strict as assert } from 'node:assert';
import { createPrivateKey, sign as nodeEd25519Sign } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { USDC_DEVNET_MINT } from '../contracts';
import { PREPARED_TTL_MS, UNCONFIRMED_EXPIRY_MS } from '../transfers/transfers.service';
import { Harness, linkCustomer, makeHarness, rejection } from './helpers';

const MINT = new PublicKey(USDC_DEVNET_MINT);
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

async function setup(balance = USDC(100), options: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness(options);
  const who = await linkCustomer(h);
  h.chain.creditUsdc(who.address, balance);
  const destination = Keypair.generate().publicKey.toBase58();
  return { h, ...who, destination };
}

const customerSign = (unsignedBase64: string, keypair: Keypair): string => {
  const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  tx.partialSign(keypair); // TEST ONLY: plays the customer's own wallet
  return tx.serialize().toString('base64');
};

/** Ed25519 signature by an arbitrary key over arbitrary bytes, via node crypto (test only). */
function rawSign(keypair: Keypair, message: Uint8Array): Buffer {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.slice(0, 32))]);
  return nodeEd25519Sign(null, message, createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}

function countBroadcasts(chain: SandboxSolanaChain) {
  const counter = { count: 0 };
  const original = chain.broadcast.bind(chain);
  chain.broadcast = async (bytes) => {
    counter.count += 1;
    return original(bytes);
  };
  return counter;
}

/** Builds a legitimately customer-signed transaction that differs from the prepared one. */
async function differentTxSignedByCustomer(h: Harness, keypair: Keypair, destination: string, amount: bigint, preparedBase64: string) {
  const prepared = Transaction.from(Buffer.from(preparedBase64, 'base64'));
  const owner = keypair.publicKey;
  const dest = new PublicKey(destination);
  const tx = new Transaction({ feePayer: owner, blockhash: prepared.recentBlockhash!, lastValidBlockHeight: 1 });
  tx.add(
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(MINT, owner, true),
      MINT,
      getAssociatedTokenAddressSync(MINT, dest, true),
      owner,
      amount,
      6,
    ),
  );
  tx.partialSign(keypair);
  return tx.serialize().toString('base64');
}

// ---------------------------------------------------------------- prepare

test('prepare builds an unsigned legacy transfer: customer fee payer, transferChecked, 6 decimals, ATA creation disclosed', async () => {
  const { h, customer, address, destination } = await setup();
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '2500000' });
  assert.equal(prepared.amountAtomic, 2_500_000n);
  assert.equal(prepared.signer, address);
  assert.equal(prepared.fee.networkFeeLamports, 5000n);
  assert.equal(prepared.fee.destinationAccountCreation.required, true);
  assert.ok(prepared.fee.destinationAccountCreation.rentLamports > 0n);
  assert.ok(prepared.warnings.some((w) => /irreversible/i.test(w)));
  assert.ok(prepared.warnings.some((w) => /verify the destination/i.test(w)));
  assert.ok(prepared.warnings.some((w) => /SOL/.test(w)));
  assert.ok(prepared.warnings.some((w) => /rent/i.test(w)));

  const tx = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  assert.equal(tx.feePayer!.toBase58(), address);
  assert.equal(tx.signature, null); // nothing signed by the platform
  assert.equal(tx.instructions.length, 2); // idempotent ATA create + transferChecked
  const transfer = tx.instructions[1];
  assert.equal(transfer.data[0], 12); // TransferChecked
  assert.equal(transfer.data.readBigUInt64LE(1), 2_500_000n);
  assert.equal(transfer.data[9], 6);
  assert.equal(transfer.keys[1].pubkey.toBase58(), USDC_DEVNET_MINT);
  assert.equal(transfer.keys[0].pubkey.toBase58(), getAssociatedTokenAddressSync(MINT, new PublicKey(address)).toBase58());
  assert.equal(transfer.keys[2].pubkey.toBase58(), getAssociatedTokenAddressSync(MINT, new PublicKey(destination)).toBase58());

  const row = h.prisma.cryptoTransaction.rows[0];
  assert.equal(row.type, 'WITHDRAWAL');
  assert.equal(row.status, 'PREPARED');
  assert.match(row.reference, /^wd_/);
  assert.equal(row.amountAtomic, 2_500_000n);
  assert.equal(row.txSignature, null);
});

test('prepare skips ATA creation when the recipient already has a USDC account', async () => {
  const { h, customer, destination } = await setup();
  h.chain.creditUsdc(destination, 1n);
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  assert.equal(prepared.fee.destinationAccountCreation.required, false);
  assert.equal(Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64')).instructions.length, 1);
});

test('prepare rejects invalid address, self-transfer, bad amounts, and insufficient funds', async () => {
  const { h, customer, address, destination } = await setup(USDC(10));
  const bad = (input: any) => rejection(h.transfers.prepare(customer.id, input));
  assert.equal((await bad({ destination: 'nope', amountAtomic: '1' })).status, 400);
  assert.equal((await bad({ destination: undefined, amountAtomic: '1' })).status, 400);
  assert.equal((await bad({ destination: address, amountAtomic: '1' })).status, 400);
  assert.equal((await bad({ destination: USDC_DEVNET_MINT, amountAtomic: '1' })).status, 400);
  for (const amount of ['0', '-5', '1.5', '1e6', 'abc', '', ' 1', 12, null === undefined]) {
    assert.equal((await bad({ destination, amountAtomic: amount })).status, 400, String(amount));
  }
  assert.equal((await bad({ destination, amountAtomic: '99999999999999999999999' })).status, 400);
  assert.equal((await bad({ destination })).status, 400); // neither amount nor max
  assert.equal((await bad({ destination, amountAtomic: '1', max: true })).status, 400);
  const insufficient = await bad({ destination, amountAtomic: '10000001' });
  assert.equal(insufficient.status, 400);
  assert.match(insufficient.message, /insufficient/i);
  assert.equal(h.prisma.cryptoTransaction.rows.length, 0); // nothing persisted on rejection
  // exactly the whole balance is allowed (no arbitrary limits)
  assert.equal((await h.transfers.prepare(customer.id, { destination, amountAtomic: '10000000' })).amountAtomic, 10_000_000n);
});

test('prepare with max:true sends the full spendable balance (after reservations and pending)', async () => {
  const { h, customer, address, destination } = await setup(USDC(100));
  await h.prisma.creditReservation.create({ data: { customerId: customer.id, orderId: 'o1', amountAtomic: USDC(30), expiresAt: new Date(Date.now() + 60_000) } });
  await h.prisma.cryptoTransaction.create({
    data: { customerId: customer.id, type: 'PURCHASE', status: 'SUBMITTED', amountAtomic: USDC(5), sourceAddress: address, destinationAddress: 'x', mint: USDC_DEVNET_MINT, network: 'solana-devnet', reference: 'p1' },
  });
  const prepared = await h.transfers.prepare(customer.id, { destination, max: true });
  assert.equal(prepared.amountAtomic, USDC(65));
  // max on an empty spendable balance is rejected
  const empty = await setup(0n);
  assert.equal((await rejection(empty.h.transfers.prepare(empty.customer.id, { destination: empty.destination, max: true }))).status, 400);
});

test('prepare fails closed (503) on chain outage and honors the compliance hook', async () => {
  const outage = await setup();
  outage.h.chain.setOutage(true);
  assert.equal((await rejection(outage.h.transfers.prepare(outage.customer.id, { destination: outage.destination, amountAtomic: '1' }))).status, 503);

  const seen: any[] = [];
  const blocked = await setup(USDC(10), { compliance: { screen: async (input) => (seen.push(input), { allowed: false, reason: 'listed' }) } });
  const err = await rejection(blocked.h.transfers.prepare(blocked.customer.id, { destination: blocked.destination, amountAtomic: '1' }));
  assert.equal(err.status, 403);
  assert.ok(!err.message.includes('listed'));
  assert.equal(seen[0].destinationAddress, blocked.destination);
  assert.equal(blocked.h.prisma.cryptoTransaction.rows.length, 0);
});

// ---------------------------------------------------------------- submit

test('signed transfer is broadcast, counts as pending, and only FINALIZED from chain finalization', async () => {
  const { h, customer, keypair, address, destination } = await setup(USDC(100));
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: String(USDC(40)) });
  const submitted = await h.transfers.submit(customer.id, prepared.transactionId, customerSign(prepared.unsignedTransaction, keypair));
  assert.equal(submitted.status, 'SUBMITTED');
  assert.ok(submitted.txSignature);

  // in flight: chain still shows full balance, pending subtracts
  let balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.finalizedAtomic, USDC(100));
  assert.equal(balance.pendingOutgoingAtomic, USDC(40));
  assert.equal(balance.spendableAtomic, USDC(60));

  await h.transfers.reconcile(customer.id);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'CONFIRMED'); // observed, not finalized
  assert.equal((await h.credits.getBalance(customer.id)).spendableAtomic, USDC(60));

  h.chain.finalize(submitted.txSignature!);
  await h.transfers.reconcile(customer.id);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'FINALIZED');
  assert.ok(h.prisma.cryptoTransaction.rows[0].finalizedAt);
  balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.finalizedAtomic, USDC(60));
  assert.equal(balance.pendingOutgoingAtomic, 0n);
  assert.equal(balance.spendableAtomic, USDC(60));
  assert.equal(await h.chain.getFinalizedUsdcBalance(destination), USDC(40));
  assert.equal(await h.chain.getFinalizedUsdcBalance(address), USDC(60));
});

test('submit broadcasts the canonical serialization: trailing bytes and a non-minimal shortvec are not forwarded', async () => {
  const { h, customer, keypair, destination } = await setup(USDC(100));
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: String(USDC(10)) });
  const signed = Buffer.from(customerSign(prepared.unsignedTransaction, keypair), 'base64');
  const canonical = Transaction.from(signed).serialize();
  assert.ok(canonical.equals(signed), 'sanity: the wallet-signed bytes are canonical');
  // Non-minimal shortvec for "1 signature" (0x01 -> 0x81 0x00) plus trailing garbage: still decodes, must not be forwarded.
  const mangled = Buffer.concat([Buffer.from([0x81, 0x00]), signed.subarray(1), Buffer.from('deadbeef', 'hex')]);
  assert.ok(!mangled.equals(canonical));
  const forwarded: Uint8Array[] = [];
  const original = h.chain.broadcast.bind(h.chain);
  h.chain.broadcast = async (bytes) => {
    forwarded.push(Buffer.from(bytes));
    return original(bytes);
  };
  const result = await h.transfers.submit(customer.id, prepared.transactionId, mangled.toString('base64'));
  assert.equal(result.status, 'SUBMITTED');
  assert.equal(forwarded.length, 1);
  assert.ok(Buffer.from(forwarded[0]).equals(canonical), 'only the canonical bytes reach the chain');
});

test('submit rejects an unsigned, garbage-signed, and foreign-signed transaction', async () => {
  const { h, customer, keypair, destination } = await setup();
  const broadcasts = countBroadcasts(h.chain);
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });

  // missing signature
  const unsigned = await rejection(h.transfers.submit(customer.id, prepared.transactionId, prepared.unsignedTransaction));
  assert.equal(unsigned.status, 400);
  assert.match(unsigned.message, /not signed/i);

  // invalid (random) signature bytes in the customer's slot
  const forged = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  forged.signatures[0].signature = Buffer.alloc(64, 7);
  const invalid = await rejection(h.transfers.submit(customer.id, prepared.transactionId, forged.serialize({ verifySignatures: false }).toString('base64')));
  assert.equal(invalid.status, 400);
  assert.match(invalid.message, /signature/i);

  // valid ed25519 signature, but by a different key than the customer's wallet
  const foreign = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  foreign.signatures[0].signature = rawSign(Keypair.generate(), foreign.compileMessage().serialize());
  const foreignErr = await rejection(h.transfers.submit(customer.id, prepared.transactionId, foreign.serialize({ verifySignatures: false }).toString('base64')));
  assert.equal(foreignErr.status, 400);
  assert.match(foreignErr.message, /signature is not valid/i);

  // a transaction whose fee payer is another wallet entirely (signed correctly by that wallet)
  const mallory = Keypair.generate();
  const other = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  const swapped = new Transaction({ feePayer: mallory.publicKey, blockhash: other.recentBlockhash!, lastValidBlockHeight: 1 });
  swapped.add(...other.instructions);
  swapped.partialSign(mallory);
  const swappedErr = await rejection(h.transfers.submit(customer.id, prepared.transactionId, swapped.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')));
  assert.equal(swappedErr.status, 400);

  // garbage payloads
  for (const junk of ['', '%%%', 'AAAA', 12 as any]) {
    assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, junk))).status, 400);
  }
  assert.equal(broadcasts.count, 0);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'PREPARED');

  // the genuine signature still works afterwards
  const ok = await h.transfers.submit(customer.id, prepared.transactionId, customerSign(prepared.unsignedTransaction, keypair));
  assert.equal(ok.status, 'SUBMITTED');
  assert.equal(broadcasts.count, 1);
});

test('submit rejects a tampered message even when validly signed by the customer', async () => {
  const { h, customer, keypair, destination } = await setup();
  const broadcasts = countBroadcasts(h.chain);
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });

  // different amount
  const bigger = await differentTxSignedByCustomer(h, keypair, destination, 9_000_000n, prepared.unsignedTransaction);
  assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, bigger))).status, 400);
  // different destination (attacker address) with the same amount
  const redirected = await differentTxSignedByCustomer(h, keypair, Keypair.generate().publicKey.toBase58(), 1_000_000n, prepared.unsignedTransaction);
  assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, redirected))).status, 400);
  // extra instruction appended to the prepared transaction
  const appended = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  appended.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  appended.partialSign(keypair);
  assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, appended.serialize().toString('base64')))).status, 400);
  // different recent blockhash
  const reblocked = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  reblocked.recentBlockhash = h.chain.advanceBlockhash();
  reblocked.partialSign(keypair);
  assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, reblocked.serialize().toString('base64')))).status, 400);

  assert.equal(broadcasts.count, 0);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'PREPARED');
});

test('duplicate submit is idempotent and broadcasts once; a different payload for the same id is 409', async () => {
  const { h, customer, keypair, destination } = await setup();
  const broadcasts = countBroadcasts(h.chain);
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  const signed = customerSign(prepared.unsignedTransaction, keypair);
  const first = await h.transfers.submit(customer.id, prepared.transactionId, signed);
  const second = await h.transfers.submit(customer.id, prepared.transactionId, signed);
  assert.deepEqual(second, first);
  assert.equal(broadcasts.count, 1);

  const different = await differentTxSignedByCustomer(h, keypair, destination, 2_000_000n, prepared.unsignedTransaction);
  assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, different))).status, 409);
  assert.equal(broadcasts.count, 1);
});

test('the same signed transaction cannot fulfil two prepared transfers', async () => {
  const { h, customer, keypair, destination } = await setup();
  const one = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  const two = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' }); // identical message
  const signed = customerSign(one.unsignedTransaction, keypair);
  await h.transfers.submit(customer.id, one.transactionId, signed);
  assert.equal((await rejection(h.transfers.submit(customer.id, two.transactionId, signed))).status, 409);
});

test("submit cannot touch another customer's transfer", async () => {
  const { h, customer, keypair, destination } = await setup();
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  const intruder = await linkCustomer(h, 'intruder@example.com');
  const err = await rejection(h.transfers.submit(intruder.customer.id, prepared.transactionId, customerSign(prepared.unsignedTransaction, keypair)));
  assert.equal(err.status, 404);
});

test('submit fails closed when the prepared record is missing or expired', async () => {
  const { h, customer, keypair, destination } = await setup();
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  await h.store.delete(prepared.transactionId); // e.g. process restart with the in-memory store
  const err = await rejection(h.transfers.submit(customer.id, prepared.transactionId, customerSign(prepared.unsignedTransaction, keypair)));
  assert.equal(err.status, 409);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'EXPIRED');
});

test('submit re-checks spendable funds and honors chain rejection by marking FAILED', async () => {
  const { h, customer, keypair, address, destination } = await setup(USDC(10));
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: String(USDC(10)) });
  await h.prisma.creditReservation.create({ data: { customerId: customer.id, orderId: 'o9', amountAtomic: USDC(5), expiresAt: new Date(Date.now() + 60_000) } });
  const err = await rejection(h.transfers.submit(customer.id, prepared.transactionId, customerSign(prepared.unsignedTransaction, keypair)));
  assert.equal(err.status, 400);
  assert.match(err.message, /insufficient/i);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'PREPARED');

  // network rejection (no SOL for fees on a strict chain) -> FAILED, no longer pending
  const strictChain = new SandboxSolanaChain({ strictSolFees: true });
  const s = await setup(USDC(10), { chain: strictChain });
  strictChain.setSolBalance(s.address, 0n);
  const p = await s.h.transfers.prepare(s.customer.id, { destination: s.destination, amountAtomic: '1000000' });
  assert.ok(p.warnings.some((w) => /below/.test(w)));
  const failed = await rejection(s.h.transfers.submit(s.customer.id, p.transactionId, customerSign(p.unsignedTransaction, s.keypair)));
  assert.equal(failed.status, 400);
  assert.equal(s.h.prisma.cryptoTransaction.rows[0].status, 'FAILED');
  assert.equal((await s.h.credits.getBalance(s.customer.id)).pendingOutgoingAtomic, 0n);
  void address;
});

test('broadcast outage keeps the transfer SUBMITTED (pending) and returns 503', async () => {
  const { h, customer, keypair, destination } = await setup();
  const prepared = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  const signed = customerSign(prepared.unsignedTransaction, keypair);
  const original = h.chain.broadcast.bind(h.chain);
  h.chain.broadcast = async () => {
    h.chain.setOutage(true);
    return original(new Uint8Array());
  };
  assert.equal((await rejection(h.transfers.submit(customer.id, prepared.transactionId, signed))).status, 503);
  assert.equal(h.prisma.cryptoTransaction.rows[0].status, 'SUBMITTED');
  h.chain.setOutage(false);
});

test('reconcile expires stale prepared rows and unconfirmed submissions, never finalizing without the chain', async () => {
  const { h, customer, keypair, destination } = await setup();
  const stale = await h.transfers.prepare(customer.id, { destination, amountAtomic: '1000000' });
  h.prisma.cryptoTransaction.rows.find((r) => r.id === stale.transactionId)!.createdAt = new Date(Date.now() - PREPARED_TTL_MS - 1000);
  const lost = await h.transfers.prepare(customer.id, { destination, amountAtomic: '2000000' });
  const original = h.chain.broadcast.bind(h.chain);
  h.chain.broadcast = async () => 'sig-never-lands'; // pretend broadcast accepted but nothing appears on chain
  await h.transfers.submit(customer.id, lost.transactionId, customerSign(lost.unsignedTransaction, keypair));
  h.chain.broadcast = original;
  await h.transfers.reconcile(customer.id);
  assert.equal(h.prisma.cryptoTransaction.rows.find((r) => r.id === stale.transactionId)!.status, 'EXPIRED');
  assert.equal(h.prisma.cryptoTransaction.rows.find((r) => r.id === lost.transactionId)!.status, 'SUBMITTED');
  h.prisma.cryptoTransaction.rows.find((r) => r.id === lost.transactionId)!.createdAt = new Date(Date.now() - UNCONFIRMED_EXPIRY_MS - 1000);
  await h.transfers.reconcile(customer.id);
  assert.equal(h.prisma.cryptoTransaction.rows.find((r) => r.id === lost.transactionId)!.status, 'EXPIRED');
});

// ---------------------------------------------------------------- invariants

test('platform source contains no signing or secret-key code path (outside tests)', () => {
  const root = join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === '__tests__') continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length > 10);
  const forbidden = [/Keypair\.fromSecretKey/, /\.secretKey/, /\bsecretKey\b/, /\bsign\(/, /partialSign/, /Keypair\.generate/, /createPrivateKey/];
  for (const file of files.filter((f) => !f.includes('/checkout/'))) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
  }
});
