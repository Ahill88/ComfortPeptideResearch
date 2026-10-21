/**
 * TEST-ONLY helpers for the COA anchoring suites: an in-memory Prisma double for Coa/Lot/CoaAnchor, a fake Solana chain that "lands"
 * the exact bytes the service broadcast, and an in-memory publisher signer (the platform ships none, see coa-publisher-signer.port.ts).
 */
import { createPrivateKey, sign as ed25519Detached } from 'node:crypto';
import { Keypair, PublicKey, Transaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { AnchorService } from '../../apps/api/src/coa/anchor/anchor.service';
import { COA_ANCHOR_OFF, type CoaAnchorConfig } from '../../apps/api/src/coa/anchor/coa-anchor.config';
import { CoaAnchorChainUnavailableError, CoaAnchorRejectedError, toBody, type CoaAnchorChain, type CoaAnchorTxView } from '../../apps/api/src/coa/anchor/coa-anchor-chain';
import type { CoaPublisherSigner } from '../../apps/api/src/coa/anchor/coa-publisher-signer.port';
import { MEMO_PROGRAM_ID } from '../../apps/api/src/coa/coa.types';
import { base58Encode } from '../../apps/api/src/wallet/chain/base58';

type Row = Record<string, any>;

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

/* ----------------------------------- signer ----------------------------------- */

export class InMemoryPublisherSigner implements CoaPublisherSigner {
  readonly keypair: Keypair;
  readonly publicKey: string;
  signCalls = 0;
  /** Misbehaviour switches for the signer tests. */
  mode: 'ok' | 'throw' | 'short' | 'wrong-key' = 'ok';
  constructor(keypair: Keypair = Keypair.generate()) {
    this.keypair = keypair;
    this.publicKey = keypair.publicKey.toBase58();
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    this.signCalls++;
    if (this.mode === 'throw') throw new Error('kms offline');
    if (this.mode === 'short') return new Uint8Array(10);
    const key = this.mode === 'wrong-key' ? Keypair.generate() : this.keypair;
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key.secretKey.slice(0, 32))]);
    return new Uint8Array(ed25519Detached(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })));
  }
}

/* ------------------------------------ chain ------------------------------------ */

export interface Sent {
  bytes: Uint8Array;
  signature: string;
  tx: Transaction;
}

export class FakeAnchorChain implements CoaAnchorChain {
  network: CoaAnchorChain['network'] = 'solana-devnet';
  sent: Sent[] = [];
  /** What the next broadcast does. */
  broadcastMode: 'ok' | 'reject' | 'unknown' = 'ok';
  blockhashFails = false;
  lookupFails = false;
  /** Signatures the "cluster" knows, with how they look. */
  views = new Map<string, CoaAnchorTxView>();
  private counter = 0;
  /** Awaited before each broadcast resolves (concurrency tests). */
  broadcastDelayMs = 0;

  async getLatestBlockhash() {
    if (this.blockhashFails) throw new CoaAnchorChainUnavailableError('rpc down');
    this.counter++;
    // A valid 32-byte base58 hash, different per call.
    const bytes = Buffer.alloc(32, this.counter);
    return { blockhash: new PublicKey(bytes).toBase58(), lastValidBlockHeight: 1000 + this.counter };
  }

  async broadcast(bytes: Uint8Array): Promise<string> {
    if (this.broadcastDelayMs) await new Promise((resolve) => setTimeout(resolve, this.broadcastDelayMs));
    const tx = Transaction.from(Buffer.from(bytes));
    const sig = base58Encode(tx.signature!);
    this.sent.push({ bytes, signature: sig, tx });
    if (this.broadcastMode === 'reject') throw new CoaAnchorRejectedError('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.');
    if (this.broadcastMode === 'unknown') throw new CoaAnchorChainUnavailableError('timeout of 30000ms exceeded');
    return sig;
  }

  async getTransaction(signature: string): Promise<CoaAnchorTxView | null> {
    if (this.lookupFails) throw new CoaAnchorChainUnavailableError('rpc down');
    return this.views.get(signature) ?? null;
  }

  /** Makes the signature known to the cluster as a finalized, successful transaction of exactly the bytes that were sent (or of `tx`). */
  land(signature: string, options: { tx?: Transaction; finalized?: boolean; succeeded?: boolean; slot?: number; blockTime?: number | null; innerInstructions?: number } = {}): void {
    const tx = options.tx ?? this.sent.find((s) => s.signature === signature)?.tx;
    if (!tx) throw new Error('nothing to land');
    const finalized = options.finalized ?? true;
    const succeeded = options.succeeded ?? true;
    const response = {
      slot: options.slot ?? 123_456,
      blockTime: options.blockTime === undefined ? 1_800_000_000 : options.blockTime,
      version: 'legacy',
      transaction: { message: tx.compileMessage(), signatures: [] },
      meta: {
        err: succeeded ? null : { InstructionError: [0, 'Custom'] },
        innerInstructions: options.innerInstructions ? [{ index: 0, instructions: new Array(options.innerInstructions).fill({}) }] : [],
      },
    } as unknown as VersionedTransactionResponse;
    this.views.set(signature, {
      signature,
      finalized,
      succeeded,
      errorText: succeeded ? null : '{"InstructionError":[0,"Custom"]}',
      slot: response.slot,
      blockTime: response.blockTime ?? null,
      body: finalized ? toBody(response) : null,
    });
  }
}

