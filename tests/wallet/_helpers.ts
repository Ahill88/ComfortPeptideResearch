/**
 * Shared, implementation-independent helpers for the wallet QA suite.
 * Everything here reads the repository AS IT EXISTS WHEN THE TEST RUNS.
 *
 * Not a test file (no `.test.ts` suffix) so it is never scanned as one.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '..', '..');
export const API_SRC = path.join(ROOT, 'apps/api/src');
export const WALLET_SRC = path.join(API_SRC, 'wallet');
export const WALLET_CHECKOUT_SRC = path.join(WALLET_SRC, 'checkout');
export const WALLET_ADMIN_SRC = path.join(API_SRC, 'wallet-admin');
export const STOREFRONT = path.join(ROOT, 'apps/storefront');
export const SF_WALLET_PAGE = path.join(STOREFRONT, 'app/account/wallet');
export const SF_WALLET_COMPONENTS = path.join(STOREFRONT, 'components/wallet');
export const SF_WALLET_LIB = path.join(STOREFRONT, 'lib/wallet');
export const PRISMA_SCHEMA = path.join(ROOT, 'apps/api/prisma/schema.prisma');

export const FLAG_ENV_NAMES = [
  'ENABLE_REAL_MOONPAY',
  'ENABLE_SOLANA_MAINNET',
  'ENABLE_LIVE_CRYPTO_PAYMENTS',
  'ENABLE_DELEGATED_PAYMENTS',
  'ENABLE_LIVE_FULFILLMENT',
] as const;

export const FLAG_CAMEL_NAMES = [
  'enableRealMoonpay',
  'enableSolanaMainnet',
  'enableLiveCryptoPayments',
  'enableDelegatedPayments',
  'enableLiveFulfillment',
] as const;

export function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Fail loudly. Used for every target that has not been built yet. */
export function notYetImplemented(what: string, expected: string[] = []): never {
  const where = expected.length ? ` Expected at: ${expected.map((e) => (path.isAbsolute(e) ? rel(e) : e)).join(', ')}.` : '';
  assert.fail(`not yet implemented: ${what}.${where}`);
}

export function requireDir(dir: string, why: string): void {
  if (!exists(dir) || !fs.statSync(dir).isDirectory()) notYetImplemented(`${why} (directory missing)`, [dir]);
}

const SKIP_DIRS = new Set(['node_modules', '.next', '.next-dev', 'dist', '.turbo', 'coverage', '.git']);

export function isTestFile(file: string): boolean {
  const p = file.split(path.sep).join('/');
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(__tests__|tests?)\//.test(rel(file));
}

/** Recursively list files (deterministic order), skipping build/vendor dirs. */
export function listFiles(dir: string, exts: string[] = ['.ts', '.tsx']): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(current, entry.name));
      } else if (exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
        out.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return out;
}

export function listSourceFiles(dir: string, exts: string[] = ['.ts', '.tsx']): string[] {
  return listFiles(dir, exts).filter((f) => !isTestFile(f));
}

/**
 * Replace comments with spaces (newlines preserved so line numbers stay valid).
 * Respects '...', "..." (reset at end of line) and `...` (may span lines).
 * Limits: JSX text containing an apostrophe is treated as an unterminated string
 * until end of line (so a comment later on that same line is not stripped);
 * regex literals containing quotes are not understood.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') mode = c;
      out += c; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; } else out += ' ';
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
    // inside a string
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if (c === '\n' && mode !== '`') { mode = 'code'; out += c; i++; continue; }
    if (c === mode) mode = 'code';
    out += c; i++;
  }
  return out;
}

export function lineNumberAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

export interface Hit { file: string; line: number; text: string; rule: string }

/** Run regex rules over comment-stripped source; each match becomes a Hit. */
export function scanRules(files: string[], rules: { name: string; re: RegExp }[], opts: { allow?: (hit: Hit) => boolean; keepComments?: boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const raw = read(file);
    const src = opts.keepComments ? raw : stripComments(raw);
    const lines = src.split('\n');
    const rawLines = raw.split('\n');
    for (const rule of rules) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (m[0] === '') { re.lastIndex++; continue; }
        const line = lineNumberAt(src, m.index);
        const hit: Hit = { file: rel(file), line, text: (rawLines[line - 1] ?? lines[line - 1] ?? '').trim().slice(0, 160), rule: rule.name };
        if (!opts.allow || !opts.allow(hit)) hits.push(hit);
      }
    }
  }
  return hits;
}

