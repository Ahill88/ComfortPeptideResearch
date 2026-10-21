/**
 * Chain adapters and the sandbox fee-payer signer under fee sponsorship (platform pays the network fee).
 *
 * - SandboxSolanaChain.broadcast models sponsorship: the fee is debited from the FEE PAYER's sandbox SOL, the customer
 *   needs none, and the CUSTOMER (token authority) must still sign. Transfer fields stay bound to the customer wallet.
 * - DevnetSolanaChain.getTransfer reports the real token authority/owner (never the fee payer) from a fake Connection.
 * - The sandbox-only signer refuses to exist outside NODE_ENV=development|test and is only wired for the sandbox chain.
 * NOT run against a live cluster.
 */
import { strict as assert } from 'node:assert';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { test } from 'node:test';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { USDC_DECIMALS, USDC_DEVNET_MINT } from '../../contracts';
import { makeConfig } from '../../__tests__/helpers';
import { createSandboxFeePayerSigner } from '../../wallet.wiring';
import { base58Encode } from '../base58';
import { ChainRejectedError } from '../chain-errors';
import { DevnetSolanaChain, AmbiguousTransferError } from '../devnet-solana-chain';
import { SANDBOX_SPONSOR_LAMPORTS, SandboxFeePayerSigner } from '../sandbox-fee-payer-signer';
import { SandboxSolanaChain } from '../sandbox-solana-chain';

const MINT = new PublicKey(USDC_DEVNET_MINT);
/** TEST-ONLY: a customer/stranger wallet signing a message (ed25519 detached). */
function detachedSignature(keypair: Keypair, message: Uint8Array): Buffer {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.slice(0, 32))]);
  return nodeSign(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner, true);

function world(amount = 25_000_000n) {
  const chain = new SandboxSolanaChain();
  const customer = Keypair.generate();
  const sponsor = Keypair.generate();
  const merchant = Keypair.generate();
  const stranger = Keypair.generate();
  chain.creditUsdc(customer.publicKey.toBase58(), 100_000_000n);
  chain.creditUsdc(merchant.publicKey.toBase58(), 0n);
  chain.setSolBalance(customer.publicKey.toBase58(), 0n);
  chain.setSolBalance(sponsor.publicKey.toBase58(), 1_000_000_000n);
  const reference = Keypair.generate().publicKey;
  const build = async (feePayer: PublicKey, authority: PublicKey = customer.publicKey, source: PublicKey = customer.publicKey) => {
    const ix = createTransferCheckedInstruction(ata(source), MINT, ata(merchant.publicKey), authority, amount, USDC_DECIMALS);
    ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
    const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
    return new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(ix);
  };
  const bytes = (tx: Transaction) => new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  return { chain, customer, sponsor, merchant, stranger, reference, build, bytes, amount };
}

// ---------------------------------------------------------------------------------------------
// SandboxSolanaChain
// ---------------------------------------------------------------------------------------------

test('sandbox: a sponsored transfer needs no customer SOL, debits the FEE PAYER, and the id is the fee payer signature', async () => {
  const w = world();
  const tx = await w.build(w.sponsor.publicKey);
  tx.partialSign(w.sponsor, w.customer);
  const signature = await w.chain.broadcast(w.bytes(tx));
  assert.equal(signature, base58Encode(tx.signatures[0].signature!), 'first signature = fee payer');
  assert.notEqual(signature, base58Encode(tx.signatures[1].signature!));
  assert.equal(await w.chain.getSolBalanceLamports(w.customer.publicKey.toBase58()), 0n, 'the customer paid no SOL');
  assert.equal(await w.chain.getSolBalanceLamports(w.sponsor.publicKey.toBase58()), 1_000_000_000n - 10_000n, '2 signatures x 5000 from the sponsor');

  const transfer = await w.chain.getTransfer(signature);
  assert.ok(transfer);
  assert.equal(transfer.sourceOwner, w.customer.publicKey.toBase58(), 'source owner is the customer, never the fee payer');
  assert.equal(transfer.destinationOwner, w.merchant.publicKey.toBase58());
  assert.equal(transfer.amountAtomic, w.amount);
  assert.deepEqual(transfer.referenceKeys, [w.reference.toBase58()]);
  assert.equal(await w.chain.getTransfer(base58Encode(tx.signatures[1].signature!)), null, 'the customer signature is not a transaction id');
  // Finalizing moves the CUSTOMER's USDC by exactly the amount; the sponsor holds no USDC either way.
  w.chain.finalize(signature);
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.customer.publicKey.toBase58()), 100_000_000n - w.amount);
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.sponsor.publicKey.toBase58()), 0n);
});

