import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SNAPSHOT_MAX_AGE_MS } from '../credits.service';
import { linkCustomer, makeHarness } from './helpers';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const snapshots = (h: ReturnType<typeof makeHarness>) => h.prisma.balanceSnapshot.rows;

test('a successful chain read records a snapshot of the FINALIZED amount (not spendable)', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 10_000_000n);
  // pending outgoing + reservation make spendable differ from finalized
  await h.prisma.creditReservation.create({ data: { customerId: customer.id, orderId: 'o1', amountAtomic: 4_000_000n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 60_000) } });
  const before = Date.now();
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.spendableAtomic, 6_000_000n);
  assert.equal(snapshots(h).length, 1);
  const [snap] = snapshots(h);
  const wallet = await h.prisma.customerWallet.findUnique({ where: { customerId: customer.id } });
  assert.equal(snap.walletId, wallet!.id);
  assert.equal(snap.mint, MINT);
  assert.equal(snap.amountAtomic, 10_000_000n);
  assert.ok(snap.observedAt instanceof Date && snap.observedAt.getTime() >= before - 5);
});

test('unchanged amount within an hour writes nothing; a changed amount writes a new snapshot', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 3_000_000n);
  await h.credits.getBalance(customer.id);
  await h.credits.getBalance(customer.id);
  await h.credits.getBalance(customer.id);
  assert.equal(snapshots(h).length, 1, 'bounded growth: identical reads are not re-recorded');
  h.chain.creditUsdc(address, 1n);
  await h.credits.getBalance(customer.id);
  assert.deepEqual(snapshots(h).map((s) => s.amountAtomic), [3_000_000n, 3_000_001n]);
  await h.credits.getBalance(customer.id);
  assert.equal(snapshots(h).length, 2);
});

test('an unchanged amount is re-recorded once the latest snapshot is older than one hour (and not before)', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 3_000_000n);
  await h.credits.getBalance(customer.id);
  const first = snapshots(h)[0];

  first.observedAt = new Date(Date.now() - (SNAPSHOT_MAX_AGE_MS - 60_000));
  await h.credits.getBalance(customer.id);
  assert.equal(snapshots(h).length, 1, 'just under an hour old: no new row');

  first.observedAt = new Date(Date.now() - (SNAPSHOT_MAX_AGE_MS + 1_000));
  await h.credits.getBalance(customer.id);
  assert.equal(snapshots(h).length, 2, 'older than an hour: heartbeat row');
  assert.equal(snapshots(h)[1].amountAtomic, 3_000_000n);
});

test('the comparison uses the wallet\'s LATEST snapshot, not any older one', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 1_000_000n);
  await h.credits.getBalance(customer.id); // 1_000_000
  h.chain.creditUsdc(address, 1_000_000n);
  await h.credits.getBalance(customer.id); // 2_000_000
  h.chain.setUsdcBalance(address, 1_000_000n); // back to an older value: differs from latest, so recorded
  await h.credits.getBalance(customer.id);
  assert.deepEqual(snapshots(h).map((s) => s.amountAtomic), [1_000_000n, 2_000_000n, 1_000_000n]);
});

test('no snapshot on a stale (outage) read or for a customer without a wallet', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 3_000_000n);
  h.chain.setOutage(true);
  const stale = await h.credits.getBalance(customer.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.spendableAtomic, 0n);
  assert.equal(snapshots(h).length, 0);
  h.chain.setOutage(false);

  const none = await h.credits.getBalance('cust_without_wallet');
  assert.equal(none.hasWallet, false);
  assert.equal(snapshots(h).length, 0);
});

test('a snapshot write failure never affects or fails the balance response', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 7_000_000n);
  h.prisma.balanceSnapshot.create = async () => {
    throw new Error('db down');
  };
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.stale, false);
  assert.equal(balance.finalizedAtomic, 7_000_000n);
  assert.equal(balance.spendableAtomic, 7_000_000n);

  h.prisma.balanceSnapshot.findFirst = async () => {
    throw new Error('db down');
  };
  const again = await h.credits.getBalance(customer.id);
  assert.equal(again.spendableAtomic, 7_000_000n);

  // a prisma without the table at all (e.g. not migrated) also cannot break the balance
  (h.prisma as any).balanceSnapshot = undefined;
  assert.equal((await h.credits.getBalance(customer.id)).spendableAtomic, 7_000_000n);
});

test('snapshots are observation only: spendable ignores a planted higher snapshot (read OK and on outage)', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 5_000_000n);
  const wallet = await h.prisma.customerWallet.findUnique({ where: { customerId: customer.id } });
  await h.prisma.balanceSnapshot.create({
    data: { walletId: wallet!.id, mint: MINT, amountAtomic: 999_000_000_000n, observedAt: new Date() },
  });

  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.finalizedAtomic, 5_000_000n);
  assert.equal(balance.spendableAtomic, 5_000_000n);
  assert.equal(balance.researchCredits, 5n);
  assert.equal(snapshots(h).length, 2, 'the real (lower) observation is recorded alongside it');

  h.chain.setOutage(true);
  const stale = await h.credits.getBalance(customer.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.spendableAtomic, 0n, 'a stale read never falls back to a snapshot');
  assert.equal(stale.finalizedAtomic, 0n);
  await assert.rejects(h.credits.requireSpendableAtomic(customer.id), (e: any) => e.getStatus?.() === 503);
});
