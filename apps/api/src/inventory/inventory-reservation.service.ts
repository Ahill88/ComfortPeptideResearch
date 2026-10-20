import { Injectable } from '@nestjs/common';
import {
  type InventoryAllocation,
  type InventoryLotStock,
  type InventoryReservation,
  type InventoryReservationRequest,
  type InventoryReservationStore,
} from './inventory-reservation.types';

export class InsufficientInventoryError extends Error {
  constructor(
    readonly productId: string,
    readonly requestedQuantity: number,
    readonly availableQuantity: number,
  ) {
    super(`Insufficient inventory for product ${productId}`);
    this.name = 'InsufficientInventoryError';
  }
}

export class InventoryReservationConflictError extends Error {
  constructor(readonly lotId: string) {
    super(`Inventory changed while reserving lot ${lotId}`);
    this.name = 'InventoryReservationConflictError';
  }
}

@Injectable()
export class InventoryReservationService {
  constructor(private readonly store: InventoryReservationStore) {}

  async reserve(request: InventoryReservationRequest): Promise<InventoryReservation> {
    if (!request.reservationId) throw new TypeError('reservationId is required');
    if (request.lines.length === 0) throw new TypeError('at least one reservation line is required');

    const demandByProduct = new Map<string, number>();
    for (const line of request.lines) {
      if (!line.productId || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
        throw new TypeError('reservation lines require a productId and positive integer quantity');
      }
      demandByProduct.set(line.productId, (demandByProduct.get(line.productId) ?? 0) + line.quantity);
    }

    return this.store.transaction(async (transaction) => {
      const allocations: InventoryAllocation[] = [];
      for (const [productId, quantity] of demandByProduct) {
        const lots = await transaction.listAvailableLots(productId);
        allocations.push(...this.allocateFefo(productId, quantity, lots));
      }

      // All stock checks complete before a mutation. The adapter must rollback this
      // transaction if a conditional decrement loses a concurrent update.
      for (const allocation of allocations) {
        const reserved = await transaction.decrementLotAvailability(allocation.lotId, allocation.quantity);
        if (!reserved) throw new InventoryReservationConflictError(allocation.lotId);
      }

      return { reservationId: request.reservationId, allocations };
    });
  }

  private allocateFefo(
    productId: string,
    requestedQuantity: number,
    lots: readonly InventoryLotStock[],
  ): InventoryAllocation[] {
    const eligibleLots = lots
      .filter((lot) => lot.productId === productId && lot.availableQuantity > 0)
      .sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime() || left.lotId.localeCompare(right.lotId));
    const availableQuantity = eligibleLots.reduce((total, lot) => total + lot.availableQuantity, 0);
    if (availableQuantity < requestedQuantity) {
      throw new InsufficientInventoryError(productId, requestedQuantity, availableQuantity);
    }

    let remaining = requestedQuantity;
    const allocations: InventoryAllocation[] = [];
    for (const lot of eligibleLots) {
      const quantity = Math.min(remaining, lot.availableQuantity);
      if (quantity > 0) allocations.push({ productId, lotId: lot.lotId, lotCode: lot.lotCode, quantity });
      remaining -= quantity;
      if (remaining === 0) break;
    }
    return allocations;
  }
}
