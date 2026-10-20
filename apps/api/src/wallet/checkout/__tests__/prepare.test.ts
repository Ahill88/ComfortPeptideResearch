import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Message, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { USDC_DEVNET_MINT } from '../../contracts';
import { referenceKeyFor } from '../checkout.util';
import { CUSTOMER_ID, ORDER_ID, makeHarness } from './harness';

const rejects = (promise: Promise<unknown>, status: number, match?: RegExp) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), status, `expected HTTP ${status}, got ${e.getStatus?.()} (${e.message})`);
    if (match) assert.match(e.message, match);
    return true;
  });

test('prepare builds an unsigned transfer with reference, exact amount and disclosures', async () => {
  const h = makeHarness({ totalCents: 25_050 });
  const p = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(p.amountAtomic, '250500000');
  assert.equal(p.amountUsd, '250.50');
  assert.equal(p.network, 'solana-devnet');
  assert.equal(p.mint, USDC_DEVNET_MINT);
  assert.equal(p.merchant, h.merchant.publicKey.toBase58());
  assert.equal(p.feeLamports, '5000');
  assert.equal(typeof p.amountAtomic, 'string');
  assert.match(p.disclosures.join('\n'), /250\.50 USD/);
  assert.match(p.disclosures.join('\n'), /SOL/);
  assert.match(p.disclosures.join('\n'), /your own signature/);
  assert.match(p.disclosures.join('\n'), /reduce only when the USDC transfer is finalized/);

  const tx = Transaction.from(Buffer.from(p.unsignedTransactionBase64, 'base64'));
  assert.equal(tx.feePayer!.toBase58(), h.customer.publicKey.toBase58());
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.signatures[0].signature, null, 'must be unsigned');
  const ix = tx.instructions[0];
  assert.equal(ix.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  const mint = new PublicKey(USDC_DEVNET_MINT);
  assert.equal(ix.keys[0].pubkey.toBase58(), getAssociatedTokenAddressSync(mint, h.customer.publicKey).toBase58());
  assert.equal(ix.keys[2].pubkey.toBase58(), getAssociatedTokenAddressSync(mint, h.merchant.publicKey, true).toBase58());
  const ref = ix.keys[ix.keys.length - 1];
  assert.equal(ref.pubkey.toBase58(), referenceKeyFor(p.paymentReference).toBase58());
  assert.equal(ref.isSigner, false);
  assert.equal(ref.isWritable, false);
  // transferChecked data: [12, u64 amount LE, decimals]
  assert.equal(ix.data[0], 12);
  assert.equal(ix.data.readBigUInt64LE(1), 250_500_000n);
  assert.equal(ix.data[9], 6);

  assert.equal(h.prisma.reservations.length, 1);
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  assert.equal(h.prisma.txs.length, 1);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
  assert.equal(h.prisma.txs[0].type, 'PURCHASE');
  const stored = await h.store.get(p.paymentReference);
  assert.deepEqual(Buffer.from(stored!.messageBytes), Buffer.from(Message.from(Transaction.from(Buffer.from(p.unsignedTransactionBase64, 'base64')).serializeMessage()).serialize()));
});

test('prepare rejects insufficient funds', async () => {
  const h = makeHarness({ usdc: 249_999_999n });
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402, /Insufficient Research Credits/);
  assert.equal(h.prisma.reservations.length, 0);
  assert.equal(h.prisma.txs.length, 0);
});

test('prepare rejects insufficient SOL for the fee', async () => {
  const h = makeHarness();
  h.chain.sol.set(h.customer.publicKey.toBase58(), 100n);
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402, /SOL/);
  assert.equal(h.prisma.reservations.length, 0);
});

test('prepare fails closed on a stale balance', async () => {
  const h = makeHarness();
  h.staleBalance.value = true;
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 503, /stale/);
  assert.equal(h.prisma.reservations.length, 0);
});

test('prepare rejects an order owned by another customer (404, no leak)', async () => {
  const h = makeHarness();
  await rejects(h.checkout.prepare('cust_2', ORDER_ID), 404);
  await rejects(h.checkout.prepare(CUSTOMER_ID, 'nope'), 404);
  assert.equal(h.prisma.reservations.length, 0);
});

test('prepare rejects a non-pending order', async () => {
  for (const status of ['PAID', 'CANCELLED', 'SHIPPED']) {
    const h = makeHarness({ orderStatus: status });
    await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /not awaiting payment/);
  }
});

