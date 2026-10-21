/**
 * Platform-paid Solana network fee ("fee sponsorship") for wallet checkout.
 *
 * In-memory doubles only (see harness.ts). The fee-payer signer is a throwaway TEST key; no production signer exists in
 * the repository. What is pinned here:
 *   - OFF (default): nothing changes, even when a signer is bound.
 *   - ON: a zero-SOL customer can pay; the fee payer is account index 0 and appears in no instruction; the customer is
 *     still the USDC authority and a required signer; the platform signs only AFTER every customer check and the claim.
 *   - Every fallback / refusal path: low sponsor balance, daily cap, no signer, sponsor key equal to customer/merchant.
 *   - Failure paths after the claim release it, and nothing is broadcast.
 *   - Verification stays bound to the CUSTOMER wallet; the transaction id is the FEE PAYER's signature.
 */
import { strict as assert } from 'node:assert';
import { mock, test } from 'node:test';
import { TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from '@solana/spl-token';
import { Keypair, Message, PublicKey, Transaction } from '@solana/web3.js';
import { Logger } from '@nestjs/common';
import { ChainRejectedError } from '../../chain/chain-errors';
import { ChainUnavailableError, USDC_DEVNET_MINT } from '../../contracts';
import { base58Encode } from '../checkout.util';
import { CheckoutService } from '../checkout.service';
import { FeePayerSignerError } from '../fee-payer-signer.port';
import {
  DEFAULT_FEE_SPONSOR_MAX_PER_CUSTOMER_DAY,
  DEFAULT_FEE_SPONSOR_MIN_LAMPORTS,
  FEE_SPONSORED_AUDIT_ACTION,
  assertSponsorOnlyPaysFee,
  loadFeeSponsorshipConfig,
  requiredSignersOf,
} from '../fee-sponsorship';
import { loadCheckoutConfig } from '../ports';
import { CUSTOMER_ID, ORDER_ID, TestFeePayerSigner, makeHarness, signAs, signAsCustomerOnly, transferFor, type Harness } from './harness';

const decode = (base64: string) => Transaction.from(Buffer.from(base64, 'base64'));
const encode = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
const rejects = (promise: Promise<unknown>, status: number, match?: RegExp) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), status, `expected HTTP ${status}, got ${e.getStatus?.()} (${e.message})`);
    if (match) assert.match(e.message, match);
    return true;
  });

/** Sponsorship ON, customer holds ZERO SOL (the on-ramp customer). */
const sponsored = (options: Parameters<typeof makeHarness>[0] = {}) => makeHarness({ sponsorship: true, customerSol: 0n, ...options });
const SPONSOR_SOL = 1_000_000_000n;

async function prepareSponsored(h: Harness) {
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.feeSponsored, true);
  return prepared;
}

async function paySponsored(h: Harness) {
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  const submitted = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  return { prepared, signed, submitted };
}

const instructionAccounts = (tx: Transaction) => tx.compileMessage().instructions.flatMap((ix) => ix.accounts);
const auditCount = (h: Harness) => h.prisma.audits.filter((a) => a.action === FEE_SPONSORED_AUDIT_ACTION).length;

// ---------------------------------------------------------------------------------------------
// OFF by default
// ---------------------------------------------------------------------------------------------

test('sponsorship OFF (default): customer is the fee payer, the signer is never used, and a zero-SOL customer still gets 402', async () => {
  const h = makeHarness({ customerSol: 0n });
  // Even with a signer bound, the feature flag decides.
  const checkout = h.makeCheckout({ signer: h.signer });
  h.chain.sol.set(h.signer.publicKey, SPONSOR_SOL);
  await rejects(checkout.prepare(CUSTOMER_ID, ORDER_ID), 402, /Insufficient SOL/);

  h.chain.sol.set(h.customer.publicKey.toBase58(), 50_000_000n);
  const prepared = await checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.feeSponsored, false);
  assert.equal(prepared.feePayer, h.customer.publicKey.toBase58());
  assert.equal(prepared.feeLamports, '5000');
  assert.match(prepared.disclosures.join(' '), /paid in SOL by your own wallet/);
  assert.doesNotMatch(prepared.disclosures.join(' '), /Helix & Field/);
  const tx = decode(prepared.unsignedTransactionBase64);
  assert.equal(tx.feePayer!.toBase58(), h.customer.publicKey.toBase58());
  assert.equal(tx.signatures.length, 1);
  assert.equal(auditCount(h), 0);

  const submitted = await checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer));
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(h.signer.calls.length, 0, 'the platform signed nothing');
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(Transaction.from(Buffer.from(h.chain.broadcasts[0])).signatures.length, 1);
});

test('a customer-paid prepare is unchanged when sponsorship is on but not available (response still carries feePayer/feeSponsored)', async () => {
  const h = sponsored({ customerSol: 50_000_000n });
  h.chain.sol.set(h.signer.publicKey, 1n); // below the floor
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.feeSponsored, false);
  assert.equal(prepared.feePayer, h.customer.publicKey.toBase58());
  assert.equal(prepared.feeLamports, '5000');
});

// ---------------------------------------------------------------------------------------------
// ON: prepare
// ---------------------------------------------------------------------------------------------

