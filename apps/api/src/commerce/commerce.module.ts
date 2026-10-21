import { Global, Module } from '@nestjs/common';
import { COMMERCE_CONFIG, loadCommerceConfig, type CommerceConfig } from './commerce.config';
import { InventoryService } from './inventory.service';
import { INVENTORY_PORT } from './inventory.types';
import { OrderSweepScheduler, OrderSweepService } from './order-sweep.service';
import { ShippingTaxCalculator } from './shipping-tax.calculator';

/**
 * Stock, totals and the unpaid-order sweep. Global: the INVENTORY_PORT, InventoryService and ShippingTaxCalculator are
 * available everywhere without importing this module again. The environment is parsed strictly when the module is built, so a
 * bad SHIPPING_*, TAX_RATE_BPS, ORDER_HOLD_MINUTES or ORDER_SWEEP_INTERVAL_MS value stops the application from starting.
 */
@Global()
@Module({
  providers: [
    { provide: COMMERCE_CONFIG, useFactory: (): CommerceConfig => loadCommerceConfig() },
    { provide: ShippingTaxCalculator, inject: [COMMERCE_CONFIG], useFactory: (config: CommerceConfig) => new ShippingTaxCalculator(config) },
    InventoryService,
    { provide: INVENTORY_PORT, useExisting: InventoryService },
    OrderSweepService,
    OrderSweepScheduler,
  ],
  exports: [COMMERCE_CONFIG, ShippingTaxCalculator, InventoryService, INVENTORY_PORT, OrderSweepService],
})
export class CommerceModule {}
