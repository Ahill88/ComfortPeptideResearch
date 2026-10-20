/**
 * (4) End-to-end SANDBOX scenario: deposit -> balance -> checkout prepare -> sign (test-only key) -> submit -> verify -> settle,
 * plus negative cases. Runs against the repo's real SandboxSolanaChain, CheckoutService and VerificationService, dynamically
 * required when this file runs. Only Prisma is replaced, by a small in-memory double defined below.
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/sandbox-scenario.test.ts
 *
 * NOT covered (needs Postgres): real transaction isolation, row locking, concurrent prepare/submit/verify races,
 * migrations. The in-memory double only emulates the Prisma calls checkout/verification make (equality, in, not, lt/gt,
 * unique violations -> P2002, $transaction with rollback on throw).
 *
 * The test keypair is created inside this file ONLY, signs locally, and is never handed to any service.
 */
import { strict as assert } from 'node:assert';
import { createHash, createPrivateKey, randomBytes, sign as nodeSign } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { API_SRC, ROOT, WALLET_CHECKOUT_SRC, WALLET_SRC, exists, listSourceFiles, notYetImplemented, read, rel, requireDir, requireRepoModule, stripComments } from './_helpers';

const apiRequire = createRequire(path.join(ROOT, 'apps/api/package.json'));
const web3 = apiRequire('@solana/web3.js');
const spl = apiRequire('@solana/spl-token');
const { Keypair, PublicKey, Transaction } = web3;

const contracts = () => requireRepoModule<typeof import('../../apps/api/src/wallet/contracts')>(path.join(WALLET_SRC, 'contracts.ts'), 'wallet contracts');

/* ------------------------------------ discovery ------------------------------------ */

function findExportFile(dir: string, className: string): string | null {
  const re = new RegExp(`export\\s+(?:abstract\\s+)?class\\s+${className}\\b`);
  return listSourceFiles(dir).find((f) => re.test(stripComments(read(f)))) ?? null;
}

interface Classes { SandboxSolanaChain: any; CheckoutService: any; VerificationService: any; InMemoryPreparedMessageStore: any; ports: any }

function loadClasses(): Classes {
  requireDir(WALLET_SRC, 'wallet module');
  const missing: string[] = [];
  const locate = (dir: string, name: string) => { const f = findExportFile(dir, name); if (!f) missing.push(`export class ${name} (under ${rel(dir)})`); return f; };
  const chainFile = locate(WALLET_SRC, 'SandboxSolanaChain');
  const checkoutFile = locate(WALLET_CHECKOUT_SRC, 'CheckoutService');
  const verificationFile = locate(WALLET_CHECKOUT_SRC, 'VerificationService');
  const storeFile = locate(WALLET_CHECKOUT_SRC, 'InMemoryPreparedMessageStore');
  const portsFile = path.join(WALLET_CHECKOUT_SRC, 'ports.ts');
  if (!exists(portsFile)) missing.push(rel(portsFile));
  if (missing.length) notYetImplemented(`sandbox scenario prerequisites: ${missing.join('; ')}`);
  const classes: Classes = {
    SandboxSolanaChain: requireRepoModule(chainFile!, 'SandboxSolanaChain').SandboxSolanaChain,
    CheckoutService: requireRepoModule(checkoutFile!, 'CheckoutService').CheckoutService,
    VerificationService: requireRepoModule(verificationFile!, 'VerificationService').VerificationService,
    InMemoryPreparedMessageStore: requireRepoModule(storeFile!, 'InMemoryPreparedMessageStore').InMemoryPreparedMessageStore,
    ports: requireRepoModule(portsFile, 'checkout ports'),
  };
  // Wiring guards: fail with an exact to-do list instead of silently mis-wiring.
  const need: string[] = [];
  const proto = classes.SandboxSolanaChain.prototype;
  for (const m of ['creditUsdc', 'finalize', 'recordTransfer', 'broadcast', 'getTransfer', 'getFinalizedUsdcBalance', 'getLatestBlockhash', 'estimateFeeLamports', 'getSolBalanceLamports']) {
    if (typeof proto[m] !== 'function') need.push(`SandboxSolanaChain.${m}()`);
  }
  if (classes.CheckoutService.length !== 7) need.push(`CheckoutService constructor (prisma, chain, balances, wallets, flags, store, config) - found ${classes.CheckoutService.length} params`);
  if (classes.VerificationService.length !== 4) need.push(`VerificationService constructor (prisma, chain, flags, fulfillment) - found ${classes.VerificationService.length} params`);
  for (const m of ['prepare', 'submit', 'status']) if (typeof classes.CheckoutService.prototype[m] !== 'function') need.push(`CheckoutService.${m}()`);
  if (typeof classes.VerificationService.prototype.verifyAndSettle !== 'function') need.push('VerificationService.verifyAndSettle()');
  if (need.length) assert.fail(`wire up scenario: the scenario expects ${need.join(', ')}. Update tests/wallet/sandbox-scenario.test.ts wiring to the new signatures.`);
  return classes;
}