test('sponsored prepare: fee payer is account index 0 and appears in NO instruction; customer is still the USDC authority and a required signer', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const sponsor = h.signer.publicKey;
  assert.equal(prepared.feePayer, sponsor);
  assert.notEqual(prepared.feePayer, h.customer.publicKey.toBase58());
  assert.equal(prepared.feeLamports, '10000', 'two signatures x 5000');
  assert.equal(h.prisma.txs[0].feeLamports, 10_000n);

  const tx = decode(prepared.unsignedTransactionBase64);
  const message = tx.compileMessage();
  assert.equal(message.accountKeys[0].toBase58(), sponsor);
  assert.deepEqual(requiredSignersOf(message), [sponsor, h.customer.publicKey.toBase58()]);
  assert.ok(!instructionAccounts(tx).includes(0), 'the fee payer is in no instruction account list');
  assert.ok(message.instructions.every((ix) => ix.programIdIndex !== 0), 'and is no instruction program');
  assert.equal(message.accountKeys.filter((k) => k.toBase58() === sponsor).length, 1);
  // Customer is the transfer authority (instruction key 3 of transferChecked) and a signer.
  const transfer = tx.instructions[0];
  assert.equal(transfer.keys[3].pubkey.toBase58(), h.customer.publicKey.toBase58());
  assert.equal(transfer.keys[3].isSigner, true);
  assert.ok(transfer.keys.every((k) => k.pubkey.toBase58() !== sponsor));
  // Nothing is signed by the platform at prepare.
  assert.ok(tx.signatures.every((s) => s.signature === null));
  assert.equal(h.signer.calls.length, 0);
  // The decision is recorded server-side in the stored compiled message.
  const stored = await h.store.get(prepared.paymentReference);
  assert.equal(Message.from(stored!.messageBytes).accountKeys[0].toBase58(), sponsor);
  assert.equal(stored!.feeLamports, 10_000n);
});

test('sponsored prepare: disclosure says Helix & Field pays the fee, never "your own wallet"; the sponsor balance is never leaked', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const text = prepared.disclosures.join('\n');
  assert.match(text, /paid by Helix & Field/);
  assert.doesNotMatch(text, /paid in SOL by your own wallet/);
  assert.match(text, /only as the network-fee payer/);
  assert.ok(!JSON.stringify(prepared).includes(SPONSOR_SOL.toString()), 'the sponsor balance is not in the response');
  assert.deepEqual(
    Object.keys(prepared).sort(),
    ['amountAtomic', 'amountUsd', 'disclosures', 'expiresAt', 'feeLamports', 'feePayer', 'feeSponsored', 'merchant', 'mint', 'network', 'paymentReference', 'unsignedTransactionBase64'],
    'additive contract: only feePayer and feeSponsored were added',
  );
});

test('sponsored prepare writes exactly one CHECKOUT_FEE_SPONSORED audit event per payment; re-prepare does not add another', async () => {
  const h = sponsored();
  const first = await prepareSponsored(h);
  assert.equal(auditCount(h), 1);
  const event = h.prisma.audits.find((a) => a.action === FEE_SPONSORED_AUDIT_ACTION)!;
  assert.equal(event.customerId, CUSTOMER_ID);
  assert.equal((event.detail as any).reference, first.paymentReference);
  const again = await prepareSponsored(h);
  assert.equal(again.paymentReference, first.paymentReference);
  assert.equal(auditCount(h), 1);
});

test('existing prepare checks still come first: insufficient credits is 402 and no sponsorship decision (no audit, no sponsor RPC read) happens', async () => {
  const h = sponsored({ usdc: 1_000_000n });
  const reads: string[] = [];
  const original = h.chain.getSolBalanceLamports.bind(h.chain);
  h.chain.getSolBalanceLamports = async (owner: string) => (reads.push(owner), original(owner));
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402, /Insufficient Research Credits/);
  assert.deepEqual(reads, []);
  assert.equal(auditCount(h), 0);
  const unapproved = sponsored({ eligibility: 'PENDING' });
  await rejects(unapproved.checkout.prepare(CUSTOMER_ID, ORDER_ID), 403);
  assert.equal(auditCount(unapproved), 0);
});

// ---------------------------------------------------------------------------------------------
// ON: submit, happy path and the transaction id
// ---------------------------------------------------------------------------------------------