test('sandbox: a sponsored transfer without the CUSTOMER signature (or with a forged/wrong one) never broadcasts, even with a valid fee-payer signature', async () => {
  const w = world();
  const before = await w.chain.getSolBalanceLamports(w.sponsor.publicKey.toBase58());
  const feePayerOnly = await w.build(w.sponsor.publicKey);
  feePayerOnly.partialSign(w.sponsor);
  await assert.rejects(w.chain.broadcast(w.bytes(feePayerOnly)), ChainRejectedError);

  const forged = await w.build(w.sponsor.publicKey);
  forged.partialSign(w.sponsor);
  forged.signatures[1].signature = Buffer.alloc(64, 3);
  await assert.rejects(w.chain.broadcast(w.bytes(forged)), ChainRejectedError);

  const strangerSigned = await w.build(w.sponsor.publicKey);
  strangerSigned.partialSign(w.sponsor);
  // A VALID ed25519 signature over the same message, but by a stranger's key, in the customer's slot.
  strangerSigned.signatures[1].signature = detachedSignature(w.stranger, strangerSigned.serializeMessage());
  await assert.rejects(w.chain.broadcast(w.bytes(strangerSigned)), ChainRejectedError);

  assert.equal(await w.chain.getSolBalanceLamports(w.sponsor.publicKey.toBase58()), before, 'no fee was taken');
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.customer.publicKey.toBase58()), 100_000_000n);
});

test('sandbox: the fee payer alone can never move the customer\'s USDC (authority must be the source token account owner and must sign)', async () => {
  const w = world();
  // Authority = the sponsor, but the source token account belongs to the customer.
  const stolen = await w.build(w.sponsor.publicKey, w.sponsor.publicKey, w.customer.publicKey);
  stolen.partialSign(w.sponsor);
  await assert.rejects(w.chain.broadcast(w.bytes(stolen)), /Source is not the signer ATA/);
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.customer.publicKey.toBase58()), 100_000_000n);
});

test('sandbox: a sponsor with no SOL cannot pay the fee (rejected, nothing recorded); a customer-paid transfer keeps the old rules', async () => {
  const w = world();
  w.chain.setSolBalance(w.sponsor.publicKey.toBase58(), 9_999n);
  const tx = await w.build(w.sponsor.publicKey);
  tx.partialSign(w.sponsor, w.customer);
  await assert.rejects(w.chain.broadcast(w.bytes(tx)), /Insufficient SOL for fees/);
  assert.equal(await w.chain.getSolBalanceLamports(w.sponsor.publicKey.toBase58()), 9_999n);
  assert.equal(await w.chain.getTransfer(base58Encode(tx.signatures[0].signature!)), null);

  // Customer-paid (customer is the fee payer): unchanged, and strictSolFees still applies to the customer's own SOL.
  const strict = new SandboxSolanaChain({ strictSolFees: true });
  strict.creditUsdc(w.customer.publicKey.toBase58(), 100_000_000n);
  strict.creditUsdc(w.merchant.publicKey.toBase58(), 0n);
  strict.setSolBalance(w.customer.publicKey.toBase58(), 0n);
  const own = new Transaction({ feePayer: w.customer.publicKey, ...(await strict.getLatestBlockhash()) }).add(
    createTransferCheckedInstruction(ata(w.customer.publicKey), MINT, ata(w.merchant.publicKey), w.customer.publicKey, 1_000_000n, USDC_DECIMALS),
  );
  own.partialSign(w.customer);
  await assert.rejects(strict.broadcast(new Uint8Array(own.serialize())), /Insufficient SOL for fees/);
  strict.setSolBalance(w.customer.publicKey.toBase58(), 5_000n);
  const ok = await strict.broadcast(new Uint8Array(own.serialize()));
  assert.equal(ok, base58Encode(own.signatures[0].signature!), 'customer-paid id is still the customer signature');
  assert.equal(await strict.getSolBalanceLamports(w.customer.publicKey.toBase58()), 5_000n, 'customer-paid fees are not modelled/debited (unchanged)');
});