/* ------------------------------- in-memory Prisma double ------------------------------- */

type Row = Record<string, any>;
const UNIQUE: Record<string, string[]> = {
  customer: ['id', 'email'], order: ['id'], cryptoTransaction: ['id', 'reference', 'txSignature'], creditReservation: ['id', 'orderId'], walletAuditEvent: ['id'], customerEligibility: ['id', 'customerId'],
};
const norm = (v: any) => (v === undefined ? null : v instanceof Date ? v.getTime() : v);
const isOp = (v: any) => v !== null && typeof v === 'object' && !(v instanceof Date) && Object.keys(v).length > 0 && Object.keys(v).every((k) => ['in', 'not', 'lt', 'lte', 'gt', 'gte', 'equals'].includes(k));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const actual = norm(row[key]);
    if (!isOp(cond)) return actual === norm(cond);
    return Object.entries(cond as Row).every(([op, v]) => {
      switch (op) {
        case 'in': return (v as any[]).map(norm).includes(actual);
        case 'not': return actual !== norm(v);
        case 'equals': return actual === norm(v);
        case 'lt': return actual !== null && actual < norm(v);
        case 'lte': return actual !== null && actual <= norm(v);
        case 'gt': return actual !== null && actual > norm(v);
        case 'gte': return actual !== null && actual >= norm(v);
        default: throw new Error(`prisma double: unsupported operator ${op}`);
      }
    });
  });
}