test('sponsored submit end to end: zero-SOL customer pays; two valid signatures are broadcast; the id is the FEE PAYER signature; platform signs after the claim and before broadcast', async () => {
  const h = sponsored();
  const original = h.signer.signMessage.bind(h.signer);
  let observed: { status: string; broadcasts: number; txSignature: string | null } | null = null;
  h.signer.signMessage = async (message) => {
    observed = { status: h.prisma.txs[0].status, broadcasts: h.chain.broadcasts.length, txSignature: h.prisma.txs[0].txSignature };
    return original(message);
  };
  const { prepared, submitted } = await paySponsored(h);

  assert.deepEqual(observed, { status: 'SUBMITTED', broadcasts: 0, txSignature: null }, 'signed only after the claim, before anything was broadcast');
  assert.equal(h.signer.calls.length, 1);
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(h.chain.broadcasts.length, 1);
  const sent = Transaction.from(Buffer.from(h.chain.broadcasts[0]));
  assert.equal(sent.signatures.length, 2);
  assert.equal(sent.verifySignatures(), true, 'both required signatures are valid over the message');
  assert.equal(sent.signatures[0].publicKey.toBase58(), h.signer.publicKey);
  assert.equal(sent.signatures[1].publicKey.toBase58(), h.customer.publicKey.toBase58());
  // The platform signed exactly the prepared message.
  assert.deepEqual(Buffer.from(h.signer.calls[0]), Buffer.from((await h.store.get(prepared.paymentReference))!.messageBytes));
  // The transaction id is the FEE PAYER's signature (signatures[0]), not the customer's.
  const feePayerSig = base58Encode(sent.signatures[0].signature!);
  const customerSig = base58Encode(sent.signatures[1].signature!);
  assert.equal(submitted.txSignature, feePayerSig);
  assert.notEqual(submitted.txSignature, customerSig);
  assert.equal(h.prisma.txs[0].txSignature, feePayerSig);
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  const audit = h.prisma.audits.find((a) => a.action === 'checkout.submitted')!;
  assert.equal((audit.detail as any).txSignature, feePayerSig);
  assert.equal((audit.detail as any).feeSponsored, true);
  // The customer's wallet still holds no SOL: the platform paid.
  assert.equal(h.chain.sol.get(h.customer.publicKey.toBase58()) ?? 0n, 0n);
});

test('sponsored submit is idempotent: the same customer-signed payload (whatever sits in the fee-payer slot) returns the same id and never re-broadcasts or re-signs', async () => {
  const h = sponsored();
  const { signed, submitted } = await paySponsored(h);
  const again = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  assert.equal(again.idempotent, true);
  assert.equal(again.txSignature, submitted.txSignature);
  // A retry carrying junk in the fee-payer slot is the same payment too.
  const junk = decode(signed);
  junk.signatures[0].signature = Buffer.alloc(64, 9);
  const third = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, encode(junk));
  assert.equal(third.idempotent, true);
  assert.equal(third.txSignature, submitted.txSignature);
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(h.signer.calls.length, 1);
  // A DIFFERENT transaction for the same order is still refused.
  const other = decode(signed);
  other.recentBlockhash = base58Encode(Buffer.alloc(32, 3));
  other.signatures.forEach((s) => (s.signature = null));
  other.partialSign(h.customer);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, encode(other)), 409, /different transaction/);
  assert.equal(h.chain.broadcasts.length, 1);
});

test('parallel sponsored submits: exactly one claim, one signature request, one broadcast', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)));
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(h.signer.calls.length, 1, 'losing submits never reach the signer');
  assert.equal(results.filter((r) => r.status === 'fulfilled' && !(r.value as any).idempotent).length, 1);
  for (const r of results) if (r.status === 'rejected') assert.equal((r.reason as any).getStatus?.(), 409, String(r.reason));
});

// ---------------------------------------------------------------------------------------------
// ON: customer-supplied material and tampering
// ---------------------------------------------------------------------------------------------

test('a customer-supplied fee-payer signature is ignored: junk or a valid stranger signature is cleared and replaced by the platform signature', async () => {
  for (const injected of ['junk', 'stranger'] as const) {
    const h = sponsored();
    const prepared = await prepareSponsored(h);
    const tx = decode(signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer));
    const supplied =
      injected === 'junk'
        ? Buffer.alloc(64, 5)
        : Buffer.from(await new TestFeePayerSigner(h.stranger).signMessage(tx.serializeMessage())); // a VALID ed25519 signature, wrong key
    tx.signatures[0].signature = supplied;
    const submitted = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, encode(tx));
    const sent = Transaction.from(Buffer.from(h.chain.broadcasts[0]));
    assert.equal(sent.verifySignatures(), true, injected);
    assert.equal(sent.signatures[0].publicKey.toBase58(), h.signer.publicKey);
    assert.ok(!Buffer.from(sent.signatures[0].signature!).equals(supplied), `${injected}: the supplied bytes did not reach the chain`);
    assert.equal(submitted.txSignature, base58Encode(sent.signatures[0].signature!));
    assert.notEqual(submitted.txSignature, base58Encode(supplied));
    assert.equal(h.signer.calls.length, 1);
  }
});

test('a customer who signs with the wrong key, forges the signature, or omits it is rejected: nothing is claimed, signed or broadcast', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const reject = async (encoded: string, status: number, match: RegExp) => {
    await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, encoded), status, match);
    assert.equal(h.chain.broadcasts.length, 0);
    assert.equal(h.signer.calls.length, 0, 'the platform never signs for a payment the customer has not validly authorized');
    assert.equal(h.prisma.txs[0].status, 'PREPARED');
    assert.equal(h.prisma.txs[0].txSignature, null);
  };
  // missing: fully unsigned, and a fee-payer slot set but the customer slot empty
  await reject(prepared.unsignedTransactionBase64, 400, /not signed by the customer/);
  const onlyFeePayerSlot = decode(prepared.unsignedTransactionBase64);
  onlyFeePayerSlot.signatures[0].signature = Buffer.alloc(64, 1);
  await reject(encode(onlyFeePayerSlot), 400, /not signed by the customer/);
  // forged: random bytes in the customer slot
  const forged = decode(prepared.unsignedTransactionBase64);
  forged.signatures[1].signature = Buffer.alloc(64, 7);
  await reject(encode(forged), 400, /signature is invalid/);
  // wrong key: a stranger's valid signature over the very same message, placed in the customer slot
  const wrongKey = decode(prepared.unsignedTransactionBase64);
  wrongKey.signatures[1].signature = Buffer.from(await new TestFeePayerSigner(h.stranger).signMessage(wrongKey.serializeMessage()));
  await reject(encode(wrongKey), 400, /signature is invalid/);
});

