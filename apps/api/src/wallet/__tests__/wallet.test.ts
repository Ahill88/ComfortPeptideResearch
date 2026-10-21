import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { Keypair } from '@solana/web3.js';
import { base58Encode } from '../chain/base58';
import { DevnetSolanaChain } from '../chain/devnet-solana-chain';
import { createSolanaChain } from '../chain/chain.factory';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { ChainUnavailableError, centsToAtomic } from '../contracts';
import { readCustomerEmail } from '../customer-identity';
import { createHmac } from 'node:crypto';
import { canonicalizeCustomerIp, createAllowedIpHash, createMoonPayUrlSignature, MoonPayOnRampProvider } from '../onramp/moonpay-onramp.provider';
import { findSecretFields } from '../secret-fields';
import { loadRuntimeConfig } from '../wallet.config';
import { toJsonSafe } from '../wallet.http';
import { FLAGS, linkCustomer, linkRequest, makeConfig, makeHarness, rejection } from './helpers';

const addr = () => Keypair.generate().publicKey.toBase58();

// ---------------------------------------------------------------- wallet association

test('wallet association rejects secret-looking fields with 400 and stores only the public address', async () => {
  for (const field of ['secretKey', 'privateKey', 'seed', 'mnemonic', 'seedPhrase', 'private_key']) {
    const h = makeHarness();
    const kp = Keypair.generate();
    // Otherwise-valid proof: the ONLY reason for the 400 is the secret-looking field.
    const err = await rejection(h.wallets.associateWallet('a@example.com', { ...linkRequest(h, 'a@example.com', kp), [field]: 'do-not-store-me' }));
    assert.equal(err.status, 400, field);
    assert.equal(h.prisma.customerWallet.rows.length, 0, field);
    const audit = JSON.stringify(h.prisma.walletAuditEvent.rows);
    assert.ok(!audit.includes('do-not-store-me'), 'secret value must never be audited');
    assert.ok(!err.message.includes('do-not-store-me'));
  }
  assert.deepEqual(findSecretFields({ nested: { mnemonic: 'x' } }), ['nested.mnemonic']);
  assert.deepEqual(findSecretFields({ address: 'abc', provider: 'sandbox' }), []);
});

test('wallet association validates address as 32-byte ed25519 public key', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  for (const bad of ['', 'not-base58-!!', '1111', base58Encode(kp.secretKey), undefined, 42, 'A'.repeat(45), '0'.repeat(40)]) {
    const err = await rejection(h.wallets.associateWallet('a@example.com', { address: bad, provider: 'sandbox' }));
    assert.equal(err.status, 400, String(bad));
  }
  // System program id is a valid 32-byte key but off-curve in many cases; a PDA must be rejected as a user wallet.
  const [pda] = (await import('@solana/web3.js')).PublicKey.findProgramAddressSync([Buffer.from('x')], Keypair.generate().publicKey);
  assert.equal((await rejection(h.wallets.associateWallet('a@example.com', { address: pda.toBase58(), provider: 'sandbox' }))).status, 400);
  assert.equal(h.prisma.customerWallet.rows.length, 0);
});

test('wallet association is idempotent for same address, 409 for a different one, one wallet per customer', async () => {
  const h = makeHarness();
  const kp = Keypair.generate();
  const first = await h.wallets.associateWallet('a@example.com', linkRequest(h, 'a@example.com', kp));
  const again = await h.wallets.associateWallet('a@example.com', linkRequest(h, 'a@example.com', kp));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(h.prisma.customerWallet.rows.length, 1);
  assert.equal(h.prisma.walletAuditEvent.rows.filter((e) => e.action === 'WALLET_ASSOCIATED').length, 1);
  // a second, properly proven wallet for the same account is still refused: one wallet per customer
  assert.equal((await rejection(h.wallets.associateWallet('a@example.com', linkRequest(h, 'a@example.com', Keypair.generate())))).status, 409);
  const stored = h.prisma.customerWallet.rows[0];
  assert.deepEqual(Object.keys(stored).sort(), ['address', 'createdAt', 'customerId', 'id', 'network', 'provider']);
});

test('getWallet returns wallet plus honest provider disclosure', async () => {
  const h = makeHarness();
  const { address } = await linkCustomer(h);
  const result = await h.wallets.getWallet('buyer@example.com');
  assert.equal(result.wallet.address, address);
  assert.equal(result.provider.name, 'sandbox');
  assert.match(result.provider.disclosure, /not for real funds/i);
  assert.match(result.provider.disclosure, /browser/i);
  assert.match(result.provider.disclosure, /NOT PRIVY/);
  assert.equal(result.provider.realFundsSuitable, false);
  assert.equal((await rejection(h.wallets.getWallet('none@example.com'))).status, 404);
});

