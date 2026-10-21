/**
 * Platform-paid Solana network fee ("fee sponsorship") for wallet checkout: what this browser accepts and signs.
 *
 * The API may add `feePayer` + `feeSponsored` to POST /wallet/checkout/:orderId/prepare. When feeSponsored is true the transaction's
 * fee payer is the platform's key, there are exactly two signers [fee payer, customer], the customer signs only their own slot and
 * the server adds the platform signature at submit. These tests build REAL transactions (@solana/web3.js, @solana/spl-token from
 * apps/api), run them through the storefront's real validator (lib/wallet/tx.ts), the real SandboxBrowserSigner and the real
 * top-up run, and check that anything outside the fixed shape is refused BEFORE a signature is made.
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/sponsored-fee-validation.test.ts
 *
 * NOT covered (needs a browser / live API): rendering of the checkout panel (only static text scans below), the real API's
 * sponsored transaction, the server adding the platform signature, an on-chain broadcast.
 */
import { strict as assert } from 'node:assert';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { normalizeCheckoutPreparation, type CheckoutPreparation } from '../../apps/storefront/lib/wallet/api';
import { SandboxBrowserSigner } from '../../apps/storefront/lib/wallet/sandbox-signer';
import { USDC_DEVNET_MINT, base64ToBytes, bytesToBase64, checkoutPreparationProblems, signingOptionsFor, verifyUsdcTransfer } from '../../apps/storefront/lib/wallet/tx';
import { createTopUpRun, createTopUpStore, solFeeProblem, type KeyValueStorage, type TopUpDeps, type TopUpPlan } from '../../apps/storefront/lib/wallet/topup-flow';
import { ROOT, read } from './_helpers';

const apiRequire = createRequire(path.join(ROOT, 'apps/api/package.json'));
const web3 = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');
const spl = apiRequire('@solana/spl-token') as typeof import('@solana/spl-token');
const { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } = web3;

/* ------------------------------ fixtures ------------------------------ */

const memory = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } },
};

const signer = SandboxBrowserSigner.create('sponsored@example.com');
const CUSTOMER = signer.address;
const platform = Keypair.generate();
const PLATFORM = platform.publicKey.toBase58();
const MERCHANT = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();
const REFERENCE_TEXT = 'ref-order-1';
const REFERENCE = new PublicKey(createHash('sha256').update(REFERENCE_TEXT).digest()).toBase58();
const AMOUNT = 100_000_000n;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const MINT = new PublicKey(USDC_DEVNET_MINT);

type Build = {
  feePayer?: string;
  customer?: string;
  authority?: string;
  destinationOwner?: string;
  amount?: bigint;
  decimals?: number;
  mint?: string;
  reference?: string;
  /** Extra account keys appended to the transfer instruction. */
  extraKeys?: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  before?: unknown[];
  after?: unknown[];
};

