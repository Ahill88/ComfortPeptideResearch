/**
 * Holds the exact compiled message bytes the platform prepared, so submit() can prove the
 * customer signed precisely that message and nothing was altered.
 *
 * PRODUCTION NOTE: InMemoryPreparedTransactionStore is process-memory only (lost on restart, not
 * shared across instances) and is used only in test/development. Production uses
 * RedisPreparedTransactionStore (../stores) and refuses to start with the in-memory one; selection is
 * in ../stores/prepared-store.factory.ts (WALLET_PREPARED_STORE). Failing closed: if a record is
 * missing, submit refuses and the customer re-prepares.
 */
export interface PreparedTransactionRecord {
  transactionId: string;
  customerId: string;
  /** Serialized legacy Message bytes (tx.compileMessage().serialize()). */
  messageBytes: Uint8Array;
  expiresAt: Date;
}

export interface PreparedTransactionStore {
  save(record: PreparedTransactionRecord): Promise<void>;
  get(transactionId: string): Promise<PreparedTransactionRecord | null>;
  delete(transactionId: string): Promise<void>;
}

export class InMemoryPreparedTransactionStore implements PreparedTransactionStore {
  private readonly records = new Map<string, PreparedTransactionRecord>();

  async save(record: PreparedTransactionRecord): Promise<void> {
    this.records.set(record.transactionId, { ...record, messageBytes: new Uint8Array(record.messageBytes) });
  }

  async get(transactionId: string): Promise<PreparedTransactionRecord | null> {
    const record = this.records.get(transactionId);
    return record ? { ...record, messageBytes: new Uint8Array(record.messageBytes) } : null;
  }

  async delete(transactionId: string): Promise<void> {
    this.records.delete(transactionId);
  }
}
