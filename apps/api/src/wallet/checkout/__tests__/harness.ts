/**
 * Test harness: in-memory prisma double, fake SolanaChain, and a throwaway customer Keypair that
 * simulates the customer's OWN wallet signing. Secret keys exist ONLY in test code.
 */
import { Keypair, Transaction } from '@solana/web3.js';
import {
  ChainUnavailableError,
  USDC_DEVNET_MINT,
  computeSpendable,
  type ChainTransfer,
  type SolanaChain,
  type SolanaNetwork,
  type WalletFeatureFlags,
} from '../../contracts';
import { CheckoutService } from '../checkout.service';
import { base58Encode, referenceKeyFor } from '../checkout.util';
import { InMemoryPreparedMessageStore } from '../prepared-message-store';
import { ReconciliationService } from '../reconciliation.service';
import { VerificationService } from '../verification.service';
import type { BalancePort, CheckoutConfig, FulfillmentTrigger, WalletLookupPort } from '../ports';
import type { PrepareResult } from '../checkout.types';

type Row = Record<string, any>;
const UNIQUE: Record<string, string[]> = {
  customer: ['email'],
  order: [],
  cryptoTransaction: ['reference', 'txSignature'],
  creditReservation: ['orderId'],
  walletAuditEvent: [],
  customerEligibility: ['customerId'],
};
const DEFAULTS: Record<string, () => Row> = {
  customer: () => ({}),
  order: () => ({ status: 'PENDING_PAYMENT', currency: 'USD', researchAcknowledgedAt: null }),
  cryptoTransaction: () => ({ status: 'PREPARED', feeLamports: null, orderId: null, txSignature: null, failureReason: null, finalizedAt: null }),
  creditReservation: () => ({ status: 'ACTIVE' }),
  walletAuditEvent: () => ({ detail: null }),
  customerEligibility: () => ({ status: 'PENDING' }),
};

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      if ('not' in cond) return value !== cond.not;
      if ('lt' in cond) return value < cond.lt;
      if ('gt' in cond) return value > cond.gt;
      throw new Error(`unsupported operator ${JSON.stringify(Object.keys(cond))}`);
    }
    return value === cond;
  });
}

export class FakePrisma {
  readonly tables: Record<string, Row[]> = { customer: [], order: [], cryptoTransaction: [], creditReservation: [], walletAuditEvent: [], customerEligibility: [] };
  private seq = 0;
  private lock: Promise<void> | null = null;
  /** Optional hook to inject failures. */
  failOn: ((table: string, op: string) => void) | null = null;

  constructor() {
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
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        await gate();
        const r = clean(find(where)[0]);
        if (!r) throw new Error('not found');
        return r;
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
        this.failOn?.(table, 'create');
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
        this.failOn?.(table, 'updateMany');
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
    while (this.lock) await this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => (release = resolve));
    const undo: Array<() => void> = [];
    const view: Record<string, unknown> = {};
    for (const name of Object.keys(this.tables)) view[name] = this.delegate(name, undo);
    try {
      return await fn(view);
    } catch (error) {
      for (const step of undo.reverse()) step();
      throw error;
    } finally {
      this.lock = null;
      release();
    }
  }

  // convenience accessors for assertions
  get orders() { return this.tables.order; }
  get txs() { return this.tables.cryptoTransaction; }
  get reservations() { return this.tables.creditReservation; }
  get audits() { return this.tables.walletAuditEvent; }
  get eligibility() { return this.tables.customerEligibility; }
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
  /** When set, getTransfer throws it (e.g. a landed-but-ambiguous transfer). */
  transferError: Error | null = null;
  private blockhashCounter = 0;

  private check() {
    if (this.unavailable) throw new ChainUnavailableError();
  }
  async getFinalizedUsdcBalance(owner: string) { this.check(); return this.usdc.get(owner) ?? 0n; }
  async getSolBalanceLamports(owner: string) { this.check(); return this.sol.get(owner) ?? 0n; }
  async getLatestBlockhash() {
    this.check();
    // 32 bytes -> valid base58 blockhash
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
  async getTransfer(signature: string) {
    this.check();
    if (this.transferError) throw this.transferError;
    return this.transfers.get(signature) ?? null;
  }
}

export interface Harness {
  prisma: FakePrisma;
  chain: FakeChain;
  customer: Keypair;
  stranger: Keypair;
  merchant: Keypair;
  flags: WalletFeatureFlags;
  config: CheckoutConfig;
  store: InMemoryPreparedMessageStore;
  fulfillmentCalls: Array<Record<string, string>>;
  staleBalance: { value: boolean };
  checkout: CheckoutService;
  verification: VerificationService;
  recon: ReconciliationService;
  makeCheckout(): CheckoutService;
  spendable(): Promise<{ finalizedAtomic: bigint; spendableAtomic: bigint }>;
}

export const CUSTOMER_ID = 'cust_1';
export const ORDER_ID = 'order-test-0001';

