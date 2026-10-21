import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadEmailConfig, type EmailProviderName } from '../email.config';
import { EmailConfigError } from '../email.errors';
import { buildStorefrontLink } from '../email.links';
import { createEmailProvider } from '../email.provider';

const KEY = 're_test_0123456789abcdefghij';
const resendEnv = { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: KEY, EMAIL_FROM: 'Helix & Field <orders@example.com>' };

test('provider default matrix: console in development/test; none in production, unset, unknown and miscased runtimes', () => {
  const expected: [string | undefined, EmailProviderName][] = [
    ['development', 'console'], ['test', 'console'], ['production', 'none'], [undefined, 'none'], ['staging', 'none'], ['Production', 'none'], ['prod', 'none'], ['', 'none'],
  ];
  for (const [nodeEnv, provider] of expected) assert.equal(loadEmailConfig({ NODE_ENV: nodeEnv }).provider, provider, String(nodeEnv));
});

test('explicit EMAIL_PROVIDER wins in any runtime (case-insensitive, blank means default); unknown values stop startup', () => {
  assert.equal(loadEmailConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' }).provider, 'console');
  assert.equal(loadEmailConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'NONE' }).provider, 'none');
  assert.equal(loadEmailConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: '  ' }).provider, 'console');
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'smtp' }), (e: any) => e instanceof EmailConfigError && /EMAIL_PROVIDER must be one of/.test(e.message));
});

test('resend requires EMAIL_API_KEY and a valid EMAIL_FROM; errors list every problem and never echo values', () => {
  for (const nodeEnv of ['development', 'production']) {
    const ok = loadEmailConfig({ NODE_ENV: nodeEnv, ...resendEnv });
    assert.equal(ok.provider, 'resend');
    assert.equal(ok.apiKey, KEY);
    assert.equal(ok.from, 'Helix & Field <orders@example.com>');
  }
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend' }), (e: any) => /EMAIL_API_KEY is required/.test(e.message) && /EMAIL_FROM is required/.test(e.message));
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'production', ...resendEnv, EMAIL_API_KEY: '' }), /EMAIL_API_KEY is required/);
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'production', ...resendEnv, EMAIL_FROM: '' }), /EMAIL_FROM is required/);
  for (const badFrom of ['not-an-address', 'Name <nope>', 'a@b.co\r\nBcc: x@y.co', '<a@b.co>']) {
    assert.throws(() => loadEmailConfig({ NODE_ENV: 'production', ...resendEnv, EMAIL_FROM: badFrom }), (e: any) => e instanceof EmailConfigError && /EMAIL_FROM must be a valid address/.test(e.message) && !e.message.includes('Bcc'), badFrom);
  }
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'production', ...resendEnv, EMAIL_API_KEY: 'has space' }), (e: any) => !e.message.includes('has space'));
  try {
    loadEmailConfig({ NODE_ENV: 'production', ...resendEnv, EMAIL_FROM: 'bad' });
  } catch (error) {
    assert.ok(!(error as Error).message.includes(KEY), 'the key must never appear in an error');
  }
});

test('console and none ignore the key and sender (not retained in config); a malformed EMAIL_FROM still stops startup', () => {
  const c = loadEmailConfig({ NODE_ENV: 'development', EMAIL_API_KEY: KEY, EMAIL_FROM: 'a@example.com' });
  assert.equal(c.apiKey, null);
  assert.equal(c.from, null);
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'development', EMAIL_FROM: 'broken' }), /EMAIL_FROM/);
});

test('worker interval: default 5000, 0 disables, 100..3600000 accepted, anything else stops startup', () => {
  assert.equal(loadEmailConfig({ NODE_ENV: 'test' }).workerIntervalMs, 5000);
  assert.equal(loadEmailConfig({ NODE_ENV: 'test', EMAIL_WORKER_INTERVAL_MS: '0' }).workerIntervalMs, 0);
  assert.equal(loadEmailConfig({ NODE_ENV: 'test', EMAIL_WORKER_INTERVAL_MS: '100' }).workerIntervalMs, 100);
  assert.equal(loadEmailConfig({ NODE_ENV: 'test', EMAIL_WORKER_INTERVAL_MS: ' 250 ' }).workerIntervalMs, 250);
  assert.equal(loadEmailConfig({ NODE_ENV: 'test', EMAIL_WORKER_INTERVAL_MS: '' }).workerIntervalMs, 5000);
  for (const bad of ['-1', '99', '3600001', '1.5', 'abc', '1e3', '5s']) assert.throws(() => loadEmailConfig({ NODE_ENV: 'test', EMAIL_WORKER_INTERVAL_MS: bad }), /EMAIL_WORKER_INTERVAL_MS/, bad);
});

test('dev files and directory are development/test only', () => {
  const dev = loadEmailConfig({ NODE_ENV: 'development', EMAIL_DEV_OUTBOX_DIR: '/tmp/custom-mail' });
  assert.equal(dev.devFiles, true);
  assert.equal(dev.devOutboxDir, '/tmp/custom-mail');
  assert.equal(loadEmailConfig({ NODE_ENV: 'test' }).devOutboxDir, '/tmp/helix-dev-mail');
  for (const nodeEnv of ['production', undefined, 'staging']) {
    const c = loadEmailConfig({ NODE_ENV: nodeEnv, EMAIL_PROVIDER: 'console', EMAIL_DEV_OUTBOX_DIR: '/tmp/custom-mail' });
    assert.equal(c.devFiles, false, String(nodeEnv));
    assert.equal(c.devOutboxDir, '/tmp/helix-dev-mail');
  }
});

test('createEmailProvider: console and resend build a transport, none builds null (worker warns and sends nothing)', () => {
  assert.equal(createEmailProvider(loadEmailConfig({ NODE_ENV: 'test' }))?.name, 'console');
  assert.equal(createEmailProvider(loadEmailConfig({ NODE_ENV: 'production', ...resendEnv }))?.name, 'resend');
  assert.equal(createEmailProvider(loadEmailConfig({ NODE_ENV: 'production' })), null);
});

test('STOREFRONT_PUBLIC_URL: normalised to an origin, optional, http(s) only; link helper encodes the token', () => {
  assert.equal(loadEmailConfig({ NODE_ENV: 'test', STOREFRONT_PUBLIC_URL: 'https://shop.example.com/some/path/' }).storefrontUrl, 'https://shop.example.com');
  assert.equal(loadEmailConfig({ NODE_ENV: 'test' }).storefrontUrl, null);
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'test', STOREFRONT_PUBLIC_URL: 'javascript:alert(1)' }), /STOREFRONT_PUBLIC_URL/);
  assert.throws(() => loadEmailConfig({ NODE_ENV: 'test', STOREFRONT_PUBLIC_URL: 'shop.example.com' }), /STOREFRONT_PUBLIC_URL/);
  const env = { STOREFRONT_PUBLIC_URL: 'https://shop.example.com/' };
  assert.equal(buildStorefrontLink('verify-email', 'a+b/c=', env), 'https://shop.example.com/verify-email?token=a%2Bb%2Fc%3D');
  assert.equal(buildStorefrontLink('reset-password', 'tok', env), 'https://shop.example.com/reset-password?token=tok');
  assert.equal(buildStorefrontLink('reset-password', 'tok', {}), null);
  assert.equal(buildStorefrontLink('reset-password', 'tok', { STOREFRONT_PUBLIC_URL: 'javascript:1' }), null);
});
