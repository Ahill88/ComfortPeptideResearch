/**
 * (2) STATIC CUSTODY INVARIANTS. Scans the repo as it exists when run; never imports application code.
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/custody-invariants.test.ts
 *
 * These are heuristic text scans (see docs/testing/wallet-qa.md "Limits of static scans").
 * A hit is a failure: fix the source, do not weaken the rule.
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  API_SRC, CUSTODY_RULES, assignsFlagTrue, FLAG_CAMEL_NAMES, FLAG_ENV_NAMES, PRISMA_SCHEMA, ROOT, SF_WALLET_COMPONENTS, SF_WALLET_LIB, STOREFRONT,
  WALLET_ADMIN_SRC, WALLET_SRC, declarationRhs, exists, extractParenGroup, findNetworkCalls, formatHits, isMoonpayFile, isTestFile,
  lineNumberAt, listSourceFiles, notYetImplemented, projectFiles, read, rel, requireDir, scanRules, stripComments,
} from './_helpers';

const API_FILES = () => listSourceFiles(API_SRC, ['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const moonpayFiles = () => listSourceFiles(WALLET_SRC).filter(isMoonpayFile);

/* ------------------------- no key material anywhere in API ------------------------- */

test('custody: apps/api/src (non-test) never generates, loads, holds or uses private keys / seeds / signing', () => {
  const files = API_FILES();
  assert.ok(files.length > 0, 'scan covered zero files; apps/api/src path is wrong');
  const hits = scanRules(files, CUSTODY_RULES, {
    // The ONLY allowance: MOONPAY_SECRET_KEY on a line inside a moonpay provider file (URL HMAC).
    allow: (hit) => (hit.rule.startsWith('secretKey') && isMoonpayLine(hit)) || isImportFreeDenylist(hit) || isSponsorSignerAllowance(hit),
  });
  assert.equal(hits.length, 0, `custody violations (platform must never touch private keys):\n${formatHits(hits)}`);
});

/*
 * NARROW EXTENSION for network-fee sponsorship (owner-approved product decision; see docs/wallet/custody-model.md).
 * The platform now signs ONE thing: the network-fee payer's signature, through the FeePayerSigner port. Exactly two
 * hits are tolerated, each pinned to one file and one statement, and the tests after this block pin what those two
 * files must look like so the allowance cannot quietly widen:
 *   1. chain/sandbox-fee-payer-signer.ts: `pair.privateKey` (the sandbox-only in-memory key; rule 'privateKey identifier').
 *   2. checkout/fee-payer-signer.port.ts: `signer.signMessage(message)` (the single call into the bound KMS/HSM signer).
 * Nothing else (no Keypair, no secretKey, no .sign( / .partialSign( / nacl) is allowed anywhere else.
 *
 * WHY THE PORT'S SINGLE CALL SITE IS SAFE: a fee-payer signature can authorize only the payment of the network fee, and
 * nothing else, because CheckoutService asserts (assertSponsorOnlyPaysFee on the compiled message, before the claim and
 * again immediately before asking for the signature) that the fee payer is account index 0 and appears in NO instruction
 * account list, nor as a program. A signature by an account that no instruction references cannot move USDC or SOL out of
 * any account; the customer's wallet remains the USDC authority and must sign itself. The static test below pins that
 * the service keeps making that assertion in front of the signing call.
 */
const SANDBOX_SIGNER_FILE = 'apps/api/src/wallet/chain/sandbox-fee-payer-signer.ts';
const FEE_PAYER_PORT_FILE = 'apps/api/src/wallet/checkout/fee-payer-signer.port.ts';
function isSponsorSignerAllowance(hit: { file: string; rule: string; text: string }): boolean {
  const file = rel(absoluteHitPath(hit.file));
  if (file === SANDBOX_SIGNER_FILE) return hit.rule.startsWith('privateKey') && /^this\.#key\s*=\s*pair\.privateKey;$/.test(hit.text);
  if (file === FEE_PAYER_PORT_FILE) return hit.rule.startsWith('transaction/message signing') && /^signature\s*=\s*await signer\.signMessage\(message\);$/.test(hit.text);
  return false;
}

