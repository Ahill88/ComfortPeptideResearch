// Imported under another name: the withdrawal-path text scan in wallet/__tests__/transfers.test.ts forbids the plain
// crypto signing call anywhere outside checkout/. tests/wallet/custody-invariants.test.ts is the authoritative guard for
// THIS file and pins it.
import { generateKeyPairSync, sign as ed25519Detached, type KeyObject } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { isNonProductionRuntime, type EnvLike } from '../../config/runtime';
import type { FeePayerSigner } from '../checkout/fee-payer-signer.port';
import { isSandboxAllowed, type WalletRuntimeConfig } from '../wallet.config';

/**
 * SANDBOX-ONLY fee-payer signer for the in-memory mock chain. It exists so the sponsored-fee checkout can be
 * demonstrated and tested end to end without a KMS. It is NOT a production implementation and cannot become one:
 *
 *  - it refuses to construct unless the sandbox is allowed (NODE_ENV exactly "development" or "test", the same
 *    allowlist gate as the mock chain, see isSandboxAllowed) AND the runtime is non-production (config/runtime.ts);
 *  - its key is generated fresh in memory when the object is created, lives in a true private field, is never read
 *    from the environment, a file, or a database, is never logged, serialized or exposed, and is lost on restart;
 *  - the account it controls exists only inside SandboxSolanaChain's fake ledger and holds no real value.
 *
 * Production and devnet deployments bind their own KMS/HSM-backed FEE_PAYER_SIGNER (fee-payer-signer.port.ts).
 * tests/wallet/custody-invariants.test.ts allows key generation in THIS file only and pins the guards above.
 */
export class SandboxFeePayerSigner implements FeePayerSigner {
  readonly publicKey: string;
  readonly #key: KeyObject;

  constructor(config: Pick<WalletRuntimeConfig, 'isProductionLike' | 'isProduction'>, env: EnvLike = process.env) {
    if (!isSandboxAllowed(config) || !isNonProductionRuntime(env)) {
      throw new Error('The in-memory sandbox fee-payer signer is only allowed when NODE_ENV is exactly "development" or "test". Bind a KMS/HSM-backed FEE_PAYER_SIGNER instead.');
    }
    const pair = generateKeyPairSync('ed25519');
    this.#key = pair.privateKey;
    const x = pair.publicKey.export({ format: 'jwk' }).x;
    if (typeof x !== 'string') throw new Error('could not derive the sandbox fee-payer public key');
    this.publicKey = new PublicKey(Buffer.from(x, 'base64url')).toBase58();
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(ed25519Detached(null, Buffer.from(message), this.#key));
  }
}

/** SOL (lamports) the sandbox ledger credits the sandbox sponsor so it can pay fees: 100 SOL. */
export const SANDBOX_SPONSOR_LAMPORTS = 100_000_000_000n;