function makeDb() {
  let tables: Record<string, Row[]> = { customer: [], order: [], cryptoTransaction: [], creditReservation: [], walletAuditEvent: [], customerEligibility: [] };
  let counter = 0;
  const uniqueViolation = (table: string, key: string) => Object.assign(new Error(`Unique constraint failed on ${table}.${key}`), { code: 'P2002' });
  const checkUnique = (table: string, row: Row, ignore?: Row) => {
    for (const key of UNIQUE[table]) {
      if (row[key] === null || row[key] === undefined) continue;
      if (tables[table].some((r) => r !== ignore && norm(r[key]) === norm(row[key]))) throw uniqueViolation(table, key);
    }
  };
  const model = (table: string, defaults: () => Row) => ({
    async findFirst({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) { return (await this.findMany({ where, orderBy, take: 1 }))[0] ?? null; },
    async findUnique({ where }: { where: Row }) { return tables[table].find((r) => matches(r, where)) ? { ...tables[table].find((r) => matches(r, where))! } : null; },
    async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) {
      let rows = tables[table].filter((r) => matches(r, where)).map((r) => ({ ...r }));
      if (orderBy) {
        const [[field, dir]] = Object.entries(orderBy);
        rows.sort((a, b) => (norm(a[field]) === norm(b[field]) ? 0 : (norm(a[field]) ?? -Infinity) > (norm(b[field]) ?? -Infinity) ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      }
      return take ? rows.slice(0, take) : rows;
    },
    async create({ data }: { data: Row }) {
      const row: Row = { id: `${table}_${++counter}`, createdAt: new Date(), ...defaults(), ...data };
      checkUnique(table, row);
      tables[table].push(row);
      return { ...row };
    },
    async updateMany({ where, data }: { where?: Row; data: Row }) {
      const rows = tables[table].filter((r) => matches(r, where));
      for (const r of rows) { const next = { ...r, ...data }; checkUnique(table, next, r); Object.assign(r, data); }
      return { count: rows.length };
    },
  });
  const db: Row = {
    customer: model('customer', () => ({})),
    order: model('order', () => ({})),
    cryptoTransaction: model('cryptoTransaction', () => ({ txSignature: null, feeLamports: null, failureReason: null, finalizedAt: null, orderId: null, status: 'PREPARED' })),
    creditReservation: model('creditReservation', () => ({ status: 'ACTIVE' })),
    walletAuditEvent: model('walletAuditEvent', () => ({})),
    customerEligibility: model('customerEligibility', () => ({ status: 'PENDING' })),
    async $transaction(fn: (tx: any) => Promise<any>) {
      const snapshot = structuredClone(tables);
      try { return await fn(db); } catch (error) { tables = snapshot; throw error; }
    },
    _tables: () => tables,
  };
  return db;
}

/* ---------------------------------- test-only crypto ---------------------------------- */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}

/** Ed25519 signature by an arbitrary test keypair over message bytes, via node:crypto (no extra deps). */
function signWith(kp: any, message: Uint8Array): Buffer {
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return nodeSign(null, message, key);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/* ------------------------------------- the world ------------------------------------- */

const ORDER_CENTS = 1999;
const ORDER_ATOMIC = 19_990_000n;

async function buildWorld(opts: { flags?: Record<string, boolean>; fundAtomic?: bigint; totalCents?: number } = {}) {
  const C = loadClasses();
  const { loadFeatureFlags, computeSpendable } = contracts();
  const flags = { ...loadFeatureFlags({}), ...(opts.flags ?? {}) };
  const chain = new C.SandboxSolanaChain();
  const db = makeDb();
  const owner = Keypair.generate(); // TEST ONLY: the customer's own key. Never passed to any service.
  const stranger = Keypair.generate();
  const treasury = Keypair.generate().publicKey.toBase58();
  const customerId = 'cust_1';
  const orderId = 'order_1';
  const wallets = new Map<string, { address: string; network: string }>([[customerId, { address: owner.publicKey.toBase58(), network: 'solana-devnet' }]]);
  await db.customer.create({ data: { id: customerId, email: 'qa@example.test' } });
  // Checkout is gated on an APPROVED CustomerEligibility (the gate stays enforced; the scenario customer is approved).
  await db.customerEligibility.create({ data: { customerId, status: 'APPROVED' } });
  await db.customerEligibility.create({ data: { customerId: 'cust_2', status: 'APPROVED' } }); // keeps the foreign-order => 404 check about ownership, not eligibility
  await db.order.create({ data: { id: orderId, customerId, status: 'PENDING_PAYMENT', researchAcknowledgedAt: new Date(), currency: 'USD', totalCents: opts.totalCents ?? ORDER_CENTS } });
  await db.order.create({ data: { id: 'order_other', customerId: 'cust_2', status: 'PENDING_PAYMENT', researchAcknowledgedAt: new Date(), currency: 'USD', totalCents: 100 } });
  chain.creditUsdc(treasury, 0n); // the merchant's USDC token account must already exist
  if ((opts.fundAtomic ?? 25_500_000n) > 0n) chain.creditUsdc(owner.publicKey.toBase58(), opts.fundAtomic ?? 25_500_000n);

  const balances = {
    // Independent re-statement of the credit rule: spendable = finalized chain balance - active (unexpired) reservations.
    async getSpendable(id: string) {
      const w = wallets.get(id)!;
      const finalizedAtomic = await chain.getFinalizedUsdcBalance(w.address);
      const held = (await db.creditReservation.findMany({ where: { customerId: id, status: 'ACTIVE' } }))
        .filter((r: Row) => r.expiresAt > new Date()).reduce((s: bigint, r: Row) => s + r.amountAtomic, 0n);
      return { ...computeSpendable({ finalizedAtomic, pendingOutgoingAtomic: 0n, activeReservationsAtomic: held }), stale: false };
    },
  };
  const walletLookup = { async getWallet(id: string) { return wallets.get(id) ?? null; } };
  const fulfillmentCalls: any[] = [];
  const fulfillment = { async trigger(input: any) { fulfillmentCalls.push(input); } };
  const config = { treasury, mainnetUsdcMint: undefined, reservationTtlMs: 15 * 60_000, messageReuseMs: 20_000, nodeEnv: 'test' };
  const store = new C.InMemoryPreparedMessageStore();
  const checkout = new C.CheckoutService(db, chain, balances, walletLookup, flags, store, config);
  const verification = new C.VerificationService(db, chain, flags, fulfillment);
  const mint = new PublicKey(contracts().USDC_DEVNET_MINT);
  return { C, chain, db, owner, stranger, treasury, customerId, orderId, balances, checkout, verification, fulfillmentCalls, flags, mint, wallets };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

function parseUnsigned(base64: string) { return Transaction.from(Buffer.from(base64, 'base64')); }

function signAsOwner(w: World, unsignedBase64: string): { tx: any; base64: string; signature: string } {
  const tx = parseUnsigned(unsignedBase64);
  tx.partialSign(w.owner); // customer-side signing, inside the test only
  const raw = tx.serialize();
  return { tx, base64: b64(raw), signature: b58(tx.signatures[0].signature) };
}

/** Build a transferChecked tx from the owner to the treasury with an arbitrary amount (attacker-chosen), using the chain's blockhash. */
async function craftTransfer(w: World, amountAtomic: bigint, opts: { feePayer?: any; authority?: any } = {}) {
  const authority = opts.authority ?? w.owner;
  const source = spl.getAssociatedTokenAddressSync(w.mint, authority.publicKey, false);
  const destination = spl.getAssociatedTokenAddressSync(w.mint, new PublicKey(w.treasury), true);
  const ix = spl.createTransferCheckedInstruction(source, w.mint, destination, authority.publicKey, amountAtomic, 6);
  const { blockhash, lastValidBlockHeight } = await w.chain.getLatestBlockhash();
  const tx = new Transaction({ feePayer: (opts.feePayer ?? authority).publicKey, blockhash, lastValidBlockHeight });
  tx.add(ix);
  return tx;
}

interface State { rows: { status: string; txSignature: string | null }[]; reservation: string | null; order: string; ownerUsdc: bigint; treasuryUsdc: bigint; audit: number }
async function state(w: World): Promise<State> {
  const rows = (await w.db.cryptoTransaction.findMany({ where: { orderId: w.orderId } })).map((r: Row) => ({ status: r.status, txSignature: r.txSignature }));
  const reservation = (await w.db.creditReservation.findUnique({ where: { orderId: w.orderId } }))?.status ?? null;
  return {
    rows, reservation, order: (await w.db.order.findUnique({ where: { id: w.orderId } })).status,
    ownerUsdc: await w.chain.getFinalizedUsdcBalance(w.owner.publicKey.toBase58()),
    treasuryUsdc: await w.chain.getFinalizedUsdcBalance(w.treasury),
    audit: (await w.db.walletAuditEvent.findMany()).length,
  };
}

/* ---------------------------------- double sanity ---------------------------------- */

test('scenario harness: the in-memory prisma double enforces uniqueness, filters and rolls back transactions', async () => {
  const db = makeDb();
  await db.cryptoTransaction.create({ data: { reference: 'r1', txSignature: 'sig1', status: 'SUBMITTED', orderId: 'o1' } });
  await assert.rejects(() => db.cryptoTransaction.create({ data: { reference: 'r1', status: 'PREPARED' } }), (e: any) => e.code === 'P2002');
  await assert.rejects(() => db.cryptoTransaction.create({ data: { reference: 'r2', txSignature: 'sig1' } }), (e: any) => e.code === 'P2002');
  await db.cryptoTransaction.create({ data: { reference: 'r3', status: 'PREPARED', orderId: 'o1' } });
  await db.cryptoTransaction.create({ data: { reference: 'r4', status: 'PREPARED', orderId: 'o2' } });
  assert.equal((await db.cryptoTransaction.findMany({ where: { orderId: 'o1', status: { in: ['SUBMITTED', 'CONFIRMED'] } } })).length, 1);
  assert.equal((await db.cryptoTransaction.findMany({ where: { orderId: 'o1', status: { not: 'SUBMITTED' } } })).length, 1);
  assert.equal((await db.cryptoTransaction.updateMany({ where: { orderId: 'o1', status: 'PREPARED' }, data: { status: 'EXPIRED' } })).count, 1);
  assert.equal((await db.cryptoTransaction.updateMany({ where: { orderId: 'o1', status: 'PREPARED' }, data: { status: 'EXPIRED' } })).count, 0, 'compare-and-set must not match twice');
  await assert.rejects(() => db.$transaction(async (tx: any) => { await tx.cryptoTransaction.updateMany({ where: { reference: 'r4' }, data: { status: 'FINALIZED' } }); throw new Error('boom'); }), /boom/);
  assert.equal((await db.cryptoTransaction.findUnique({ where: { reference: 'r4' } })).status, 'PREPARED', 'transaction must roll back on throw');
});

test('scenario wiring: sandbox chain, checkout and verification services are present and match the expected shape', () => {
  loadClasses();
});

/* --------------------------------- chain-level checks --------------------------------- */

test('sandbox chain: devnet only, deposit is reflected in finalized balance, unfunded owner has zero', async () => {
  const w = await buildWorld();
  assert.equal(w.chain.network, 'solana-devnet', 'sandbox chain must never claim mainnet');
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.stranger.publicKey.toBase58()), 0n);
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.owner.publicKey.toBase58()), 25_500_000n);
});

