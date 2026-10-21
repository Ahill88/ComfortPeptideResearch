import { DynamicModule, Module } from '@nestjs/common';
import { AdminOrderRefundController } from './admin-order-refund.controller';
import { AdminOrderRefundService } from './admin-order-refund.service';
import { AdminOrdersService } from './admin-orders.service';

/**
 * Owner refund routes for orders. It needs the SAME RefundsService instance the rest of the app uses (its signer, chain and per-refund
 * locks), so the caller passes the exact RefundsModule.register(...) value it also imports itself:
 *   const refunds = RefundsModule.register({ ... });
 *   imports: [refunds, AdminOrderRefundModule.register(refunds)]
 * Nest derives a dynamic module's identity from a serialization of its metadata: do not put objects holding BigInt (a fake chain, say)
 * directly in `useValue` in a test composition, because every such module then serializes identically and Nest silently keeps only one of
 * them. Use `useFactory: () => value` there (tests/refunds/admin-order-refund.integration.test.ts does).
 * Session guard and audit service come from the global AdminCoreModule; Prisma from the global PrismaModule.
 */
@Module({ controllers: [AdminOrderRefundController], providers: [AdminOrderRefundService, AdminOrdersService] })
export class AdminOrderRefundModule {
  static register(refundsModule: DynamicModule): DynamicModule {
    return {
      module: AdminOrderRefundModule,
      imports: [refundsModule],
    };
  }
}