/* --------------------------------- in-memory prisma --------------------------------- */

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'coaId_kind') return row.coaId === cond.coaId && row.kind === cond.kind;
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === 'object') {
      if ('in' in cond) return cond.in.includes(value);
      return false;
    }
    return value === cond;
  });
}

let sequence = 0;
const uniqueError = (target: string) => Object.assign(new Error(`Unique constraint failed on the fields: (${target})`), { code: 'P2002' });

class Table {
  rows: Row[] = [];
  constructor(private readonly onCreate?: (row: Row, rows: Row[]) => void, private readonly onUpdate?: (row: Row, rows: Row[]) => void) {}
  async findUnique({ where, include }: { where: Row; include?: Row }) {
    const row = this.rows.find((r) => matches(r, where));
    return row ? this.withInclude(row, include) : null;
  }
  async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) {
    let out = this.rows.filter((r) => matches(r, where));
    if (orderBy) {
      const [[key, dir]] = Object.entries(orderBy);
      out = [...out].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    return (take ? out.slice(0, take) : out).map((r) => ({ ...r }));
  }
  async create({ data }: { data: Row }) {
    const row: Row = { id: `row${++sequence}`, error: null, attempts: 0, txSignature: null, slot: null, blockTime: null, status: 'PENDING', createdAt: new Date(), updatedAt: new Date(), ...data };
    this.onCreate?.(row, this.rows);
    this.rows.push(row);
    return { ...row };
  }
  async updateMany({ where, data }: { where: Row; data: Row }) {
    const targets = this.rows.filter((r) => matches(r, where));
    for (const row of targets) {
      const next = { ...row, ...data, updatedAt: new Date() };
      this.onUpdate?.(next, this.rows.filter((r) => r !== row));
      Object.assign(row, next);
    }
    return { count: targets.length };
  }
  private withInclude(row: Row, include?: Row) {
    return include?.lot ? { ...row, lot: this.lots?.find((l) => l.id === row.lotId) } : { ...row };
  }
  lots?: Row[];
}

export class FakePrisma {
  lot = new Table();
  coa = new Table();
  coaAnchor = new Table(
    (row, rows) => {
      if (rows.some((r) => r.coaId === row.coaId && r.kind === row.kind)) throw uniqueError('coaId,kind');
      if (row.txSignature && rows.some((r) => r.txSignature === row.txSignature)) throw uniqueError('txSignature');
    },
    (row, rows) => {
      if (row.txSignature && rows.some((r) => r.txSignature === row.txSignature)) throw uniqueError('txSignature');
    },
  );
  /** Artificial latency on reads so concurrent callers genuinely interleave. */
  constructor() {
    this.coa.lots = this.lot.rows;
  }

  addLot(code: string) {
    const lot = { id: `lot${++sequence}`, code };
    this.lot.rows.push(lot);
    return lot;
  }
  addCoa(lotId: string, over: Row = {}) {
    const coa = { id: `coa${++sequence}`, lotId, version: 1, status: 'PUBLISHED', fileSha256: SHA_A, publishedAt: new Date(), ...over };
    this.coa.rows.push(coa);
    return coa;
  }
  anchors(): Row[] {
    return this.coaAnchor.rows;
  }
}

/* ---------------------------------- harness ---------------------------------- */

export function makeConfig(over: Partial<CoaAnchorConfig> = {}): CoaAnchorConfig {
  return { ...COA_ANCHOR_OFF, enabled: true, ...over };
}

export function makeHarness(options: { signer?: InMemoryPublisherSigner | null; config?: Partial<CoaAnchorConfig> } = {}) {
  const prisma = new FakePrisma();
  const chain = new FakeAnchorChain();
  const signer = options.signer === null ? undefined : (options.signer ?? new InMemoryPublisherSigner());
  const config = makeConfig(options.config);
  const service = new AnchorService(prisma as never, config, chain, signer);
  const lot = prisma.addLot('LOT-001');
  const coa = prisma.addCoa(lot.id);
  const memo = `helix-coa:v1:publish:LOT-001:1:${SHA_A}`;
  return { prisma, chain, signer, config, service, lot, coa, memo };
}

export { MEMO_PROGRAM_ID };
export const ago = (ms: number) => new Date(Date.now() - ms);