test('sandbox chain: rejects unsigned, forged-signature, tampered and overdrawn transactions; none move funds', async () => {
  const w = await buildWorld();
  const before = await state(w);

  const unsigned = await craftTransfer(w, ORDER_ATOMIC);
  await assert.rejects(() => w.chain.broadcast(unsigned.serialize({ requireAllSignatures: false, verifySignatures: false })), 'unsigned transaction must be rejected');

  const forged = await craftTransfer(w, ORDER_ATOMIC);
  forged.addSignature(w.owner.publicKey, signWith(w.stranger, forged.serializeMessage()));
  await assert.rejects(() => w.chain.broadcast(forged.serialize({ requireAllSignatures: false, verifySignatures: false })), "a stranger's signature in the owner's slot must be rejected");

  const tampered = await craftTransfer(w, ORDER_ATOMIC);
  tampered.partialSign(w.owner);
  const bytes = Buffer.from(tampered.serialize());
  const amountIx = Buffer.from(tampered.instructions[0].data);
  const at = bytes.indexOf(amountIx);
  assert.ok(at > 0, 'test bug: could not locate instruction data');
  bytes[at + 1] ^= 0xff; // flip a byte of the amount after signing
  await assert.rejects(() => w.chain.broadcast(bytes), 'a transaction altered after signing must be rejected');

  const overdrawn = await craftTransfer(w, 26_000_000n);
  overdrawn.partialSign(w.owner);
  await assert.rejects(() => w.chain.broadcast(overdrawn.serialize()), 'spending more than the finalized balance must be rejected');

  await assert.rejects(() => w.chain.broadcast(new Uint8Array([1, 2, 3])), 'garbage must be rejected');
  assert.deepEqual(await state(w), before, 'rejected broadcasts must not change any balance or record');
});