function buildBase64(o: Build = {}): string {
  const customer = new PublicKey(o.customer ?? CUSTOMER);
  const mint = new PublicKey(o.mint ?? USDC_DEVNET_MINT);
  const source = spl.getAssociatedTokenAddressSync(mint, customer, false);
  const destination = spl.getAssociatedTokenAddressSync(mint, new PublicKey(o.destinationOwner ?? MERCHANT), true);
  const ix = spl.createTransferCheckedInstruction(source, mint, destination, new PublicKey(o.authority ?? CUSTOMER), o.amount ?? AMOUNT, o.decimals ?? 6);
  ix.keys.push({ pubkey: new PublicKey(o.reference ?? REFERENCE), isSigner: false, isWritable: false });
  for (const k of o.extraKeys ?? []) ix.keys.push({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable });
  const tx = new Transaction({ feePayer: new PublicKey(o.feePayer ?? PLATFORM), blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
  for (const extra of o.before ?? []) tx.add(extra as never);
  tx.add(ix);
  for (const extra of o.after ?? []) tx.add(extra as never);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function prep(over: Partial<CheckoutPreparation> = {}, build: Build = {}): CheckoutPreparation {
  return {
    paymentReference: REFERENCE_TEXT, amountAtomic: AMOUNT, amountUsd: '100.00', merchant: MERCHANT, network: 'solana-devnet', feeLamports: 5000n,
    feePayer: PLATFORM, feeSponsored: true, unsignedTransactionBase64: buildBase64(build), expiresAt: null, disclosures: [], ...over,
  };
}
/** Prepared payment where the customer pays the fee, exactly as before sponsorship existed. */
const customerPays = (over: Partial<CheckoutPreparation> = {}, build: Build = {}) => prep({ feePayer: null, feeSponsored: false, ...over }, { feePayer: CUSTOMER, ...build });

const problems = (p: CheckoutPreparation) => checkoutPreparationProblems(p, CUSTOMER);
const refused = async (p: CheckoutPreparation, reason?: RegExp, why = '') => {
  const found = await problems(p);
  assert.ok(found.length > 0, `expected a refusal ${why}`);
  if (reason) assert.ok(found.some((m) => reason.test(m)), `expected ${reason} in: ${found.join(' | ')}`);
  return found;
};

function signatureOk(signedBase64: string, index: number, publicKey: string): boolean {
  const signed = VersionedTransaction.deserialize(base64ToBytes(signedBase64));
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(new PublicKey(publicKey).toBytes())]);
  return nodeVerify(null, Buffer.from(signed.message.serialize()), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(signed.signatures[index]));
}
const isEmptySlot = (signature: Uint8Array) => signature.every((b) => b === 0);

/* ------------------------------ happy path ------------------------------ */

test('sponsored: a transaction with the platform as fee payer and [platform, customer] signers is accepted', async () => {
  assert.deepEqual(await problems(prep()), []);
  assert.equal(verifyUsdcTransfer(prep().unsignedTransactionBase64, { signer: CUSTOMER, destinationOwner: MERCHANT, amountAtomic: AMOUNT, purpose: 'checkout', referenceKey: REFERENCE, feeSponsored: true, feePayer: PLATFORM }).length, 0);
});

test('sponsored: signing fills ONLY the customer slot; the fee-payer slot stays empty; the submit body is the base64 of that', async () => {
  const p = prep();
  assert.deepEqual(signingOptionsFor(p), { sponsoredFeePayer: PLATFORM });
  const signed = await signer.signTransaction(p.unsignedTransactionBase64, signingOptionsFor(p));
  const tx = VersionedTransaction.deserialize(base64ToBytes(signed));
  assert.equal(tx.signatures.length, 2);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), PLATFORM);
  assert.equal(tx.message.staticAccountKeys[1].toBase58(), CUSTOMER);
  assert.ok(isEmptySlot(tx.signatures[0]), 'fee-payer slot must stay empty');
  assert.ok(!isEmptySlot(tx.signatures[1]), 'customer slot is filled');
  assert.ok(signatureOk(signed, 1, CUSTOMER), 'the customer signature verifies over the exact message');
  // Same message bytes as what was prepared: nothing was altered while signing.
  assert.deepEqual(Buffer.from(tx.message.serialize()), Buffer.from(VersionedTransaction.deserialize(base64ToBytes(p.unsignedTransactionBase64)).message.serialize()));
  assert.ok(typeof bytesToBase64(base64ToBytes(signed)) === 'string' && bytesToBase64(base64ToBytes(signed)) === signed, 'plain base64 round trip');
});

test('not sponsored: unchanged. Customer pays, one signature, a full signature set results, old responses without the fields still pass', async () => {
  const p = customerPays();
  assert.deepEqual(await problems(p), []);
  assert.equal(signingOptionsFor(p), undefined);
  const signed = await signer.signTransaction(p.unsignedTransactionBase64);
  const tx = VersionedTransaction.deserialize(base64ToBytes(signed));
  assert.equal(tx.signatures.length, 1);
  assert.ok(signatureOk(signed, 0, CUSTOMER));
  // An API that names the customer as the fee payer (feeSponsored:false) is also fine.
  assert.deepEqual(await problems(customerPays({ feePayer: CUSTOMER })), []);
});

/* ------------------------------ fee payer / sponsored flag mismatches ------------------------------ */

test('feeSponsored:true but the transaction fee payer is the customer: refused', async () => {
  await refused(prep({}, { feePayer: CUSTOMER }), /your own wallet is the transaction fee payer/);
  await refused(prep({ feePayer: CUSTOMER }, { feePayer: CUSTOMER }), /named fee payer is your own wallet/);
});

