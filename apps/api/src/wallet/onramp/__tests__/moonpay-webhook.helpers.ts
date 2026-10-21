/** TEST-ONLY doubles and builders for the MoonPay webhook tests. */
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../../prisma.service';

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('path' in cond) {
        const leaf = (cond.path as string[]).reduce((node: any, part: string) => (node == null ? undefined : node[part]), value);
        return leaf === cond.equals;
      }
      if ('in' in cond) return cond.in.includes(value);
      return false;
    }
    return value === cond;
  });
}

const UNIQUE: Record<string, string[]> = { onRampIntent: ['externalReference'] };

class Table {
  rows: Row[] = [];
  private seq = 0;
  constructor(private readonly name: string) {}
  async findUnique({ where }: { where: Row }) {
    return this.rows.find((row) => matches(row, where)) ?? null;
  }
  async findFirst({ where }: { where?: Row } = {}) {
    return this.rows.find((row) => matches(row, where)) ?? null;
  }
  async findMany({ where }: { where?: Row } = {}) {
    return this.rows.filter((row) => matches(row, where));
  }
  async create({ data }: { data: Row }) {
    const row: Row = { id: data.id ?? `${this.name}_${++this.seq}`, createdAt: new Date(), ...data };
    this.assertUnique(row, row);
    this.rows.push(row);
    return row;
  }
  async updateMany({ where, data }: { where: Row; data: Row }) {
    const targets = this.rows.filter((r) => matches(r, where));
    for (const row of targets) {
      this.assertUnique(row, data);
      Object.assign(row, data, { updatedAt: new Date() });
    }
    return { count: targets.length };
  }
  private assertUnique(self: Row, data: Row) {
    for (const field of UNIQUE[this.name] ?? []) {
      if (data[field] != null && this.rows.some((r) => r !== self && r[field] === data[field])) {
        throw Object.assign(new Error(`Unique constraint failed on ${field}`), { code: 'P2002' });
      }
    }
  }
}

/**
 * In-memory stand-in for the two tables the webhook may touch. Every other property access THROWS, so a handler that
 * reaches for cryptoTransaction / order / balance tables fails the test loudly. $transaction serialises callers (a
 * stand-in for the row lock) and rolls both tables back if the callback throws.
 */
export class WebhookDb {
  readonly onRampIntent = new Table('onRampIntent');
  readonly walletAuditEvent = new Table('walletAuditEvent');
  readonly lockQueries: unknown[][] = [];
  transactions = 0;
  private tail: Promise<unknown> = Promise.resolve();
  /** The guarded proxy handed to transaction callbacks so tx.* is policed too. */
  proxy?: WebhookDb;

  async $queryRaw(...args: unknown[]) {
    this.lockQueries.push(args);
    return [];
  }

  async $transaction<T>(fn: (tx: WebhookDb) => Promise<T>): Promise<T> {
    const run = async () => {
      this.transactions += 1;
      const snapshot = [this.onRampIntent, this.walletAuditEvent].map((t) => t.rows.map((r) => ({ ...r })));
      try {
        return await fn(this.proxy ?? this);
      } catch (error) {
        this.onRampIntent.rows = snapshot[0];
        this.walletAuditEvent.rows = snapshot[1];
        throw error;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const ALLOWED = new Set(['onRampIntent', 'walletAuditEvent', '$transaction', '$queryRaw', 'lockQueries', 'transactions', 'tail', 'proxy', 'then']);

/** Probed by the Nest container / test runner on every provider; they are not table access. */
const FRAMEWORK_PROBES = new Set(['onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'onApplicationShutdown', 'beforeApplicationShutdown', 'constructor', 'toJSON', 'asymmetricMatch', 'nodeType', 'inspect']);

export function makeWebhookDb(): { db: WebhookDb; prisma: PrismaService } {
  const db = new WebhookDb();
  const guarded = new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || ALLOWED.has(prop)) {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (FRAMEWORK_PROBES.has(prop)) return undefined;
      throw new Error(`webhook touched forbidden table/property "${String(prop)}"`);
    },
  });
  db.proxy = guarded;
  return { db, prisma: guarded as unknown as PrismaService };
}

export const CUSTOMER_ID = 'cust_1';
export const WALLET = '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
export const INTENT_ID = '11111111-2222-3333-4444-555555555555';
export const MOONPAY_TX_ID = 'defb7c52-7bd3-422b-9052-374df50cc51a';

export function seedIntent(db: WebhookDb, overrides: Row = {}) {
  const row: Row = {
    id: INTENT_ID,
    customerId: CUSTOMER_ID,
    provider: 'moonpay',
    status: 'CREATED',
    intendedUsdCents: 5000,
    destinationAddress: WALLET,
    externalReference: null,
    orderId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  db.onRampIntent.rows.push(row);
  return row;
}

export type BuyStatus = 'waitingPayment' | 'pending' | 'waitingAuthorization' | 'failed' | 'completed';

/** A BuyTransaction envelope shaped like MoonPay's documented payload. `at` is an ISO timestamp for data.updatedAt. */
export function buyEvent(
  opts: { type?: string; status?: BuyStatus | string; at?: string; data?: Row; envelope?: Row; id?: string } = {},
): Row {
  return {
    type: opts.type ?? 'transaction_updated',
    data: {
      id: opts.id ?? MOONPAY_TX_ID,
      createdAt: '2026-10-21T10:00:00.000Z',
      updatedAt: opts.at ?? '2026-10-21T10:05:00.000Z',
      status: opts.status ?? 'pending',
      failureReason: null,
      walletAddress: WALLET,
      cryptoTransactionId: null,
      baseCurrencyAmount: 50,
      quoteCurrencyAmount: 49.5,
      currency: { code: 'usdc_sol', name: 'USD Coin (Solana)' },
      externalTransactionId: INTENT_ID,
      externalCustomerId: CUSTOMER_ID,
      ...opts.data,
    },
    externalCustomerId: CUSTOMER_ID,
    ...opts.envelope,
  };
}

/**
 * Independent implementation of MoonPay's documented algorithm (signature.md): HMAC-SHA256 keyed with the webhook key
 * over `<t>.<raw body>`, hex. Deliberately does not import the production verifier.
 */
export function moonPayHeader(rawBody: string | Buffer, key: string, timestamp: number): string {
  const mac = createHmac('sha256', key).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `t=${timestamp},s=${mac}`;
}