export function formatHits(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line} [${h.rule}] ${h.text}`).join('\n');
}

/** Files git considers part of the project: tracked + untracked-but-not-ignored. */
export function projectFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    return out.split('\0').filter(Boolean).filter((f) => exists(path.join(ROOT, f))).map((f) => path.join(ROOT, f));
  } catch (error) {
    assert.fail(`git is required to enumerate committed/uncommitted project files: ${(error as Error).message}`);
  }
}

/** From index of an opening paren, return the balanced call text "( ... )". Skips string contents for matching. */
export function extractParenGroup(src: string, openIndex: number): string {
  assert.equal(src[openIndex], '(');
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    } else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIndex, i + 1); }
    i++;
  }
  return src.slice(openIndex, Math.min(src.length, openIndex + 2000));
}

/** Text of a variable's initializer: `const name = <this>` up to a top-level `;` or newline-at-depth-0. */
export function declarationRhs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/[$]/g, '\\$')}\\b[^=\\n]*=(?!=)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    const start = i;
    for (; i < src.length && i < start + 1200; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
      if ('({['.includes(c)) depth++;
      else if (')}]'.includes(c)) depth--;
      else if ((c === ';' || c === '\n') && depth <= 0) break;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

/* ----------------------------- secret-leak predicate ----------------------------- */

const SECRET_TOKEN = '(?:secret\\w*|seed\\w*|mnemonic\\w*|private_?key\\w*|keypair\\w*)';

/**
 * Does this text (a fetch call, or the initializer of a variable used in one) serialize secret key
 * material? Heuristic by design:
 *   - object/JSON key named like a secret            { secretKey: ... }  "seed": ...
 *   - brace-group shorthand with no parens inside    { secretKey }
 *   - body / JSON.stringify directly given a secret  body: secretKey   JSON.stringify(kp.secretKey)
 *   - encoders applied directly to a secret          bs58.encode(kp.secretKey)
 * It deliberately does NOT flag `sign(tx, kp.secretKey)` (signing locally then sending the signature is
 * the intended flow). See docs/testing/wallet-qa.md for limits.
 */
export function leaksSecret(text: string): string | null {
  const rules: [string, RegExp][] = [
    ['secret-named key', new RegExp(`['"]?\\b${SECRET_TOKEN}['"]?\\s*:(?!:)`, 'i')],
    ['secret shorthand property', new RegExp(`\\{[^{}()]*\\b${SECRET_TOKEN}\\b[^{}()]*\\}`, 'i')],
    ['secret passed directly as body', new RegExp(`\\b(?:body\\s*:|JSON\\.stringify\\()\\s*[\\w.$\\[\\]'"?]*${SECRET_TOKEN}`, 'i')],
    ['encoded secret', new RegExp(`\\b(?:bs58\\.encode|Buffer\\.from|Array\\.from|btoa|encodeBase58|encodeBase64)\\(\\s*[\\w.$\\[\\]'"?]*${SECRET_TOKEN}`, 'i')],
  ];
  for (const [name, re] of rules) if (re.test(text)) return name;
  return null;
}

/** Bare reference initializer: `const payload = kp.secretKey;` */
export function isBareSecretReference(rhs: string): boolean {
  return new RegExp(`^\\s*[\\w.$\\[\\]'"?]*${SECRET_TOKEN}[\\w.$\\[\\]'"?]*\\s*$`, 'i').test(rhs);
}