export function makeHarness(
  options: {
    totalCents?: number;
    usdc?: bigint;
    acknowledged?: boolean;
    orderStatus?: string;
    pullSettlement?: boolean;
    /** CustomerEligibility seeded for the customer. Default APPROVED (the gate is enforced); null = no record at all. */
    eligibility?: 'APPROVED' | 'PENDING' | 'REJECTED' | null;
  } = {},
): Harness {
  const prisma = new FakePrisma();
  const chain = new FakeChain();
  const customer = Keypair.generate();
  const stranger = Keypair.generate();
  const merchant = Keypair.generate();
  prisma.tables.customer.push({ id: CUSTOMER_ID, email: 'researcher@example.com', createdAt: new Date(), __seq: 0 });
  prisma.tables.customer.push({ id: 'cust_2', email: 'other@example.com', createdAt: new Date(), __seq: 0 });
  const eligibility = options.eligibility === undefined ? 'APPROVED' : options.eligibility;
  if (eligibility) prisma.tables.customerEligibility.push({ id: 'elig_1', customerId: CUSTOMER_ID, status: eligibility, requestedAt: new Date(), __seq: 0 });
  // The other customer is always approved so ownership (404) tests keep testing ownership, not the eligibility gate.
  prisma.tables.customerEligibility.push({ id: 'elig_2', customerId: 'cust_2', status: 'APPROVED', requestedAt: new Date(), __seq: 0 });
  prisma.tables.order.push({
    id: ORDER_ID,
    customerId: CUSTOMER_ID,
    status: options.orderStatus ?? 'PENDING_PAYMENT',
    totalCents: options.totalCents ?? 25_000,
    currency: 'USD',
    researchAcknowledgedAt: options.acknowledged === false ? null : new Date(),
    createdAt: new Date(),
    __seq: 0,
  });
  chain.usdc.set(customer.publicKey.toBase58(), options.usdc ?? 1_000_000_000n);
  chain.sol.set(customer.publicKey.toBase58(), 50_000_000n);

  const flags: WalletFeatureFlags = {
    enableRealMoonpay: false,
    enableSolanaMainnet: false,
    enableLiveCryptoPayments: false,
    enableDelegatedPayments: false,
    enableLiveFulfillment: false,
  };
  const config: CheckoutConfig = {
    treasury: merchant.publicKey.toBase58(),
    mainnetUsdcMint: undefined,
    reservationTtlMs: 15 * 60_000,
    messageReuseMs: 20_000,
    nodeEnv: 'test',
  };
  const store = new InMemoryPreparedMessageStore();
  const fulfillmentCalls: Array<Record<string, string>> = [];
  const fulfillment: FulfillmentTrigger = { trigger: async (input) => void fulfillmentCalls.push(input) };
  const wallets: WalletLookupPort = {
    getWallet: async (id) => (id === CUSTOMER_ID ? { address: customer.publicKey.toBase58(), network: 'solana-devnet' } : null),
  };
  const staleBalance = { value: false };

  const balances: BalancePort = {
    // Mirrors the real formula: finalized chain balance - pending outgoing (SUBMITTED/CONFIRMED) - ACTIVE reservations.
    async getSpendable(customerId) {
      const finalized = await chain.getFinalizedUsdcBalance(customer.publicKey.toBase58());
      const pending = prisma.txs
        .filter((t) => t.customerId === customerId && ['SUBMITTED', 'CONFIRMED'].includes(t.status) && t.type === 'PURCHASE')
        .reduce((sum, t) => sum + (t.amountAtomic as bigint), 0n);
      const active = prisma.reservations
        .filter((r) => r.customerId === customerId && r.status === 'ACTIVE' && r.expiresAt > new Date())
        // a reservation whose tx is already pending is counted once via pendingOutgoing
        .filter((r) => !prisma.txs.some((t) => t.orderId === r.orderId && ['SUBMITTED', 'CONFIRMED'].includes(t.status)))
        .reduce((sum, r) => sum + (r.amountAtomic as bigint), 0n);
      return { ...computeSpendable({ finalizedAtomic: finalized, pendingOutgoingAtomic: pending, activeReservationsAtomic: active }), stale: staleBalance.value };
    },
  };

  const verification = new VerificationService(prisma as any, chain, flags, fulfillment);
  // Pull-driven settlement (post-submit kick + status refresh) is OFF by default so tests that drive
  // verification by hand stay deterministic; pass { pullSettlement: true } to wire it as the Nest module does.
  const make = () => new CheckoutService(prisma as any, chain, balances, wallets, flags, store, config, options.pullSettlement ? verification : undefined);
  return {
    prisma,
    chain,
    customer,
    stranger,
    merchant,
    flags,
    config,
    store,
    fulfillmentCalls,
    staleBalance,
    checkout: make(),
    verification,
    recon: new ReconciliationService(prisma as any, verification, config),
    makeCheckout: make,
    async spendable() {
      const s = await balances.getSpendable(CUSTOMER_ID);
      return { finalizedAtomic: s.finalizedAtomic, spendableAtomic: s.spendableAtomic };
    },
  };
}

/** Simulates the customer's own wallet signing the prepared transaction. */
export function signAs(unsignedBase64: string, signer: Keypair): string {
  const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  tx.partialSign(signer);
  return tx.serialize().toString('base64');
}

export function signatureOf(signedBase64: string): string {
  return base58Encode(Transaction.from(Buffer.from(signedBase64, 'base64')).signatures[0].signature!);
}

/** A transfer exactly matching `prepared`, which tests then perturb. */
export function transferFor(h: Harness, prepared: PrepareResult, signature: string, overrides: Partial<ChainTransfer> = {}): ChainTransfer {
  return {
    signature,
    network: 'solana-devnet',
    finalized: true,
    succeeded: true,
    mint: USDC_DEVNET_MINT,
    sourceOwner: h.customer.publicKey.toBase58(),
    destinationOwner: h.merchant.publicKey.toBase58(),
    amountAtomic: BigInt(prepared.amountAtomic),
    referenceKeys: [referenceKeyFor(prepared.paymentReference).toBase58()],
    ...overrides,
  };
}

/** prepare -> customer signs -> submit; returns everything tests need. */
export async function prepareSignSubmit(h: Harness) {
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const submitted = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  return { prepared, signed, submitted, signature: submitted.txSignature };
}