test('sandbox chain: a validly signed transfer is not applied until finalized, then moves exactly the amount', async () => {
  const w = await buildWorld();
  const tx = await craftTransfer(w, ORDER_ATOMIC);
  tx.partialSign(w.owner);
  const signature = await w.chain.broadcast(tx.serialize());
  assert.equal(signature, b58(tx.signatures[0].signature), 'broadcast must return the transaction signature');
  const pending = await w.chain.getTransfer(signature);
  assert.ok(pending, 'broadcast transfer must be readable');
  assert.equal(pending.finalized, false, 'a fresh broadcast must not be reported finalized');
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.owner.publicKey.toBase58()), 25_500_000n, 'balance must not move before finalization');
  assert.equal(w.chain.finalize(signature), true);
  const done = await w.chain.getTransfer(signature);
  assert.ok(done && done.finalized && done.succeeded);
  assert.equal(done.amountAtomic, ORDER_ATOMIC);
  assert.equal(done.sourceOwner, w.owner.publicKey.toBase58());
  assert.equal(done.destinationOwner, w.treasury);
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.owner.publicKey.toBase58()), 25_500_000n - ORDER_ATOMIC);
  assert.equal(await w.chain.getFinalizedUsdcBalance(w.treasury), ORDER_ATOMIC);
});

/* ------------------------------------ happy path ------------------------------------ */

test('scenario: deposit -> balance -> prepare -> sign -> submit -> verify -> settle', async () => {
  const w = await buildWorld();
  const ownerAddr = w.owner.publicKey.toBase58();

  // deposit -> balance (25.5 USDC deposited = 25 RC, exact atomic preserved)
  const funded = await w.balances.getSpendable(w.customerId);
  assert.equal(funded.finalizedAtomic, 25_500_000n);
  assert.equal(funded.spendableAtomic, 25_500_000n);
  assert.equal(funded.researchCredits, 25n);

  // prepare
  const prepared = await w.checkout.prepare(w.customerId, w.orderId);
  assert.equal(prepared.amountAtomic, ORDER_ATOMIC.toString(), '$19.99 must be exactly 19,990,000 USDC base units');
  assert.equal(prepared.merchant, w.treasury);
  assert.equal(prepared.network, 'solana-devnet');
  assert.equal(prepared.mint, contracts().USDC_DEVNET_MINT);
  assert.ok(prepared.paymentReference);

  // what the platform asks the customer to sign must be exactly one transfer of the order total to the treasury, unsigned
  const unsigned = parseUnsigned(prepared.unsignedTransactionBase64);
  assert.equal(unsigned.feePayer.toBase58(), ownerAddr, 'customer wallet must be the fee payer');
  assert.ok(unsigned.signatures.every((s: any) => s.signature === null), 'prepared transaction must be unsigned');
  assert.equal(unsigned.instructions.length, 1);
  const decoded = spl.decodeTransferCheckedInstruction(unsigned.instructions[0], spl.TOKEN_PROGRAM_ID);
  assert.equal(decoded.data.amount, ORDER_ATOMIC);
  assert.equal(decoded.keys.owner.pubkey.toBase58(), ownerAddr);
  assert.equal(decoded.keys.destination.pubkey.toBase58(), spl.getAssociatedTokenAddressSync(w.mint, new PublicKey(w.treasury), true).toBase58());
  assert.equal(decoded.keys.mint.pubkey.toBase58(), w.mint.toBase58());

  // reservation holds the credits but nothing moved yet
  const held = await w.balances.getSpendable(w.customerId);
  assert.equal(held.finalizedAtomic, 25_500_000n, 'on-chain balance must not move at prepare');
  assert.equal(held.spendableAtomic, 25_500_000n - ORDER_ATOMIC);
  assert.equal(held.researchCredits, 5n);

  // sign (test-only key) and submit
  const signed = signAsOwner(w, prepared.unsignedTransactionBase64);
  const submitted = await w.checkout.submit(w.customerId, w.orderId, signed.base64);
  assert.equal(submitted.status, 'SUBMITTED', 'submit must never report a payment as settled');
  assert.equal(submitted.txSignature, signed.signature);
  assert.equal((await state(w)).order, 'PENDING_PAYMENT', 'order must not be paid on submit');

  // verify before finalization: still pending, order unpaid
  const early = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(early.outcome, 'PENDING', `unfinalized transfer must stay PENDING, got ${JSON.stringify(early)}`);
  assert.equal((await state(w)).order, 'PENDING_PAYMENT', 'order must stay unpaid until finalized');
  assert.equal(w.fulfillmentCalls.length, 0);

  // finalize on the sandbox chain, then verify -> settle
  assert.equal(w.chain.finalize(signed.signature), true);
  const settled = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(settled.outcome, 'FINALIZED', `a correct, finalized transfer must settle; got ${JSON.stringify(settled)}`);
  assert.equal(settled.settledNow, true);

  const after = await state(w);
  assert.equal(after.order, 'PAID');
  assert.deepEqual(after.rows, [{ status: 'FINALIZED', txSignature: signed.signature }]);
  assert.equal(after.reservation, 'CONSUMED');
  assert.equal(after.ownerUsdc, 25_500_000n - ORDER_ATOMIC);
  assert.equal(after.treasuryUsdc, ORDER_ATOMIC);

  // credits fall only because the chain balance fell (no separate deduction)
  const finalBalance = await w.balances.getSpendable(w.customerId);
  assert.equal(finalBalance.spendableAtomic, 5_510_000n);
  assert.equal(finalBalance.researchCredits, 5n);

  // status endpoint agrees
  const status = await w.checkout.status(w.customerId, w.orderId);
  assert.equal(status.orderStatus, 'PAID');
  assert.equal(status.payment?.status, 'FINALIZED');
  assert.equal(status.payment?.txSignature, signed.signature);

  // fulfillment is held while ENABLE_LIVE_FULFILLMENT is false
  assert.equal(w.fulfillmentCalls.length, 0, 'fulfillment must not trigger while enableLiveFulfillment is false');
});

