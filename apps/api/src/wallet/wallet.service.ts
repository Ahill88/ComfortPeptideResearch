import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import { PrismaService } from '../prisma.service';
import { SolanaChain } from './contracts';
import { findSecretFields } from './secret-fields';
import { IssuedLinkChallenge, issueLinkChallenge, resolveLinkChallengeKey, verifyLinkProof } from './link-proof';
import { COMPLIANCE_SCREEN, SOLANA_CHAIN, WALLET_RUNTIME_CONFIG } from './wallet.tokens';
import { type ComplianceScreen, refuseIfSanctioned } from './transfers/compliance-screen';
import { WalletRuntimeConfig } from './wallet.config';
import { SANDBOX_PROVIDER_REFUSED_MESSAGE, WALLET_PROVIDER_NAMES, WalletProviderDescriptor, WalletProviderName, describeWalletProvider, isSandboxProviderAllowed } from './wallet-providers';

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Parses a customer-owned wallet address: must be a valid 32-byte ed25519 public key (on-curve). */
export function parseWalletAddress(value: unknown): PublicKey {
  if (typeof value !== 'string' || !BASE58_ADDRESS.test(value)) throw new BadRequestException('Invalid Solana address');
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new BadRequestException('Invalid Solana address');
  }
  if (key.toBytes().length !== 32 || !PublicKey.isOnCurve(key.toBytes())) {
    throw new BadRequestException('Address is not a valid ed25519 public key');
  }
  return key;
}

export function parseDestinationAddress(value: unknown): PublicKey {
  if (typeof value !== 'string' || !BASE58_ADDRESS.test(value)) throw new BadRequestException('Invalid destination address');
  try {
    const key = new PublicKey(value);
    if (key.toBytes().length !== 32) throw new Error('length');
    return key;
  } catch {
    throw new BadRequestException('Invalid destination address');
  }
}

/** Single generic message for EVERY link refusal that is not about the caller's own account (invalid proof, address linked elsewhere...). */
export const UNABLE_TO_LINK_MESSAGE = 'Unable to link this wallet';

export interface WalletView {
  address: string;
  provider: string;
  network: string;
  createdAt: Date;
}

