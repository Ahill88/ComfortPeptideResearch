import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { DevnetSolanaChain } from '../chain/devnet-solana-chain';
import { createSolanaChain } from '../chain/chain.factory';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { USDC_DECIMALS } from '../contracts';
import { FLAGS, makeConfig } from './helpers';

const sandbox = (config: Parameters<typeof makeConfig>[0] = {}) => createSolanaChain(FLAGS, makeConfig(config)) as SandboxSolanaChain;

async function signedTransfer(chain: SandboxSolanaChain, payer: Keypair, destinationOwner: string, amount: bigint) {
  const mint = new PublicKey(chain.usdcMint);
  const owner = new PublicKey(destinationOwner);
  const source = getAssociatedTokenAddressSync(mint, payer.publicKey, false);
  const destination = getAssociatedTokenAddressSync(mint, owner, true);
  const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
  tx.add(createTransferCheckedInstruction(source, mint, destination, payer.publicKey, amount, USDC_DECIMALS));
  tx.sign(payer);
  return tx.serialize();
}

test('factory-built sandbox auto-finalizes broadcasts and registers the configured treasury', async () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  const chain = sandbox({ treasuryAddress: treasury });
  assert.ok(chain instanceof SandboxSolanaChain);
  assert.equal(await chain.usdcAccountExists(treasury), true, 'treasury token account is registered');
  assert.equal(await chain.getFinalizedUsdcBalance(treasury), 0n, 'registration mints nothing');

  const payer = Keypair.generate();
  chain.creditUsdc(payer.publicKey.toBase58(), 10_000_000n);
  const signature = await chain.broadcast(await signedTransfer(chain, payer, treasury, 4_000_000n));
  const transfer = await chain.getTransfer(signature);
  assert.equal(transfer?.finalized, true, 'no manual finalize() needed');
  assert.equal(transfer?.succeeded, true);
  assert.equal(transfer?.destinationOwner, treasury);
  assert.equal(await chain.getFinalizedUsdcBalance(treasury), 4_000_000n);
  assert.equal(await chain.getFinalizedUsdcBalance(payer.publicKey.toBase58()), 6_000_000n);
});

test('without SOLANA_USDC_TREASURY the factory skips registration silently (and an unregistered merchant is still rejected)', async () => {
  const chain = sandbox({ treasuryAddress: null });
  const payer = Keypair.generate();
  chain.creditUsdc(payer.publicKey.toBase58(), 1_000_000n);
  const stranger = Keypair.generate().publicKey.toBase58();
  await assert.rejects(chain.broadcast(await signedTransfer(chain, payer, stranger, 1n)), /Destination token account does not exist/);
});

test('an invalid treasury value does not crash chain construction', () => {
  assert.ok(sandbox({ treasuryAddress: 'not-a-public-key' }) instanceof SandboxSolanaChain);
});

test('sandbox stays impossible in production, treasury or not', () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  assert.throws(() => createSolanaChain(FLAGS, makeConfig({ isProductionLike: true, isProduction: true, treasuryAddress: treasury })), /production/);
  assert.throws(() => createSolanaChain(FLAGS, makeConfig({ isProductionLike: true, isProduction: true })), /production/);
});

test('devnet mode is unchanged: a DevnetSolanaChain, never the sandbox', () => {
  const chain = createSolanaChain(FLAGS, makeConfig({ chainMode: 'devnet', treasuryAddress: Keypair.generate().publicKey.toBase58() }));
  assert.ok(chain instanceof DevnetSolanaChain);
  assert.ok(!(chain instanceof SandboxSolanaChain));
});

test('a directly constructed SandboxSolanaChain still needs manual finalize (default unchanged)', async () => {
  const chain = new SandboxSolanaChain();
  const treasury = Keypair.generate().publicKey.toBase58();
  chain.creditUsdc(treasury, 0n);
  const payer = Keypair.generate();
  chain.creditUsdc(payer.publicKey.toBase58(), 5_000_000n);
  const signature = await chain.broadcast(await signedTransfer(chain, payer, treasury, 1_000_000n));
  assert.equal((await chain.getTransfer(signature))?.finalized, false);
  assert.equal(chain.finalize(signature), true);
  assert.equal((await chain.getTransfer(signature))?.finalized, true);
});
