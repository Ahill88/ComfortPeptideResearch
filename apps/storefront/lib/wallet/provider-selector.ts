import { SandboxBrowserSigner, SANDBOX_DISCLOSURE, type WalletProviderId, type WalletSigner } from './sandbox-signer';

/**
 * ProviderSelector: the single seam for choosing a wallet provider.
 * Only the SANDBOX browser provider exists today. Privy is not configured or integrated, and neither
 * is any other embedded-wallet vendor: adding one in future means registering another descriptor
 * here that returns a WalletSigner.
 */
export type WalletProviderDescriptor = {
  id: WalletProviderId;
  label: string;
  custody: 'browser-held';
  /** Where the key lives, in plain language. */
  keyLocation: string;
  disclosure: string;
  sandbox: boolean;
  supportsExport: boolean;
  supportsDelete: boolean;
  load(email: string): WalletSigner | null;
  create(email: string): WalletSigner;
  destroy(email: string): void;
};

const sandboxProvider: WalletProviderDescriptor = {
  id: 'sandbox',
  label: 'Sandbox browser wallet (devnet)',
  custody: 'browser-held',
  keyLocation: 'This browser (localStorage), unencrypted. The platform servers never receive it, and there is no server-side backup.',
  disclosure: SANDBOX_DISCLOSURE,
  sandbox: true,
  supportsExport: true,
  supportsDelete: true,
  load: (email) => SandboxBrowserSigner.load(email),
  create: (email) => SandboxBrowserSigner.create(email),
  destroy: (email) => SandboxBrowserSigner.destroy(email),
};

const registry: Record<WalletProviderId, WalletProviderDescriptor> = { sandbox: sandboxProvider };

export function getWalletProvider(id: WalletProviderId = 'sandbox'): WalletProviderDescriptor {
  return registry[id];
}

export function listWalletProviders(): WalletProviderDescriptor[] {
  return Object.values(registry);
}