test('scenario: settlement is exactly-once (re-verify, re-submit) and fulfillment fires once only when its flag is on', async () => {
  const w = await buildWorld({ flags: { enableLiveFulfillment: true } });
  const prepared = await w.checkout.prepare(w.customerId, w.orderId);
  const signed = signAsOwner(w, prepared.unsignedTransactionBase64);
  await w.checkout.submit(w.customerId, w.orderId, signed.base64);
  w.chain.finalize(signed.signature);
  const first = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(first.outcome, 'FINALIZED', JSON.stringify(first));
  const second = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(second.outcome, 'ALREADY_FINALIZED');
  const bySignature = await w.verification.verifyAndSettle({ signature: signed.signature });
  assert.equal(bySignature.outcome, 'ALREADY_FINALIZED');
  assert.equal(w.fulfillmentCalls.length, 1, 'fulfillment must trigger exactly once');
  const again = await w.checkout.submit(w.customerId, w.orderId, signed.base64);
  assert.equal(again.idempotent, true, 're-submitting the identical signed payload must be idempotent');
  assert.equal((await state(w)).ownerUsdc, 25_500_000n - ORDER_ATOMIC, 'funds must move once');
  await assert.rejects(() => w.checkout.prepare(w.customerId, w.orderId), 'a paid order cannot be prepared again');
});

/* -------------------------------------- negatives -------------------------------------- */

async function assertSubmitRejectedAndNothingMoved(w: World, base64: string, why: string, forgedSignature?: string) {
  const before = await state(w);
  await assert.rejects(() => w.checkout.submit(w.customerId, w.orderId, base64), `${why} must be rejected`);
  assert.deepEqual(await state(w), { ...before, audit: before.audit }, `${why}: no row, reservation, order or balance may change`);
  if (forgedSignature) assert.equal(await w.chain.getTransfer(forgedSignature), null, `${why}: nothing may be broadcast`);
}

test('negative: submission without a signature is rejected and nothing is broadcast', async () => {
  const w = await buildWorld();
  const prepared = await w.checkout.prepare(w.customerId, w.orderId);
  const before = await state(w);
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].status, 'PREPARED');

  await assertSubmitRejectedAndNothingMoved(w, prepared.unsignedTransactionBase64, 'the unsigned transaction exactly as prepared');
  await assertSubmitRejectedAndNothingMoved(w, '', 'an empty payload');
  await assertSubmitRejectedAndNothingMoved(w, b64(randomBytes(64)), 'random bytes');
  await assert.rejects(() => w.checkout.submit(w.customerId, w.orderId, undefined as any), 'a missing payload must be rejected');

  // all-zero signature in the owner slot is "present but not a signature"
  const zeroed = parseUnsigned(prepared.unsignedTransactionBase64);
  zeroed.addSignature(w.owner.publicKey, Buffer.alloc(64));
  await assertSubmitRejectedAndNothingMoved(w, b64(zeroed.serialize({ requireAllSignatures: false, verifySignatures: false })), 'an all-zero signature');
});