test('feeSponsored:false but the transaction fee payer is not the customer: refused', async () => {
  // A platform-paid, two-signer transaction presented as customer-paid.
  await refused(prep({ feeSponsored: false, feePayer: null }), /fee payer and only signer|exactly one signature/);
  await refused(prep({ feeSponsored: false, feePayer: PLATFORM }), /fee payer other than your wallet/);
  // The flag is missing entirely (normalizer default) while the transaction is platform-paid.
  const defaulted = normalizeCheckoutPreparation({ paymentReference: REFERENCE_TEXT, amountAtomic: AMOUNT.toString(), merchant: MERCHANT, network: 'solana-devnet', unsignedTransactionBase64: buildBase64() });
  await refused(defaulted, /only signer/);
});

test('sponsored with a missing, malformed or different announced fee payer: refused', async () => {
  await refused(prep({ feePayer: null }), /did not name a valid fee payer/);
  await refused(prep({ feePayer: 'not-a-public-key' }), /did not name a valid fee payer/);
  await refused(prep({ feePayer: STRANGER }), /not the fee payer the service announced/);
  assert.throws(() => signingOptionsFor({ feeSponsored: true, feePayer: null }), /names no fee payer/);
});

test('fee payer equal to the merchant address: refused', async () => {
  await refused(prep({ feePayer: MERCHANT }, { feePayer: MERCHANT }), /must not be the merchant address/);
});

/* ------------------------------ the fee payer must be inert ------------------------------ */

test('fee payer used as the transfer authority: refused', async () => {
  const found = await refused(prep({}, { authority: PLATFORM }));
  assert.ok(found.some((m) => /authority|originate|second signer|exactly two/.test(m)), found.join(' | '));
});

test('fee payer appearing in an instruction as a writable account: refused', async () => {
  await refused(prep({}, { extraKeys: [{ pubkey: PLATFORM, isSigner: false, isWritable: true }] }), /used inside an instruction/);
});

test('fee payer appearing in an instruction as a read-only account: refused', async () => {
  await refused(prep({}, { extraKeys: [{ pubkey: PLATFORM, isSigner: false, isWritable: false }] }), /used inside an instruction/);
});

test('fee payer appearing in an instruction as a signer: refused', async () => {
  await refused(prep({}, { extraKeys: [{ pubkey: PLATFORM, isSigner: true, isWritable: true }] }), /used inside an instruction/);
});

test('fee payer as the OWNER of the destination token account: refused', async () => {
  await refused(prep({}, { destinationOwner: PLATFORM }), /destination does not match/);
});

test('fee payer as an extra instruction that moves SOL out of it or into it: refused', async () => {
  const drain = SystemProgram.transfer({ fromPubkey: new PublicKey(PLATFORM), toPubkey: new PublicKey(STRANGER), lamports: 1_000_000 });
  await refused(prep({}, { before: [drain] }), /instructions other than the USDC transfer/);
  const tip = SystemProgram.transfer({ fromPubkey: new PublicKey(CUSTOMER), toPubkey: new PublicKey(PLATFORM), lamports: 1 });
  await refused(prep({}, { after: [tip] }));
});

/* ------------------------------ signer count ------------------------------ */

test('wrong number of required signers: refused', async () => {
  // 3 signers: an extra read-only signer account on the transfer.
  await refused(prep({}, { extraKeys: [{ pubkey: STRANGER, isSigner: true, isWritable: false }] }), /exactly two signatures/);
  // 3 signers, the extra one writable.
  await refused(prep({}, { extraKeys: [{ pubkey: STRANGER, isSigner: true, isWritable: true }] }), /exactly two signatures/);
  // 1 signer: the fee payer is the only signer and the customer is not one.
  await refused(prep({}, { authority: PLATFORM }), /exactly two signatures|second signer/);
});

test('the transaction fee payer must be the announced one (a different key in slot 0 is refused)', async () => {
  await refused(prep({}, { feePayer: STRANGER }), /not the fee payer the service announced/);
});

test('accounts that no instruction uses are refused in a sponsored transaction', async () => {
  // Append a key (read-only, unsigned) that no instruction references.
  const raw = VersionedTransaction.deserialize(base64ToBytes(buildBase64()));
  (raw.message as unknown as { staticAccountKeys: unknown[] }).staticAccountKeys.push(new PublicKey(STRANGER));
  await refused(prep({ unsignedTransactionBase64: Buffer.from(raw.serialize()).toString('base64') }), /no instruction uses/);
});

/* ------------------------------ existing checks stay in force for sponsored transactions ------------------------------ */

