/** Test doubles and harness shared by the wallet tests. TEST-ONLY: uses Keypair to play the customer's wallet. */
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { PrismaService } from '../../prisma.service';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { CreditsService } from '../credits.service';
import { WalletFeatureFlags } from '../contracts';
import { MoonPayOnRampProvider } from '../onramp/moonpay-onramp.provider';
import { OnRampService } from '../onramp/onramp.service';
import { AllowAllComplianceScreen, ComplianceScreen } from '../transfers/compliance-screen';
import { InMemoryPreparedTransactionStore } from '../transfers/prepared-transaction.store';
import { TransfersService } from '../transfers/transfers.service';
import { WalletRuntimeConfig } from '../wallet.config';
import { WalletService } from '../wallet.service';

type Row = Record<string, any>;

const DEFAULTS: Record<string, () => Row> = {
  customer: () => ({ name: null, createdAt: new Date() }),
  customerWallet: () => ({ createdAt: new Date() }),
  cryptoTransaction: () => ({ status: 'PREPARED', feeLamports: null, orderId: null, txSignature: null, failureReason: null, createdAt: new Date(), finalizedAt: null }),
  creditReservation: () => ({ status: 'ACTIVE', createdAt: new Date() }),
  onRampIntent: () => ({ status: 'CREATED', externalReference: null, createdAt: new Date(), updatedAt: new Date() }),
  walletAuditEvent: () => ({ detail: null, createdAt: new Date() }),
  balanceSnapshot: () => ({ slot: null, observedAt: new Date() }),
};
const UNIQUE: Record<string, string[]> = {
  customer: ['email'],
  customerWallet: ['customerId', 'address'],
  cryptoTransaction: ['reference', 'txSignature'],
  creditReservation: ['orderId'],
};

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      if ('gt' in cond) return value > cond.gt;
      return false;
    }
    return value === cond;
  });
}

class Table {
  rows: Row[] = [];
  private seq = 0;
  constructor(private readonly name: string) {}

  async findUnique({ where }: { where: Row }) {
    return this.rows.find((row) => matches(row, where)) ?? null;
  }
  async findFirst(args: { where?: Row; orderBy?: Row } = {}) {
    return (await this.findMany(args))[0] ?? null;
  }
  async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) {
    let out = this.rows.filter((row) => matches(row, where));
    if (orderBy) {
      const [[key, dir]] = Object.entries(orderBy);
      // Ties keep insertion order ascending / newest-inserted first descending (like an auto-increment tiebreak).
      const order = new Map(out.map((row, index) => [row, index]));
      const sign = dir === 'desc' ? -1 : 1;
      out = [...out].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : order.get(a)! - order.get(b)!) * sign);
    }
    return take ? out.slice(0, take) : out;
  }
  async create({ data }: { data: Row }) {
    const row: Row = { id: data.id ?? `${this.name}_${++this.seq}`, ...DEFAULTS[this.name]?.(), ...data };
    for (const field of UNIQUE[this.name] ?? []) {
      if (row[field] != null && this.rows.some((existing) => existing[field] === row[field])) {
        throw Object.assign(new Error(`Unique constraint failed on ${field}`), { code: 'P2002' });
      }
    }
    this.rows.push(row);
    return row;
  }
  async update({ where, data }: { where: Row; data: Row }) {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new Error('not found');
    this.assertUnique(row, data);
    Object.assign(row, data);
    return row;
  }
  async updateMany({ where, data }: { where: Row; data: Row }) {
    const targets = this.rows.filter((r) => matches(r, where));
    for (const row of targets) {
      this.assertUnique(row, data);
      Object.assign(row, data);
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

export class FakePrisma {
  customer = new Table('customer');
  customerWallet = new Table('customerWallet');
  cryptoTransaction = new Table('cryptoTransaction');
  creditReservation = new Table('creditReservation');
  onRampIntent = new Table('onRampIntent');
  walletAuditEvent = new Table('walletAuditEvent');
  balanceSnapshot = new Table('balanceSnapshot');
}

export const FLAGS: WalletFeatureFlags = {
  enableRealMoonpay: false,
  enableSolanaMainnet: false,
  enableLiveCryptoPayments: false,
  enableDelegatedPayments: false,
  enableLiveFulfillment: false,
};

export function makeConfig(overrides: Partial<WalletRuntimeConfig> = {}): WalletRuntimeConfig {
  return {
    chainMode: 'sandbox',
    isProductionLike: false,
    isProduction: false,
    solanaRpcUrl: 'https://api.devnet.solana.com',
    solanaNetwork: 'solana-devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    treasuryAddress: null,
    moonpayPublishableKey: null,
    moonpaySigningSecret: null,
    privyAppId: null,
    ...overrides,
  };
}

export interface HarnessOptions {
  config?: Partial<WalletRuntimeConfig>;
  flags?: Partial<WalletFeatureFlags>;
  compliance?: ComplianceScreen;
  chain?: SandboxSolanaChain;
}

export function makeHarness(options: HarnessOptions = {}) {
  const prisma = new FakePrisma();
  const db = prisma as unknown as PrismaService;
  const chain = options.chain ?? new SandboxSolanaChain();
  const config = makeConfig(options.config);
  const flags = { ...FLAGS, ...options.flags };
  const store = new InMemoryPreparedTransactionStore();
  const wallets = new WalletService(db, chain, config);
  const credits = new CreditsService(db, chain);
  const provider = new MoonPayOnRampProvider(flags, config);
  const onRamp = new OnRampService(db, wallets, provider, chain, config);
  const transfers = new TransfersService(db, credits, wallets, chain, store, options.compliance ?? new AllowAllComplianceScreen());
  return { prisma, db, chain, config, flags, store, wallets, credits, provider, onRamp, transfers };
}

export type Harness = ReturnType<typeof makeHarness>;

// PKCS#8 DER prefix wrapping a raw 32-byte ed25519 seed (TEST-ONLY: plays the customer's wallet).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** TEST-ONLY: what a customer wallet does: detached ed25519 signature (base64) of a UTF-8 message. */
export function signLinkMessage(keypair: Keypair, message: string): string {
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

/** Runs the full client flow (challenge -> sign with the wallet key -> request body) and returns the POST /wallet body. */
export function linkRequest(h: Harness, email: string, keypair: Keypair, provider = 'sandbox') {
  const address = keypair.publicKey.toBase58();
  const { message, challenge } = h.wallets.createLinkChallenge(email, { address });
  return { address, provider, challenge, signature: signLinkMessage(keypair, message) };
}

/** Creates a customer with a linked wallet; returns the customer's (test-only) keypair. */
export async function linkCustomer(h: Harness, email = 'buyer@example.com', keypair = Keypair.generate()) {
  const result = await h.wallets.associateWallet(email, linkRequest(h, email, keypair));
  const customer = await h.wallets.resolveCustomer(email);
  return { keypair, customer, address: keypair.publicKey.toBase58(), result };
}

export async function rejection(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error: any) {
    return { status: typeof error.getStatus === 'function' ? error.getStatus() : 500, message: String(error.message) };
  }
  throw new Error('Expected promise to reject');
}