test('a tampered message is rejected before any signature is requested (amount, destination, fee payer swapped to the customer, extra instruction using the fee payer)', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const reject = async (tx: Transaction) => {
    await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, encode(tx)), 400, /does not match the prepared payment/);
    assert.equal(h.chain.broadcasts.length, 0);
    assert.equal(h.signer.calls.length, 0);
    assert.equal(h.prisma.txs[0].status, 'PREPARED');
  };
  const amount = decode(prepared.unsignedTransactionBase64);
  amount.instructions[0].data[1] ^= 1; // different USDC amount
  amount.partialSign(h.customer);
  await reject(amount);

  const swappedDestination = decode(prepared.unsignedTransactionBase64);
  swappedDestination.instructions[0].keys[2].pubkey = Keypair.generate().publicKey;
  swappedDestination.partialSign(h.customer);
  await reject(swappedDestination);

  // The customer re-builds the payment with THEMSELVES as fee payer.
  const original = decode(prepared.unsignedTransactionBase64);
  const selfPaid = new Transaction({ feePayer: h.customer.publicKey, blockhash: original.recentBlockhash!, lastValidBlockHeight: 1000 });
  selfPaid.add(...original.instructions);
  selfPaid.partialSign(h.customer);
  await reject(selfPaid);

  // An extra instruction that would use the fee payer as a token authority.
  const extra = decode(prepared.unsignedTransactionBase64);
  extra.add(
    createTransferCheckedInstruction(Keypair.generate().publicKey, new PublicKey(USDC_DEVNET_MINT), Keypair.generate().publicKey, new PublicKey(h.signer.publicKey), 1n, 6, [], TOKEN_PROGRAM_ID),
  );
  extra.partialSign(h.customer);
  await reject(extra);
});

// ---------------------------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------------------------

test('sponsor balance below FEE_SPONSOR_MIN_LAMPORTS => fallback: 402 for a zero-SOL customer, normal customer-paid success for a customer with SOL', async () => {
  const h = sponsored();
  h.chain.sol.set(h.signer.publicKey, DEFAULT_FEE_SPONSOR_MIN_LAMPORTS - 1n);
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402, /Insufficient SOL in the customer wallet/);
  assert.equal(auditCount(h), 0);

  const rich = sponsored({ customerSol: 50_000_000n });
  rich.chain.sol.set(rich.signer.publicKey, DEFAULT_FEE_SPONSOR_MIN_LAMPORTS - 1n);
  const prepared = await rich.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.feeSponsored, false);
  assert.equal(prepared.feePayer, rich.customer.publicKey.toBase58());
  const submitted = await rich.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, rich.customer));
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(rich.signer.calls.length, 0);

  // Exactly at the floor: sponsored.
  const atFloor = sponsored();
  atFloor.chain.sol.set(atFloor.signer.publicKey, DEFAULT_FEE_SPONSOR_MIN_LAMPORTS);
  assert.equal((await atFloor.checkout.prepare(CUSTOMER_ID, ORDER_ID)).feeSponsored, true);
});

test('a configured FEE_SPONSOR_MIN_LAMPORTS is honoured, and the floor never drops below what two signatures cost', async () => {
  const h = sponsored({ sponsorship: { minSponsorLamports: 2_000_000n } });
  h.chain.sol.set(h.signer.publicKey, 1_999_999n);
  await rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402);
  h.chain.sol.set(h.signer.publicKey, 2_000_000n);
  assert.equal((await h.checkout.prepare(CUSTOMER_ID, ORDER_ID)).feeSponsored, true);
  const tiny = sponsored({ sponsorship: { minSponsorLamports: 1n } });
  tiny.chain.sol.set(tiny.signer.publicKey, 9_999n); // cannot pay 2 x 5000
  await rejects(tiny.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402);
});

test('per-customer daily cap counts CHECKOUT_FEE_SPONSORED events from the last 24h only; at the cap => fallback', async () => {
  const seed = (h: Harness, count: number, ageMs = 60_000, customerId = CUSTOMER_ID) =>
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        (h.prisma as any).walletAuditEvent.create({
          data: { customerId, action: FEE_SPONSORED_AUDIT_ACTION, detail: { reference: `seed-${customerId}-${ageMs}-${i}` }, createdAt: new Date(Date.now() - ageMs) },
        }),
      ),
    );
  const cap2 = () => sponsored({ sponsorship: { maxPerCustomerDay: 2 } });

  const under = cap2();
  await seed(under, 1);
  assert.equal((await under.checkout.prepare(CUSTOMER_ID, ORDER_ID)).feeSponsored, true, '1 of 2 used: sponsored');

  const atCap = cap2();
  await seed(atCap, 2);
  await rejects(atCap.checkout.prepare(CUSTOMER_ID, ORDER_ID), 402, /Insufficient SOL in the customer wallet/);
  assert.equal(auditCount(atCap), 2, 'a fallback adds no sponsored event');

  const old = cap2();
  await seed(old, 5, 25 * 60 * 60_000);
  assert.equal((await old.checkout.prepare(CUSTOMER_ID, ORDER_ID)).feeSponsored, true, 'events older than 24h do not count');

  const other = cap2();
  await seed(other, 5, 60_000, 'cust_2');
  assert.equal((await other.checkout.prepare(CUSTOMER_ID, ORDER_ID)).feeSponsored, true, "another customer's events do not count");

  // With a customer who has SOL the fallback is a normal customer-paid success.
  const rich = makeHarness({ sponsorship: { maxPerCustomerDay: 1 }, customerSol: 50_000_000n });
  await seed(rich, 1);
  const fallback = await rich.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(fallback.feeSponsored, false);
  assert.equal(fallback.feePayer, rich.customer.publicKey.toBase58());
});