test("negative: a signature from a different key is rejected (forged slot, wrong fee payer, valid-but-foreign tx)", async () => {
  const w = await buildWorld();
  const prepared = await w.checkout.prepare(w.customerId, w.orderId);

  // (a) the prepared message, but the signature slot holds the stranger's signature
  const forged = parseUnsigned(prepared.unsignedTransactionBase64);
  forged.addSignature(w.owner.publicKey, signWith(w.stranger, forged.serializeMessage()));
  const forgedSig = b58(forged.signatures[0].signature);
  await assertSubmitRejectedAndNothingMoved(w, b64(forged.serialize({ requireAllSignatures: false, verifySignatures: false })), "the stranger's signature in the owner's slot", forgedSig);

  // (b) a transaction the stranger can sign for real (stranger is fee payer and authority) -> not the customer's wallet
  const strangerTx = await craftTransfer(w, ORDER_ATOMIC, { authority: w.stranger });
  strangerTx.partialSign(w.stranger);
  await assertSubmitRejectedAndNothingMoved(w, b64(strangerTx.serialize()), 'a transaction fully signed by someone else', b58(strangerTx.signatures[0].signature));

  // (c) prepared message signed by the stranger only (owner signature absent)
  const swapped = parseUnsigned(prepared.unsignedTransactionBase64);
  swapped.signatures = [{ publicKey: w.owner.publicKey, signature: null }];
  swapped.addSignature(w.owner.publicKey, signWith(w.stranger, swapped.serializeMessage()));
  await assertSubmitRejectedAndNothingMoved(w, b64(swapped.serialize({ requireAllSignatures: false, verifySignatures: false })), 'the prepared message signed by a stranger');

  // the legitimate signature still works afterwards (rejections did not poison the payment)
  const good = signAsOwner(w, prepared.unsignedTransactionBase64);
  const ok = await w.checkout.submit(w.customerId, w.orderId, good.base64);
  assert.equal(ok.status, 'SUBMITTED');
});

test('negative: wrong amount is rejected at submit (customer-signed but not what was prepared)', async () => {
  const w = await buildWorld();
  const prepared = await w.checkout.prepare(w.customerId, w.orderId);
  for (const amount of [1n, ORDER_ATOMIC - 1n, ORDER_ATOMIC + 1n, 25_500_000n]) {
    const tx = await craftTransfer(w, amount);
    tx.partialSign(w.owner); // a perfectly valid signature by the real customer over a DIFFERENT amount
    await assertSubmitRejectedAndNothingMoved(w, b64(tx.serialize()), `a validly signed transfer of ${amount} base units for a ${ORDER_ATOMIC} order`, b58(tx.signatures[0].signature));
  }
  const good = signAsOwner(w, prepared.unsignedTransactionBase64);
  assert.equal((await w.checkout.submit(w.customerId, w.orderId, good.base64)).status, 'SUBMITTED');
});

test('negative: a finalized transfer that does not match the order is never settled (amount, destination, source, mint, reference)', async () => {
  const variants: { name: string; mutate: (t: any, w: World, reference: string) => any }[] = [
    { name: 'underpayment', mutate: (t) => ({ ...t, amountAtomic: ORDER_ATOMIC - 1n }) },
    { name: 'overpayment', mutate: (t) => ({ ...t, amountAtomic: ORDER_ATOMIC + 1n }) },
    { name: 'wrong destination', mutate: (t, w) => ({ ...t, destinationOwner: w.stranger.publicKey.toBase58() }) },
    { name: 'wrong source', mutate: (t, w) => ({ ...t, sourceOwner: w.stranger.publicKey.toBase58() }) },
    { name: 'wrong mint', mutate: (t) => ({ ...t, mint: Keypair.generate().publicKey.toBase58() }) },
    { name: 'missing payment reference', mutate: (t) => ({ ...t, referenceKeys: [] }) },
    { name: 'wrong network', mutate: (t) => ({ ...t, network: 'solana-mainnet' }) },
  ];
  for (const variant of variants) {
    const w = await buildWorld();
    const prepared = await w.checkout.prepare(w.customerId, w.orderId);
    const signed = signAsOwner(w, prepared.unsignedTransactionBase64);
    await w.checkout.submit(w.customerId, w.orderId, signed.base64);
    const real = await w.chain.getTransfer(signed.signature);
    assert.ok(real, 'precondition: the submitted transfer is known to the chain');
    // Replace what the chain reports with a finalized, successful transfer that deviates in one respect. Reference key is the
    // one the platform derived for this payment (sha256 of the reference), unless the variant removes it.
    const referenceKey = new PublicKey(createHash('sha256').update(prepared.paymentReference, 'utf8').digest()).toBase58();
    const doctored = variant.mutate({ ...real, finalized: true, succeeded: true, referenceKeys: [referenceKey] }, w, prepared.paymentReference);
    w.chain.recordTransfer(doctored);
    const result = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.equal(result.outcome, 'FAILED', `${variant.name}: must not settle; got ${JSON.stringify(result)}`);
    const after = await state(w);
    assert.equal(after.order, 'PENDING_PAYMENT', `${variant.name}: order must not be marked paid`);
    assert.notEqual(after.reservation, 'CONSUMED', `${variant.name}: credits must not be consumed`);
    assert.equal(after.rows[0].status, 'FAILED', `${variant.name}: payment row must be FAILED`);
    assert.equal(w.fulfillmentCalls.length, 0, `${variant.name}: fulfillment must not trigger`);
    const retry = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.notEqual(retry.outcome, 'FINALIZED', `${variant.name}: a retry must never settle a failed payment`);
  }
});

