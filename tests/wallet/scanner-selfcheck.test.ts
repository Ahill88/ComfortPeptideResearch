/**
 * Self-checks for the heuristic scanners used by the other wallet QA files.
 * A static scan that cannot fail proves nothing, so this file feeds the scanners known-bad and known-good
 * fixtures (in memory; nothing here touches application code).
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/scanner-selfcheck.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CUSTODY_RULES, FLAG_CAMEL_NAMES, FLAG_ENV_NAMES, assignsFlagTrue, findNetworkCalls, leaksSecret, scanPaidClaims, stripComments } from './_helpers';

const custodyHits = (code: string) => {
  const src = stripComments(code);
  return CUSTODY_RULES.filter((r) => new RegExp(r.re.source, r.re.flags).test(src)).map((r) => r.name);
};

test('stripComments: removes // and /* */ comments, keeps strings and line numbers', () => {
  const src = "const a = 'http://x'; // Keypair.generate()\n/* secretKey\n   mnemonic */ const b = `//not a comment`;\n";
  const out = stripComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(out.includes("'http://x'"));
  assert.ok(out.includes('`//not a comment`'));
  assert.ok(!/Keypair|secretKey|mnemonic/.test(out));
});

test('custody rules: flag every forbidden construct', () => {
  const bad: [string, string][] = [
    ['Keypair.fromSecretKey', 'const k = Keypair.fromSecretKey(bytes);'],
    ['Keypair.fromSeed', 'Keypair.fromSeed(s)'],
    ['Keypair.generate', 'const k = Keypair.generate();'],
    ['new Keypair(', 'new Keypair({ publicKey, secretKey })'],
    ['secretKey / SECRET_KEY identifier', 'const k = process.env.SOLANA_SECRET_KEY;'],
    ['secretKey / SECRET_KEY identifier', 'wallet.secretKey'],
    ['privateKey / PRIVATE_KEY identifier', 'process.env.WALLET_PRIVATE_KEY'],
    ['privateKey / PRIVATE_KEY identifier', 'privateKeyToAccount(k)'],
    ['mnemonic', 'const m = process.env.TREASURY_MNEMONIC;'],
    ['seed phrase / wallet seed', 'const seedPhrase = x;'],
    ['env read of *SEED*', 'process.env.WALLET_SEED_HEX'],
    ['HD derivation / bip39', "import * as bip39 from 'bip39';"],
    ['transaction/message signing call', 'tx.partialSign(kp)'],
    ['transaction/message signing call', 'await wallet.signTransaction(tx)'],
    ['.sign( call', 'transaction.sign(payer)'],
    ['.sign( call', 'tx.sign([kp])'],
    ['nacl.sign( / nacl.sign.detached( / nacl.sign.keyPair', 'nacl.sign.detached(msg, sk)'],
    ['nacl.sign( / nacl.sign.detached( / nacl.sign.keyPair', 'nacl.sign(msg, sk)'],
    ['nacl.sign( / nacl.sign.detached( / nacl.sign.keyPair', 'nacl.sign.keyPair()'],
  ];
  for (const [rule, code] of bad) assert.ok(custodyHits(code).includes(rule), `rule "${rule}" should flag: ${code} (got ${JSON.stringify(custodyHits(code))})`);
});

test('custody rules: do not flag legitimate constructs', () => {
  const good = [
    'nacl.sign.detached.verify(message, signature, publicKey)',
    'this.jwt.sign(payload)',
    'jwtService.sign({ sub })',
    'createHmac("sha256", x).update(y).digest("base64")',
    'const k = new PublicKey(address); PublicKey.unique();',
    'const signedTransactionBase64 = body.signedTransactionBase64;',
    'tx.verifySignatures(); tx.serialize({ requireAllSignatures: true })',
    '// Keypair.generate() is forbidden here\nconst x = 1;',
    '/* secretKey */ const y = 2;',
    'const designed = assignedSeeds;',
  ];
  for (const code of good) assert.deepEqual(custodyHits(code), [], `should NOT flag: ${code}`);
});

test('leaksSecret: flags serialization of secret material', () => {
  const bad = [
    'fetch(u, { method: "POST", body: JSON.stringify({ secretKey }) })',
    'fetch(u, { body: JSON.stringify({ secretKey: kp.secretKey }) })',
    'fetch(u, { body: JSON.stringify({ seed: s }) })',
    'fetch(u, { body: JSON.stringify({ mnemonic }) })',
    'fetch(u, { body: JSON.stringify({ "privateKey": k }) })',
    'fetch(u, { body: JSON.stringify(kp.secretKey) })',
    'fetch(u, { body: kp.secretKey })',
    'fetch(u, { body: JSON.stringify({ k: bs58.encode(kp.secretKey) }) })',
    'fetch(u, { body: JSON.stringify({ k: Array.from(kp.secretKey) }) })',
  ];
  for (const code of bad) assert.ok(leaksSecret(code), `should flag: ${code}`);
});