test('the cap counts payments, not prepares: re-preparing the same order never uses up the cap; a second order does', async () => {
  const h = sponsored({ sponsorship: { maxPerCustomerDay: 1 } });
  await prepareSponsored(h);
  await prepareSponsored(h);
  assert.equal((await h.checkout.prepare(CUSTOMER_ID, ORDER_ID)).feeSponsored, true);
  assert.equal(auditCount(h), 1);
  await (h.prisma as any).order.create({
    data: { id: 'order-test-0002', customerId: CUSTOMER_ID, status: 'PENDING_PAYMENT', totalCents: 1_000, currency: 'USD', researchAcknowledgedAt: new Date() },
  });
  await rejects(h.checkout.prepare(CUSTOMER_ID, 'order-test-0002'), 402, /Insufficient SOL in the customer wallet/);
});

test('signer NOT bound => sponsorship unavailable at prepare (fallback), and a sponsored submit fails closed with 503 and broadcasts nothing', async () => {
  const h = sponsored();
  const noSigner = h.makeCheckout({ signer: null });
  await rejects(noSigner.prepare(CUSTOMER_ID, ORDER_ID), 402, /Insufficient SOL in the customer wallet/);

  // Prepared WITH a signer, submitted to a process that has none (or a rotated key).
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  await rejects(noSigner.submit(CUSTOMER_ID, ORDER_ID, signed), 503, /sponsorship is unavailable/i);
  const rotated = new TestFeePayerSigner();
  await rejects(h.makeCheckout({ signer: rotated }).submit(CUSTOMER_ID, ORDER_ID, signed), 503);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(rotated.calls.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED', 'nothing was claimed, so the customer can retry once the signer is back');
  // ... and it works once the right signer is bound again.
  assert.equal((await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)).status, 'SUBMITTED');
});

test('sponsor key equal to the customer wallet or the merchant treasury => sponsorship refused (customer-paid), the signer is never asked', async () => {
  const asCustomer = sponsored();
  const customerSigner = new TestFeePayerSigner(asCustomer.customer);
  await rejects(asCustomer.makeCheckout({ signer: customerSigner }).prepare(CUSTOMER_ID, ORDER_ID), 402);
  assert.equal(customerSigner.calls.length, 0);
  assert.equal(auditCount(asCustomer), 0);

  const asMerchant = sponsored({ customerSol: 50_000_000n });
  const merchantSigner = new TestFeePayerSigner(asMerchant.merchant);
  asMerchant.chain.sol.set(merchantSigner.publicKey, SPONSOR_SOL);
  const prepared = await asMerchant.makeCheckout({ signer: merchantSigner }).prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.feeSponsored, false);
  assert.equal(prepared.feePayer, asMerchant.customer.publicKey.toBase58());
  assert.equal(merchantSigner.calls.length, 0);
  assert.equal(auditCount(asMerchant), 0);
});

test('the compiled-message invariant refuses (internal error) a sponsor that is a token authority, not the first signer, or equals the merchant', async () => {
  const h = sponsored();
  const service = h.checkout as unknown as { assertFeePayerLayout(stored: unknown, feePayer: string, sponsored: boolean): void };
  const sponsor = new PublicKey(h.signer.publicKey);
  const customer = h.customer.publicKey;
  const merchant = h.merchant.publicKey;
  const build = (feePayer: PublicKey, authority: PublicKey) => {
    const tx = new Transaction({ feePayer, blockhash: base58Encode(Buffer.alloc(32, 1)), lastValidBlockHeight: 1 });
    tx.add(createTransferCheckedInstruction(Keypair.generate().publicKey, new PublicKey(USDC_DEVNET_MINT), Keypair.generate().publicKey, authority, 1n, 6));
    return { messageBytes: new Uint8Array(tx.compileMessage().serialize()), payer: customer.toBase58(), merchant: merchant.toBase58() };
  };
  const internal = (e: any) => e.getStatus?.() === 500;
  // Sound layout passes.
  assert.doesNotThrow(() => service.assertFeePayerLayout(build(sponsor, customer), sponsor.toBase58(), true));
  // The sponsor is ALSO the token authority (its signature would authorize the transfer): refused.
  await assert.rejects(async () => service.assertFeePayerLayout(build(sponsor, sponsor), sponsor.toBase58(), true), internal);
  // The customer is the fee payer but a different key is declared as sponsor: layout mismatch.
  await assert.rejects(async () => service.assertFeePayerLayout(build(customer, customer), sponsor.toBase58(), true), internal);
  // Sponsor equals the merchant.
  await assert.rejects(async () => service.assertFeePayerLayout(build(merchant, customer), merchant.toBase58(), true), internal);
  // Not sponsored: a no-op by design.
  assert.doesNotThrow(() => service.assertFeePayerLayout(build(sponsor, sponsor), sponsor.toBase58(), false));
  // The pure helper agrees.
  assert.throws(() => assertSponsorOnlyPaysFee(Message.from(build(sponsor, sponsor).messageBytes), sponsor.toBase58()), /appears in an instruction/);
  assert.throws(() => assertSponsorOnlyPaysFee(Message.from(build(customer, customer).messageBytes), sponsor.toBase58()), /not the message fee payer/);
  assert.doesNotThrow(() => assertSponsorOnlyPaysFee(Message.from(build(sponsor, customer).messageBytes), sponsor.toBase58()));
});