const JS_WORDS = new Set(['fetch', 'JSON', 'stringify', 'method', 'POST', 'PUT', 'PATCH', 'await', 'async', 'const', 'let', 'var', 'new', 'true', 'false', 'null', 'undefined', 'Content', 'Type', 'application', 'json']);

export interface NetworkCall { file: string; line: number; callee: string; text: string; leak: string | null }

/** Find outbound request calls and report which ones appear to serialize secret material. */
export function findNetworkCalls(file: string, srcOverride?: string): NetworkCall[] {
  const src = stripComments(srcOverride ?? read(file));
  const calls: NetworkCall[] = [];
  const re = /\b(fetch|apiFetch|apiPost|apiPut|apiPatch|postJson|sendBeacon|axios(?:\.\w+)?|api\.(?:post|put|patch)|http\.(?:post|put|patch)|client\.(?:post|put|patch))\s*(?:<[^>()]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].lastIndexOf('(');
    const text = extractParenGroup(src, open);
    let leak = leaksSecret(text);
    if (!leak) {
      const idents = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
      for (const id of idents) {
        if (JS_WORDS.has(id)) continue;
        for (const rhs of declarationRhs(src, id)) {
          const l = leaksSecret(rhs) ?? (isBareSecretReference(rhs) ? 'bare secret reference' : null);
          if (l) { leak = `${l} via variable '${id}'`; break; }
        }
        if (leak) break;
      }
    }
    calls.push({ file: rel(file), line: lineNumberAt(src, m.index), callee: m[1], text: text.slice(0, 200), leak });
  }
  return calls;
}

/* ------------------------------- dynamic loading -------------------------------- */

/** Require a TypeScript module from the repo (ts-node is registered by the runner). Fails clearly if absent. */
export function requireRepoModule<T = any>(file: string, what: string): T {
  if (!exists(file)) notYetImplemented(what, [file]);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(file) as T;
  } catch (error) {
    assert.fail(`${what}: ${rel(file)} exists but failed to load: ${(error as Error).stack ?? error}`);
  }
}

/* --------------------------------- custody rules -------------------------------- */

/**
 * Patterns that indicate the platform generating, holding, loading or using private key material.
 * Applied to comment-stripped, non-test source under apps/api/src.
 *
 * Deliberate choices (documented in docs/testing/wallet-qa.md):
 *  - `nacl.sign.detached.verify` is allowed (verifying a customer's signature needs no secret);
 *    `nacl.sign(`, `nacl.sign.detached(` and `nacl.sign.keyPair` are not.
 *  - `.sign(` is flagged unless the receiver is clearly a JWT/HMAC helper (jwt, jwtService, jsonwebtoken, hmac).
 *  - `PublicKey.unique()` and `new PublicKey(...)` are fine; they carry no secret.
 */