test('privy descriptor is explicitly inactive unless PRIVY_APP_ID is configured, and cannot be linked', async () => {
  const h = makeHarness();
  const privy = h.wallets.providerDescriptor('privy');
  assert.equal(privy.active, false);
  assert.match(privy.disclosure, /PRIVY_APP_ID/);
  assert.match(privy.disclosure, /NOT ACTIVE/);
  assert.ok(privy.requirements.includes('PRIVY_APP_ID'));
  const err = await rejection(h.wallets.associateWallet('a@example.com', { address: addr(), provider: 'privy' }));
  assert.equal(err.status, 400);
  const configured = makeHarness({ config: { privyAppId: 'app_id' } });
  assert.equal(configured.wallets.providerDescriptor('privy').active, true);
  assert.doesNotMatch(configured.wallets.providerDescriptor('sandbox').disclosure, /Privy wallet/);
});

test('treasury address cannot be linked as a customer wallet', async () => {
  const treasury = addr();
  const h = makeHarness({ config: { treasuryAddress: treasury } });
  assert.equal((await rejection(h.wallets.associateWallet('a@example.com', { address: treasury, provider: 'sandbox' }))).status, 400);
});

// ---------------------------------------------------------------- identity and serialization

test('x-customer-email is honored only outside production', () => {
  assert.equal(readCustomerEmail({ 'x-customer-email': ' Buyer@Example.com ' }, 'development'), 'buyer@example.com');
  assert.throws(() => readCustomerEmail({ 'x-customer-email': 'buyer@example.com' }, 'production'), UnauthorizedException);
  assert.throws(() => readCustomerEmail({}, 'development'), UnauthorizedException);
  assert.throws(() => readCustomerEmail({ 'x-customer-email': 'not-an-email' }, undefined), UnauthorizedException);
});

test('bigint values serialize as decimal strings', () => {
  const out = toJsonSafe({ a: 1n, nested: [{ b: 18_446_744_073_709_551_615n }], d: new Date(0), n: null });
  assert.equal(JSON.stringify(out), '{"a":"1","nested":[{"b":"18446744073709551615"}],"d":"1970-01-01T00:00:00.000Z","n":null}');
});

// ---------------------------------------------------------------- on-ramp

test('on-ramp destination is always the customers own wallet, never the treasury', async () => {
  const treasury = addr();
  const h = makeHarness({ config: { treasuryAddress: treasury } });
  const { customer, address } = await linkCustomer(h);
  const { intentId, quote } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 5_000 });
  assert.equal(quote.destinationAddress, address);
  assert.notEqual(quote.destinationAddress, treasury);
  assert.equal(h.prisma.onRampIntent.rows.find((r) => r.id === intentId)!.destinationAddress, address);
  // Without a wallet, no intent
  const other = await h.wallets.resolveCustomer('nowallet@example.com');
  assert.equal((await rejection(h.onRamp.createIntent(other.id, { intendedUsdCents: 5_000 }))).status, 409);
  // Provider itself refuses the treasury regardless of caller
  const err = await rejection(h.provider.createQuote({ customerId: customer.id, destinationAddress: treasury, intendedUsdCents: 100, intentId: 'i' }));
  assert.equal(err.status, 400);
  assert.match(err.message, /treasury/i);
});

test('sandbox quote is clearly labeled, has null estimates and a local widget path', async () => {
  const h = makeHarness();
  const { customer } = await linkCustomer(h);
  const { intentId, quote } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 2_500 });
  assert.equal(quote.provider, 'moonpay-sandbox');
  assert.equal(quote.sandbox, true);
  assert.equal(quote.estimatedFeeUsdCents, null);
  assert.equal(quote.estimatedUsdcAtomic, null);
  assert.equal(quote.widgetUrl, `/wallet/sandbox-onramp?intent=${intentId}`);
  const text = quote.disclosures.join(' ');
  assert.match(text, /MoonPay .*identity verification/i);
  assert.match(text, /Fees .*set by MoonPay/i);
  assert.match(text, /SANDBOX/);
});

