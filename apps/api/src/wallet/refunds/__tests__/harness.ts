/**
 * Test harness for refunds: in-memory prisma double, fake SolanaChain and a throwaway Keypair acting as
 * the MERCHANT signer. Secret keys exist ONLY in test code; production binds a KMS/HSM-backed signer.
 */
import { Keypair, Transaction } from '@solana/web3.js';
import {
  ChainUnavailableError,
  USDC_DEVNET_MINT,
  type ChainTransfer,
  type SolanaChain,
  type SolanaNetwork,
} from '../../contracts';
import { base58Encode, referenceKeyFor } from '../../checkout/checkout.util';
import type { MerchantSigner, MerchantSignerContext } from '../merchant-signer.port';
import { RefundsService } from '../refunds.service';
import type { RefundView } from '../refunds.types';

type Row = Record<string, any>;
const UNIQUE: Record<string, string[]> = {
  order: [],
  cryptoTransaction: ['reference', 'txSignature'],
  walletAuditEvent: [],
};
const DEFAULTS: Record<string, () => Row> = {
  order: () => ({ status: 'PENDING_PAYMENT', currency: 'USD' }),
  cryptoTransaction: () => ({ status: 'PREPARED', feeLamports: null, orderId: null, txSignature: null, failureReason: null, finalizedAt: null }),
  walletAuditEvent: () => ({ detail: null }),
};

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      if ('not' in cond) return value !== cond.not;
      throw new Error(`unsupported operator ${JSON.stringify(Object.keys(cond))}`);
    }
    return value === cond;
  });
}

/**
 * `serialized` (default) holds a global lock for the duration of each $transaction (like SERIALIZABLE).
 * `concurrent` lets transactions interleave with NO locking (like READ COMMITTED), so only unique
 * constraints protect against races. The refund engine must be correct in both.
 */
export class FakePrisma {
  readonly tables: Record<string, Row[]> = { order: [], cryptoTransaction: [], walletAuditEvent: [] };
  private seq = 0;
  private lock: Promise<void> | null = null;

  constructor(private readonly mode: 'serialized' | 'concurrent' = 'serialized') {
    for (const name of Object.keys(this.tables)) (this as any)[name] = this.delegate(name, null);
  }

  private async gate() {
    while (this.lock) await this.lock;
    await Promise.resolve();
  }

  private delegate(table: string, undo: Array<() => void> | null) {
    const rows = this.tables[table];
    const gate = async () => {
      if (!undo) await this.gate();
      else await Promise.resolve();
    };
    const find = (where: Row) => rows.filter((r) => matches(r, where));
    const sortRows = (list: Row[], orderBy?: Row) => {
      if (!orderBy) return list;
      const [[key, dir]] = Object.entries(orderBy);
      return [...list].sort((a, b) => {
        const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.__seq - b.__seq;
        return dir === 'desc' ? -cmp || b.__seq - a.__seq : cmp;
      });
    };
    const clean = (row: Row | undefined | null) => {
      if (!row) return null;
      const { __seq, ...rest } = row;
      return { ...rest };
    };
    return {
      findUnique: async ({ where }: { where: Row }) => {
        await gate();
        return clean(find(where)[0]);
      },
      findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
        await gate();
        return clean(sortRows(find(where ?? {}), orderBy)[0]);
      },
      findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) => {
        await gate();
        const list = sortRows(find(where ?? {}), orderBy).map(clean);
        return take ? list.slice(0, take) : list;
      },
      create: async ({ data }: { data: Row }) => {
        await gate();
        for (const key of UNIQUE[table]) {
          if (data[key] != null && rows.some((r) => r[key] === data[key])) {
            throw Object.assign(new Error(`Unique constraint failed on ${key}`), { code: 'P2002' });
          }
        }
        const row: Row = { id: `${table}_${++this.seq}`, createdAt: new Date(), ...DEFAULTS[table](), ...data, __seq: this.seq };
        rows.push(row);
        undo?.push(() => rows.splice(rows.indexOf(row), 1));
        return clean(row);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        await gate();
        const targets = find(where);
        for (const row of targets) {
          for (const [key, value] of Object.entries(data)) {
            if (key === 'txSignature' && value != null && rows.some((r) => r !== row && r.txSignature === value)) {
              throw Object.assign(new Error('Unique constraint failed on txSignature'), { code: 'P2002' });
            }
          }
          const before = { ...row };
          Object.assign(row, data);
          undo?.push(() => Object.assign(row, before));
        }
        return { count: targets.length };
      },
    };
  }

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const serialized = this.mode === 'serialized';
    let release: () => void = () => undefined;
    if (serialized) {
      while (this.lock) await this.lock;
      this.lock = new Promise<void>((resolve) => (release = resolve));
    }
    const undo: Array<() => void> = [];
    const view: Record<string, unknown> = {};
    for (const name of Object.keys(this.tables)) view[name] = this.delegate(name, undo);
    try {
      return await fn(view);
    } catch (error) {
      for (const step of undo.reverse()) step();
      throw error;
    } finally {
      if (serialized) {
        this.lock = null;
        release();
      }
    }
  }

  get orders() { return this.tables.order; }
  get txs() { return this.tables.cryptoTransaction; }
  get audits() { return this.tables.walletAuditEvent; }
  get refunds() { return this.tables.cryptoTransaction.filter((r) => r.type === 'REFUND'); }
}

