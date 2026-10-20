import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ChainUnavailableError, USDC_DEVNET_MINT } from '../../contracts';
import { base58Encode } from '../base58';
import { AmbiguousTransferError, DevnetSolanaChain } from '../devnet-solana-chain';

/**
 * getTransfer() parsing against a FAKE Connection that returns jsonParsed-shaped transactions.
 * The parsed shape mirrors the RPC's spl-token parser (anza-xyz/agave transaction-status/src/parse_token.rs):
 * a transferChecked with extra accounts after the authority is reported as `multisigAuthority` + `signers`
 * (the extra accounts), which is where a Solana Pay reference appears.
 * NOT run against a live cluster.
 */
const FLAGS = { enableSolanaMainnet: false } as never;
const SIGNATURE = base58Encode(new Uint8Array(64).fill(7));
const MINT = USDC_DEVNET_MINT;
const key = () => Keypair.generate().publicKey;

interface Fixture {
  owner: PublicKey;
  merchant: PublicKey;
  sourceAta: PublicKey;
  destAta: PublicKey;
  reference: PublicKey;
}
const fixture = (): Fixture => ({ owner: key(), merchant: key(), sourceAta: key(), destAta: key(), reference: key() });

type Info = Record<string, unknown>;
const transferIx = (info: Info, type: 'transferChecked' | 'transfer' = 'transferChecked', programId: PublicKey = TOKEN_PROGRAM_ID) => ({
  program: 'spl-token',
  programId,
  parsed: { type, info },
});

/** What the RPC parser emits for [source, mint, dest, authority, ...extra]. */
function checkedInfo(f: Fixture, extra: { reference?: PublicKey; amount?: string; authority?: PublicKey; destination?: PublicKey; source?: PublicKey } = {}): Info {
  const base: Info = {
    source: (extra.source ?? f.sourceAta).toBase58(),
    mint: MINT,
    destination: (extra.destination ?? f.destAta).toBase58(),
    tokenAmount: { amount: extra.amount ?? '250000000', decimals: 6, uiAmount: 250, uiAmountString: '250' },
  };
  const authority = (extra.authority ?? f.owner).toBase58();
  if (extra.reference) return { ...base, multisigAuthority: authority, signers: [extra.reference.toBase58()] };
  return { ...base, authority };
}

interface Built {
  instructions?: unknown[];
  inner?: unknown[];
  extraKeys?: Array<{ pubkey: PublicKey; signer?: boolean; writable?: boolean }>;
  balances?: Array<{ key: PublicKey; owner: string; mint?: string }>;
}

function parsedTx(f: Fixture, built: Built) {
  const accountKeys = [
    { pubkey: f.owner, signer: true, writable: true },
    { pubkey: f.sourceAta, signer: false, writable: true },
    { pubkey: f.destAta, signer: false, writable: true },
    { pubkey: new PublicKey(MINT), signer: false, writable: false },
    { pubkey: f.reference, signer: false, writable: false },
    ...(built.extraKeys ?? []).map((k) => ({ pubkey: k.pubkey, signer: k.signer ?? false, writable: k.writable ?? false })),
  ];
  const indexOf = (k: PublicKey) => accountKeys.findIndex((a) => a.pubkey.equals(k));
  const balances = built.balances ?? [
    { key: f.sourceAta, owner: f.owner.toBase58() },
    { key: f.destAta, owner: f.merchant.toBase58() },
  ];
  const tokenBalances = balances.map((b) => ({
    accountIndex: indexOf(b.key),
    mint: b.mint ?? MINT,
    owner: b.owner,
    uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
  }));
  return {
    slot: 1,
    blockTime: 1,
    version: 'legacy',
    transaction: { signatures: [SIGNATURE], message: { accountKeys, instructions: built.instructions ?? [], recentBlockhash: 'x' } },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: built.inner ? [{ index: 0, instructions: built.inner }] : [],
      preTokenBalances: tokenBalances,
      postTokenBalances: tokenBalances,
    },
  };
}

function chainFor(tx: unknown, status: Record<string, unknown> | null = { confirmationStatus: 'finalized', err: null }) {
  const connection: any = {
    getSignatureStatuses: async () => ({ value: [status] }),
    getParsedTransaction: async () => tx,
  };
  return new DevnetSolanaChain(FLAGS, { connection });
}

const ambiguous = (promise: Promise<unknown>, detail?: RegExp) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AmbiguousTransferError, `expected AmbiguousTransferError, got ${String(error)}`);
    assert.equal(error.ambiguousTransfer, true);
    if (detail) assert.match(error.detail, detail);
    return true;
  });