test('custody: the fee-payer signing allowance is confined to the port helper and the sandbox-only in-memory signer', () => {
  const files = API_FILES();
  // 1. Only the sandbox signer generates a key, and only wallet.wiring.ts (a non-test file) constructs it.
  const generating = files.filter((f) => /\bgenerateKeyPair(?:Sync)?\s*\(/.test(stripComments(read(f)))).map(rel);
  assert.deepEqual(generating, [SANDBOX_SIGNER_FILE], `only the sandbox signer may generate a key; found: ${generating.join(', ')}`);
  const constructing = files.filter((f) => /\bnew\s+SandboxFeePayerSigner\b/.test(stripComments(read(f)))).map(rel).sort();
  assert.deepEqual(constructing, ['apps/api/src/wallet/wallet.wiring.ts'], 'only wallet.wiring.ts may construct the sandbox signer');
  // 2. The only implementation of the port in this repository is the sandbox one; the only call into a signer is the port helper.
  const implementing = files.filter((f) => /\bimplements\s+FeePayerSigner\b/.test(stripComments(read(f)))).map(rel);
  assert.deepEqual(implementing, [SANDBOX_SIGNER_FILE], `no production FeePayerSigner implementation may ship in apps/api/src; found: ${implementing.join(', ')}`);
  const calls = files.filter((f) => /\.\s*signMessage\s*\(/.test(stripComments(read(f)))).map(rel);
  assert.deepEqual(calls, [FEE_PAYER_PORT_FILE], `signMessage may be called only by the port helper; found: ${calls.join(', ')}`);
  // 3. The sandbox signer must keep its guards and must not load, persist or expose key material.
  // The only environment access tolerated is the injectable default `env: EnvLike = process.env` fed to the runtime gate.
  const src = stripComments(read(path.join(ROOT, SANDBOX_SIGNER_FILE))).replace('env: EnvLike = process.env', 'env: EnvLike');
  assert.match(src, /isSandboxAllowed\s*\(/, 'sandbox signer must be gated by isSandboxAllowed');
  assert.match(src, /isNonProductionRuntime\s*\(/, 'sandbox signer must be gated by isNonProductionRuntime');
  assert.match(src, /throw new Error\(/, 'sandbox signer must refuse to construct outside development/test');
  assert.match(src, /readonly #key\b/, 'the key must live in a true private field');
  assert.doesNotMatch(src, /\bfs\b|readFile|writeFile|process\.env|\benv\s*\.|JSON\.stringify|console\.|logger|export\s*\{|toString\s*\(\s*['"`]base58|secret/i, 'sandbox signer must not read/write files or env keys, log, serialize or expose key material');
  assert.equal((src.match(/^export\b/gm) ?? []).length, 2, 'sandbox signer file exports only the class and the sandbox lamports constant');
  // 3b. The service asserts "fee payer is in no instruction" before it may ask for a fee-payer signature.
  const service = stripComments(read(path.join(ROOT, 'apps/api/src/wallet/checkout/checkout.service.ts')));
  const signing = service.slice(service.indexOf('private async signAsFeePayer'));
  assert.ok(signing.indexOf('assertSponsorOnlyPaysFee(') > 0 && signing.indexOf('assertSponsorOnlyPaysFee(') < signing.indexOf('requestFeePayerSignature('), 'assertSponsorOnlyPaysFee must run before requestFeePayerSignature');
  const requesting = files.filter((f) => /\brequestFeePayerSignature\s*\(/.test(stripComments(read(f)))).map(rel).sort();
  assert.deepEqual(requesting, ['apps/api/src/wallet/checkout/checkout.service.ts', FEE_PAYER_PORT_FILE].sort(), 'only the checkout service may request a fee-payer signature');
  // 4. The port file holds no key material and no implementation, and the platform never types the word "secret" there.
  const port = stripComments(read(path.join(ROOT, FEE_PAYER_PORT_FILE)));
  assert.doesNotMatch(port, /secret|generateKeyPair|Keypair|createPrivateKey|process\.env|\bfs\b/i, 'the port must hold no key material');
});

// MoonPay's URL-signing secret may be named only in the provider and in the env config loader.
const MOONPAY_SECRET_FILES = ['apps/api/src/wallet/wallet.config.ts'];
// Scan hits may carry repo-relative paths; normalize before comparing or reading.
const absoluteHitPath = (file: string) => (path.isAbsolute(file) ? file : path.join(ROOT, file));
function isMoonpayLine(hit: { file: string; text: string }): boolean {
  const allowedFile = isMoonpayFile(hit.file) || MOONPAY_SECRET_FILES.includes(rel(absoluteHitPath(hit.file)));
  return allowedFile && /\bMOONPAY_SECRET_KEY\b|moonpay\w*secret\w*/i.test(hit.text);
}

// secret-fields.ts is a request-body DENYLIST: it names words like "secret" only to detect and reject them.
// It is allowed solely while it has NO imports, because a file with no imports cannot sign, load keys, or do I/O.
function isImportFreeDenylist(hit: { file: string }): boolean {
  if (rel(absoluteHitPath(hit.file)) !== 'apps/api/src/wallet/secret-fields.ts') return false;
  return !/^\s*(?:import\s|const\s+\w+\s*=\s*require\()/m.test(read(absoluteHitPath(hit.file)));
}

test('custody: MOONPAY_SECRET_KEY is referenced only by the env config loader and the MoonPay provider, and only the provider signs with it', () => {
  const codeDirs = [API_SRC, path.join(STOREFRONT, 'app'), path.join(STOREFRONT, 'components'), path.join(STOREFRONT, 'lib'), path.join(ROOT, 'apps/admin'), path.join(ROOT, 'packages')];
  const referencing = codeDirs
    .flatMap((d) => listSourceFiles(d, ['.ts', '.tsx', '.js', '.mjs']))
    .filter((f) => /moonpay\w*secret|secret\w*moonpay/i.test(stripComments(read(f))));
  const names = referencing.map(rel);
  for (const f of referencing) {
    const allowedLoader = MOONPAY_SECRET_FILES.includes(rel(f));
    const allowedProvider = f.startsWith(WALLET_SRC) && isMoonpayFile(f);
    assert.ok(allowedLoader || allowedProvider, `MOONPAY_SECRET_KEY may only be referenced by the env loader or the moonpay provider; found in ${rel(f)} (all hits: ${names.join(', ')})`);
  }
  const providers = referencing.filter((f) => isMoonpayFile(f));
  assert.ok(providers.length <= 1, `exactly one MoonPay provider file may use the secret; found: ${providers.map(rel).join(', ')}`);
  // Names that appear inside string literals (e.g. error messages naming the variable) are not uses of the value.
  const withoutLiterals = (line: string) => line.replace(/(['"`])(?:(?!\1).)*\1/g, '""');
  for (const f of referencing) {
    const src = stripComments(read(f));
    if (isMoonpayFile(f)) {
      assert.match(src, /createHmac\s*\(\s*['"`]sha256['"`]/, `${rel(f)} uses MOONPAY_SECRET_KEY but has no createHmac('sha256', ...): it must only be used to sign the widget URL`);
    } else {
      assert.doesNotMatch(src, /createHmac|createSign|createHash/, `${rel(f)} (config loader) must only read the secret into config, never use it`);
    }
    src.split('\n').forEach((raw, i) => {
      const line = withoutLiterals(raw);
      if (/moonpay\w*secret|secret\w*moonpay/i.test(line)) {
        assert.doesNotMatch(line, /console\.|logger|\blog\b|JSON\.stringify|throw\s|res\.|return\s+\w*secret/i, `${rel(f)}:${i + 1} MOONPAY_SECRET_KEY must not be logged, thrown, serialized or returned: ${raw.trim()}`);
      }
    });
  }
});

test('custody: no frontend (storefront/admin) reference to MOONPAY_SECRET_KEY or a NEXT_PUBLIC secret/private variable', () => {
  const files = [STOREFRONT, path.join(ROOT, 'apps/admin')].flatMap((d) => listSourceFiles(d, ['.ts', '.tsx', '.js', '.mjs', '.json']));
  const hits = scanRules(files.filter((f) => !/package\.json$|tsconfig/.test(f)), [
    { name: 'MOONPAY_SECRET in frontend', re: /MOONPAY\w*SECRET/i },
    { name: 'NEXT_PUBLIC secret/private', re: /NEXT_PUBLIC_\w*(?:SECRET|PRIVATE|MNEMONIC|SEED)\w*/i },
  ]);
  assert.equal(hits.length, 0, `secrets must never be exposed to a browser bundle:\n${formatHits(hits)}`);
});

test('custody: no embedded key material (64-byte arrays, base58 secret keys, PEM) in non-test project files', () => {
  const exts = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|toml|env|example)$|(^|\/)\.env[^/]*$|(^|\/)Dockerfile[^/]*$/;
  const files = projectFiles().filter((f) => exts.test(rel(f)) && !isTestFile(f) && !/pnpm-lock|package-lock|tsconfig\.tsbuildinfo/.test(f) && !rel(f).startsWith('docs/'));
  const hits = scanRules(files, [
    { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: '64-number byte array (ed25519 secret key)', re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
    { name: 'base58 string of secret-key length (86-90 chars)', re: /['"`][1-9A-HJ-NP-Za-km-z]{86,90}['"`]/ },
  ], {
    keepComments: true,
    // A 64-byte ed25519 SIGNATURE and a 64-byte SECRET KEY have identical base58 length, so a literal is only
    // tolerated when `signature` appears within 4 lines (e.g. an OpenAPI example for a `signature` field).
    allow: (hit) => hit.rule.startsWith('base58') && nearSignatureWord(hit),
  });
  assert.equal(hits.length, 0, `embedded key material:\n${formatHits(hits)}`);
});

function nearSignatureWord(hit: { file: string; line: number }): boolean {
  const lines = read(path.join(ROOT, hit.file)).split('\n');
  return lines.slice(Math.max(0, hit.line - 5), hit.line + 4).some((l) => /signature/i.test(l));
}

/* ------------------------------------ prisma ------------------------------------ */

function parsePrismaModels(src: string): { model: string; fields: { name: string; type: string; mapped: string[]; line: number }[] }[] {
  const models: ReturnType<typeof parsePrismaModels> = [];
  const re = /^\s*model\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end === -1 ? src.length : end);
    const fields: ReturnType<typeof parsePrismaModels>[number]['fields'] = [];
    body.split('\n').forEach((raw, idx) => {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) return;
      // Handles both `name Type ...` and one-line models `a String b Int` poorly; schema uses one field per line.
      const parts = line.match(/^(\w+)\s+([\w\[\]?]+)/);
      if (!parts) return;
      const mapped = [...line.matchAll(/@map\(\s*"([^"]+)"/g)].map((x) => x[1]);
      fields.push({ name: parts[1], type: parts[2], mapped, line: lineNumberAt(src, start) + idx });
    });
    models.push({ model: m[1], fields });
  }
  return models;
}

const FORBIDDEN_COLUMN = /^(?:privatekey\w*|secretkey\w*|\w*privatekey|\w*secretkey|seed|seedphrase|seedbytes|\w+seed|mnemonic\w*|\w*mnemonic|keypair\w*|recoveryphrase|secretphrase|walletseed|signingkey\w*|encryptedkey\w*|keymaterial|keyshare\w*)$/;

test('prisma: schema has no column that can hold private keys, seeds or mnemonics (any model, incl. @map names)', () => {
  assert.ok(exists(PRISMA_SCHEMA), 'prisma schema missing');
  const models = parsePrismaModels(read(PRISMA_SCHEMA));
  assert.ok(models.length >= 5, `parsed only ${models.length} models; parser/schema problem`);
  assert.ok(models.some((m) => m.model === 'CustomerWallet'), 'CustomerWallet model must exist');
  const bad: string[] = [];
  for (const { model, fields } of models) {
    for (const f of fields) {
      for (const name of [f.name, ...f.mapped]) {
        if (FORBIDDEN_COLUMN.test(name.replace(/_/g, '').toLowerCase())) bad.push(`${model}.${f.name}${name !== f.name ? ` (@map ${name})` : ''}`);
      }
    }
  }
  assert.deepEqual(bad, [], `columns that could hold key material: ${bad.join(', ')}`);
});

test('prisma: wallet-domain models contain no Bytes column (a Bytes column could store raw key material)', () => {
  const walletModels = new Set(['CustomerWallet', 'BalanceSnapshot', 'OnRampIntent', 'CryptoTransaction', 'CreditReservation', 'DelegatedPermission', 'WalletAuditEvent']);
  const bad = parsePrismaModels(read(PRISMA_SCHEMA)).filter((m) => walletModels.has(m.model)).flatMap((m) => m.fields.filter((f) => /^Bytes/.test(f.type)).map((f) => `${m.model}.${f.name}`));
  assert.deepEqual(bad, [], `Bytes columns in wallet models: ${bad.join(', ')}`);
});

test('prisma: CustomerWallet stores a public address only (has address, and no secret-like sibling)', () => {
  const wallet = parsePrismaModels(read(PRISMA_SCHEMA)).find((m) => m.model === 'CustomerWallet');
  assert.ok(wallet, 'CustomerWallet missing');
  assert.ok(wallet.fields.some((f) => f.name === 'address'), 'CustomerWallet.address missing');
});

/* ------------------------------ storefront fetch bodies ------------------------------ */

test('storefront: no fetch/HTTP call under lib/wallet or components/wallet sends secret key / seed material', () => {
  requireDir(SF_WALLET_LIB, 'storefront wallet lib');
  requireDir(SF_WALLET_COMPONENTS, 'storefront wallet components');
  const files = [...listSourceFiles(SF_WALLET_LIB), ...listSourceFiles(SF_WALLET_COMPONENTS)];
  assert.ok(files.length > 0, 'storefront wallet dirs exist but contain no .ts/.tsx files');
  const calls = files.flatMap((f) => findNetworkCalls(f));
  const leaking = calls.filter((c) => c.leak);
  assert.equal(leaking.length, 0, `request bodies that appear to carry secret material (heuristic):\n${leaking.map((c) => `  ${c.file}:${c.line} ${c.callee}(...) -> ${c.leak}: ${c.text.replace(/\s+/g, ' ')}`).join('\n')}`);
});

/* --------------------------------- feature flags --------------------------------- */

function parseDotenv(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out.set(m[1], m[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

test('flags: .env.example declares all five feature flags and each is false', () => {
  const file = path.join(ROOT, '.env.example');
  assert.ok(exists(file), '.env.example missing');
  const env = parseDotenv(read(file));
  const missing = FLAG_ENV_NAMES.filter((n) => !env.has(n));
  assert.deepEqual(missing, [], `.env.example is missing flags (each must be present and false): ${missing.join(', ')}`);
  for (const n of FLAG_ENV_NAMES) assert.equal(env.get(n), 'false', `.env.example ${n} must default to false, got ${JSON.stringify(env.get(n))}`);
});

test('flags: .env.example holds no secret values (secret/private/mnemonic variables must be blank)', () => {
  const env = parseDotenv(read(path.join(ROOT, '.env.example')));
  const filled = [...env].filter(([k, v]) => /secret|private|mnemonic|seed|api_?key|token/i.test(k) && v !== '').map(([k]) => k);
  assert.deepEqual(filled, [], `.env.example must not carry values for: ${filled.join(', ')}`);
});

test('flags: no committed/untracked non-test config or source sets any feature flag to true', () => {
  const names = [...FLAG_ENV_NAMES, ...FLAG_CAMEL_NAMES];
  const configLike = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|toml|env|example)$|(^|\/)\.env[^/]*$|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*$/;
  const files = projectFiles().filter((f) => configLike.test(rel(f)) && !isTestFile(f) && !/pnpm-lock|package-lock|tsbuildinfo/.test(f));
  assert.ok(files.length > 10, `only ${files.length} candidate files; git enumeration looks wrong`);
  const offenders: string[] = [];
  for (const f of files) {
    const isScript = /\.(ts|tsx|js|mjs|cjs)$/.test(f);
    const text = isScript ? stripComments(read(f)) : read(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    text.split('\n').forEach((line, i) => { if (assignsFlagTrue(line, names)) offenders.push(`${rel(f)}:${i + 1} ${line.trim().slice(0, 140)}`); });
  }
  assert.deepEqual(offenders, [], `feature flags must never be enabled in committed files (markdown docs are not scanned; prose inside error strings is not an assignment):\n  ${offenders.join('\n  ')}`);
});

/* ------------------------------------ mainnet ------------------------------------ */

test('network: no source/config contains a mainnet RPC URL or "mainnet-beta" (mainnet must come from env behind ENABLE_SOLANA_MAINNET)', () => {
  const dirs = [API_SRC, STOREFRONT];
  const files = dirs.flatMap((d) => listSourceFiles(d, ['.ts', '.tsx', '.js', '.mjs', '.json'])).filter((f) => !/package\.json$|tsconfig/.test(f));
  files.push(...['.env.example', 'docker-compose.yml'].map((f) => path.join(ROOT, f)).filter(exists));
  const hits = scanRules(files, [
    { name: 'mainnet-beta', re: /mainnet-beta/i },
    { name: 'URL containing "mainnet"', re: /https?:\/\/[^\s'"`]*mainnet[^\s'"`]*/i },
    { name: 'clusterApiUrl(mainnet)', re: /clusterApiUrl\s*\(\s*['"`]mainnet/i },
  ]);
  assert.equal(hits.length, 0, `mainnet RPC literal found (must be env-provided, never a default):\n${formatHits(hits)}`);
});

test('network: any default RPC URL literal in API source is devnet/local', () => {
  const hits: string[] = [];
  for (const f of API_FILES()) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(/(\w*RPC\w*)\s*(?:\?\?|\|\|)\s*(['"`])([^'"`]+)\2/g)) {
      if (!/devnet|localhost|127\.0\.0\.1|sandbox/i.test(m[3])) hits.push(`${rel(f)}:${lineNumberAt(src, m.index ?? 0)} default ${m[1]} = ${m[3]}`);
    }
    for (const m of src.matchAll(/clusterApiUrl\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      if (m[1] !== 'devnet') hits.push(`${rel(f)}:${lineNumberAt(src, m.index ?? 0)} clusterApiUrl('${m[1]}')`);
    }
  }
  assert.deepEqual(hits, [], `non-devnet RPC defaults:\n  ${hits.join('\n  ')}`);
});

/* ------------------------------------ MoonPay ------------------------------------ */

test('moonpay: provider file exists under apps/api/src/wallet', () => {
  if (moonpayFiles().length === 0) notYetImplemented('MoonPay provider file (basename containing "moonpay")', [path.join(WALLET_SRC, '**/moonpay*.ts')]);
});

test('moonpay: provider never references SOLANA_USDC_TREASURY (customer funds go to the customer wallet, not the merchant treasury)', () => {
  const files = moonpayFiles();
  if (files.length === 0) notYetImplemented('MoonPay provider file', [path.join(WALLET_SRC, '**/moonpay*.ts')]);
  const hits = scanRules(files, [{ name: 'SOLANA_USDC_TREASURY in moonpay provider', re: /SOLANA_USDC_TREASURY/ }]);
  assert.equal(hits.length, 0, `MoonPay provider must not use the treasury:\n${formatHits(hits)}`);
});

test('moonpay: walletAddress is sourced from the CustomerWallet address (destinationAddress), never a treasury', () => {
  const files = moonpayFiles();
  if (files.length === 0) notYetImplemented('MoonPay provider file', [path.join(WALLET_SRC, '**/moonpay*.ts')]);
  const setters: { file: string; line: number; segment: string }[] = [];
  for (const f of files) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(/\bwalletAddress\b/g)) {
      const idx = m.index ?? 0;
      const lineStart = src.lastIndexOf('\n', idx) + 1;
      const lineEnd = src.indexOf('\n', idx);
      const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      // skip pure type annotations: `walletAddress: string` / `walletAddress?: string;`
      if (/\bwalletAddress\??\s*:\s*(?:string|PublicKey|string\s*\|\s*null)\s*[;,]?\s*$/.test(line)) continue;
      setters.push({ file: rel(f), line: lineNumberAt(src, idx), segment: src.slice(idx, idx + 220).split(/\n\s*\n/)[0] });
    }
  }
  assert.ok(setters.length > 0, `no MoonPay file sets walletAddress; the widget URL must carry the customer's wallet address. Looked in: ${files.map(rel).join(', ')}`);
  const bad: string[] = [];
  for (const s of setters) {
    const seg = s.segment.replace(/\s+/g, ' ');
    if (/treasury/i.test(seg)) bad.push(`${s.file}:${s.line} walletAddress sourced from treasury: ${seg}`);
    else if (!/destinationAddress|destination|wallet\w*\??\.address|customerWallet|customer\.wallet|walletAddr/i.test(seg)) bad.push(`${s.file}:${s.line} walletAddress not visibly sourced from the CustomerWallet address: ${seg}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('moonpay: callers of createQuote pass the CustomerWallet address and never the treasury', () => {
  const files = listSourceFiles(WALLET_SRC).filter((f) => !isMoonpayFile(f));
  const calls: { file: string; line: number; text: string; src: string }[] = [];
  for (const f of files) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(/\.\s*createQuote\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      calls.push({ file: rel(f), line: lineNumberAt(src, m.index ?? 0), text: extractParenGroup(src, open), src });
    }
  }
  if (calls.length === 0) notYetImplemented('a service that calls OnRampProvider.createQuote', [path.join(WALLET_SRC, '**/*.service.ts')]);
  const bad: string[] = [];
  for (const c of calls) {
    const text = c.text.replace(/\s+/g, ' ');
    if (/treasury/i.test(text)) { bad.push(`${c.file}:${c.line} createQuote uses treasury: ${text}`); continue; }
    const m = text.match(/destinationAddress\s*(?::\s*([^,}]+))?\s*[,}]/);
    if (!m) { bad.push(`${c.file}:${c.line} createQuote call has no destinationAddress: ${text}`); continue; }
    const expr = (m[1] ?? 'destinationAddress').trim();
    const sourced = /wallet\w*\??\.address|customerWallet/i.test(expr)
      || (/^\w+$/.test(expr) && declarationRhs(c.src, expr).some((rhs) => /wallet\w*\??\.address|customerWallet/i.test(rhs)));
    if (!sourced) bad.push(`${c.file}:${c.line} destinationAddress '${expr}' is not visibly the CustomerWallet address`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

/* ------------------------------ identity header gating ------------------------------ */

/**
 * A string literal naming an identity-bearing request header (spoofable if trusted blindly), e.g. 'x-customer-email'.
 * Credential headers (names containing token/secret/key/signature/authorization, e.g. x-admin-token) are a different
 * mechanism (a shared secret that fails closed) and are exempt from the NODE_ENV rule.
 */
function identityHeaderLiterals(src: string): string[] {
  return [...src.matchAll(/['"`](x-[\w-]*(?:customer|user|account|admin|actor|identity|principal|subject|session|auth|owner|email)[\w-]*)['"`]/gi)]
    .map((m) => m[1])
    .filter((name) => !/token|secret|key|signature|authorization/i.test(name));
}

function resolveLocalImports(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), m[1]);
    for (const cand of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
      if (exists(cand) && cand.endsWith('.ts')) { out.push(cand); break; }
    }
  }
  return out;
}

function closure(file: string, depth = 3, seen = new Set<string>()): string[] {
  if (seen.has(file) || !exists(file)) return [];
  seen.add(file);
  if (depth > 0) for (const dep of resolveLocalImports(file, stripComments(read(file)))) closure(dep, depth - 1, seen);
  return [...seen].filter((f) => f.startsWith(API_SRC));
}

function productionGateIn(files: string[]): { ok: boolean; detail: string } {
  for (const f of files) {
    const src = stripComments(read(f));
    // Accepted gates: the fail-closed allowlist helpers from config/runtime.ts (true only for exactly
    // NODE_ENV=development|test), or a literal NODE_ENV/'production' comparison next to a rejection.
    const REJECTION = /throw|Unauthorized|Forbidden|Exception|return\s+false|NotFound|ignore|undefined|reject/i;
    for (const m of src.matchAll(/\b(isNonProductionRuntime|isProductionLikeRuntime)\s*\(/g)) {
      const window = src.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 400);
      if (REJECTION.test(window)) return { ok: true, detail: `${rel(f)}:${lineNumberAt(src, m.index ?? 0)}` };
    }
    for (const m of src.matchAll(/NODE_ENV/g)) {
      const window = src.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 400);
      if (/['"`]production['"`]/.test(window) && REJECTION.test(window)) {
        return { ok: true, detail: `${rel(f)}:${lineNumberAt(src, m.index ?? 0)}` };
      }
    }
  }
  return { ok: false, detail: '' };
}

function controllersIn(dir: string): string[] {
  return listSourceFiles(dir).filter((f) => /\.controller\.ts$/.test(f));
}

function assertIdentityGated(dir: string, label: string) {
  const controllers = controllersIn(dir);
  if (controllers.length === 0) notYetImplemented(`${label} controllers`, [path.join(dir, '**/*.controller.ts')]);
  let mechanisms = 0;
  const failures: string[] = [];
  for (const controller of controllers) {
    const files = closure(controller);
    const readsHeader = files.filter((f) => identityHeaderLiterals(stripComments(read(f))).length > 0);
    const usesGuard = /@UseGuards\s*\(/.test(stripComments(read(controller)));
    if (readsHeader.length > 0) {
      mechanisms++;
      const gate = productionGateIn(readsHeader);
      if (!gate.ok) failures.push(`${rel(controller)} reads an identity header (in ${readsHeader.map(rel).join(', ')}) but no NODE_ENV === 'production' rejection/ignore was found next to it`);
    } else if (usesGuard) mechanisms++;
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.ok(mechanisms > 0, `${label} controllers (${controllers.map(rel).join(', ')}) show no identity mechanism at all (no x-* identity header literal in the controller or its local imports, no @UseGuards); cannot verify gating`);
}

test('identity: wallet controllers gate the identity header on NODE_ENV (rejected/ignored in production)', () => {
  requireDir(WALLET_SRC, 'wallet module');
  assertIdentityGated(WALLET_SRC, 'wallet');
});

test('identity: wallet-admin controllers gate any identity header on NODE_ENV (and have some identity mechanism)', () => {
  requireDir(WALLET_ADMIN_SRC, 'wallet-admin module');
  assertIdentityGated(WALLET_ADMIN_SRC, 'wallet-admin');
});

/* --------------------------------- admin read-only --------------------------------- */

test('wallet-admin: API is read-only (no @Post/@Put/@Patch/@Delete/@All) and exposes at least one @Get', () => {
  requireDir(WALLET_ADMIN_SRC, 'wallet-admin module');
  const files = listSourceFiles(WALLET_ADMIN_SRC);
  assert.ok(controllersIn(WALLET_ADMIN_SRC).length > 0, `no *.controller.ts under ${rel(WALLET_ADMIN_SRC)}`);
  const hits = scanRules(files, [{ name: 'mutating HTTP decorator', re: /@(?:Post|Put|Patch|Delete|All)\s*\(/ }]);
  assert.equal(hits.length, 0, `admin wallet API must be read-only:\n${formatHits(hits)}`);
  const gets = scanRules(files, [{ name: '@Get', re: /@Get\s*\(/ }]);
  assert.ok(gets.length > 0, 'wallet-admin exposes no @Get route; nothing to review');
});
