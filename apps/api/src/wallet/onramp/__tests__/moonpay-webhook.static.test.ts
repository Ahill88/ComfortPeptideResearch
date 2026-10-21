import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = join(__dirname, '..');
const files = readdirSync(DIR).filter((f) => /^moonpay-webhook\..*\.ts$/.test(f));
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
/** Comments replaced by spaces; string contents are kept. */
const code = (name: string) => read(name).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');

test('the webhook source files exist (signature, config, service, controller)', () => {
  assert.deepEqual(files.sort(), ['moonpay-webhook.config.ts', 'moonpay-webhook.controller.ts', 'moonpay-webhook.service.ts', 'moonpay-webhook.signature.ts']);
});

test('secret-free naming: the word "secret" appears nowhere in the webhook code or comments (the URL-signing credential is a different one)', () => {
  for (const name of files) assert.doesNotMatch(read(name), /secret/i, name);
});

test('the webhook key is read only by the config loader, and only from MOONPAY_WEBHOOK_KEY / MOONPAY_WEBHOOK_TOLERANCE_SECONDS', () => {
  for (const name of files) {
    const src = code(name);
    if (name === 'moonpay-webhook.config.ts') {
      const vars = [...new Set([...src.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
      assert.deepEqual(vars, ['MOONPAY_WEBHOOK_KEY', 'MOONPAY_WEBHOOK_TOLERANCE_SECONDS']);
      assert.doesNotMatch(src, /MOONPAY_(?!WEBHOOK)\w*/, 'config must not read any other MoonPay variable');
    } else if (name === 'moonpay-webhook.controller.ts') {
      // the only environment access is the runtime-kind check used for a startup warning
      assert.deepEqual([...src.matchAll(/process\.env/g)].length, 1);
      assert.match(src, /isNonProductionRuntime\(process\.env\)/);
    } else {
      assert.doesNotMatch(src, /process\.env|\benv\./, `${name} must not read the environment`);
    }
  }
});

test('INVARIANT (static): the service never touches money tables, chain clients, credits or orders; only OnRampIntent and WalletAuditEvent', () => {
  const src = code('moonpay-webhook.service.ts');
  const models = new Set([...src.matchAll(/\b(?:tx|prisma|this\.prisma)\.(\w+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany|findUnique|findFirst|findMany|count|aggregate)\b/g)].map((m) => m[1]));
  assert.deepEqual([...models].sort(), ['onRampIntent', 'walletAuditEvent']);
  assert.doesNotMatch(src, /\bcryptoTransaction\b|balanceSnapshot|creditReservation|delegatedPermission|\border\b|\bpayments?\b|ledger|CreditsService|WalletService|OnRampService|OrderTopUp|SolanaChain|SOLANA_CHAIN|@solana|\bchain\b|\bfetch\s*\(|https?:\/\/|\bcredit\w*\s*\(|markPaid|balance/i);
  // raw SQL is limited to the one row lock
  const raw = [...src.matchAll(/\$(?:queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)/g)].length;
  assert.equal(raw, 1);
  assert.match(src, /FOR UPDATE/);
  // the only OnRampIntent write is the status/externalReference update
  assert.equal([...src.matchAll(/onRampIntent\.(?:create|update|updateMany|upsert|delete|deleteMany)\b/g)].length, 1);
  assert.deepEqual([...src.matchAll(/data\.(\w+)\s*=/g)].map((m) => m[1]).sort(), ['externalReference', 'status']);
  const controller = code('moonpay-webhook.controller.ts');
  assert.doesNotMatch(controller, /prisma|cryptoTransaction|CreditsService|SolanaChain|SOLANA_CHAIN|OnRampService/i);
});

test('the route is authenticated only by its signature: no identity/admin guard, and no identity header is read', () => {
  const controller = code('moonpay-webhook.controller.ts');
  assert.doesNotMatch(controller, /@UseGuards|AdminTokenGuard|CustomerEmail|x-customer-email|x-admin-token/i);
  assert.match(controller, /@Controller\('webhooks'\)/);
  assert.match(controller, /@Post\('moonpay'\)/);
  assert.match(controller, /@Throttle\(/, 'a dedicated throttle bucket is declared (see the comment on MOONPAY_WEBHOOK_THROTTLE)');
});

test('verification uses a constant-time comparison on equal-length buffers and the V2 header only', () => {
  const src = code('moonpay-webhook.signature.ts');
  assert.match(src, /timingSafeEqual\(parsed\.mac, expected\)/);
  assert.match(src, /length !== expected\.length/);
  assert.doesNotMatch(src, /===\s*(?:expected|parsed\.mac|input\.mac)\b|(?:expected|parsed\.mac)\s*===/, 'no ordinary equality on MACs');
  assert.match(src, /'moonpay-signature-v2'/);
  assert.doesNotMatch(src, /['"]moonpay-signature['"]/i, 'the legacy header is not consulted');
});

test('request logging redacts both MoonPay signature headers (pino-http would otherwise log every request header)', () => {
  const appModule = readFileSync(join(__dirname, '..', '..', '..', 'app.module.ts'), 'utf8');
  assert.match(appModule, /redact:\s*\{[^}]*req\.headers\["moonpay-signature-v2"\]/);
  assert.match(appModule, /redact:\s*\{[^}]*req\.headers\["moonpay-signature"\]/);
});
