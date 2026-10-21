/*
 * DEAD / DEVNET-ONLY CODE, left as is on purpose. Nothing in the repository imports this package (the API's wallet stack uses
 * apps/api/src/wallet/**, whose single mint source is `chain.usdcMint` from SOLANA_USDC_MINT). Every type here is pinned to the
 * literal network 'devnet' and the devnet mint, so it cannot describe mainnet and must not be extended to: a mainnet adapter
 * belongs in the API wallet stack, behind its startup checks (docs/wallet/mainnet-readiness.md).
 */
export const SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export type SolanaInvoice = {
  reference: string;
  destination: string;
  amountAtomic: bigint;
  expiresAt: Date;
  network: 'devnet';
  mint: typeof SOLANA_DEVNET_USDC_MINT;
};

export type VerifiedSolanaUsdcTransfer = {
  signature: string;
  network: 'devnet';
  mint: typeof SOLANA_DEVNET_USDC_MINT;
  destination: string;
  amountAtomic: bigint;
  reference: string;
  finality: 'finalized';
};

/**
 * Development-only contract. A production implementation must independently
 * verify every field against a configured RPC before returning a transfer.
 */
export interface SolanaUsdcAdapter {
  readonly network: 'devnet';
  createInvoice(input: Omit<SolanaInvoice, 'network' | 'mint'>): SolanaInvoice;
  verifyTransfer(invoice: SolanaInvoice, signature: string): Promise<VerifiedSolanaUsdcTransfer>;
}

export function assertDevnet(network: string): asserts network is 'devnet' {
  if (network !== 'devnet') throw new Error('Only Solana devnet is enabled');
}

/**
 * Test double only. Transfers must be explicitly registered; a signature by
 * itself can never satisfy verification.
 */
export class MockDevnetSolanaUsdcAdapter implements SolanaUsdcAdapter {
  readonly network = 'devnet' as const;
  private readonly transfers = new Map<string, VerifiedSolanaUsdcTransfer>();

  createInvoice(input: Omit<SolanaInvoice, 'network' | 'mint'>): SolanaInvoice {
    return { ...input, network: 'devnet', mint: SOLANA_DEVNET_USDC_MINT };
  }

  registerVerifiedTransfer(transfer: VerifiedSolanaUsdcTransfer): void {
    this.transfers.set(transfer.signature, transfer);
  }

  async verifyTransfer(invoice: SolanaInvoice, signature: string): Promise<VerifiedSolanaUsdcTransfer> {
    const transfer = this.transfers.get(signature);
    if (
      !transfer ||
      transfer.network !== invoice.network ||
      transfer.mint !== invoice.mint ||
      transfer.destination !== invoice.destination ||
      transfer.amountAtomic !== invoice.amountAtomic ||
      transfer.reference !== invoice.reference ||
      transfer.finality !== 'finalized'
    ) {
      throw new Error('Mock transfer does not satisfy the invoice');
    }
    return transfer;
  }
}