// ---------------------------------------------------------------------------------------------
// DevnetSolanaChain.getTransfer: the authority/source owner is reported as it is, never the fee payer
// ---------------------------------------------------------------------------------------------

type Info = Record<string, unknown>;
function devnetFixture(options: { authority: 'customer' | 'sponsor'; sourceOwner: 'customer' | 'sponsor' }) {
  const sponsor = Keypair.generate().publicKey;
  const customer = Keypair.generate().publicKey;
  const merchant = Keypair.generate().publicKey;
  const sourceAta = Keypair.generate().publicKey;
  const destAta = Keypair.generate().publicKey;
  const reference = Keypair.generate().publicKey;
  const signature = base58Encode(new Uint8Array(64).fill(9));
  // The RPC parser reports [source, mint, dest, authority, ...extra] with extras under `signers`.
  const authority = options.authority === 'customer' ? customer : sponsor;
  const info: Info = { source: sourceAta.toBase58(), mint: USDC_DEVNET_MINT, destination: destAta.toBase58(), multisigAuthority: authority.toBase58(), signers: [reference.toBase58()], tokenAmount: { amount: '25000000', decimals: 6 } };
  const accountKeys = [
    { pubkey: sponsor, signer: true, writable: true }, // fee payer: account index 0
    { pubkey: customer, signer: true, writable: false },
    { pubkey: sourceAta, signer: false, writable: true },
    { pubkey: destAta, signer: false, writable: true },
    { pubkey: MINT, signer: false, writable: false },
    { pubkey: reference, signer: false, writable: false },
  ];
  const indexOf = (k: PublicKey) => accountKeys.findIndex((a) => a.pubkey.equals(k));
  const owner = options.sourceOwner === 'customer' ? customer : sponsor;
  const balances = [
    { accountIndex: indexOf(sourceAta), mint: USDC_DEVNET_MINT, owner: owner.toBase58(), uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' } },
    { accountIndex: indexOf(destAta), mint: USDC_DEVNET_MINT, owner: merchant.toBase58(), uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' } },
  ];
  const parsed = {
    slot: 1,
    blockTime: 1,
    version: 'legacy',
    transaction: {
      signatures: [signature],
      message: { accountKeys, instructions: [{ program: 'spl-token', programId: TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info } }], recentBlockhash: 'x' },
    },
    meta: { err: null, fee: 10_000, preBalances: [], postBalances: [], innerInstructions: [], preTokenBalances: balances, postTokenBalances: balances },
  };
  const connection: any = {
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'finalized', err: null }] }),
    getParsedTransaction: async () => parsed,
  };
  return { chain: new DevnetSolanaChain({ enableSolanaMainnet: false } as never, { connection }), sponsor, customer, merchant, signature, reference };
}

test('devnet: a sponsored transfer (fee payer at index 0, customer authority) reports the CUSTOMER as source owner and the reference; the fee payer is neither', async () => {
  const f = devnetFixture({ authority: 'customer', sourceOwner: 'customer' });
  const transfer = await f.chain.getTransfer(f.signature);
  assert.ok(transfer);
  assert.equal(transfer.signature, f.signature);
  assert.equal(transfer.sourceOwner, f.customer.toBase58());
  assert.notEqual(transfer.sourceOwner, f.sponsor.toBase58());
  assert.equal(transfer.destinationOwner, f.merchant.toBase58());
  assert.equal(transfer.amountAtomic, 25_000_000n);
  assert.deepEqual(transfer.referenceKeys, [f.reference.toBase58()]);
});

test('devnet: a transfer authorized by the fee payer is reported with the fee payer as source owner (so verification, bound to the customer, refuses it)', async () => {
  const f = devnetFixture({ authority: 'sponsor', sourceOwner: 'sponsor' });
  const transfer = await f.chain.getTransfer(f.signature);
  assert.ok(transfer);
  assert.equal(transfer.sourceOwner, f.sponsor.toBase58());
  assert.notEqual(transfer.sourceOwner, f.customer.toBase58());
});

test("devnet: the fee payer acting as a delegate over the customer's token account is ambiguous (manual review), never a clean customer transfer", async () => {
  const f = devnetFixture({ authority: 'sponsor', sourceOwner: 'customer' });
  await assert.rejects(f.chain.getTransfer(f.signature), (error: unknown) => {
    assert.ok(error instanceof AmbiguousTransferError);
    assert.match(error.detail, /delegate/);
    return true;
  });
});