test('mock-complete credits only through the sandbox chain, once, and balance derives from chain', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  const { intentId } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 12_345 });
  // creating an intent credits nothing
  assert.equal((await h.credits.getBalance(customer.id)).spendableAtomic, 0n);
  const done = await h.onRamp.mockComplete(customer.id, intentId);
  assert.equal(done.credited, true);
  assert.equal(await h.chain.getFinalizedUsdcBalance(address), centsToAtomic(12_345));
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.spendableAtomic, 123_450_000n);
  assert.equal(balance.researchCredits, 123n);
  // idempotent: second call does not double credit
  assert.equal((await h.onRamp.mockComplete(customer.id, intentId)).credited, false);
  assert.equal(await h.chain.getFinalizedUsdcBalance(address), centsToAtomic(12_345));
  // flipping DB intent status alone changes nothing
  const other = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 100 });
  h.prisma.onRampIntent.rows.find((r) => r.id === other.intentId)!.status = 'COMPLETED';
  assert.equal(await h.chain.getFinalizedUsdcBalance(address), centsToAtomic(12_345));
});

test('mock-complete is refused outside sandbox mode, in production, and for other customers', async () => {
  const prod = makeHarness({ config: { isProductionLike: true, isProduction: true } });
  const a = await linkCustomer(prod);
  const { intentId } = await prod.onRamp.createIntent(a.customer.id, { intendedUsdCents: 100 });
  assert.equal((await rejection(prod.onRamp.mockComplete(a.customer.id, intentId))).status, 403);

  const devnetMode = makeHarness({ config: { chainMode: 'devnet' } });
  const b = await linkCustomer(devnetMode);
  const intent = await devnetMode.onRamp.createIntent(b.customer.id, { intendedUsdCents: 100 });
  assert.equal((await rejection(devnetMode.onRamp.mockComplete(b.customer.id, intent.intentId))).status, 403);

  const h = makeHarness();
  const owner = await linkCustomer(h, 'o@example.com');
  const thief = await linkCustomer(h, 't@example.com');
  const mine = await h.onRamp.createIntent(owner.customer.id, { intendedUsdCents: 100 });
  assert.equal((await rejection(h.onRamp.mockComplete(thief.customer.id, mine.intentId))).status, 404);
});

test('mock-complete refuses real-provider intents', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  const intent = await h.prisma.onRampIntent.create({ data: { customerId: customer.id, provider: 'moonpay', intendedUsdCents: 100, destinationAddress: address } });
  assert.equal((await rejection(h.onRamp.mockComplete(customer.id, intent.id))).status, 409);
});

// ---------------------------------------------------------------- MoonPay URL building and signing

test('MoonPay URL signing matches the documented test vector', () => {
  const query = '?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
  assert.equal(createMoonPayUrlSignature(query, 'sk_test_DocsVector00'), 'oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=');
});

test('real MoonPay quote builds a signed URL with only verified parameters', async () => {
  const wallet = addr();
  const config = makeConfig({ moonpayPublishableKey: 'pk_test_abc', moonpaySigningSecret: 'sk_test_abc', treasuryAddress: addr() });
  const provider = new MoonPayOnRampProvider({ ...FLAGS, enableRealMoonpay: true }, config);
  const quote = await provider.createQuote({ customerId: 'cust_1', destinationAddress: wallet, intendedUsdCents: 5_000, intentId: 'intent-1', customerIp: '203.0.113.9' });
  assert.equal(quote.provider, 'moonpay');
  assert.equal(quote.sandbox, true); // pk_test_ key = MoonPay sandbox host
  const url = new URL(quote.widgetUrl);
  assert.equal(url.origin, 'https://buy-sandbox.moonpay.com');
  const p = url.searchParams;
  assert.deepEqual([...p.keys()], ['apiKey', 'currencyCode', 'walletAddress', 'baseCurrencyCode', 'baseCurrencyAmount', 'externalCustomerId', 'externalTransactionId', 'allowedIpAddress', 'signature']);
  assert.equal(p.get('walletAddress'), wallet);
  assert.equal(p.get('baseCurrencyAmount'), '50');
  assert.equal(p.get('externalTransactionId'), 'intent-1');
  assert.equal(p.get('currencyCode'), 'usdc_sol');
  // signature covers exactly the query string (with leading ?) preceding &signature=
  const raw = quote.widgetUrl;
  const signed = raw.slice(raw.indexOf('?'), raw.indexOf('&signature='));
  assert.equal(p.get('signature'), createMoonPayUrlSignature(signed, 'sk_test_abc'));
  assert.ok(!quote.widgetUrl.includes('sk_test_abc'));
  assert.match(quote.disclosures.join(' '), /MoonPay .*identity verification/i);
});

