export type InventoryReservationLine = Readonly<{
  productId: string;
  quantity: number;
}>;

export type InventoryLotStock = Readonly<{
  lotId: string;
  productId: string;
  lotCode: string;
  expiresAt: Date;
  availableQuantity: number;
}>;

export type InventoryAllocation = Readonly<{
  productId: string;
  lotId: string;
  lotCode: string;
  quantity: number;
}>;

export type InventoryReservationRequest = Readonly<{
  reservationId: string;
  lines: readonly InventoryReservationLine[];
}>;

export type InventoryReservation = Readonly<{
  reservationId: string;
  allocations: readonly InventoryAllocation[];
}>;

/** Operations within this port share one database transaction. */
export interface InventoryReservationTransaction {
  listAvailableLots(productId: string): Promise<readonly InventoryLotStock[]>;
  decrementLotAvailability(lotId: string, quantity: number): Promise<boolean>;
}

export interface InventoryReservationStore {
  transaction<T>(
    operation: (transaction: InventoryReservationTransaction) => Promise<T>,
  ): Promise<T>;
}
