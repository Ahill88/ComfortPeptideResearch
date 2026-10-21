/** The exact on-chain shape: memo bytes, compiled message, the signer-port guard, and the strict body check behind CONFIRMED. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import { buildCoaMemo } from '../../apps/api/src/coa/coa.types';
import { toBody } from '../../apps/api/src/coa/anchor/coa-anchor-chain';
import { assertMemoOnlyMessage, buildMemoTransaction, checkAnchorBody, type ChainAnchorBody } from '../../apps/api/src/coa/anchor/coa-anchor-message';
import { CoaPublisherSignerError, requestCoaPublisherSignature } from '../../apps/api/src/coa/anchor/coa-publisher-signer.port';
import { InMemoryPublisherSigner, MEMO_PROGRAM_ID, SHA_A } from './_anchor-helpers';

const publisher = Keypair.generate();
const memo = buildCoaMemo('PUBLISH', 'LOT-001', 1, SHA_A);
const BLOCKHASH = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const memoIx = (keys: TransactionInstruction['keys'], text = memo) => new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys, data: Buffer.from(text, 'utf8') });
const signerKey = { pubkey: publisher.publicKey, isSigner: true, isWritable: false };

test('memo bytes are exactly helix-coa:v1:<kind>:<lot>:<version>:<sha256> in UTF-8', () => {
  assert.equal(memo, `helix-coa:v1:publish:LOT-001:1:${'a'.repeat(64)}`);
  assert.equal(buildCoaMemo('REVOKE', 'A.b_c-9', 12, SHA_A), `helix-coa:v1:revoke:A.b_c-9:12:${SHA_A}`);
  const tx = buildMemoTransaction(publisher.publicKey, memo, BLOCKHASH);
  assert.equal(tx.instructions.length, 1);
  assert.ok(Buffer.from(tx.instructions[0].data).equals(Buffer.from(memo, 'utf8')));
  assert.equal(Buffer.from(tx.instructions[0].data).toString('hex'), Buffer.from(`helix-coa:v1:publish:LOT-001:1:${'a'.repeat(64)}`).toString('hex'));
});

test('transaction shape: legacy, one Memo-v2 instruction, publisher is fee payer and the only (writable) signer, no other account', () => {
  const tx = buildMemoTransaction(publisher.publicKey, memo, BLOCKHASH);
  const message = tx.compileMessage();
  assert.deepEqual(message.accountKeys.map((k) => k.toBase58()), [publisher.publicKey.toBase58(), MEMO_PROGRAM_ID]);
  assert.deepEqual(message.header, { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 });
  assert.equal(message.instructions.length, 1);
  assert.equal(message.instructions[0].programIdIndex, 1);
  assert.deepEqual(message.instructions[0].accounts, [0]);
  assert.equal(new PublicKey(MEMO_PROGRAM_ID).toBase58(), 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  assertMemoOnlyMessage(tx.serializeMessage(), publisher.publicKey.toBase58(), memo); // does not throw
});

test('assertMemoOnlyMessage refuses anything but the anchor message (a signature over it could authorize more than a memo)', () => {
  const pub = publisher.publicKey.toBase58();
  const build = (instructions: TransactionInstruction[], feePayer = publisher.publicKey) => {
    const tx = new Transaction({ feePayer, recentBlockhash: BLOCKHASH });
    tx.add(...instructions);
    return tx.serializeMessage();
  };
  const other = Keypair.generate().publicKey;
  const transfer = SystemProgram.transfer({ fromPubkey: publisher.publicKey, toPubkey: other, lamports: 1_000_000 });
  assert.throws(() => assertMemoOnlyMessage(build([transfer]), pub, memo), /invariant/);
  assert.throws(() => assertMemoOnlyMessage(build([memoIx([signerKey]), transfer]), pub, memo), /invariant/);
  assert.throws(() => assertMemoOnlyMessage(build([memoIx([signerKey]), memoIx([signerKey])]), pub, memo), /invariant/);
  assert.throws(() => assertMemoOnlyMessage(build([memoIx([signerKey, { pubkey: other, isSigner: false, isWritable: true }])]), pub, memo), /invariant/);
  assert.throws(() => assertMemoOnlyMessage(build([memoIx([signerKey], memo + 'x')]), pub, memo), /invariant/);
  assert.throws(() => assertMemoOnlyMessage(build([memoIx([signerKey])], other), pub, memo), /invariant/); // fee payer is someone else
  assert.throws(() => assertMemoOnlyMessage(build([new TransactionInstruction({ programId: SystemProgram.programId, keys: [signerKey], data: Buffer.from(memo) })]), pub, memo), /invariant/);
  assertMemoOnlyMessage(build([memoIx([signerKey])]), pub, memo);
  assert.throws(() => assertMemoOnlyMessage(build([memoIx([])]), pub, memo), /invariant/); // the Memo-v2 signer attribution is part of the shape
});

test('the signer port helper is the validating call site: 64-byte Uint8Array or CoaPublisherSignerError', async () => {
  const signer = new InMemoryPublisherSigner();
  const message = buildMemoTransaction(signer.keypair.publicKey, memo, BLOCKHASH).serializeMessage();
  assert.equal((await requestCoaPublisherSignature(signer, message)).byteLength, 64);
  signer.mode = 'throw';
  await assert.rejects(requestCoaPublisherSignature(signer, message), CoaPublisherSignerError);
  signer.mode = 'short';
  await assert.rejects(requestCoaPublisherSignature(signer, message), /64-byte/);
  const notBytes = { publicKey: signer.publicKey, signMessage: async () => 'sig' as unknown as Uint8Array };
  await assert.rejects(requestCoaPublisherSignature(notBytes, message), /64-byte/);
});

/* -------- checkAnchorBody: the body of a finalized transaction must be EXACTLY the anchor shape -------- */