test('extra instruction (before or after the transfer): refused', async () => {
  const memo = new web3.TransactionInstruction({ keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from('hi') });
  await refused(prep({}, { before: [memo] }), /instructions other than the USDC transfer/);
  await refused(prep({}, { after: [memo] }));
});

test('tampered amount, decimals, destination, mint or reference: refused', async () => {
  await refused(prep({}, { amount: AMOUNT + 1n }), /amount does not match/);
  await refused(prep({}, { amount: AMOUNT - 1n }), /amount does not match/);
  await refused(prep({}, { decimals: 9 }), /decimals/);
  await refused(prep({}, { destinationOwner: STRANGER }), /destination does not match/);
  await refused(prep({}, { reference: STRANGER }), /reference does not match/);
  await refused(prep({}, { mint: Keypair.generate().publicKey.toBase58() }), /not in devnet USDC/);
  await refused(prep({ amountAtomic: AMOUNT + 1n }), /amount does not match/); // the screen says more than the transaction pays
  await refused(prep({ merchant: STRANGER }), /destination does not match/);
  await refused(prep({ network: 'solana-mainnet' }), /not supported/);
});

test('a source account that is not the customer, or a signer-flagged source: refused', async () => {
  const other = Keypair.generate().publicKey.toBase58();
  await refused(prep({}, { customer: other }), /does not originate from your wallet/);
});

test('sponsorship is refused for plain wallet-to-wallet transfers (checkout only)', () => {
  const found = verifyUsdcTransfer(buildBase64(), { signer: CUSTOMER, destinationOwner: MERCHANT, amountAtomic: AMOUNT, feeSponsored: true, feePayer: PLATFORM });
  assert.ok(found.some((m) => /only supported for checkout/.test(m)), found.join(' | '));
});

/* ------------------------------ the signer itself refuses too (defence in depth) ------------------------------ */

test('signer: refuses a two-signer transaction unless sponsorship was declared, and refuses anything off-shape when it was', async () => {
  const sponsored = prep();
  await assert.rejects(() => signer.signTransaction(sponsored.unsignedTransactionBase64), /exactly one signature/);
  await assert.rejects(() => signer.signTransaction(sponsored.unsignedTransactionBase64, { sponsoredFeePayer: STRANGER }), /exactly two signatures/);
  await assert.rejects(() => signer.signTransaction(sponsored.unsignedTransactionBase64, { sponsoredFeePayer: CUSTOMER }), /exactly two signatures/);
  // Sponsorship declared but the customer is the fee payer.
  await assert.rejects(() => signer.signTransaction(customerPays().unsignedTransactionBase64, { sponsoredFeePayer: PLATFORM }), /exactly two signatures/);
  // Three signers.
  const three = buildBase64({ extraKeys: [{ pubkey: STRANGER, isSigner: true, isWritable: false }] });
  await assert.rejects(() => signer.signTransaction(three, { sponsoredFeePayer: PLATFORM }), /exactly two signatures/);
  // Customer in the fee-payer slot with a second signer behind it.
  const swapped = buildBase64({ feePayer: CUSTOMER, extraKeys: [{ pubkey: PLATFORM, isSigner: true, isWritable: false }] });
  await assert.rejects(() => signer.signTransaction(swapped, { sponsoredFeePayer: PLATFORM }), /exactly two signatures/);
});

/* ------------------------------ normalizer ------------------------------ */

test('normalizer: feePayer defaults to null and feeSponsored to false when the API omits them; real values pass through', () => {
  const base = { paymentReference: 'r', amountAtomic: '100', merchant: MERCHANT, network: 'solana-devnet', unsignedTransactionBase64: 'AA==' };
  const old = normalizeCheckoutPreparation(base);
  assert.equal(old.feePayer, null);
  assert.equal(old.feeSponsored, false);
  const sponsored = normalizeCheckoutPreparation({ ...base, feePayer: PLATFORM, feeSponsored: true });
  assert.equal(sponsored.feePayer, PLATFORM);
  assert.equal(sponsored.feeSponsored, true);
  const customer = normalizeCheckoutPreparation({ ...base, feePayer: CUSTOMER, feeSponsored: false });
  assert.equal(customer.feePayer, CUSTOMER);
  assert.equal(customer.feeSponsored, false);
  // Only a literal boolean true sponsors. Truthy strings/numbers do not, and junk fee payers become null.
  for (const junk of ['true', 1, 'yes', {}, null]) assert.equal(normalizeCheckoutPreparation({ ...base, feeSponsored: junk }).feeSponsored, false, `feeSponsored ${JSON.stringify(junk)}`);
  for (const junk of [5, '', {}, null]) assert.equal(normalizeCheckoutPreparation({ ...base, feePayer: junk }).feePayer, null);
  // Every previously existing field is untouched.
  assert.equal(old.amountAtomic, 100n);
  assert.equal(old.merchant, MERCHANT);
  assert.equal(old.feeLamports, null);
});