// ---------------------------------------------------------------------------------------------
// Failures after the claim
// ---------------------------------------------------------------------------------------------

test('signer throws => 503, claim released (row back to PREPARED, no id), nothing broadcast; a retry then works', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  h.signer.failWith = new Error('KMS unavailable');
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 503, /nothing was sent/);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
  assert.equal(h.prisma.txs[0].txSignature, null);
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  assert.equal(h.signer.calls.length, 1);

  h.signer.failWith = null;
  const retried = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  assert.equal(retried.status, 'SUBMITTED');
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(h.prisma.txs[0].txSignature, retried.txSignature);
});

test('a signer that returns a bad signature (wrong length, over other bytes, by another key, all zeros) never reaches the chain', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  const message = Uint8Array.from((await h.store.get(prepared.paymentReference))!.messageBytes);
  const overOtherBytes = await h.signer.signMessage(new Uint8Array([1, 2, 3]));
  const overOtherKey = await new TestFeePayerSigner().signMessage(message);
  for (const bad of [new Uint8Array(63), overOtherBytes, overOtherKey, new Uint8Array(64)]) {
    h.signer.returnInstead = bad;
    await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 503);
    assert.equal(h.chain.broadcasts.length, 0, 'a broken signer can only make submit fail');
    assert.equal(h.prisma.txs[0].status, 'PREPARED');
    assert.equal(h.prisma.txs[0].txSignature, null);
  }
  h.signer.returnInstead = null;
  assert.equal((await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)).status, 'SUBMITTED');
});

test('sponsor drained between prepare and submit => 503 before signing, claim released, nothing broadcast', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  h.chain.sol.set(h.signer.publicKey, 0n);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 503);
  assert.equal(h.signer.calls.length, 0);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
  assert.equal(h.prisma.txs[0].txSignature, null);
  h.chain.sol.set(h.signer.publicKey, SPONSOR_SOL);
  assert.equal((await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)).status, 'SUBMITTED');
});

test('RPC outage while re-checking the sponsor balance after the claim => 503 and the claim is released', async () => {
  const h = sponsored();
  const prepared = await prepareSponsored(h);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, h.customer);
  const original = h.chain.getSolBalanceLamports.bind(h.chain);
  h.chain.getSolBalanceLamports = async () => {
    throw new ChainUnavailableError('rpc down');
  };
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 503);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.signer.calls.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
  h.chain.getSolBalanceLamports = original;
  assert.equal((await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)).status, 'SUBMITTED');
});

test('broadcast rejected after signing => claim released (id cleared); unknown outcome => stays SUBMITTED with the fee-payer id and an idempotent retry', async () => {
  const rejected = sponsored();
  const prepared = await prepareSponsored(rejected);
  const signed = signAsCustomerOnly(prepared.unsignedTransactionBase64, rejected.customer);
  rejected.chain.broadcastError = new ChainRejectedError('blockhash expired');
  await rejects(rejected.checkout.submit(CUSTOMER_ID, ORDER_ID, signed), 502, /rejected the transaction/);
  assert.equal(rejected.prisma.txs[0].status, 'PREPARED');
  assert.equal(rejected.prisma.txs[0].txSignature, null);
  rejected.chain.broadcastError = null;
  assert.equal((await rejected.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)).status, 'SUBMITTED');

  const unknown = sponsored();
  const p2 = await prepareSponsored(unknown);
  const signed2 = signAsCustomerOnly(p2.unsignedTransactionBase64, unknown.customer);
  unknown.chain.broadcastError = new ChainUnavailableError('timeout');
  await rejects(unknown.checkout.submit(CUSTOMER_ID, ORDER_ID, signed2), 503);
  assert.equal(unknown.prisma.txs[0].status, 'SUBMITTED', 'the cluster may have accepted it: keep the hold');
  const id = unknown.prisma.txs[0].txSignature as string;
  assert.ok(id, 'the fee-payer signature was persisted BEFORE the broadcast attempt');
  unknown.chain.broadcastError = null;
  const retry = await unknown.checkout.submit(CUSTOMER_ID, ORDER_ID, signed2);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.txSignature, id);
  assert.equal(unknown.chain.broadcasts.length, 0, 'never re-broadcast on an idempotent retry');
  assert.equal(unknown.signer.calls.length, 1);
});