test('a single classic transferChecked with a trailing reference parses: owners, mint, amount and the reference come from that instruction', async () => {
  const f = fixture();
  const chain = chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f, { reference: f.reference }))] }));
  const transfer = await chain.getTransfer(SIGNATURE);
  assert.ok(transfer);
  assert.equal(transfer.finalized, true);
  assert.equal(transfer.succeeded, true);
  assert.equal(transfer.mint, MINT);
  assert.equal(transfer.sourceOwner, f.owner.toBase58());
  assert.equal(transfer.destinationOwner, f.merchant.toBase58());
  assert.equal(transfer.amountAtomic, 250_000_000n);
  assert.deepEqual(transfer.referenceKeys, [f.reference.toBase58()]);
});

test('not found is null; "landed but unparseable" is a distinct typed error that fails closed for unaware callers', async () => {
  const f = fixture();
  assert.equal(await chainFor(null, null).getTransfer(SIGNATURE), null, 'no status => not found');
  // Landed (has a status) but the RPC returns no body.
  await ambiguous(chainFor(null).getTransfer(SIGNATURE), /body is not available/);
  // Landed but nothing that looks like a token transfer.
  await ambiguous(chainFor(parsedTx(f, { instructions: [] })).getTransfer(SIGNATURE), /no spl-token transfer/);
  const error = new AmbiguousTransferError(SIGNATURE, 'x');
  assert.ok(error instanceof ChainUnavailableError, 'an unaware caller treats it like an outage (503, state untouched), never as success or absence');
  assert.equal(error.ambiguousTransfer, true);
});

test('decoy transfer followed by the real payment (top-level) is ambiguous, not a match on either', async () => {
  const f = fixture();
  const decoyDestination = key();
  const attacker = key();
  const chain = chainFor(
    parsedTx(f, {
      extraKeys: [{ pubkey: decoyDestination, writable: true }],
      instructions: [
        transferIx(checkedInfo(f, { amount: '1', destination: decoyDestination })),
        transferIx(checkedInfo(f, { reference: f.reference })),
      ],
      balances: [
        { key: f.sourceAta, owner: f.owner.toBase58() },
        { key: f.destAta, owner: f.merchant.toBase58() },
        { key: decoyDestination, owner: attacker.toBase58() },
      ],
    }),
  );
  await ambiguous(chain.getTransfer(SIGNATURE), /2 spl-token transfers/);
});

test('the real payment plus a second transfer hidden in an inner (CPI) instruction is ambiguous', async () => {
  const f = fixture();
  const chain = chainFor(
    parsedTx(f, {
      instructions: [transferIx(checkedInfo(f, { reference: f.reference }))],
      inner: [transferIx(checkedInfo(f, { amount: '5' }), 'transfer')],
    }),
  );
  await ambiguous(chain.getTransfer(SIGNATURE), /2 spl-token transfers/);
});

test('two plain transfers are ambiguous even when identical', async () => {
  const f = fixture();
  const ix = transferIx(checkedInfo(f, { reference: f.reference }));
  await ambiguous(chainFor(parsedTx(f, { instructions: [ix, ix] })).getTransfer(SIGNATURE), /2 spl-token transfers/);
});

test('a read-only account elsewhere in the transaction is NOT a reference: only the transfer instruction own accounts count', async () => {
  const f = fixture();
  // The reference key is in the transaction (read-only, non-signer) but is attached to a different instruction (a memo),
  // not to the transfer. It must not be reported as a reference of the transfer.
  const memo = { programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), accounts: [f.reference], data: '3Bxs4h24hBtQy9rw' };
  const chain = chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f)), memo] }));
  const transfer = await chain.getTransfer(SIGNATURE);
  assert.ok(transfer);
  assert.deepEqual(transfer.referenceKeys, [], 'a reference outside the transfer instruction must not satisfy the reference check');
});

test('only non-signer, read-only accounts of the transfer instruction can be references (writable or signer extras are dropped)', async () => {
  const f = fixture();
  const writableExtra = key();
  const signerExtra = key();
  const info = { ...checkedInfo(f), authority: undefined, multisigAuthority: f.owner.toBase58(), signers: [f.reference.toBase58(), writableExtra.toBase58(), signerExtra.toBase58(), f.owner.toBase58()] };
  const chain = chainFor(parsedTx(f, { extraKeys: [{ pubkey: writableExtra, writable: true }, { pubkey: signerExtra, signer: true }], instructions: [transferIx(info)] }));
  const transfer = await chain.getTransfer(SIGNATURE);
  assert.deepEqual(transfer!.referenceKeys, [f.reference.toBase58()]);
});

