/**
 * LOCAL DEVELOPMENT ONLY: a MerchantSigner (apps/api/src/wallet/refunds/merchant-signer.port.ts) backed by a throwaway DEVNET key
 * read from a file. The API never holds key material (tests/wallet/custody-invariants.test.ts), so this lives under tools/dev and is bound
 * only by the dev launcher (tools/dev/api-devnet-sponsored.ts) and the live refund proof (tests/refunds/live-refund.run.ts), exactly like
 * the dev fee-payer and COA publisher bindings. Production binds a KMS/HSM-backed signer instead; nothing here may be reused there.
 *
 * Like a real signing service it enforces its OWN policy on what it is asked to sign, independent of the platform:
 *   exactly one instruction, an SPL Token transferChecked of the devnet USDC mint, authority = this treasury, source = the treasury's
 *   USDC account, destination = the USDC account of `context.destination`, amount = `context.amountAtomic`, fee payer = this treasury.
 * Anything else is refused and nothing is signed. The key is never printed or returned.
 */
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const apiRequire = createRequire(path.join(__dirname, '../../apps/api/package.json'));
const web3 = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');
const spl = apiRequire('@solana/spl-token') as typeof import('@solana/spl-token');

/** The devnet USDC mint the platform itself is pinned to (apps/api/src/wallet/contracts.ts USDC_DEVNET_MINT). */
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface DevMerchantSigner {
  treasuryAddress(): Promise<string>;
  signTransaction(unsignedBase64: string, context: { refundId: string; orderId: string; amountAtomic: bigint; destination: string }): Promise<string>;
}

export function readDevKeypair(file: string): import('@solana/web3.js').Keypair {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as number[];
  return web3.Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export function createDevTreasurySigner(treasury: import('@solana/web3.js').Keypair): DevMerchantSigner {
  const treasuryKey = treasury.publicKey;
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(treasury.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  const mint = new web3.PublicKey(DEVNET_USDC_MINT);

  const refuse = (why: string): never => {
    throw new Error(`dev treasury signer refused: ${why}`);
  };

  return {
    async treasuryAddress() {
      return treasuryKey.toBase58();
    },
    async signTransaction(unsignedBase64, context) {
      const tx = web3.Transaction.from(Buffer.from(unsignedBase64, 'base64'));
      if (!tx.feePayer || !tx.feePayer.equals(treasuryKey)) refuse('fee payer is not the treasury');
      if (tx.instructions.length !== 1) refuse('expected exactly one instruction');
      const instruction = tx.instructions[0];
      if (!instruction.programId.equals(spl.TOKEN_PROGRAM_ID)) refuse('not an SPL Token instruction');
      const decoded = spl.decodeTransferCheckedInstruction(instruction);
      if (!decoded.keys.mint.pubkey.equals(mint)) refuse('not the devnet USDC mint');
      if (!decoded.keys.owner.pubkey.equals(treasuryKey)) refuse('authority is not the treasury');
      if (!decoded.keys.source.pubkey.equals(spl.getAssociatedTokenAddressSync(mint, treasuryKey, true))) refuse('source is not the treasury USDC account');
      if (!decoded.keys.destination.pubkey.equals(spl.getAssociatedTokenAddressSync(mint, new web3.PublicKey(context.destination), false))) refuse('destination is not the customer USDC account');
      if (decoded.data.amount !== context.amountAtomic) refuse('amount differs from the approved refund');
      if (decoded.data.decimals !== 6) refuse('unexpected decimals');
      const signature = crypto.sign(null, tx.serializeMessage(), privateKey);
      tx.addSignature(treasuryKey, signature);
      return tx.serialize().toString('base64');
    },
  };
}
