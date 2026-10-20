import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair, Transaction } from '@solana/web3.js';
import { ChainRejectedError } from '../../chain/chain-errors';
import { ChainUnavailableError } from '../../contracts';
import { base58Encode } from '../checkout.util';
import { CUSTOMER_ID, ORDER_ID, makeHarness, prepareSignSubmit, signAs, signatureOf, transferFor } from './harness';

const rejects = (promise: Promise<unknown>, status: number, match?: RegExp) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), status, `expected HTTP ${status}, got ${e.getStatus?.()} (${e.message})`);
    if (match) assert.match(e.message, match);
    return true;
  });

test('submit accepts the customer-signed prepared transaction, broadcasts and records SUBMITTED', async () => {
  const h = makeHarness();
  const { prepared, submitted, signed } = await prepareSignSubmit(h);
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(submitted.idempotent, false);
  assert.equal(submitted.txSignature, signatureOf(signed));
  assert.equal(h.chain.broadcasts.length, 1);
  const row = h.prisma.txs[0];
  assert.equal(row.status, 'SUBMITTED');
  assert.equal(row.txSignature, submitted.txSignature);
  assert.equal(row.reference, prepared.paymentReference);
  // submit does not settle the order or touch credits
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
});

test('submit rejects an unsigned transaction and never broadcasts', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, prepared.unsignedTransactionBase64), 400, /not signed/);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
});

test('submit rejects a transaction whose signature was produced by a different key', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  // Build a signature over the same message with a stranger's key and place it in the customer's slot.
  const tx = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  const forged = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  const strangerTx = new Transaction({ feePayer: h.stranger.publicKey, blockhash: tx.recentBlockhash!, lastValidBlockHeight: 1 });
  strangerTx.add(...tx.instructions);
  strangerTx.sign(h.stranger);
  forged.addSignature(h.customer.publicKey, strangerTx.signature!);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, forged.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')), 400, /signature is invalid/);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('submit rejects a transaction signed by the stranger as fee payer (different message)', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const tx = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  const other = new Transaction({ feePayer: h.stranger.publicKey, blockhash: tx.recentBlockhash!, lastValidBlockHeight: 1 });
  other.add(...tx.instructions);
  other.sign(h.stranger);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, other.serialize({ requireAllSignatures: false }).toString('base64')), 400, /does not match/);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('submit rejects tampered messages (different amount / destination / reference), even if validly signed', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const tx = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));

  // different amount (transferChecked u64 LE at data[1..9])
  const lowerAmount = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  lowerAmount.instructions[0].data.writeBigUInt64LE(1n, 1);
  // different destination token account
  const otherDest = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  otherDest.instructions[0].keys[2].pubkey = Keypair.generate().publicKey;
  // dropped reference account
  const noRef = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  noRef.instructions[0].keys.pop();

  for (const tampered of [lowerAmount, otherDest, noRef]) {
    tampered.recentBlockhash = tx.recentBlockhash;
    tampered.feePayer = h.customer.publicKey;
    tampered.sign(h.customer); // customer's own valid signature over the *tampered* message
    await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, tampered.serialize().toString('base64')), 400, /does not match the prepared payment/);
  }
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
});

test('submit rejects malformed payloads', async () => {
  const h = makeHarness();
  await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, '!!!notbase64'), 400);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, 'AAAAAAAA'), 400, /deserialized/);
});

test('submit rejects an expired or released reservation', async () => {
  for (const mutate of [
    (r: any) => (r.expiresAt = new Date(Date.now() - 1)),
    (r: any) => (r.status = 'RELEASED'),
    (r: any) => (r.status = 'EXPIRED'),
  ]) {
    const h = makeHarness();
    const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
    mutate(h.prisma.reservations[0]);
    await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer)), 409, /Reservation/);
    assert.equal(h.chain.broadcasts.length, 0);
  }
});

test('submit: identical payload is idempotent, a different payload is 409', async () => {
  const h = makeHarness();
  const { prepared, signed, submitted } = await prepareSignSubmit(h);
  const again = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  assert.equal(again.idempotent, true);
  assert.equal(again.txSignature, submitted.txSignature);
  assert.equal(h.chain.broadcasts.length, 1, 'no second broadcast');

  // A different payload for the same order (re-prepared by calling prepare again is blocked, so craft one).
  const different = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  different.recentBlockhash = base58Encode(Buffer.alloc(32, 9));
  different.sign(h.customer);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, different.serialize().toString('base64')), 409, /different transaction/);
  assert.equal(h.chain.broadcasts.length, 1);
});

test('concurrent submits of the same payload broadcast once', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const results = await Promise.allSettled([1, 2, 3].map(() => h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)));
  assert.equal(h.chain.broadcasts.length, 1);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal(h.prisma.txs.filter((t) => t.status === 'SUBMITTED').length, 1);
});