export class FakeChain implements SolanaChain {
  network: SolanaNetwork = 'solana-devnet';
  unavailable = false;
  feeLamports = 5000n;
  usdc = new Map<string, bigint>();
  sol = new Map<string, bigint>();
  transfers = new Map<string, ChainTransfer>();
  broadcasts: Uint8Array[] = [];
  broadcastError: Error | null = null;
  private blockhashCounter = 0;

  private check() {
    if (this.unavailable) throw new ChainUnavailableError();
  }
  async getFinalizedUsdcBalance(owner: string) { this.check(); return this.usdc.get(owner) ?? 0n; }
  async getSolBalanceLamports(owner: string) { this.check(); return this.sol.get(owner) ?? 0n; }
  async getLatestBlockhash() {
    this.check();
    const bytes = Buffer.alloc(32, 7);
    bytes.writeUInt32BE(++this.blockhashCounter, 0);
    return { blockhash: base58Encode(bytes), lastValidBlockHeight: 1000 };
  }
  async estimateFeeLamports() { this.check(); return this.feeLamports; }
  async broadcast(serialized: Uint8Array) {
    this.check();
    if (this.broadcastError) throw this.broadcastError;
    this.broadcasts.push(serialized);
    return base58Encode(Transaction.from(Buffer.from(serialized)).signatures[0].signature!);
  }
  async getTransfer(signature: string) { this.check(); return this.transfers.get(signature) ?? null; }
}

export interface SignerCall {
  unsignedBase64: string;
  context: MerchantSignerContext;
}

/** TEST-ONLY merchant signer backed by a throwaway Keypair. */
export class TestMerchantSigner implements MerchantSigner {
  calls: SignerCall[] = [];
  /** Optional hook to tamper with / replace the signed output. */
  respond: ((unsignedBase64: string, keypair: Keypair) => string) | null = null;
  reportedTreasury: string | null = null;

  constructor(readonly keypair: Keypair) {}

  async treasuryAddress() {
    return this.reportedTreasury ?? this.keypair.publicKey.toBase58();
  }

  async signTransaction(unsignedBase64: string, context: MerchantSignerContext) {
    this.calls.push({ unsignedBase64, context });
    if (this.respond) return this.respond(unsignedBase64, this.keypair);
    const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
    tx.partialSign(this.keypair);
    return tx.serialize().toString('base64');
  }
}