test('prepare rejects a missing research acknowledgement', async () => {
  const h = makeHarness({ acknowledged: false });
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 400, /acknowledgement/);
  assert.equal(h.prisma.reservations.length, 0);
});

test('prepare rejects when a PURCHASE is already FINALIZED', async () => {
  const h = makeHarness();
  h.prisma.txs.push({ id: 'old', customerId: CUSTOMER_ID, type: 'PURCHASE', status: 'FINALIZED', orderId: ORDER_ID, reference: 'x', amountAtomic: 1n, createdAt: new Date(), __seq: 0 });
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /finalized/);
});

test('prepare refuses mainnet unless flagged, and live payments flag gates mainnet', async () => {
  const h = makeHarness();
  h.chain.network = 'solana-mainnet';
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /mainnet is disabled/);
  h.flags.enableSolanaMainnet = true;
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /Live crypto payments are disabled/);
  h.flags.enableLiveCryptoPayments = true;
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /mint is not configured/);
  assert.equal(h.prisma.reservations.length, 0);
});

test('devnet works with all flags false (sandbox/devnet is not "live")', async () => {
  const h = makeHarness();
  assert.equal(h.flags.enableLiveCryptoPayments, false);
  await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
});

test('prepare refuses missing/invalid treasury and treasury equal to the customer wallet', async () => {
  const h = makeHarness();
  h.config.treasury = undefined;
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 503, /treasury/);
  h.config.treasury = 'not-a-key';
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 503, /treasury/);
  h.config.treasury = h.customer.publicKey.toBase58();
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 409, /differ from the customer wallet/);
  assert.equal(h.prisma.reservations.length, 0);
});

test('chain outage during prepare leaves no state', async () => {
  const h = makeHarness();
  h.chain.unavailable = true;
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 503);
  assert.equal(h.prisma.reservations.length, 0);
  assert.equal(h.prisma.txs.length, 0);
});

test('concurrent prepare (same service) creates exactly one reservation and one purchase row', async () => {
  const h = makeHarness();
  const results = await Promise.all([1, 2, 3, 4].map(() => h.checkout.prepare(CUSTOMER_ID, ORDER_ID)));
  assert.equal(h.prisma.reservations.length, 1);
  assert.equal(h.prisma.txs.length, 1);
  assert.equal(new Set(results.map((r) => r.paymentReference)).size, 1);
  assert.equal(new Set(results.map((r) => r.unsignedTransactionBase64)).size, 1, 'identical message is reused');
});

test('concurrent prepare across service instances (no shared lock) relies on the unique reservation and handles P2002', async () => {
  const h = makeHarness();
  const a = h.makeCheckout();
  const b = h.makeCheckout();
  let reservationInserts = 0;
  h.prisma.failOn = (table, op) => {
    if (table === 'creditReservation' && op === 'create') reservationInserts++;
  };
  const results = await Promise.all([a.prepare(CUSTOMER_ID, ORDER_ID), b.prepare(CUSTOMER_ID, ORDER_ID)]);
  assert.equal(reservationInserts, 2, 'both attempted; the loser hit P2002');
  assert.equal(h.prisma.reservations.length, 1);
  assert.equal(h.prisma.txs.length, 1);
  assert.equal(results[0].paymentReference, results[1].paymentReference);
  assert.equal(h.prisma.audits.filter((x) => x.action === 'checkout.prepared').length, 1);
});

test('re-prepare is idempotent for funds exactly equal to the price (own hold is not double counted)', async () => {
  const h = makeHarness({ usdc: 250_000_000n });
  const first = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const second = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(first.paymentReference, second.paymentReference);
  assert.equal(h.prisma.reservations.length, 1);
});

test('re-prepare after expiry revives the reservation with a fresh reference', async () => {
  const h = makeHarness();
  const first = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  h.prisma.reservations[0].expiresAt = new Date(Date.now() - 1000);
  const second = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.notEqual(first.paymentReference, second.paymentReference);
  assert.equal(h.prisma.reservations.length, 1);
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  assert.equal(h.prisma.txs.find((t) => t.reference === first.paymentReference)!.status, 'EXPIRED');
});

test('a second order cannot be prepared with funds already reserved by the first', async () => {
  const h = makeHarness({ usdc: 300_000_000n });
  await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  h.prisma.orders.push({ id: 'order-2', customerId: CUSTOMER_ID, status: 'PENDING_PAYMENT', totalCents: 25_000, currency: 'USD', researchAcknowledgedAt: new Date(), createdAt: new Date(), __seq: 0 });
  await rejects(h.checkout.prepare(CUSTOMER_ID, 'order-2'), 402);
});