test('allowedIpAddress follows MoonPay\'s documented scheme: base64(HMAC-SHA256(secretKey, canonicalIp)), with the same key that signs the URL', async () => {
  const secret = 'sk_test_abc';
  const ip = '203.0.113.9';
  const hash = createAllowedIpHash(ip, secret);
  // MoonPay recomputes exactly this from the IP it observes (https://dev.moonpay.com/widget/on-ramp/customization/ip-matching.md).
  assert.equal(hash, createHmac('sha256', secret).update(ip).digest('base64'));
  assert.equal(hash, createAllowedIpHash(ip, secret), 'deterministic');
  assert.notEqual(hash, createAllowedIpHash('203.0.113.10', secret));
  assert.notEqual(hash, createAllowedIpHash(ip, 'sk_test_other'));
  assert.ok(!hash.includes(ip));
  // Not an oracle: URL signatures are always over a query string starting with "?", and canonical IP literals never can.
  assert.throws(() => createAllowedIpHash('?apiKey=pk_test_abc&walletAddress=attacker', secret));
  assert.throws(() => createAllowedIpHash('not-an-ip', secret));
  assert.throws(() => createAllowedIpHash('::FFFF:203.0.113.9', secret), 'non-canonical input is refused, not silently re-hashed');
  // The documented URL-signing vector is unaffected.
  assert.equal(createMoonPayUrlSignature('?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe', 'sk_test_DocsVector00'), 'oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=');

  const provider = new MoonPayOnRampProvider({ ...FLAGS, enableRealMoonpay: true }, makeConfig({ moonpayPublishableKey: 'pk_test_abc', moonpaySigningSecret: secret, treasuryAddress: addr() }));
  const input = { customerId: 'cust_1', destinationAddress: addr(), intendedUsdCents: 5_000, intentId: 'intent-1' };
  const quote = await provider.createQuote({ ...input, customerIp: ip });
  const p = new URL(quote.widgetUrl).searchParams;
  assert.equal(p.get('allowedIpAddress'), hash);
  const signed = quote.widgetUrl.slice(quote.widgetUrl.indexOf('?'), quote.widgetUrl.indexOf('&signature='));
  assert.equal(p.get('signature'), createMoonPayUrlSignature(signed, secret), 'URL signing covers allowedIpAddress');
  // Express reports IPv4 clients as ::ffff:a.b.c.d: it must be unmapped before hashing, or MoonPay's comparison fails.
  const mapped = new URL((await provider.createQuote({ ...input, customerIp: '::ffff:203.0.113.9' })).widgetUrl).searchParams;
  assert.equal(mapped.get('allowedIpAddress'), hash);
  // A crafted non-IP string is dropped entirely: the provider never MACs attacker-chosen text.
  for (const crafted of ['?apiKey=pk_test_abc&walletAddress=attacker', 'not-an-ip', '203.0.113.9, 198.51.100.1', '', '203.0.113.09', 'fe80::1%eth0']) {
    const dropped = new URL((await provider.createQuote({ ...input, customerIp: crafted })).widgetUrl).searchParams;
    assert.equal(dropped.has('allowedIpAddress'), false, crafted);
  }
});

