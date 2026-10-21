import { DynamicModule, Module, type ModuleMetadata, type Provider } from '@nestjs/common';
import { AdminTokenGuard } from '../../wallet-admin/admin-token.guard';
import { CHAIN_PORT } from '../checkout/ports';
import { MERCHANT_SIGNER, type MerchantSigner } from './merchant-signer.port';
import { OrderRefundedEffects } from './order-refunded.effects';
import { REFUND_ORDER_HOOK } from './refund-order-hook';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

/**
 * RefundsModule: merchant-signed USDC refunds (treasury -> the customer's own wallet).
 *
 * PROVIDERS THE IMPORTER MUST SUPPLY:
 *   CHAIN_PORT (from ../checkout/ports, same token CheckoutModule uses) -> a SolanaChain implementation.
 * OPTIONAL:
 *   MERCHANT_SIGNER (from ./merchant-signer.port) -> a KMS/HSM-backed MerchantSigner. NO implementation ships
 *   in this repository. When it is not bound, submitting a refund fails closed with HTTP 503.
 * PrismaService comes from the global PrismaModule.
 *
 * Defaults bound here: MERCHANT_SIGNER -> undefined (no key in the repo; listed first so a later provider, or the dev launcher's
 * override, replaces it) and REFUND_ORDER_HOOK -> OrderRefundedEffects (REFUNDED order event + stock release for unshipped orders).
 *
 * Nest only resolves providers visible inside this module, so supply them via
 * `RefundsModule.register({ imports: [...], providers: [{ provide: CHAIN_PORT, useExisting: SOLANA_CHAIN }] })`.
 * Admin access: x-admin-token must equal ADMIN_API_TOKEN (all environments, including production).
 */
@Module({
  controllers: [RefundsController],
  providers: [
    RefundsService,
    AdminTokenGuard,
    { provide: MERCHANT_SIGNER, useFactory: (): MerchantSigner | undefined => undefined },
    { provide: REFUND_ORDER_HOOK, useClass: OrderRefundedEffects },
  ],
  exports: [RefundsService],
})
export class RefundsModule {
  static register(options: { imports?: ModuleMetadata['imports']; providers: Provider[] }): DynamicModule {
    return { module: RefundsModule, imports: options.imports ?? [], providers: options.providers };
  }
}

export const REFUNDS_REQUIRED_TOKENS = [CHAIN_PORT] as const;
export const REFUNDS_OPTIONAL_TOKENS = [MERCHANT_SIGNER] as const;