test('submit never trusts the request for the sponsorship decision: a customer-paid prepared payment stays customer-paid even if the request names the platform as fee payer', async () => {
  const h = makeHarness({ sponsorship: true }); // customer HAS SOL, sponsor below the floor => prepared customer-paid
  h.chain.sol.set(h.signer.publicKey, 0n);
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.feeSponsored, false);
  h.chain.sol.set(h.signer.publicKey, SPONSOR_SOL);
  const original = decode(prepared.unsignedTransactionBase64);
  const tx = new Transaction({ feePayer: new PublicKey(h.signer.publicKey), blockhash: original.recentBlockhash!, lastValidBlockHeight: 1000 });
  tx.add(...original.instructions);
  tx.partialSign(h.customer);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, encode(tx)), 400, /does not match the prepared payment/);
  assert.equal(h.signer.calls.length, 0);
  assert.equal(h.chain.broadcasts.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Verification and reconciliation: bound to the CUSTOMER, id = fee payer signature
// ---------------------------------------------------------------------------------------------

test('verification settles a sponsored payment by the FEE PAYER signature, with transfer authority bound to the customer', async () => {
  const h = sponsored();
  const { prepared, submitted } = await paySponsored(h);
  const sent = Transaction.from(Buffer.from(h.chain.broadcasts[0]));
  const customerSig = base58Encode(sent.signatures[1].signature!);
  // The customer's own signature is NOT the transaction id: nothing recorded is known by it.
  h.chain.transfers.set(customerSig, transferFor(h, prepared, customerSig));
  assert.equal((await h.verification.verifyAndSettle({ signature: customerSig })).outcome, 'UNKNOWN');
  assert.equal((await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference })).outcome, 'PENDING', 'nothing under the fee-payer id yet');

  h.chain.transfers.set(submitted.txSignature, transferFor(h, prepared, submitted.txSignature));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FINALIZED');
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.equal(h.prisma.txs[0].sourceAddress, h.customer.publicKey.toBase58());
});

test('verification refuses a transfer whose authority/source owner is the fee payer or any non-customer', async () => {
  for (const [label, owner] of [
    ['the fee payer', (h: Harness) => h.signer.publicKey],
    ['a stranger', (h: Harness) => h.stranger.publicKey.toBase58()],
    ['the merchant', (h: Harness) => h.merchant.publicKey.toBase58()],
  ] as const) {
    const h = sponsored();
    const { prepared, submitted } = await paySponsored(h);
    h.chain.transfers.set(submitted.txSignature, transferFor(h, prepared, submitted.txSignature, { sourceOwner: owner(h) }));
    const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.equal(result.outcome, 'FAILED', label);
    assert.match(result.reason ?? '', /wrong source owner/, label);
    assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT', `${label}: order must not be paid`);
    assert.equal(h.fulfillmentCalls.length, 0);
  }
  // A transfer observed under a different signature than the recorded id is a mismatch.
  const h = sponsored();
  const { prepared, submitted } = await paySponsored(h);
  h.chain.transfers.set(submitted.txSignature, transferFor(h, prepared, base58Encode(Buffer.alloc(64, 4))));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.reason ?? '', /signature mismatch/);
});

test('reconcile releases a sponsored claim that never got an id (crash between claim and broadcast) only after the reservation TTL; a younger one is left alone', async () => {
  const h = sponsored();
  await prepareSponsored(h);
  const row = h.prisma.txs[0];
  row.status = 'SUBMITTED'; // the state a crash after the claim, before the id was persisted, leaves behind
  row.txSignature = null;
  row.createdAt = new Date(Date.now() - 5 * 60_000);
  let summary = await h.recon.reconcile(new Date());
  assert.equal(summary.expired, 0, 'younger than the reservation TTL: left alone (a live submit may still be signing)');
  assert.equal(row.status, 'SUBMITTED');
  // While claimed without an id the funds stay held (fail closed): spendable counts the pending purchase.
  assert.equal((await h.spendable()).spendableAtomic, 1_000_000_000n - 250_000_000n);
  row.createdAt = new Date(Date.now() - 20 * 60_000);
  summary = await h.recon.reconcile(new Date());
  assert.equal(summary.expired, 1);
  assert.equal(row.status, 'EXPIRED');
  assert.match(row.failureReason, /never broadcast/);
  assert.equal(h.prisma.reservations[0].status, 'EXPIRED');
  assert.equal(h.chain.broadcasts.length, 0);
});

test('reconcile leaves a sponsored payment that HAS an id and is not found yet alone before the TTL (unchanged behaviour)', async () => {
  const h = sponsored();
  await paySponsored(h);
  h.prisma.txs[0].createdAt = new Date(Date.now() - 5 * 60_000);
  const summary = await h.recon.reconcile(new Date());
  assert.equal(summary.expired, 0);
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
});

// ---------------------------------------------------------------------------------------------
// Config and startup
// ---------------------------------------------------------------------------------------------