test('canonicalizeCustomerIp implements MoonPay\'s documented canonicalization rules', () => {
  const cases: Array<[string, string | null]> = [
    ['203.0.113.42', '203.0.113.42'],
    ['203.0.113.42:8080', '203.0.113.42'],
    ['::ffff:203.0.113.42', '203.0.113.42'],
    ['[::ffff:203.0.113.42]:443', '203.0.113.42'],
    ['::FFFF:cb00:712a', '203.0.113.42'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'], // the documentation's own example
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'], // RFC 5952: compress the longest run, the first on a tie
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'], // a single zero group is not compressed
    ['0:0:0:0:0:0:0:1', '::1'],
    ['::', '::'],
    ['2001:DB8::1', '2001:db8::1'],
    ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0'], // RFC 5952 4.2.2: "::" must not shorten a single zero group
    ['203.0.113.042', null], // leading zero: ambiguous octal, refused
    ['256.1.1.1', null],
    ['fe80::1%eth0', null],
    ['203.0.113.9, 198.51.100.1', null],
    ['?x=1', null],
    ['', null],
    ['hello', null],
  ];
  for (const [input, expected] of cases) assert.equal(canonicalizeCustomerIp(input), expected, `canonicalize(${JSON.stringify(input)})`);
});

test('real MoonPay fails closed on missing keys, live key without mainnet, fractional dollars, treasury', async () => {
  const treasury = addr();
  const base = { customerId: 'c', destinationAddress: addr(), intendedUsdCents: 5_000, intentId: 'i' };
  const on = { ...FLAGS, enableRealMoonpay: true };
  const noKeys = new MoonPayOnRampProvider(on, makeConfig());
  assert.equal((await rejection(noKeys.createQuote(base))).status, 503);
  const live = new MoonPayOnRampProvider(on, makeConfig({ moonpayPublishableKey: 'pk_live_x', moonpaySigningSecret: 's' }));
  assert.equal((await rejection(live.createQuote(base))).status, 503);
  const liveMainnet = new MoonPayOnRampProvider({ ...on, enableSolanaMainnet: true }, makeConfig({ moonpayPublishableKey: 'pk_live_x', moonpaySigningSecret: 's' }));
  assert.equal(new URL((await liveMainnet.createQuote(base)).widgetUrl).origin, 'https://buy.moonpay.com');
  const test_ = new MoonPayOnRampProvider(on, makeConfig({ moonpayPublishableKey: 'pk_test_x', moonpaySigningSecret: 's', treasuryAddress: treasury }));
  assert.equal((await rejection(test_.createQuote({ ...base, intendedUsdCents: 5_050 }))).status, 400);
  assert.equal((await rejection(test_.createQuote({ ...base, destinationAddress: treasury }))).status, 400);
});

// ---------------------------------------------------------------- chain adapters

test('devnet adapter refuses mainnet unless explicitly flagged', () => {
  assert.throws(() => new DevnetSolanaChain(FLAGS, { network: 'solana-mainnet' }), /mainnet/i);
  assert.throws(() => new DevnetSolanaChain(FLAGS, { rpcUrl: 'https://api.mainnet-beta.solana.com' }), /mainnet/i);
  assert.throws(() => createSolanaChain(FLAGS, makeConfig({ chainMode: 'devnet', solanaNetwork: 'solana-mainnet' })), /mainnet/i);
  // flag on but no explicit mint: still refuses
  assert.throws(() => new DevnetSolanaChain({ ...FLAGS, enableSolanaMainnet: true }, { network: 'solana-mainnet' }), /SOLANA_USDC_MINT/);
  // flag on and network mismatch with mainnet RPC: refuses
  assert.throws(() => new DevnetSolanaChain({ ...FLAGS, enableSolanaMainnet: true }, { rpcUrl: 'https://api.mainnet-beta.solana.com' }), /looks like mainnet/);
  assert.equal(new DevnetSolanaChain(FLAGS).network, 'solana-devnet');
});

test('devnet adapter wraps RPC failures in ChainUnavailableError and reads at finalized commitment', async () => {
  const seen: unknown[] = [];
  const failing: any = {
    getAccountInfo: async (_k: unknown, commitment: unknown) => {
      seen.push(commitment);
      throw new Error('socket hang up');
    },
    getBalance: async () => {
      throw new Error('503');
    },
    getLatestBlockhash: async () => {
      throw new Error('503');
    },
  };
  const chain = new DevnetSolanaChain(FLAGS, { connection: failing });
  const owner = addr();
  await assert.rejects(chain.getFinalizedUsdcBalance(owner), ChainUnavailableError);
  await assert.rejects(chain.getSolBalanceLamports(owner), ChainUnavailableError);
  await assert.rejects(chain.getLatestBlockhash(), ChainUnavailableError);
  assert.deepEqual(seen, ['finalized']);
});

test('chain mode defaults to sandbox, rejects bad values, and sandbox refuses production', () => {
  assert.equal(loadRuntimeConfig({}).chainMode, 'sandbox');
  assert.equal(loadRuntimeConfig({ WALLET_CHAIN_MODE: 'devnet' }).chainMode, 'devnet');
  assert.throws(() => loadRuntimeConfig({ WALLET_CHAIN_MODE: 'mainnet' }));
  assert.ok(createSolanaChain(FLAGS, makeConfig()) instanceof SandboxSolanaChain);
  assert.throws(() => createSolanaChain(FLAGS, makeConfig({ isProductionLike: true, isProduction: true })), /production/);
});

test('sandbox chain is deterministic and simulates outage', async () => {
  const chain = new SandboxSolanaChain();
  const other = new SandboxSolanaChain();
  assert.equal((await chain.getLatestBlockhash()).blockhash, (await other.getLatestBlockhash()).blockhash);
  const owner = addr();
  assert.equal(await chain.getFinalizedUsdcBalance(owner), 0n);
  chain.creditUsdc(owner, 7n);
  assert.equal(await chain.getFinalizedUsdcBalance(owner), 7n);
  chain.setOutage(true);
  await assert.rejects(chain.getFinalizedUsdcBalance(owner), ChainUnavailableError);
  await assert.rejects(chain.broadcast(new Uint8Array(1)), ChainUnavailableError);
});