export const CUSTODY_RULES: { name: string; re: RegExp }[] = [
  { name: 'Keypair.fromSecretKey', re: /\bKeypair\s*\.\s*fromSecretKey\b/ },
  { name: 'Keypair.fromSeed', re: /\bKeypair\s*\.\s*fromSeed\b/ },
  { name: 'Keypair.generate', re: /\bKeypair\s*\.\s*generate\b/ },
  { name: 'new Keypair(', re: /\bnew\s+Keypair\s*\(/ },
  { name: 'secretKey / SECRET_KEY identifier', re: /secret_?key/i },
  { name: 'privateKey / PRIVATE_KEY identifier', re: /private_?key/i },
  { name: 'mnemonic', re: /mnemonic/i },
  { name: 'seed phrase / wallet seed', re: /seed_?phrase|wallet_?seed|seed_?bytes|recovery_?phrase/i },
  { name: 'env read of *SEED*', re: /\benv\s*(?:\.\s*\w*SEED\w*|\[\s*['"`]\w*SEED\w*['"`]\s*\])/ },
  { name: 'HD derivation / bip39', re: /\b(?:bip39|derivePath|ed25519-hd-key|hdkey)\b/i },
  { name: 'transaction/message signing call', re: /\.\s*(?:partialSign|signTransaction|signAllTransactions|signMessage)\s*\(/ },
  { name: '.sign( call', re: /(?<!\b(?:jwt|jwtService|jsonwebtoken|hmac)\s*)\.\s*sign\s*\(/ },
  { name: 'nacl.sign( / nacl.sign.detached( / nacl.sign.keyPair', re: /\bnacl\s*\.\s*sign\s*(?:\(|\.\s*detached\s*\(|\.\s*keyPair)/ },
];

export function isMoonpayFile(file: string): boolean {
  return /moonpay/i.test(path.basename(file));
}

/* ----------------------------- feature-flag assignment ----------------------------- */

const PREFIX_ALLOWED = /^(?:|export|ENV|ARG|-|-e|--env|-\s*-e|(?:[\w$]+\.)*env\.|(?:[\w$]+\.)*env\[|[\w$.]*env\.)$/i;

/**
 * Does this single line ASSIGN a feature flag to true? Prose such as
 *   throw new Error('set ENABLE_SOLANA_MAINNET=true to allow it')
 * is NOT an assignment; `ENABLE_X=true`, `export ENABLE_X=true`, `ENV ENABLE_X=true`, `- ENABLE_X=true`,
 * `"ENABLE_X=true"` (docker env list), `process.env.ENABLE_X = 'true'`, `ENABLE_X: 'true'`, `"ENABLE_X": true`,
 * `enableRealMoonpay: true` and `env['ENABLE_X'] = 'true'` are.
 */
export function assignsFlagTrue(line: string, names: readonly string[]): boolean {
  const alt = names.join('|');
  // key/value and bracket forms: no prose ambiguity
  if (new RegExp(`\\b(?:${alt})\\b["']?\\s*:(?!:)\\s*["']?true\\b`, 'i').test(line)) return true;
  if (new RegExp(`\\b(?:${alt})\\b["'\`]\\s*\\]\\s*=(?![=>])\\s*["']?true\\b`, 'i').test(line)) return true;
  // `NAME=true` form: reject when it sits inside a sentence
  const re = new RegExp(`\\b(?:${alt})\\b\\s*=(?![=>])\\s*["']?true\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const before = line.slice(0, m.index);
    const afterLastQuote = before.split(/["'`]/).pop() ?? '';
    if (PREFIX_ALLOWED.test(afterLastQuote.trim())) return true;
  }
  return false;
}

/* ------------------------------ "paid/confirmed" claims ------------------------------ */

export interface ClaimHit { line: number; text: string; reason: string }

function stringSpans(line: string): [number, number, string][] {
  const spans: [number, number, string][] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) { if (line[j] === '\\') j++; j++; }
      spans.push([i, Math.min(j, line.length), line.slice(i + 1, j)]);
      i = j + 1;
    } else i++;
  }
  return spans;
}

const NEGATION = /\b(?:not|never|yet|until|unless|awaiting|waiting|before|pending|unpaid|unconfirmed|cannot)\b|n't\b/i;
const NON_FINAL_COMPARE = /(?:===?|case)\s*['"`](?:submitted|pending|confirmed|prepared|processing|broadcast|created)['"`]/i;
const STATUS_TOKEN = /^(?:paid|confirmed|PAID|CONFIRMED)$/;

/**
 * Heuristic scan of one UI source file for text that claims a payment is "paid"/"confirmed" without being gated on a
 * FINALIZED status. See docs/testing/wallet-qa.md ("Limits of static scans") for what it can and cannot see.
 *
 *  R1 display text (JSX text or a multi-word / Capitalized string literal) containing paid|confirmed is accepted only if the same
 *     line is negated ("not paid yet", "until finalized"), is about network fees ("fee is paid in SOL"), mentions finalized,
 *     or a finalized check appears in the previous 6 lines; it is rejected if the same line compares against a non-finalized
 *     status (submitted/pending/confirmed/...) without negation.
 *  R2 a lowercase status token 'confirmed' must never be mapped to a finalized/paid/success outcome.
 */
export function scanPaidClaims(raw: string): ClaimHit[] {
  const lines = stripComments(raw).split('\n');
  const hits: ClaimHit[] = [];
  lines.forEach((l, idx) => {
    const lineNo = idx + 1;
    const re = /\b(paid|confirmed)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l))) {
      const spans = stringSpans(l);
      const span = spans.find(([s, e]) => m!.index > s && m!.index < e + 1);
      let display = false;
      if (span) {
        display = !STATUS_TOKEN.test(span[2].trim());
      } else {
        const before = l.slice(0, m.index);
        const afterGt = before.includes('>') ? before.slice(before.lastIndexOf('>') + 1) : before;
        const after = l.slice(m.index + m[0].length);
        if (before.includes('>')) display = !/[{}=;()]/.test(afterGt);
        else display = !/[{}=;()]|\b(?:const|let|var|function|return|if|else|import|export|type|interface|case)\b/.test(before) && !/^\s*(?:\?|=|:|\(|\)|;|,|\.\w|=>|\|\||&&)/.test(after);
      }
      if (!display) continue;
      if (NEGATION.test(l) || /\bfees?\b/i.test(l)) continue;
      if (NON_FINAL_COMPARE.test(l)) { hits.push({ line: lineNo, text: l.trim().slice(0, 160), reason: `"${m[0]}" text on a line gated on a non-finalized status` }); continue; }
      if (/finaliz/i.test(l)) continue;
      const window = lines.slice(Math.max(0, idx - 6), idx).join('\n');
      if (/finaliz/i.test(window)) continue;
      hits.push({ line: lineNo, text: l.trim().slice(0, 160), reason: `"${m[0]}" text with no finalized gating on the same line or in the preceding 6 lines` });
    }
    if (/['"`]confirmed['"`]/i.test(l)) {
      const tokenEnd = l.search(/['"`]confirmed['"`]/i);
      const rest = l.slice(tokenEnd);
      if (/(?:return|phase\s*:|=>|kind\s*:|status\s*:)\s*['"`]?(?:finalized|paid|complete|completed|success|succeeded|settled)\b/i.test(rest)) {
        hits.push({ line: lineNo, text: l.trim().slice(0, 160), reason: "status 'confirmed' mapped to a finalized/paid outcome on one line" });
      }
      if (/\bcase\s+['"`]confirmed['"`]\s*:/i.test(l) && /(?:return|phase\s*:)\s*['"`]?(?:finalized|paid|complete|completed|success|succeeded|settled)\b/i.test(lines.slice(idx, idx + 3).join(' '))) {
        hits.push({ line: lineNo, text: l.trim().slice(0, 160), reason: "case 'confirmed' falls to a finalized/paid outcome" });
      }
    }
    if (/\bconfirmed['"]?\s*:\s*['"`](?:finalized|paid|complete|completed|success|succeeded|settled)['"`]/i.test(l)) {
      hits.push({ line: lineNo, text: l.trim().slice(0, 160), reason: 'confirmed key mapped to finalized/paid in a lookup table' });
    }
  });
  return hits;
}

/** Local imports (relative, or `@/` = apps/storefront) of a TS/TSX file, resolved to existing files. */
export function resolveStorefrontImports(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]/g)) {
    const spec = m[1];
    const base = spec.startsWith('@/') ? path.join(STOREFRONT, spec.slice(2)) : path.resolve(path.dirname(file), spec);
    for (const cand of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
      if (exists(cand)) { out.push(cand); break; }
    }
  }
  return out;
}

export function storefrontClosure(file: string, depth = 5, seen = new Set<string>()): string[] {
  if (seen.has(file) || !exists(file)) return [...seen];
  seen.add(file);
  if (depth > 0) for (const dep of resolveStorefrontImports(file, stripComments(read(file)))) storefrontClosure(dep, depth - 1, seen);
  return [...seen];
}