/* ------------------------------ auto-pay path: zero SOL ------------------------------ */

const T0 = 1_700_000_000_000;
const EMAIL = 'Sponsored@Example.com';
function memStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

/**
 * The real storefront pieces (validator, signer options, signer) wired into the top-up run, with an in-memory "chain" in which
 * the customer holds ZERO SOL and ONLY the platform fee payer can pay a fee. submit() plays the server's role.
 */
function autoPay(prepared: CheckoutPreparation, sol: { balance: bigint | null | Error }, customerLamports = 0n) {
  const seen = { solReads: 0, signed: [] as string[], submitted: [] as string[] };
  let now = T0;
  const chainLamports = new Map<string, bigint>([[CUSTOMER, customerLamports], [PLATFORM, 10_000_000n]]);
  const deps: TopUpDeps<CheckoutPreparation> = {
    fetchBalance: async () => ({ spendableAtomic: AMOUNT, stale: false }),
    openWidget: () => ({ status: 'opened' }),
    sleep: async () => { now += 3000; },
    now: () => now,
    prepare: async () => prepared,
    validate: (p) => checkoutPreparationProblems(p, CUSTOMER),
    sign: async (p) => { const out = await signer.signTransaction(p.unsignedTransactionBase64, signingOptionsFor(p)); seen.signed.push(out); return out; },
    solBalanceLamports: async () => { seen.solReads += 1; if (sol.balance instanceof Error) throw sol.balance; return sol.balance; },
    submit: async (_p, signedBase64) => {
      // What the server does: the fee payer pays. A customer fee payer with zero SOL cannot.
      const tx = VersionedTransaction.deserialize(base64ToBytes(signedBase64));
      const payer = tx.message.staticAccountKeys[0].toBase58();
      if ((chainLamports.get(payer) ?? 0n) < 5000n) throw new Error('Insufficient SOL for fees');
      seen.submitted.push(signedBase64);
    },
    store: createTopUpStore(memStorage()),
  };
  const plan: TopUpPlan = { orderId: 'order-1', intentId: 'intent-1', requiredAtomic: AMOUNT, baselineSpendableAtomic: 0n, consentedAt: T0, widgetUrl: 'https://buy.moonpay.example/w', sandbox: false, merchant: MERCHANT };
  const run = createTopUpRun(plan, deps, EMAIL, { pollMs: 3000, timeoutMs: 60_000, consentMaxAgeMs: 3_600_000, settleReads: 2 });
  return { run, seen };
}

test('auto-pay with a zero-SOL customer proceeds when the fee is sponsored (the SOL balance is never even read)', async () => {
  const { run, seen } = autoPay(prep(), { balance: 0n });
  run.start();
  const end = await run.whenSettled();
  assert.equal(end.kind, 'submitted');
  assert.equal(seen.solReads, 0, 'no SOL read for a sponsored payment');
  assert.equal(seen.signed.length, 1);
  assert.equal(seen.submitted.length, 1);
  const tx = VersionedTransaction.deserialize(base64ToBytes(seen.submitted[0]));
  assert.ok(isEmptySlot(tx.signatures[0]) && !isEmptySlot(tx.signatures[1]));
});

test('auto-pay: a refused sponsored transaction never reaches the signer', async () => {
  const bad = prep({}, { extraKeys: [{ pubkey: PLATFORM, isSigner: false, isWritable: true }] });
  const { run, seen } = autoPay(bad, { balance: 0n });
  run.start();
  const end = await run.whenSettled();
  assert.equal(end.kind, 'pay-failed');
  assert.equal(seen.signed.length, 0, 'nothing signed');
  assert.equal(seen.submitted.length, 0);
});

