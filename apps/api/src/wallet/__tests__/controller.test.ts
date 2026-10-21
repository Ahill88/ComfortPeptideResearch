import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Keypair, Transaction } from '@solana/web3.js';
import { PrismaService } from '../../prisma.service';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { COMPLIANCE_SCREEN, SOLANA_CHAIN, WALLET_FEATURE_FLAGS, WalletModule } from '../wallet.module';
import { AllowAllComplianceScreen } from '../transfers/compliance-screen';
import { FakePrisma, signLinkMessage } from './helpers';

/** Through Nest DI, guard, validation pipe, interceptor and HTTP, using the in-memory prisma double. */
async function boot() {
  const prisma = new FakePrisma();
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class FakePrismaModule {}
  // COMPLIANCE_SCREEN is provided by the global SanctionsModule in the app; this fixture binds allow-all.
  @Global()
  @Module({ providers: [{ provide: COMPLIANCE_SCREEN, useFactory: () => new AllowAllComplianceScreen() }], exports: [COMPLIANCE_SCREEN] })
  class AllowAllScreenModule {}

  // Pin the manual-finalize sandbox (the factory-built sandbox auto-finalizes) so this test can observe
  // the SUBMITTED -> finalized transition explicitly.
  const moduleRef = await Test.createTestingModule({ imports: [FakePrismaModule, AllowAllScreenModule, WalletModule] })
    .overrideProvider(SOLANA_CHAIN)
    .useValue(new SandboxSolanaChain())
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-customer-email': 'e2e@example.com' }) => {
    const res = await fetch(`${base}/v1/wallet${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  /** The browser flow over HTTP: POST /link-challenge, sign the returned message with the wallet key, return the POST / body. */
  const proof = async (kp: Keypair, headers?: Record<string, string>, provider = 'sandbox') => {
    const address = kp.publicKey.toBase58();
    const issued = await call('POST', '/link-challenge', { address }, headers);
    assert.equal(issued.status, 200);
    return { address, provider, challenge: issued.json.challenge as string, signature: signLinkMessage(kp, issued.json.message) };
  };
  return { app, call, moduleRef, prisma, proof };
}

test('wallet HTTP: identity header, secret rejection, link, sandbox buy, balance strings, prepare/sign/submit', async () => {
  delete process.env.WALLET_CHAIN_MODE;
  const { app, call, moduleRef, prisma, proof } = await boot();
  try {
    const flags = moduleRef.get(WALLET_FEATURE_FLAGS);
    assert.ok(Object.values(flags).every((v) => v === false), 'all flags default false');
    const chain = moduleRef.get<SandboxSolanaChain>(SOLANA_CHAIN);
    assert.ok(chain instanceof SandboxSolanaChain);

    // no identity header -> 401
    assert.equal((await call('GET', '', undefined, {})).status, 401);

    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    // secret fields are rejected with 400 before the validation pipe can silently strip them
    const secret = await call('POST', '', { address, provider: 'sandbox', privateKey: 'abc' });
    assert.equal(secret.status, 400);
    assert.equal(prisma.customerWallet.rows.length, 0);

    // the address alone is no longer enough: proof of key control is required
    assert.equal((await call('POST', '', { address, provider: 'sandbox' })).status, 400);
    assert.equal(prisma.customerWallet.rows.length, 0);
    assert.equal((await call('POST', '', { ...(await proof(kp, undefined, 'privy')) })).status, 400); // not configured
    const linked = await call('POST', '', await proof(kp));
    assert.equal(linked.status, 201);
    assert.equal(linked.json.wallet.address, address);
    assert.equal((await call('POST', '', await proof(kp))).status, 201); // idempotent
    assert.equal((await call('POST', '', await proof(Keypair.generate()))).status, 409);
    assert.equal((await call('GET', '')).json.provider.name, 'sandbox');

    // sandbox purchase: only via mock-complete
    const intent = await call('POST', '/onramp', { amountUsdCents: 2_550 });
    assert.equal(intent.status, 201);
    assert.equal(intent.json.quote.sandbox, true);
    assert.equal(intent.json.quote.estimatedUsdcAtomic, null);
    assert.equal((await call('GET', '/balance')).json.spendableAtomic, '0');
    assert.equal((await call('POST', `/onramp/${intent.json.intentId}/mock-complete`)).status, 200);
    const balance = await call('GET', '/balance');
    assert.equal(balance.json.spendableAtomic, '25500000'); // bigint serialized as string
    assert.equal(balance.json.researchCredits, '25');
    assert.equal(balance.json.stale, false);

    // transfer: prepare -> customer signs (test-only) -> submit
    const destination = Keypair.generate().publicKey.toBase58();
    assert.equal((await call('POST', '/transfers/prepare', { destination, amountAtomic: '1.5' })).status, 400);
    const prepared = await call('POST', '/transfers/prepare', { destination, amountAtomic: '5000000' });
    assert.equal(prepared.status, 201);
    assert.equal(prepared.json.amountAtomic, '5000000');
    const tx = Transaction.from(Buffer.from(prepared.json.unsignedTransaction, 'base64'));
    tx.partialSign(kp);
    const submit = await call('POST', `/transfers/${prepared.json.transactionId}/submit`, { signedTransaction: tx.serialize().toString('base64') });
    assert.equal(submit.status, 200);
    assert.equal(submit.json.status, 'SUBMITTED');
    assert.equal((await call('GET', '/balance')).json.pendingOutgoingAtomic, '5000000');
    chain.finalize(submit.json.txSignature);
    const after = await call('GET', '/balance');
    assert.equal(after.json.finalizedAtomic, '20500000');
    assert.equal(after.json.pendingOutgoingAtomic, '0');
    const list = await call('GET', '/transactions');
    assert.deepEqual(list.json.transactions.map((t: any) => `${t.type}:${t.status}`).sort(), ['DEPOSIT:FINALIZED', 'WITHDRAWAL:FINALIZED']);

    // outage fails closed over HTTP
    chain.setOutage(true);
    const stale = await call('GET', '/balance');
    assert.equal(stale.json.stale, true);
    assert.equal(stale.json.spendableAtomic, '0');
    assert.equal((await call('POST', '/transfers/prepare', { destination, amountAtomic: '1' })).status, 503);
  } finally {
    await app.close();
  }
});

test('wallet HTTP: link-challenge contract, proof validation and the victim-squat scenario', async () => {
  const { app, call, prisma, proof } = await boot();
  const attacker = { 'x-customer-email': 'attacker@example.com' };
  const victimHeaders = { 'x-customer-email': 'victim@example.com' };
  try {
    const victim = Keypair.generate();
    const victimAddress = victim.publicKey.toBase58();

    // identity header required; body validated; secrets rejected
    assert.equal((await call('POST', '/link-challenge', { address: victimAddress }, {})).status, 401);
    assert.equal((await call('POST', '/link-challenge', {}, attacker)).status, 400);
    assert.equal((await call('POST', '/link-challenge', { address: 'nope' }, attacker)).status, 400);
    assert.equal((await call('POST', '/link-challenge', { address: victimAddress, privateKey: 'x' }, attacker)).status, 400);

    const issued = await call('POST', '/link-challenge', { address: victimAddress }, attacker);
    assert.equal(issued.status, 200);
    assert.deepEqual(Object.keys(issued.json).sort(), ['challenge', 'expiresAt', 'message']);
    assert.match(issued.json.message, /^Helix & Field wallet link\nAccount: attacker@example\.com\nAddress: \w+\nNonce: [\w-]+\nExpires: \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.ok(Date.parse(issued.json.expiresAt) > Date.now());
    assert.equal(prisma.customerWallet.rows.length, 0, 'asking for a challenge must not link anything');

    // ATTACK: link the victim's public address without the victim's key (signs with the attacker's own key)
    const attackerKey = Keypair.generate();
    const forged = { address: victimAddress, provider: 'sandbox', challenge: issued.json.challenge, signature: signLinkMessage(attackerKey, issued.json.message) };
    const refused = await call('POST', '', forged, attacker);
    assert.equal(refused.status, 400);
    assert.equal(refused.json.message, 'Unable to link this wallet');
    // missing / malformed proof fields
    assert.equal((await call('POST', '', { address: victimAddress, provider: 'sandbox', challenge: issued.json.challenge }, attacker)).status, 400);
    assert.equal((await call('POST', '', { address: victimAddress, provider: 'sandbox', challenge: 'a.b', signature: 'AAAA' }, attacker)).status, 400);
    // secret-looking fields stay rejected even next to a valid proof
    assert.equal((await call('POST', '', { ...(await proof(victim, victimHeaders)), mnemonic: 'x' }, victimHeaders)).status, 400);
    assert.equal(prisma.customerWallet.rows.length, 0);

    // the victim is not locked out and links normally
    const linked = await call('POST', '', await proof(victim, victimHeaders), victimHeaders);
    assert.equal(linked.status, 201);
    assert.equal(linked.json.wallet.address, victimAddress);
    // attacker still cannot: not with a forged signature, nor by replaying the victim's captured proof
    const victimProof = await proof(victim, victimHeaders);
    assert.equal((await call('POST', '', victimProof, attacker)).status, 400);
    assert.equal((await call('POST', '', forged, attacker)).json.message, 'Unable to link this wallet');
    assert.equal((await call('GET', '', undefined, attacker)).status, 404, 'attacker account has no wallet');
    // fund the victim's wallet: the attacker's account must not see any of it
    const intent = await call('POST', '/onramp', { amountUsdCents: 1_000 }, victimHeaders);
    assert.equal((await call('POST', `/onramp/${intent.json.intentId}/mock-complete`, undefined, victimHeaders)).status, 200);
    assert.equal((await call('GET', '/balance', undefined, victimHeaders)).json.spendableAtomic, '10000000');
    const peek = await call('GET', '/balance', undefined, attacker);
    assert.equal(peek.json.finalizedAtomic, '0', 'attacker cannot read the victims balance');
    assert.equal(peek.json.spendableAtomic, '0');
  } finally {
    await app.close();
  }
});

test('wallet HTTP: header identity is ignored (401) when NODE_ENV=production', async () => {
  const { app, call } = await boot();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal((await call('GET', '')).status, 401);
    assert.equal((await call('GET', '/balance')).status, 401);
  } finally {
    process.env.NODE_ENV = previous;
    await app.close();
  }
});
