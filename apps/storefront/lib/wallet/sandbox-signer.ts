/**
 * ============================ SANDBOX WALLET — DEVNET ONLY ============================
 * Sandbox wallet: key is stored in this browser, devnet only, not for real funds.
 *
 * SandboxBrowserSigner generates a Solana devnet Keypair in the browser and stores the
 * secret, UNENCRYPTED, in this browser's own localStorage. Any script running on this origin
 * (for example via XSS) can read it. The secret is never sent to any server, API call, or log.
 * There is no server-side backup and no key import: clearing browser data or deleting the
 * sandbox wallet destroys access irreversibly unless the user exported the key file.
 *
 * The WalletSigner interface is the seam where a provider-managed implementation could be
 * added later. No such provider is integrated (Privy is not configured or used).
 * ======================================================================================
 */
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { base64ToBytes, bytesToBase64, type SigningOptions } from './tx';

export const SANDBOX_DISCLOSURE = 'Sandbox wallet: Solana devnet only, not for real funds. In this sandbox the key is stored in this browser. Clearing browser data without exporting the key loses access.';

export type WalletProviderId = 'sandbox';

export type RecoveryExport = { filename: string; mimeType: string; content: string };

export interface WalletSigner {
  readonly providerId: WalletProviderId;
  /** Base58 public address. Safe to share and to send to the API. */
  readonly address: string;
  /**
   * Signs locally. Input and output are base64 serialized transactions.
   * Default: the transaction must have this wallet as its only signer (and fee payer).
   * With `sponsoredFeePayer` (platform-paid network fee): the transaction must have exactly two signers, [that fee payer, this wallet];
   * only this wallet's slot is filled, the fee payer's signature slot is left empty for the server.
   */
  signTransaction(unsignedBase64: string, options?: SigningOptions): Promise<string>;
  /**
   * Proves control of this wallet for account linking: signs a UTF-8 message locally and returns the base64 of the
   * 64-byte detached ed25519 signature. Only the signature leaves the browser, never the key.
   */
  signMessage(message: string): Promise<string>;
  /** Produces a user-downloadable recovery file. Must never be sent to a server. */
  exportRecovery(): Promise<RecoveryExport>;
}

const STORAGE_PREFIX = 'helix-field-SANDBOX-devnet-wallet:v1:';

type StoredSandboxWallet = { v: 1; network: 'devnet'; sandbox: true; createdAt: string; secretKey: string };

export function sandboxStorageKey(email: string): string {
  return `${STORAGE_PREFIX}${email.trim().toLowerCase()}`;
}

export class SandboxBrowserSigner implements WalletSigner {
  readonly providerId = 'sandbox' as const;
  readonly address: string;
  readonly createdAt: string;
  readonly #keypair: Keypair;
  readonly #email: string;

  private constructor(keypair: Keypair, email: string, createdAt: string) {
    this.#keypair = keypair;
    this.#email = email;
    this.address = keypair.publicKey.toBase58();
    this.createdAt = createdAt;
  }

  /** Returns the existing sandbox wallet for this email in this browser, or null. Throws if storage is unavailable or corrupt. */
  static load(email: string): SandboxBrowserSigner | null {
    const raw = window.localStorage.getItem(sandboxStorageKey(email));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredSandboxWallet>;
    if (stored.v !== 1 || typeof stored.secretKey !== 'string') throw new Error('Stored sandbox wallet is not in a recognised format.');
    const keypair = Keypair.fromSecretKey(base64ToBytes(stored.secretKey));
    return new SandboxBrowserSigner(keypair, email, typeof stored.createdAt === 'string' ? stored.createdAt : new Date(0).toISOString());
  }

  /** Generates a new devnet keypair in this browser and persists it ONLY to localStorage. */
  static create(email: string): SandboxBrowserSigner {
    const keypair = Keypair.generate();
    const createdAt = new Date().toISOString();
    const stored: StoredSandboxWallet = { v: 1, network: 'devnet', sandbox: true, createdAt, secretKey: bytesToBase64(keypair.secretKey) };
    window.localStorage.setItem(sandboxStorageKey(email), JSON.stringify(stored));
    return new SandboxBrowserSigner(keypair, email, createdAt);
  }

  static loadOrCreate(email: string): SandboxBrowserSigner {
    return SandboxBrowserSigner.load(email) ?? SandboxBrowserSigner.create(email);
  }

  /** IRREVERSIBLE: removes the secret from this browser. */
  static destroy(email: string): void {
    window.localStorage.removeItem(sandboxStorageKey(email));
  }

  async signTransaction(unsignedBase64: string, options?: SigningOptions): Promise<string> {
    const tx = VersionedTransaction.deserialize(base64ToBytes(unsignedBase64));
    const { numRequiredSignatures, numReadonlySignedAccounts } = tx.message.header;
    const required = tx.message.staticAccountKeys.slice(0, numRequiredSignatures);
    const own = this.#keypair.publicKey;
    const sponsor = options?.sponsoredFeePayer;
    if (sponsor === undefined) {
      // Customer-paid fee: a legacy transaction whose single required signer (and fee payer) is the customer.
      if (tx.version !== 'legacy' || required.length !== 1 || !required[0].equals(own)) throw new Error('This transaction must require exactly one signature, from this wallet.');
    } else {
      // Platform-paid fee: exactly [platform fee payer, this wallet]. The fee payer must be the key the caller verified, never this wallet.
      const sponsorMatches = (() => { try { return required[0]?.toBase58() === new PublicKey(sponsor).toBase58(); } catch { return false; } })();
      if (tx.version !== 'legacy' || required.length !== 2 || numReadonlySignedAccounts > 1 || !sponsorMatches || required[0].equals(own) || !required[1].equals(own)) {
        throw new Error('This transaction must require exactly two signatures: the platform fee payer, then this wallet.');
      }
    }
    // sign() fills only this keypair's slot; a fee payer's slot stays empty (the server adds that signature at submit).
    tx.sign([this.#keypair]);
    return bytesToBase64(tx.serialize());
  }

  async signMessage(message: string): Promise<string> {
    // The first 32 bytes of a web3.js secret key are the ed25519 seed. Signing happens here, in the browser.
    const signature = ed25519.sign(new TextEncoder().encode(message), this.#keypair.secretKey.slice(0, 32));
    return bytesToBase64(signature);
  }

  async exportRecovery(): Promise<RecoveryExport> {
    const content = JSON.stringify({
      warning: 'SANDBOX DEVNET WALLET. Anyone with this file controls this wallet. Not for real funds. Keep it private.',
      network: 'devnet',
      publicKey: this.address,
      secretKey: Array.from(this.#keypair.secretKey),
      createdAt: this.createdAt,
    }, null, 2);
    return { filename: `sandbox-devnet-wallet-${this.address.slice(0, 6)}.json`, mimeType: 'application/json', content };
  }

  /** Removes this wallet's secret from browser storage. IRREVERSIBLE. */
  destroy(): void {
    SandboxBrowserSigner.destroy(this.#email);
  }
}