const pub = publisher.publicKey.toBase58();
const goodBody = (): ChainAnchorBody => ({
  version: 'legacy',
  accountKeys: [pub, MEMO_PROGRAM_ID],
  numRequiredSignatures: 1,
  instructions: [{ programId: MEMO_PROGRAM_ID, accounts: [pub], data: Buffer.from(memo, 'utf8') }],
  innerInstructionCount: 0,
});

test('checkAnchorBody accepts the exact tx and rejects each deviation', () => {
  assert.equal(checkAnchorBody(goodBody(), memo, pub), null);
  const reject = (mutate: (body: ChainAnchorBody) => void, pattern: RegExp, expected = memo, signer = pub) => {
    const body = goodBody();
    mutate(body);
    assert.match(checkAnchorBody(body, expected, signer) ?? 'ACCEPTED', pattern);
  };
  reject(() => undefined, /memo does not equal/, buildCoaMemo('PUBLISH', 'LOT-002', 1, SHA_A)); // memo for another lot
  reject(() => undefined, /memo does not equal/, buildCoaMemo('PUBLISH', 'LOT-001', 2, SHA_A)); // another version
  reject(() => undefined, /memo does not equal/, buildCoaMemo('PUBLISH', 'LOT-001', 1, 'b'.repeat(64))); // another hash
  reject(() => undefined, /memo does not equal/, buildCoaMemo('REVOKE', 'LOT-001', 1, SHA_A)); // another kind
  reject((b) => { b.instructions[0].data = Buffer.from(memo + ' ', 'utf8'); }, /memo does not equal/); // trailing byte
  reject((b) => { b.instructions[0].data = Buffer.from(memo.toUpperCase(), 'utf8'); }, /memo does not equal/);
  reject((b) => { b.instructions.push({ programId: '11111111111111111111111111111111', accounts: [pub], data: new Uint8Array(12) }); }, /exactly one instruction/); // extra instruction
  reject((b) => { b.instructions.push({ ...b.instructions[0] }); }, /exactly one instruction/); // two memo instructions
  reject((b) => { b.instructions[0].programId = '11111111111111111111111111111111'; }, /exactly one instruction/); // not the memo program
  reject(() => undefined, /fee payer/, memo, Keypair.generate().publicKey.toBase58()); // wrong signer
  reject((b) => { b.accountKeys[0] = Keypair.generate().publicKey.toBase58(); }, /fee payer/);
  reject((b) => { b.numRequiredSignatures = 2; }, /more than one signer/);
  reject((b) => { b.version = 0; }, /legacy/);
  reject((b) => { b.innerInstructionCount = 1; }, /inner/);
  reject((b) => { b.accountKeys.push(Keypair.generate().publicKey.toBase58()); }, /other than the publisher/);
  reject((b) => { b.instructions[0].accounts = []; }, /signed by the publisher/);
  reject((b) => { b.instructions[0].accounts = [Keypair.generate().publicKey.toBase58()]; }, /signed by the publisher/);
});

test('toBody reads a real legacy Message (raw indexes and data bytes, no parsed-instruction format)', () => {
  const tx = buildMemoTransaction(publisher.publicKey, memo, BLOCKHASH);
  const response = { slot: 5, blockTime: 1, version: 'legacy', transaction: { message: tx.compileMessage(), signatures: [] }, meta: { err: null, innerInstructions: [] } } as unknown as VersionedTransactionResponse;
  const body = toBody(response);
  assert.equal(body.version, 'legacy');
  assert.deepEqual(body.accountKeys, [pub, MEMO_PROGRAM_ID]);
  assert.equal(body.numRequiredSignatures, 1);
  assert.equal(body.instructions.length, 1);
  assert.deepEqual(body.instructions[0].accounts, [pub]);
  assert.equal(body.instructions[0].programId, MEMO_PROGRAM_ID);
  assert.equal(Buffer.from(body.instructions[0].data).toString('utf8'), memo);
  assert.equal(checkAnchorBody(body, memo, pub), null);
});