// ---------------------------------------------------------------------------------------------
// Sandbox-only signer and its wiring
// ---------------------------------------------------------------------------------------------

test('sandbox signer: refuses to construct unless NODE_ENV is exactly development|test AND the wallet config allows the sandbox', () => {
  const ok = makeConfig();
  assert.doesNotThrow(() => new SandboxFeePayerSigner(ok, { NODE_ENV: 'test' }));
  assert.doesNotThrow(() => new SandboxFeePayerSigner(ok, { NODE_ENV: 'development' }));
  for (const nodeEnv of ['production', 'staging', 'prod', 'Production', 'production ', '', undefined]) {
    assert.throws(() => new SandboxFeePayerSigner(ok, { NODE_ENV: nodeEnv }), /only allowed when NODE_ENV is exactly/, String(nodeEnv));
  }
  assert.throws(() => new SandboxFeePayerSigner(makeConfig({ isProductionLike: true, isProduction: true }), { NODE_ENV: 'test' }), /only allowed/);
  assert.throws(() => new SandboxFeePayerSigner({ isProductionLike: undefined, isProduction: false } as never, { NODE_ENV: 'test' }), /only allowed/, 'a fixture omitting the flag is denied (allowlist)');
});

test('sandbox signer: signs messages verifiably, keeps its key private, and every instance has its own fresh key', async () => {
  const config = makeConfig();
  const a = new SandboxFeePayerSigner(config, { NODE_ENV: 'test' });
  const b = new SandboxFeePayerSigner(config, { NODE_ENV: 'test' });
  assert.notEqual(a.publicKey, b.publicKey);
  assert.equal(new PublicKey(a.publicKey).toBytes().length, 32);
  const tx = new Transaction({ feePayer: new PublicKey(a.publicKey), blockhash: base58Encode(new Uint8Array(32).fill(1)), lastValidBlockHeight: 1 }).add(
    createTransferCheckedInstruction(Keypair.generate().publicKey, MINT, Keypair.generate().publicKey, Keypair.generate().publicKey, 1n, USDC_DECIMALS),
  );
  const message = tx.serializeMessage();
  const signature = await a.signMessage(message);
  assert.equal(signature.byteLength, 64);
  tx.addSignature(new PublicKey(a.publicKey), Buffer.from(signature));
  assert.ok(tx.signatures[0].signature);
  // Verify detached against the public key (ed25519).
  const { createPublicKey, verify } = await import('node:crypto');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(a.publicKey).toBytes()]);
  assert.equal(verify(null, Buffer.from(message), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(signature)), true);
  assert.equal(verify(null, Buffer.from(message), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(await b.signMessage(message))), false);
  // Nothing about the key is reachable from outside.
  assert.deepEqual(Object.keys(a), ['publicKey']);
  assert.ok(!JSON.stringify(a).includes('key') || JSON.stringify(a) === JSON.stringify({ publicKey: a.publicKey }));
});

test('wiring: only the sandbox chain gets a signer, and it is funded with sandbox SOL; real/other chains and production-like configs get none', () => {
  const sandboxChain = new SandboxSolanaChain();
  const signer = createSandboxFeePayerSigner(sandboxChain, makeConfig());
  assert.ok(signer);
  return sandboxChain.getSolBalanceLamports(signer.publicKey).then((balance) => {
    assert.equal(balance, SANDBOX_SPONSOR_LAMPORTS);
    const devnet = new DevnetSolanaChain({ enableSolanaMainnet: false } as never, { connection: {} as never });
    assert.equal(createSandboxFeePayerSigner(devnet, makeConfig({ chainMode: 'devnet' })), undefined);
    assert.equal(createSandboxFeePayerSigner(devnet, makeConfig()), undefined, 'a real chain never gets the sandbox signer, whatever the config says');
    assert.equal(createSandboxFeePayerSigner(new SandboxSolanaChain(), makeConfig({ chainMode: 'devnet' })), undefined);
    assert.equal(createSandboxFeePayerSigner(new SandboxSolanaChain(), makeConfig({ isProductionLike: true, isProduction: true })), undefined);
  });
});