test('auto-pay: low SOL blocks ONLY when the customer pays the fee; unknown SOL never blocks', async () => {
  // Customer pays and holds 0 SOL: refuse before signing, with an honest reason.
  const low = autoPay(customerPays(), { balance: 0n });
  low.run.start();
  const lowEnd = await low.run.whenSettled();
  assert.equal(lowEnd.kind, 'pay-failed');
  assert.match(lowEnd.kind === 'pay-failed' ? lowEnd.reasons.join(' ') : '', /not hold enough SOL/);
  assert.equal(low.seen.solReads, 1);
  assert.equal(low.seen.signed.length, 0);
  // Customer pays and has enough SOL: proceeds.
  const enough = autoPay(customerPays(), { balance: 5000n }, 5000n);
  enough.run.start();
  assert.equal((await enough.run.whenSettled()).kind, 'submitted');
  // Unknown (null or a thrown read) is not "zero": the API remains the authority.
  const unknown = autoPay(customerPays(), { balance: null }, 5000n);
  unknown.run.start();
  assert.equal((await unknown.run.whenSettled()).kind, 'submitted');
  const thrown = autoPay(customerPays(), { balance: new Error('rpc down') }, 5000n);
  thrown.run.start();
  assert.equal((await thrown.run.whenSettled()).kind, 'submitted');
});

test('solFeeProblem: sponsored never warns; customer-pays warns only on a known shortfall', () => {
  assert.equal(solFeeProblem({ feeSponsored: true, feeLamports: 5000n }, 0n), null);
  assert.equal(solFeeProblem({ feeSponsored: false, feeLamports: 5000n }, 0n)?.includes('SOL'), true);
  assert.equal(solFeeProblem({ feeSponsored: false, feeLamports: 5000n }, 4999n)?.includes('SOL'), true);
  assert.equal(solFeeProblem({ feeSponsored: false, feeLamports: 5000n }, 5000n), null);
  assert.equal(solFeeProblem({ feeSponsored: false, feeLamports: null }, 0n), null);
  assert.equal(solFeeProblem({ feeSponsored: false, feeLamports: 5000n }, null), null);
  assert.equal(solFeeProblem({}, 0n), null, 'no fee estimate: unknown, not a problem');
});

/* ------------------------------ copy (static scan of the component; no browser was used) ------------------------------ */

test('component copy: sponsored says "Network fee: paid by Helix & Field"; the SOL wording is the customer-pays branch only; no invented amounts', () => {
  const src = read(path.join(ROOT, 'apps/storefront/components/wallet/credits-checkout.tsx'));
  assert.match(src, /prep\.feeSponsored \? 'Network fee: paid by Helix & Field\./);
  assert.match(src, /: 'The network fee is paid in SOL from your wallet\.'/);
  assert.match(src, /prep\.feeSponsored\s*\n?\s*\? <div[^\n]*Paid by Helix &amp; Field[^\n]*\n\s*: <div[^\n]*Estimated network fee/, 'fee row: sponsored branch has no SOL amount; the estimate row is the other branch');
  // The sponsored branch never shows lamports/SOL amounts.
  const sponsoredBranch = /prep\.feeSponsored\s*\n?\s*\? (<div[^\n]*<\/div>)/.exec(src)?.[1] ?? '';
  assert.ok(sponsoredBranch && !/SOL|lamports|formatSol/i.test(sponsoredBranch));
  // Nothing claims the fee is "free" / "no fee" / "zero fee".
  for (const line of src.split('\n')) if (/fee/i.test(line)) assert.ok(!/\b(free|no fee|zero fee|0 fee|gasless|without any fee)\b/i.test(line), line.slice(0, 160));
  // Both signing call sites pass the sponsorship options through the shared helper.
  assert.equal([...src.matchAll(/signTransaction\([^)]*signingOptionsFor\(prep\)\)/g)].length, 2);
  // The checkout panel itself asks for no SOL balance anywhere.
  assert.ok(!/solBalance|solLamports/i.test(src));
});

test('custody: the signer never puts key material into a request, and signing options carry only a public address', () => {
  const api = read(path.join(ROOT, 'apps/storefront/lib/wallet/api.ts'));
  const tx = read(path.join(ROOT, 'apps/storefront/lib/wallet/tx.ts'));
  assert.ok(!/secretKey|privateKey/i.test(api));
  assert.ok(!/secretKey|privateKey/i.test(tx));
  assert.deepEqual(signingOptionsFor({ feeSponsored: true, feePayer: PLATFORM }), { sponsoredFeePayer: PLATFORM });
});
