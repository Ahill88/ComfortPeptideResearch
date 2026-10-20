import {
  type InventoryLotStock,
  type InventoryReservationStore,
  type InventoryReservationTransaction,
} from './inventory-reservation.types';

type MutableLotStock = {
  lotId: string;
  productId: string;
  lotCode: string;
  expiresAt: Date;
  availableQuantity: number;
};

/** Test/local adapter. Production storage must atomically enforce the decrement. */
export class InMemoryInventoryReservationAdapter implements InventoryReservationStore {
  private lots: MutableLotStock[];
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(lots: readonly InventoryLotStock[]) {
    this.lots = lots.map((lot) => ({ ...lot, expiresAt: new Date(lot.expiresAt) }));
  }

  async transaction<T>(operation: (transaction: InventoryReservationTransaction) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previousTransaction = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previousTransaction;

    const stagedLots = this.lots.map((lot) => ({ ...lot, expiresAt: new Date(lot.expiresAt) }));
    const transaction: InventoryReservationTransaction = {
      listAvailableLots: async (productId) => stagedLots
        .filter((lot) => lot.productId === productId)
        .map((lot) => ({ ...lot, expiresAt: new Date(lot.expiresAt) })),
      decrementLotAvailability: async (lotId, quantity) => {
        const lot = stagedLots.find((candidate) => candidate.lotId === lotId);
        if (!lot || !Number.isSafeInteger(quantity) || quantity <= 0 || lot.availableQuantity < quantity) return false;
        lot.availableQuantity -= quantity;
        return true;
      },
    };
    try {
      const result = await operation(transaction);
      this.lots = stagedLots;
      return result;
    } finally {
      release?.();
    }
  }

  snapshot(): readonly InventoryLotStock[] {
    return this.lots.map((lot) => ({ ...lot, expiresAt: new Date(lot.expiresAt) }));
  }
}