test('negative: an unfinalized or failed-on-chain transfer never settles (otherwise-correct transfers, so only finality differs)', async () => {
  for (const mode of ['not-finalized', 'failed-on-chain'] as const) {
    const w = await buildWorld();
    const prepared = await w.checkout.prepare(w.customerId, w.orderId);
    const signed = signAsOwner(w, prepared.unsignedTransactionBase64);
    await w.checkout.submit(w.customerId, w.orderId, signed.base64);
    const real = await w.chain.getTransfer(signed.signature);
    assert.ok(real, 'precondition: the submitted transfer is known to the chain');
    // Make the transfer otherwise perfect (incl. the payment reference) so ONLY finality / success decides the outcome.
    const referenceKey = new PublicKey(createHash('sha256').update(prepared.paymentReference, 'utf8').digest()).toBase58();
    w.chain.recordTransfer({ ...real, referenceKeys: [referenceKey], finalized: mode === 'failed-on-chain', succeeded: mode !== 'failed-on-chain' });
    const result = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.equal(result.outcome, mode === 'not-finalized' ? 'PENDING' : 'FAILED', `${mode}: unexpected outcome ${JSON.stringify(result)}`);
    const after = await state(w);
    assert.equal(after.order, 'PENDING_PAYMENT', `${mode}: order must stay unpaid`);
    assert.notEqual(after.rows[0].status, 'FINALIZED', `${mode}: payment must not be FINALIZED`);
    assert.notEqual(after.reservation, 'CONSUMED', `${mode}: credits must not be consumed`);
    assert.equal(after.ownerUsdc, 25_500_000n, `${mode}: no funds may move`);
    assert.equal(w.fulfillmentCalls.length, 0);
  }
});

test('negative: insufficient credits, foreign orders and chain outage fail closed without side effects', async () => {
  // insufficient: only 10 USDC for a $19.99 order
  const poor = await buildWorld({ fundAtomic: 10_000_000n });
  await assert.rejects(() => poor.checkout.prepare(poor.customerId, poor.orderId), (e: any) => (e.getStatus?.() ?? 0) === 402, 'insufficient credits must be HTTP 402');
  assert.equal((await poor.db.creditReservation.findMany()).length, 0, 'no reservation may be created for an unaffordable order');
  assert.equal((await poor.db.cryptoTransaction.findMany()).length, 0);

  // exactly enough for a floor-credit trap: 19.989999 USDC is 19 RC but cannot pay $19.99
  const short = await buildWorld({ fundAtomic: 19_989_999n });
  await assert.rejects(() => short.checkout.prepare(short.customerId, short.orderId), (e: any) => (e.getStatus?.() ?? 0) === 402, 'one base unit short must be rejected');

  // someone else's order looks like a missing order
  const w = await buildWorld();
  await assert.rejects(() => w.checkout.prepare(w.customerId, 'order_other'), (e: any) => (e.getStatus?.() ?? 0) === 404);
  await assert.rejects(() => w.checkout.prepare('cust_2', w.orderId), (e: any) => (e.getStatus?.() ?? 0) === 404);

  // RPC outage -> 503, nothing reserved
  w.chain.setOutage(true);
  await assert.rejects(() => w.checkout.prepare(w.customerId, w.orderId), (e: any) => (e.getStatus?.() ?? 0) === 503);
  w.chain.setOutage(false);
  assert.equal((await w.db.creditReservation.findMany()).length, 0, 'an outage during prepare must not leave a reservation');
});

test('negative: with the mainnet flags off, a mainnet-labelled chain cannot prepare a payment', async () => {
  const w = await buildWorld();
  const mainnetChain = Object.create(w.chain, { network: { value: 'solana-mainnet' } });
  const C = w.C;
  const checkout = new C.CheckoutService(w.db, mainnetChain, w.balances, { async getWallet() { return { address: w.owner.publicKey.toBase58(), network: 'solana-mainnet' }; } }, w.flags, new C.InMemoryPreparedMessageStore(), { treasury: w.treasury, mainnetUsdcMint: contracts().USDC_DEVNET_MINT, reservationTtlMs: 60_000, messageReuseMs: 1000, nodeEnv: 'test' });
  await assert.rejects(() => checkout.prepare(w.customerId, w.orderId), /mainnet|disabled/i, 'mainnet must fail closed while ENABLE_SOLANA_MAINNET is false');
  assert.equal((await w.db.creditReservation.findMany()).length, 0);
  const noLive = new C.CheckoutService(w.db, mainnetChain, w.balances, { async getWallet() { return { address: w.owner.publicKey.toBase58(), network: 'solana-mainnet' }; } }, { ...w.flags, enableSolanaMainnet: true }, new C.InMemoryPreparedMessageStore(), { treasury: w.treasury, mainnetUsdcMint: contracts().USDC_DEVNET_MINT, reservationTtlMs: 60_000, messageReuseMs: 1000, nodeEnv: 'test' });
  await assert.rejects(() => noLive.prepare(w.customerId, w.orderId), /live|disabled/i, 'mainnet also needs ENABLE_LIVE_CRYPTO_PAYMENTS');
  assert.equal((await w.db.creditReservation.findMany()).length, 0);
});

// Keep API_SRC referenced: documents the root this suite is bound to.
void API_SRC;