test('Token-2022 program id is rejected (as the transfer, and even alongside a classic transfer)', async () => {
  const f = fixture();
  await ambiguous(chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f, { reference: f.reference }), 'transferChecked', TOKEN_2022_PROGRAM_ID)] })).getTransfer(SIGNATURE), /Token-2022/);
  await ambiguous(
    chainFor(
      parsedTx(f, {
        instructions: [transferIx(checkedInfo(f, { reference: f.reference }))],
        inner: [transferIx(checkedInfo(f, { amount: '1' }), 'transferChecked', TOKEN_2022_PROGRAM_ID)],
      }),
    ).getTransfer(SIGNATURE),
    /Token-2022/,
  );
});

test('a delegate (non-owner) authority is ambiguous: the source owner did not authorize the movement', async () => {
  const f = fixture();
  const delegate = key();
  const withDelegate = parsedTx(f, { extraKeys: [{ pubkey: delegate, signer: true }], instructions: [transferIx(checkedInfo(f, { authority: delegate }))] });
  await ambiguous(chainFor(withDelegate).getTransfer(SIGNATURE), /delegate/);
  const withDelegateAndReference = parsedTx(f, { extraKeys: [{ pubkey: delegate, signer: true }], instructions: [transferIx(checkedInfo(f, { authority: delegate, reference: f.reference }))] });
  await ambiguous(chainFor(withDelegateAndReference).getTransfer(SIGNATURE), /delegate/);
});

test('unparsed spl-token instructions: a possible transfer is ambiguous, a benign helper is ignored', async () => {
  const f = fixture();
  const unparsed = (firstByte: number) => ({ programId: TOKEN_PROGRAM_ID, accounts: [f.sourceAta], data: base58Encode(Uint8Array.from([firstByte, 1, 2, 3])) });
  await ambiguous(chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f, { reference: f.reference })), unparsed(12)] })).getTransfer(SIGNATURE), /could not be parsed/);
  await ambiguous(chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f, { reference: f.reference })), unparsed(3)] })).getTransfer(SIGNATURE), /could not be parsed/);
  await ambiguous(chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f, { reference: f.reference })), { programId: TOKEN_PROGRAM_ID, accounts: [], data: '' }] })).getTransfer(SIGNATURE), /could not be parsed/);
  // initializeAccount3 (tag 18) is not a transfer.
  const transfer = await chainFor(parsedTx(f, { instructions: [transferIx(checkedInfo(f, { reference: f.reference })), unparsed(18)] })).getTransfer(SIGNATURE);
  assert.equal(transfer!.amountAtomic, 250_000_000n);
});

test('inconsistent or missing token-balance data is ambiguous, never a guessed owner/mint', async () => {
  const f = fixture();
  const ix = transferIx(checkedInfo(f, { reference: f.reference }));
  await ambiguous(chainFor(parsedTx(f, { instructions: [ix], balances: [] })).getTransfer(SIGNATURE), /owner is unknown/);
  await ambiguous(
    chainFor(parsedTx(f, { instructions: [ix], balances: [{ key: f.sourceAta, owner: f.owner.toBase58() }, { key: f.destAta, owner: f.merchant.toBase58(), mint: key().toBase58() }] })).getTransfer(SIGNATURE),
    /mints differ/,
  );
  await ambiguous(
    chainFor(parsedTx(f, { instructions: [ix], balances: [{ key: f.sourceAta, owner: f.owner.toBase58() }, { key: f.sourceAta, owner: key().toBase58() }, { key: f.destAta, owner: f.merchant.toBase58() }] })).getTransfer(SIGNATURE),
    /inconsistent/,
  );
  await ambiguous(chainFor(parsedTx(f, { instructions: [transferIx({ ...checkedInfo(f), tokenAmount: { amount: '12.5' } })] })).getTransfer(SIGNATURE), /amount is missing or malformed/);
});

test('a transaction that FAILED on chain is reported as failed (no funds moved), not as ambiguous', async () => {
  const f = fixture();
  const failedStatus = { confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } };
  const transfer = await chainFor(parsedTx(f, { instructions: [] }), failedStatus).getTransfer(SIGNATURE);
  assert.ok(transfer);
  assert.equal(transfer.succeeded, false);
  assert.equal(transfer.finalized, true);
  assert.equal(transfer.amountAtomic, 0n);
  assert.deepEqual(transfer.referenceKeys, []);
  // ...but a SUCCESSFUL one with the same empty body is still ambiguous.
  await ambiguous(chainFor(parsedTx(f, { instructions: [] })).getTransfer(SIGNATURE), /no spl-token transfer/);
});

test('RPC failures stay plain ChainUnavailableError (retryable), distinct from ambiguous', async () => {
  const connection: any = {
    getSignatureStatuses: async () => {
      throw new Error('socket hang up');
    },
  };
  const error = await new DevnetSolanaChain(FLAGS, { connection }).getTransfer(SIGNATURE).catch((e: unknown) => e);
  assert.ok(error instanceof ChainUnavailableError);
  assert.ok(!(error instanceof AmbiguousTransferError));
});
