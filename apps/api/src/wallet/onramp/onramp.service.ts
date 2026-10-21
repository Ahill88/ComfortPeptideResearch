import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma.service';
import { OnRampProvider, OnRampQuote, SolanaChain, centsToAtomic } from '../contracts';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { WalletRuntimeConfig, isSandboxAllowed } from '../wallet.config';
import { ONRAMP_PROVIDER, SOLANA_CHAIN, WALLET_RUNTIME_CONFIG } from '../wallet.tokens';
import { WalletService } from '../wallet.service';
import { usdcMintOf } from '../chain/chain.types';

@Injectable()
export class OnRampService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    @Inject(ONRAMP_PROVIDER) private readonly provider: OnRampProvider,
    @Inject(SOLANA_CHAIN) private readonly chain: SolanaChain,
    @Inject(WALLET_RUNTIME_CONFIG) private readonly config: WalletRuntimeConfig,
  ) {}

  /**
   * Creates an on-ramp intent. The destination is ALWAYS the customer's own linked wallet
   * (loaded from CustomerWallet); no request field can choose it, and the treasury is refused.
   * `orderId` is an informational link set only by the order top-up flow; it never credits or pays anything.
   */
  async createIntent(
    customerId: string,
    input: { intendedUsdCents: number; customerIp?: string; orderId?: string },
  ): Promise<{ intentId: string; status: string; quote: OnRampQuote }> {
    if (!Number.isSafeInteger(input.intendedUsdCents) || input.intendedUsdCents <= 0) {
      throw new BadRequestException('amountUsdCents must be a positive integer');
    }
    const wallet = await this.requireLinkedWallet(customerId);
    const intentId = randomUUID();
    const quote = await this.quoteFor(customerId, wallet, intentId, input.intendedUsdCents, input.customerIp);
    await this.prisma.onRampIntent.create({
      data: {
        id: intentId,
        customerId,
        provider: quote.provider,
        status: 'CREATED',
        intendedUsdCents: input.intendedUsdCents,
        destinationAddress: wallet.address,
        ...(input.orderId ? { orderId: input.orderId } : {}),
      },
    });
    await this.wallets.audit(customerId, 'ONRAMP_INTENT_CREATED', { intentId, provider: quote.provider, intendedUsdCents: input.intendedUsdCents });
    return { intentId, status: 'CREATED', quote };
  }

  /**
   * A fresh provider quote for an intent that already exists (same intent id, amount and linked wallet). Used for
   * idempotent re-requests. The destination is re-derived from the customer's CURRENT linked wallet and must match
   * the stored one; otherwise null (the caller must create a new intent).
   */
  async requoteIntent(
    customerId: string,
    intent: { id: string; intendedUsdCents: number; destinationAddress: string; provider: string },
    customerIp?: string,
  ): Promise<OnRampQuote | null> {
    const wallet = await this.requireLinkedWallet(customerId);
    if (wallet.address !== intent.destinationAddress) return null;
    const quote = await this.quoteFor(customerId, wallet, intent.id, intent.intendedUsdCents, customerIp);
    return quote.provider === intent.provider ? quote : null;
  }

  private async requireLinkedWallet(customerId: string) {
    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId } });
    if (!wallet) throw new ConflictException('Link a wallet before buying credits');
    if (this.config.treasuryAddress && wallet.address === this.config.treasuryAddress) {
      throw new ConflictException('Wallet address is reserved and cannot receive on-ramp funds');
    }
    return wallet;
  }

  private async quoteFor(customerId: string, wallet: { address: string }, intentId: string, intendedUsdCents: number, customerIp?: string): Promise<OnRampQuote> {
    const quote = await this.provider.createQuote({
      customerId,
      destinationAddress: wallet.address,
      intendedUsdCents,
      intentId,
      customerIp,
    } as Parameters<OnRampProvider['createQuote']>[0]);
    if (this.config.treasuryAddress && quote.destinationAddress === this.config.treasuryAddress) {
      throw new ConflictException('On-ramp destination must never be the platform treasury');
    }
    if (quote.destinationAddress !== wallet.address) {
      throw new ConflictException('On-ramp destination must be the customer wallet');
    }
    return quote;
  }

  /**
   * SANDBOX ONLY simulation of a completed purchase. Allowed only with WALLET_CHAIN_MODE=sandbox
   * and NODE_ENV exactly "development" or "test" (allowlist; any other value, including unset, refuses). It credits the in-memory sandbox chain; balances therefore
   * derive from the chain, never from this intent's status. This is the only way credits
   * appear in the sandbox.
   */
  async mockComplete(customerId: string, intentId: string) {
    if (this.config.chainMode !== 'sandbox' || !isSandboxAllowed(this.config) || !(this.chain instanceof SandboxSolanaChain)) {
      throw new ForbiddenException('Mock completion is only available in sandbox mode when NODE_ENV is development or test');
    }
    const intent = await this.prisma.onRampIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.customerId !== customerId) throw new NotFoundException('On-ramp intent not found');
    if (intent.provider !== 'moonpay-sandbox') throw new ConflictException('Only sandbox intents can be mock-completed');
    if (intent.status === 'COMPLETED') return this.mockResult(intent.id, 'COMPLETED', false);
    if (intent.status !== 'CREATED' && intent.status !== 'PENDING') throw new ConflictException(`Intent is ${intent.status}`);

    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId } });
    if (!wallet || wallet.address !== intent.destinationAddress) throw new ConflictException('Intent destination no longer matches the linked wallet');
    if (this.config.treasuryAddress && intent.destinationAddress === this.config.treasuryAddress) {
      throw new ConflictException('Treasury cannot be an on-ramp destination');
    }

    // Claim first so concurrent calls cannot double-credit.
    const claimed = await this.prisma.onRampIntent.updateMany({
      where: { id: intent.id, status: { in: ['CREATED', 'PENDING'] } },
      data: { status: 'COMPLETED' },
    });
    if (claimed.count !== 1) return this.mockResult(intent.id, 'COMPLETED', false);

    const amountAtomic = centsToAtomic(intent.intendedUsdCents); // sandbox: 1 USD = 1 USDC, no fees
    this.chain.creditUsdc(intent.destinationAddress, amountAtomic);
    await this.prisma.cryptoTransaction.create({
      data: {
        customerId,
        type: 'DEPOSIT',
        status: 'FINALIZED',
        amountAtomic,
        sourceAddress: 'moonpay-sandbox',
        destinationAddress: intent.destinationAddress,
        mint: usdcMintOf(this.chain),
        network: this.chain.network,
        reference: `onramp-${intent.id}`,
        finalizedAt: new Date(),
      },
    });
    await this.wallets.audit(customerId, 'ONRAMP_SANDBOX_COMPLETED', { intentId: intent.id, amountAtomic: amountAtomic.toString() });
    return this.mockResult(intent.id, 'COMPLETED', true, amountAtomic);
  }

  private mockResult(intentId: string, status: string, credited: boolean, amountAtomic?: bigint) {
    return { intentId, status, sandbox: true, credited, amountAtomic: amountAtomic ?? null };
  }
}