test('leaksSecret: does not flag sending a locally produced signature or ordinary payloads', () => {
  const good = [
    'fetch(u, { body: JSON.stringify({ signedTransactionBase64: sign(tx, kp.secretKey) }) })',
    'fetch(u, { body: JSON.stringify({ intendedUsdCents: 1999, destinationAddress }) })',
    'fetch(u, { headers: { "x-customer-email": email } })',
    'fetch(u)',
  ];
  for (const code of good) assert.equal(leaksSecret(code), null, `should NOT flag: ${code}`);
});

test('findNetworkCalls: catches direct, inline-helper and variable-carried leaks; ignores signature uploads', () => {
  const run = (code: string) => findNetworkCalls('fixture.ts', code).map((c) => c.leak);
  assert.ok(run("await fetch('/api', { method: 'POST', body: JSON.stringify({ secretKey }) });")[0], 'direct');
  assert.ok(run("const payload = { secretKey: kp.secretKey };\nawait fetch('/api', { method: 'POST', body: JSON.stringify(payload) });")[0], 'via variable object');
  assert.ok(run("const body = kp.secretKey;\nawait fetch('/api', { method: 'POST', body });")[0], 'via bare reference variable');
  assert.ok(run("await apiPost('/x', { seed });")[0], 'api helper');
  assert.equal(run("const sig = sign(tx, kp.secretKey);\nawait fetch('/api', { method: 'POST', body: JSON.stringify({ signedTransactionBase64: sig }) });")[0], null, 'signature only');
  assert.equal(run("// fetch('/x', { body: JSON.stringify({ secretKey }) })\nconst a = 1;").length, 0, 'comments are ignored');
  assert.equal(run("const a = 1;").length, 0, 'no calls');
});

test('assignsFlagTrue: detects real assignments, ignores prose', () => {
  const names = [...FLAG_ENV_NAMES, ...FLAG_CAMEL_NAMES];
  const yes = [
    'ENABLE_REAL_MOONPAY=true',
    'export ENABLE_SOLANA_MAINNET=true',
    'ENV ENABLE_LIVE_FULFILLMENT=true',
    '  - ENABLE_DELEGATED_PAYMENTS=true',
    "  - 'ENABLE_REAL_MOONPAY=true'",
    "process.env.ENABLE_REAL_MOONPAY = 'true';",
    "env['ENABLE_REAL_MOONPAY'] = 'true'",
    'ENABLE_REAL_MOONPAY: "true"',
    '  ENABLE_LIVE_CRYPTO_PAYMENTS: true',
    '"ENABLE_REAL_MOONPAY": "true",',
    'const flags = { enableRealMoonpay: true };',
    'enableSolanaMainnet:true',
  ];
  for (const line of yes) assert.ok(assignsFlagTrue(line, names), `should detect: ${line}`);
  const no = [
    'ENABLE_REAL_MOONPAY=false',
    'ENABLE_REAL_MOONPAY=',
    'ENABLE_REAL_MOONPAY=truely',
    "throw new Error('Solana mainnet is disabled: set ENABLE_SOLANA_MAINNET=true to allow it (default false).');",
    "throw new ServiceUnavailableException('A live MoonPay key requires ENABLE_SOLANA_MAINNET=true');",
    "if (env.ENABLE_REAL_MOONPAY === 'true') {",
    "const on = (v) => v === 'true';",
    'enableRealMoonpay: boolean;',
    'enableRealMoonpay: false,',
  ];
  for (const line of no) assert.ok(!assignsFlagTrue(line, names), `should NOT detect: ${line}`);
});

test('scanPaidClaims: flags paid/confirmed claims not gated on finalized', () => {
  const bad = [
    "<p>Payment confirmed.</p>",
    "<Notice title=\"Payment confirmed\">Thanks</Notice>",
    "const label = 'Order paid';",
    "{stage.kind === 'submitted' ? <p>Your order is paid</p> : null}",
    "{status === 'CONFIRMED' && <Badge>Confirmed</Badge>}",
    "const m = { submitted: 'Paid' };",
    "if (['pending','confirmed'].includes(s)) return 'finalized';",
    "case 'confirmed':\n  return 'paid';",
    "const map = { confirmed: 'finalized' };",
  ];
  for (const code of bad) assert.ok(scanPaidClaims(code).length > 0, `should flag: ${code}`);
});

test('scanPaidClaims: accepts honest wording and finalized-gated text', () => {
  const good = [
    "<p>Your order is not marked paid until the transfer is finalized.</p>",
    "<p>The network fee is paid in SOL from your wallet.</p>",
    "empty=\"No research purchases paid with Research Credits yet.\"",
    "{state.kind === 'finalized' ? <Notice title=\"Payment finalized\">Your order is paid.</Notice> : null}",
    "{kind === 'finalized' && (\n  <p>\n    Your order is paid\n  </p>\n)}",
    "if (['pending', 'submitted', 'confirmed'].includes(s)) return 'pending';",
    "if (['finalized', 'paid'].includes(s)) return 'finalized';",
    "// Payment confirmed\nconst x = 1;",
    "const isConfirmed = confirmed;",
    "const confirmed = list.length;",
    "{phase === 'failed' ? `Payment ${raw}. Your order is not paid.` : null}",
  ];
  for (const code of good) assert.deepEqual(scanPaidClaims(code), [], `should NOT flag: ${code}`);
});
