import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { USDC_DEVNET_MINT } from '../../contracts';
import { ORDER_ID, makeHarness } from './harness';

const MAINNET_MINT = Keypair.generate().publicKey.toBase58(); // stand-in: the repo does not hard-code the mainnet mint
const status = (e: any) => e.getStatus?.();

test('refunds check the original purchase mint against the chain mint on EVERY network, not just devnet', async () => {
  // devnet, chain mint = the built-in one (FakeChain declares none): unchanged behaviour
  const ok = makeHarness();
  assert.equal((await ok.service.requestRefund(ORDER_ID, undefined, 'customer request', 'admin-1')).mint, USDC_DEVNET_MINT);

  // devnet purchase carrying a different mint: refused
  const rogueDevnet = makeHarness();
  rogueDevnet.prisma.tables.cryptoTransaction[0].mint = Keypair.generate().publicKey.toBase58();
  await assert.rejects(() => rogueDevnet.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1'), (e: any) => status(e) === 409 && /Unexpected mint/.test(e.message));

  // devnet chain with a configured (non-built-in) mint: the old devnet literal on a purchase row is no longer accepted
  const configured = makeHarness();
  (configured.chain as unknown as { usdcMint: string }).usdcMint = Keypair.generate().publicKey.toBase58();
  await assert.rejects(() => configured.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1'), (e: any) => status(e) === 409 && /Unexpected mint/.test(e.message));
});

test('mainnet: a purchase of the configured mint is refundable; a mainnet purchase of any other mint is refused (previously unchecked)', async () => {
  const mainnet = (purchaseMint: string) => {
    const h = makeHarness();
    h.chain.network = 'solana-mainnet';
    (h.chain as unknown as { usdcMint: string }).usdcMint = MAINNET_MINT;
    h.prisma.tables.cryptoTransaction[0].network = 'solana-mainnet';
    h.prisma.tables.cryptoTransaction[0].mint = purchaseMint;
    return h;
  };
  const good = mainnet(MAINNET_MINT);
  const requested = await good.service.requestRefund(ORDER_ID, undefined, 'customer request', 'admin-1');
  assert.equal(requested.mint, MAINNET_MINT);
  assert.equal(requested.network, 'solana-mainnet');

  for (const other of [USDC_DEVNET_MINT, Keypair.generate().publicKey.toBase58()]) {
    await assert.rejects(() => mainnet(other).service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1'), (e: any) => status(e) === 409 && /Unexpected mint/.test(e.message));
  }
});

test('a chain on another network than the purchase still reports the network mismatch first', async () => {
  const h = makeHarness();
  h.prisma.tables.cryptoTransaction[0].network = 'solana-mainnet';
  await assert.rejects(() => h.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1'), (e: any) => status(e) === 409 && /network does not match/.test(e.message));
});