@Injectable()
export class WalletService {
  /** Authenticates link challenges. Throws at construction outside development/test when WALLET_LINK_CHALLENGE_KEY is missing or short. */
  private readonly linkChallengeKey: Buffer = resolveLinkChallengeKey();
  /** Time source in epoch milliseconds (overridable in tests). */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SOLANA_CHAIN) private readonly chain: SolanaChain,
    @Inject(WALLET_RUNTIME_CONFIG) private readonly config: WalletRuntimeConfig,
    /** Sanctions screen (DI always supplies it; unit tests that build the service by hand may omit it). */
    @Optional() @Inject(COMPLIANCE_SCREEN) private readonly screen?: ComplianceScreen,
  ) {}

  /** Finds the customer for a sandbox identity (creating it on first use). */
  async resolveCustomer(email: string) {
    const normalized = email.trim().toLowerCase();
    return (
      (await this.prisma.customer.findUnique({ where: { email: normalized } })) ??
      (await this.prisma.customer.create({ data: { email: normalized } }))
    );
  }

  providerDescriptor(name: WalletProviderName): WalletProviderDescriptor {
    return describeWalletProvider(name, this.config);
  }

  /**
   * Step 1 of linking: issues a short-lived challenge bound to this account and address. Stateless and it never
   * looks at the database, so it reveals nothing about whether the address is already linked anywhere.
   */
  createLinkChallenge(customerEmail: string, input: unknown): IssuedLinkChallenge {
    if (findSecretFields(input).length > 0) {
      throw new BadRequestException('Private keys, seed phrases and other secrets must never be sent to this service');
    }
    const address = parseWalletAddress((input as { address?: unknown } | null)?.address).toBase58();
    if (this.config.treasuryAddress && address === this.config.treasuryAddress) {
      throw new BadRequestException('The platform treasury address cannot be a customer wallet');
    }
    return issueLinkChallenge(this.linkChallengeKey, { email: customerEmail.trim().toLowerCase(), address }, this.clock());
  }

  /**
   * Step 2: links a customer-owned wallet by PUBLIC address, but only with proof of control: a valid challenge for
   * this account and address plus a detached ed25519 signature of its message made by that address. Any request
   * field resembling secret material is rejected with 400 and never stored or logged.
   */
  async associateWallet(customerEmail: string, input: unknown): Promise<{ wallet: WalletView; provider: WalletProviderDescriptor; created: boolean }> {
    const customer = await this.resolveCustomer(customerEmail);
    const secretFields = findSecretFields(input);
    if (secretFields.length > 0) {
      await this.audit(customer.id, 'WALLET_SECRET_FIELDS_REJECTED', { fields: secretFields });
      throw new BadRequestException('Private keys, seed phrases and other secrets must never be sent to this service');
    }
    const body = (input ?? {}) as { address?: unknown; provider?: unknown; challenge?: unknown; signature?: unknown };
    const key = parseWalletAddress(body.address);
    const address = key.toBase58();
    const provider = body.provider;
    if (typeof provider !== 'string' || !WALLET_PROVIDER_NAMES.includes(provider as WalletProviderName)) {
      throw new BadRequestException('provider must be "privy" or "sandbox"');
    }
    const descriptor = this.providerDescriptor(provider as WalletProviderName);
    // Mainnet if EITHER the configuration or the live chain says so.
    const solanaNetwork = this.chain.network === 'solana-mainnet' ? this.chain.network : this.config.solanaNetwork;
    if (provider === 'sandbox' && !isSandboxProviderAllowed({ isProductionLike: this.config.isProductionLike, solanaNetwork })) {
      throw new BadRequestException(SANDBOX_PROVIDER_REFUSED_MESSAGE);
    }
    if (!descriptor.active) {
      throw new BadRequestException(`Wallet provider "${provider}" is not configured in this deployment`);
    }
    if (this.config.treasuryAddress && address === this.config.treasuryAddress) {
      throw new BadRequestException('The platform treasury address cannot be a customer wallet');
    }

    const proof = verifyLinkProof(
      this.linkChallengeKey,
      { email: customer.email, address, publicKey: key.toBytes(), challenge: body.challenge, signature: body.signature },
      this.clock(),
    );
    if (!proof.ok) {
      await this.audit(customer.id, 'WALLET_LINK_REJECTED', { address, reason: proof.reason });
      throw new BadRequestException(UNABLE_TO_LINK_MESSAGE);
    }

    // Sanctions screening of the address being linked (also on a replay: a newly listed address must not keep being "re-linked").
    if (this.screen) {
      const verdict = await this.screen.screen({ customerId: customer.id, sourceAddress: address, destinationAddress: address, amountAtomic: 0n, mint: '', surface: 'wallet_link' });
      await refuseIfSanctioned(verdict, 'wallet_link', (action, detail) => this.audit(customer.id, action, detail));
    }

    const existing = await this.prisma.customerWallet.findUnique({ where: { customerId: customer.id } });
    if (existing) return this.replay(existing, address, provider, descriptor);

    try {
      const created = await this.prisma.customerWallet.create({
        data: { customerId: customer.id, address, provider, network: this.chain.network },
      });
      await this.audit(customer.id, 'WALLET_ASSOCIATED', { address, provider, network: this.chain.network });
      return { wallet: this.view(created), provider: descriptor, created: true };
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const raced = await this.prisma.customerWallet.findUnique({ where: { customerId: customer.id } });
      if (raced) return this.replay(raced, address, provider, descriptor);
      // The address belongs to another account. Same generic answer as an invalid proof: never confirm that it is linked.
      await this.audit(customer.id, 'WALLET_LINK_REJECTED', { address, reason: 'address-linked-elsewhere' });
      throw new BadRequestException(UNABLE_TO_LINK_MESSAGE);
    }
  }

  async getWallet(customerEmail: string): Promise<{ wallet: WalletView; provider: WalletProviderDescriptor }> {
    const customer = await this.resolveCustomer(customerEmail);
    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId: customer.id } });
    if (!wallet) throw new NotFoundException('No wallet is linked to this account');
    return { wallet: this.view(wallet), provider: this.providerDescriptor(wallet.provider as WalletProviderName) };
  }

  async audit(customerId: string, action: string, detail?: Record<string, unknown>) {
    await this.prisma.walletAuditEvent.create({ data: { customerId, action, detail: (detail ?? undefined) as never } });
  }

  private replay(existing: WalletView, address: string, provider: string, descriptor: WalletProviderDescriptor) {
    if (existing.address !== address) {
      throw new ConflictException('A different wallet is already linked to this account; one wallet per customer');
    }
    if (existing.provider !== provider) {
      throw new ConflictException('This wallet is already linked with a different provider');
    }
    return { wallet: this.view(existing), provider: descriptor, created: false };
  }

  private view(wallet: WalletView): WalletView {
    return { address: wallet.address, provider: wallet.provider, network: wallet.network, createdAt: wallet.createdAt };
  }
}
