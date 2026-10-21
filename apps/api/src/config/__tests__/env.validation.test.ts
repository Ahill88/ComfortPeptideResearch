import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { EnvValidationError, LIVE_FUNDS_ACK_VALUE, assertValidEnv, decodeBase58, isValidSolanaAddress, validateEnv } from '../env.validation';
import { isNonProductionRuntime, isProductionLikeRuntime } from '../runtime';

const treasury = Keypair.generate().publicKey.toBase58();
const token = 'a'.repeat(40);

/** A fully valid production environment; each test mutates one thing. */
const prod = (overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    SOLANA_USDC_TREASURY: treasury,
    WALLET_CHAIN_MODE: 'devnet',
    STOREFRONT_ORIGIN: 'https://shop.example.com',
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
};
const errorsOf = (env: Record<string, string | undefined>) => validateEnv(env).errors.join('\n');

test('isNonProductionRuntime is true only for exact development/test', () => {
  assert.equal(isNonProductionRuntime({ NODE_ENV: 'development' }), true);
  assert.equal(isNonProductionRuntime({ NODE_ENV: 'test' }), true);
  for (const value of [undefined, '', 'production', 'prod', 'Production', 'staging', 'development ', 'DEVELOPMENT', 'testing']) {
    assert.equal(isNonProductionRuntime({ NODE_ENV: value }), false, `NODE_ENV=${JSON.stringify(value)}`);
    assert.equal(isProductionLikeRuntime({ NODE_ENV: value }), true);
  }
});

test('valid production env passes with no errors', () => {
  assert.deepEqual(validateEnv(prod()).errors, []);
  assert.deepEqual(assertValidEnv(prod({ ADMIN_API_TOKEN: token })), []);
});

test('production requires DATABASE_URL (present and postgres scheme)', () => {
  assert.match(errorsOf(prod({ DATABASE_URL: undefined })), /DATABASE_URL is required/);
  assert.match(errorsOf(prod({ DATABASE_URL: '   ' })), /DATABASE_URL is required/);
  assert.match(errorsOf(prod({ DATABASE_URL: 'mysql://x' })), /postgres/);
});

test('production requires a valid base58 32-byte SOLANA_USDC_TREASURY', () => {
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: undefined })), /SOLANA_USDC_TREASURY is required/);
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: '' })), /SOLANA_USDC_TREASURY is required/);
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: 'not-base58-0OIl' })), /not a valid base58/);
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: treasury.slice(0, 30) })), /not a valid base58/);
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: `${treasury}${treasury}` })), /not a valid base58/);
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: '1'.repeat(32) })), /all-zero/);
  // base58 text of the wrong decoded length (valid alphabet, 33 bytes)
  assert.match(errorsOf(prod({ SOLANA_USDC_TREASURY: 'z'.repeat(44) })), /not a valid base58/);
});

test('base58 helpers agree with @solana/web3.js', () => {
  for (let i = 0; i < 25; i += 1) {
    const key = Keypair.generate().publicKey;
    assert.deepEqual(Array.from(decodeBase58(key.toBase58()) ?? []), Array.from(key.toBytes()));
    assert.equal(isValidSolanaAddress(key.toBase58()), true);
  }
  assert.equal(decodeBase58('0'), null);
  assert.equal(isValidSolanaAddress('11111111111111111111111111111111'), true);
});

test('production refuses sandbox, unset (defaults to sandbox) and unknown WALLET_CHAIN_MODE', () => {
  assert.match(errorsOf(prod({ WALLET_CHAIN_MODE: 'sandbox' })), /WALLET_CHAIN_MODE/);
  assert.match(errorsOf(prod({ WALLET_CHAIN_MODE: undefined })), /WALLET_CHAIN_MODE/);
  assert.match(errorsOf(prod({ WALLET_CHAIN_MODE: 'mainnet' })), /not supported/);
  assert.equal(validateEnv(prod({ WALLET_CHAIN_MODE: ' devnet ' })).errors.length, 0);
});

test('ADMIN_API_TOKEN must be >= 32 chars when set in production; unset means admin API is closed', () => {
  assert.match(errorsOf(prod({ ADMIN_API_TOKEN: 'short' })), /ADMIN_API_TOKEN must be at least 32/);
  assert.match(errorsOf(prod({ ADMIN_API_TOKEN: 'a'.repeat(31) })), /ADMIN_API_TOKEN/);
  assert.equal(validateEnv(prod({ ADMIN_API_TOKEN: 'a'.repeat(32) })).errors.length, 0);
  assert.equal(validateEnv(prod()).errors.length, 0);
  // the error never echoes the secret
  assert.ok(!errorsOf(prod({ ADMIN_API_TOKEN: 'sekret-value' })).includes('sekret-value'));
});

test('unknown / unset NODE_ENV is production-like: strict requirements apply and a warning is logged', () => {
  for (const NODE_ENV of [undefined, 'staging', 'prod', 'Production']) {
    const bare = validateEnv({ NODE_ENV });
    assert.match(bare.errors.join('\n'), /DATABASE_URL is required/, `NODE_ENV=${NODE_ENV}`);
    assert.match(bare.errors.join('\n'), /SOLANA_USDC_TREASURY/);
    assert.match(bare.errors.join('\n'), /WALLET_CHAIN_MODE/);
    assert.match(bare.warnings.join('\n'), /not one of development\|test\|production/);
  }
  assert.ok(!validateEnv(prod()).warnings.some((w) => /NODE_ENV/.test(w)));
});