test('config: defaults are off / 0.05 SOL / 20; only the exact string "true" enables; malformed values stop startup', () => {
  assert.deepEqual(loadFeeSponsorshipConfig({}), { enabled: false, minSponsorLamports: 50_000_000n, maxPerCustomerDay: 20 });
  assert.equal(DEFAULT_FEE_SPONSOR_MAX_PER_CUSTOMER_DAY, 20);
  assert.equal(loadFeeSponsorshipConfig({ FEE_SPONSORSHIP: 'true' }).enabled, true);
  for (const off of ['', ' ', 'false']) assert.equal(loadFeeSponsorshipConfig({ FEE_SPONSORSHIP: off }).enabled, false, JSON.stringify(off));
  for (const bad of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'enabled']) {
    assert.throws(() => loadFeeSponsorshipConfig({ FEE_SPONSORSHIP: bad }), /FEE_SPONSORSHIP must be exactly/, JSON.stringify(bad));
  }
  const ok = loadFeeSponsorshipConfig({ FEE_SPONSORSHIP: 'true', FEE_SPONSOR_MIN_LAMPORTS: '123456', FEE_SPONSOR_MAX_PER_CUSTOMER_DAY: '3' });
  assert.deepEqual(ok, { enabled: true, minSponsorLamports: 123_456n, maxPerCustomerDay: 3 });
  for (const bad of ['0', '-1', '1.5', '1e9', '0x10', 'abc', '99999999999999999999', '01']) {
    assert.throws(() => loadFeeSponsorshipConfig({ FEE_SPONSOR_MIN_LAMPORTS: bad }), /FEE_SPONSOR_MIN_LAMPORTS/, `min ${bad}`);
  }
  for (const bad of ['0', '-1', '2.5', 'many', '10001', '100000', '07']) {
    assert.throws(() => loadFeeSponsorshipConfig({ FEE_SPONSOR_MAX_PER_CUSTOMER_DAY: bad }), /FEE_SPONSOR_MAX_PER_CUSTOMER_DAY/, `cap ${bad}`);
  }
  // Startup path: CHECKOUT_CONFIG is built by loadCheckoutConfig, so a bad value stops the API from booting.
  assert.equal(loadCheckoutConfig({ SOLANA_USDC_TREASURY: 'x' }).feeSponsorship?.enabled, false);
  assert.throws(() => loadCheckoutConfig({ SOLANA_USDC_TREASURY: 'x', FEE_SPONSORSHIP: 'yes' }), /FEE_SPONSORSHIP/);
});

test('startup: FEE_SPONSORSHIP=true with no signer bound WARNS loudly (does not crash); with a signer, or when off, it does not warn', () => {
  const build = (sponsorship: boolean, withSigner: boolean) => {
    const h = makeHarness({ sponsorship: sponsorship ? true : undefined });
    const warn = mock.method(Logger.prototype, 'warn', () => undefined);
    const log = mock.method(Logger.prototype, 'log', () => undefined);
    try {
      new CheckoutService(h.prisma as any, h.chain, {} as any, {} as any, h.flags, h.store, h.config, undefined, withSigner ? h.signer : undefined);
      return { warnings: warn.mock.calls.map((c) => String(c.arguments[0])), logs: log.mock.calls.map((c) => String(c.arguments[0])) };
    } finally {
      warn.mock.restore();
      log.mock.restore();
    }
  };
  const missing = build(true, false);
  assert.ok(missing.warnings.some((w) => /FEE_SPONSORSHIP=true but NO FEE_PAYER_SIGNER is bound/.test(w)), JSON.stringify(missing));
  assert.ok(missing.warnings.some((w) => /customers without SOL cannot check out/.test(w)));
  const bound = build(true, true);
  assert.ok(!bound.warnings.some((w) => /NO FEE_PAYER_SIGNER/.test(w)));
  assert.ok(bound.logs.some((l) => /sponsorship is ON/.test(l)));
  const off = build(false, false);
  assert.ok(!off.warnings.some((w) => /FEE_PAYER_SIGNER/.test(w)));
});

test('FeePayerSignerError is a plain Error subtype (mapped to 503 inside the service)', () => {
  const error = new FeePayerSignerError('x', { cause: new Error('hsm') });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'FeePayerSignerError');
});

test('defence in depth: asked to sign bytes whose fee payer is also an instruction account, the service refuses before the signer is called and releases the claim', async () => {
  const h = sponsored();
  await prepareSponsored(h);
  const row = h.prisma.txs[0];
  row.status = 'SUBMITTED'; // as if the claim had just been taken
  const sponsor = new PublicKey(h.signer.publicKey);
  const evil = new Transaction({ feePayer: sponsor, blockhash: base58Encode(Buffer.alloc(32, 1)), lastValidBlockHeight: 1 });
  evil.add(createTransferCheckedInstruction(Keypair.generate().publicKey, new PublicKey(USDC_DEVNET_MINT), Keypair.generate().publicKey, sponsor, 1n, 6));
  const service = h.checkout as unknown as { signAsFeePayer(input: unknown): Promise<string> };
  await rejects(
    service.signAsFeePayer({ tx: evil, row, signer: h.signer, sponsor: h.signer.publicKey, message: evil.serializeMessage(), fee: 10_000n }),
    503,
    /nothing was sent/,
  );
  assert.equal(h.signer.calls.length, 0);
  assert.equal(row.status, 'PREPARED', 'claim released');
  assert.equal(h.chain.broadcasts.length, 0);
});