export const CUSTOMER_ID = 'cust_1';
export const ORDER_ID = 'order-test-0001';
export const TOTAL_CENTS = 25_000;
export const TOTAL_ATOMIC = 250_000_000n;

export interface Harness {
  prisma: FakePrisma;
  chain: FakeChain;
  customer: Keypair;
  treasury: Keypair;
  stranger: Keypair;
  signer: TestMerchantSigner;
  service: RefundsService;
  serviceWithoutSigner: RefundsService;
  /** Puts a transfer on the fake chain that exactly matches the refund, then applies overrides. */
  land(refund: RefundView, overrides?: Partial<ChainTransfer>): ChainTransfer;
  /** request -> submit -> land -> verify for one refund. */
  fullCycle(amountAtomic?: bigint): Promise<{ refund: RefundView; verified: Awaited<ReturnType<RefundsService['verifyRefund']>> }>;
}

export function makeHarness(
  options: { orderStatus?: string; withPurchase?: boolean; mode?: 'serialized' | 'concurrent'; totalCents?: number } = {},
): Harness {
  const prisma = new FakePrisma(options.mode ?? 'serialized');
  const chain = new FakeChain();
  const customer = Keypair.generate();
  const treasury = Keypair.generate();
  const stranger = Keypair.generate();
  const totalCents = options.totalCents ?? TOTAL_CENTS;
  prisma.tables.order.push({
    id: ORDER_ID,
    customerId: CUSTOMER_ID,
    status: options.orderStatus ?? 'PAID',
    totalCents,
    currency: 'USD',
    createdAt: new Date(),
    __seq: 0,
  });
  if (options.withPurchase !== false) {
    prisma.tables.cryptoTransaction.push({
      id: 'purchase_1',
      customerId: CUSTOMER_ID,
      type: 'PURCHASE',
      status: 'FINALIZED',
      amountAtomic: BigInt(totalCents) * 10_000n,
      feeLamports: null,
      sourceAddress: customer.publicKey.toBase58(),
      destinationAddress: treasury.publicKey.toBase58(),
      mint: USDC_DEVNET_MINT,
      network: 'solana-devnet',
      reference: 'chk_original',
      orderId: ORDER_ID,
      txSignature: 'purchase_signature',
      failureReason: null,
      createdAt: new Date(),
      finalizedAt: new Date(),
      __seq: 0,
    });
  }
  chain.usdc.set(treasury.publicKey.toBase58(), 10_000_000_000n);
  chain.sol.set(treasury.publicKey.toBase58(), 100_000_000n);

  const signer = new TestMerchantSigner(treasury);
  const service = new RefundsService(prisma as any, chain, signer);
  const serviceWithoutSigner = new RefundsService(prisma as any, chain);

  const land = (refund: RefundView, overrides: Partial<ChainTransfer> = {}): ChainTransfer => {
    const transfer: ChainTransfer = {
      signature: refund.txSignature!,
      network: 'solana-devnet',
      finalized: true,
      succeeded: true,
      mint: USDC_DEVNET_MINT,
      sourceOwner: treasury.publicKey.toBase58(),
      destinationOwner: customer.publicKey.toBase58(),
      amountAtomic: BigInt(refund.amountAtomic),
      referenceKeys: [referenceKeyFor(refund.reference).toBase58()],
      ...overrides,
    };
    chain.transfers.set(refund.txSignature!, transfer);
    return transfer;
  };

  return {
    prisma,
    chain,
    customer,
    treasury,
    stranger,
    signer,
    service,
    serviceWithoutSigner,
    land,
    async fullCycle(amountAtomic) {
      const requested = await service.requestRefund(ORDER_ID, amountAtomic, 'customer request', 'admin-1');
      const submitted = await service.prepareAndSubmit(requested.refundId);
      land(submitted);
      const verified = await service.verifyRefund(requested.refundId);
      return { refund: submitted, verified };
    },
  };
}