test('development and test do not require production settings and do not warn about NODE_ENV', () => {
  for (const NODE_ENV of ['development', 'test']) {
    const result = validateEnv({ NODE_ENV });
    assert.deepEqual(result, { errors: [], warnings: [] });
  }
  assert.match(validateEnv({ NODE_ENV: 'development', ADMIN_API_TOKEN: 'short' }).warnings.join(), /ADMIN_API_TOKEN/);
});

test('live-funds flags are refused without the exact acknowledgement (every environment)', () => {
  for (const NODE_ENV of ['production', 'development', 'test']) {
    const base = NODE_ENV === 'production' ? prod() : { NODE_ENV };
    for (const flag of ['ENABLE_SOLANA_MAINNET', 'ENABLE_LIVE_CRYPTO_PAYMENTS']) {
      assert.match(errorsOf({ ...base, [flag]: 'true' }), new RegExp(`${flag}.*WALLET_LIVE_ACKNOWLEDGED`), `${NODE_ENV}/${flag}`);
      for (const wrong of ['true', 'yes', 'i_accept_live_funds_risk', `${LIVE_FUNDS_ACK_VALUE} `, '']) {
        assert.match(errorsOf({ ...base, [flag]: 'true', WALLET_LIVE_ACKNOWLEDGED: wrong }), /WALLET_LIVE_ACKNOWLEDGED/, `wrong ack ${JSON.stringify(wrong)}`);
      }
      // The acknowledgement satisfies only the acknowledgement rule. Whether the live flag itself is acceptable (production-like
      // runtime, mainnet network, ...) is decided by the network checks: see solana-network.env.test.ts for the full mainnet setup.
      const ok = validateEnv({ ...base, [flag]: 'true', WALLET_LIVE_ACKNOWLEDGED: LIVE_FUNDS_ACK_VALUE });
      assert.doesNotMatch(ok.errors.join('\n'), /WALLET_LIVE_ACKNOWLEDGED/);
      assert.match(ok.warnings.join('\n'), /LIVE FUNDS ENABLED/);
    }
  }
});

test('live-funds gate also catches sloppy truthy spellings the runtime would ignore', () => {
  for (const value of [' TRUE', 'True', '1', 'yes', 'on']) {
    assert.match(errorsOf({ NODE_ENV: 'test', ENABLE_SOLANA_MAINNET: value }), /ENABLE_SOLANA_MAINNET/, value);
  }
  for (const value of ['false', '0', '', 'no']) assert.deepEqual(validateEnv({ NODE_ENV: 'test', ENABLE_SOLANA_MAINNET: value }).errors, []);
  const both = errorsOf({ NODE_ENV: 'test', ENABLE_SOLANA_MAINNET: 'true', ENABLE_LIVE_CRYPTO_PAYMENTS: 'true' });
  assert.match(both, /ENABLE_SOLANA_MAINNET and ENABLE_LIVE_CRYPTO_PAYMENTS/);
});

test('a stray acknowledgement without a live flag only warns', () => {
  const result = validateEnv({ NODE_ENV: 'test', WALLET_LIVE_ACKNOWLEDGED: LIVE_FUNDS_ACK_VALUE });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(), /no live-funds flag/);
});

test('HTTP surface settings are validated: STOREFRONT_ORIGIN, TRUST_PROXY, PORT, throttle limits', () => {
  assert.match(errorsOf({ NODE_ENV: 'test', STOREFRONT_ORIGIN: '*' }), /wildcards/);
  assert.match(errorsOf({ NODE_ENV: 'test', STOREFRONT_ORIGIN: 'https://ok.example,https://*.evil.example' }), /wildcards/);
  assert.match(errorsOf({ NODE_ENV: 'test', TRUST_PROXY: 'true' }), /TRUST_PROXY=true/);
  assert.match(errorsOf({ NODE_ENV: 'test', TRUST_PROXY: 'garbage!' }), /TRUST_PROXY/);
  assert.match(errorsOf({ NODE_ENV: 'test', PORT: '70000' }), /PORT/);
  assert.match(errorsOf({ NODE_ENV: 'test', PORT: 'abc' }), /PORT/);
  assert.match(errorsOf({ NODE_ENV: 'test', THROTTLE_MONEY_LIMIT: '0' }), /THROTTLE_MONEY_LIMIT/);
  assert.match(errorsOf({ NODE_ENV: 'test', THROTTLE_DEFAULT_LIMIT: '1e3' }), /THROTTLE_DEFAULT_LIMIT/);
  assert.deepEqual(validateEnv({ NODE_ENV: 'test', STOREFRONT_ORIGIN: 'http://localhost:3000', TRUST_PROXY: '1', PORT: '3001', THROTTLE_AUTH_LIMIT: '5' }).errors, []);
});

test('production warnings: missing STOREFRONT_ORIGIN, plain-http origin, docs exposed', () => {
  assert.match(validateEnv(prod({ STOREFRONT_ORIGIN: undefined })).warnings.join(), /STOREFRONT_ORIGIN is unset/);
  assert.match(validateEnv(prod({ STOREFRONT_ORIGIN: 'http://shop.example.com' })).warnings.join(), /plain http/);
  assert.match(validateEnv(prod({ ENABLE_API_DOCS: 'true' })).warnings.join(), /ENABLE_API_DOCS/);
});

test('assertValidEnv throws EnvValidationError listing every problem and returns warnings otherwise', () => {
  assert.throws(
    () => assertValidEnv({ NODE_ENV: 'production' }),
    (error: unknown) => {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(error.errors.length >= 3);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /SOLANA_USDC_TREASURY/);
      return true;
    },
  );
  assert.deepEqual(assertValidEnv({ NODE_ENV: 'test' }), []);
});