test('submit for another customer or missing prepare is rejected', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  await rejects(h.checkout.submit('cust_2', ORDER_ID, signed), 404);
  const h2 = makeHarness();
  await rejects(h2.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 409, /prepare first/);
});

test('submit fails closed when the prepared message is missing (store lost)', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await h.store.delete(prepared.paymentReference);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer)), 409, /prepare again/);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('broadcast outage keeps SUBMITTED + signature (outcome unknown): retry is idempotent and the customer cannot pay twice', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const signature = signatureOf(signed);
  h.chain.broadcastError = new ChainUnavailableError('socket timeout');
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 503, /may or may not have been sent/);
  // The cluster might have accepted it: the row, signature and hold must survive.
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  assert.equal(h.prisma.txs[0].txSignature, signature);
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.submit_outcome_unknown').length, 1);
  const held = await h.spendable();
  assert.equal(held.spendableAtomic, held.finalizedAtomic - BigInt(prepared.amountAtomic), 'funds stay held while the outcome is unknown');

  // Re-preparing (which would create a second payable transaction) is blocked while this one is in flight.
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /already in flight/);
  // A different signed payload is refused.
  const different = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  different.recentBlockhash = base58Encode(Buffer.alloc(32, 9));
  different.sign(h.customer);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, different.serialize().toString('base64')), 409, /different transaction/);

  // Retrying the identical payload is idempotent: same signature, no re-broadcast, still exactly one row.
  h.chain.broadcastError = null;
  const retry = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.txSignature, signature);
  assert.equal(retry.status, 'SUBMITTED');
  assert.equal(h.chain.broadcasts.length, 0, 'an unknown-outcome retry never re-broadcasts');
  assert.equal(h.prisma.txs.length, 1);

  // Verification then settles it exactly once when it did land.
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  assert.equal((await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference })).outcome, 'FINALIZED');
  assert.equal(h.prisma.orders[0].status, 'PAID');
});

test('broadcast outage where the transaction never landed is released only by reconciliation after the reservation TTL', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  h.chain.broadcastError = new ChainUnavailableError();
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer)), 503);
  h.prisma.txs[0].createdAt = new Date(Date.now() - 5 * 60_000);
  assert.equal((await h.recon.reconcile()).expired, 0, 'inside the TTL it stays SUBMITTED');
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  h.prisma.txs[0].createdAt = new Date(Date.now() - 20 * 60_000);
  assert.equal((await h.recon.reconcile()).expired, 1);
  assert.equal(h.prisma.txs[0].status, 'EXPIRED');
});

test('an unclassified broadcast error (e.g. a timeout) is also an unknown outcome: SUBMITTED is kept', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  h.chain.broadcastError = new Error('ETIMEDOUT');
  await assert.rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), /ETIMEDOUT/);
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  assert.equal(h.prisma.txs[0].txSignature, signatureOf(signed));
});

test('a definitive rejection (ChainRejectedError) reverts to PREPARED with no signature so the customer can re-submit', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  h.chain.broadcastError = new ChainRejectedError('blockhash not found');
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 502);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
  assert.equal(h.prisma.txs[0].txSignature, null);
  h.chain.broadcastError = null;
  const ok = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  assert.equal(ok.status, 'SUBMITTED');
  assert.equal(ok.idempotent, false);
  assert.equal(h.chain.broadcasts.length, 1);
});

test('submit broadcasts the canonical serialization: trailing bytes and a non-minimal shortvec are not forwarded', async () => {
  const h = makeHarness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = Buffer.from(signAs(prepared.unsignedTransactionBase64, h.customer), 'base64');
  const canonical = Transaction.from(signed).serialize();
  assert.ok(canonical.equals(signed), 'sanity: the wallet-signed bytes are canonical');
  // [shortvec(1 signature)=0x01] -> non-minimal 0x81 0x00, plus trailing garbage.
  const nonMinimal = Buffer.concat([Buffer.from([0x81, 0x00]), signed.subarray(1), Buffer.from('deadbeef', 'hex')]);
  assert.ok(!nonMinimal.equals(canonical));
  const result = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, nonMinimal.toString('base64'));
  assert.equal(result.status, 'SUBMITTED');
  assert.equal(h.chain.broadcasts.length, 1);
  assert.ok(Buffer.from(h.chain.broadcasts[0]).equals(canonical), 'only the canonical bytes reach the chain');
});

test('status is read-only and serializes bigint as strings', async () => {
  const h = makeHarness();
  await prepareSignSubmit(h);
  const dump = () => JSON.stringify(h.prisma.tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const before = dump();
  const status = await h.checkout.status(CUSTOMER_ID, ORDER_ID);
  assert.equal(dump(), before, 'status must not mutate');
  assert.equal(status.orderStatus, 'PENDING_PAYMENT');
  assert.equal(status.payment!.status, 'SUBMITTED');
  assert.equal(status.payment!.amountAtomic, '250000000');
  assert.equal(JSON.parse(JSON.stringify(status)).reservation.amountAtomic, '250000000');
});
