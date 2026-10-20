/**
 * (3) Storefront honesty checks for the wallet UI. Static text scans of apps/storefront wallet code as it exists when run.
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/storefront-honesty.test.ts
 *
 * Heuristics, not proofs; see docs/testing/wallet-qa.md "Limits of static scans".
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  SF_WALLET_COMPONENTS, SF_WALLET_LIB, SF_WALLET_PAGE, STOREFRONT, exists, listSourceFiles, read, rel, requireDir, scanPaidClaims,
  storefrontClosure, stripComments,
} from './_helpers';

const SF_WALLET_ROUTE_ALIAS = path.join(STOREFRONT, 'app/wallet');

function walletUiFiles(): string[] {
  requireDir(SF_WALLET_PAGE, 'storefront wallet pages (apps/storefront/app/account/wallet)');
  requireDir(SF_WALLET_COMPONENTS, 'storefront wallet components (apps/storefront/components/wallet)');
  requireDir(SF_WALLET_LIB, 'storefront wallet lib (apps/storefront/lib/wallet)');
  const files = [SF_WALLET_PAGE, SF_WALLET_COMPONENTS, SF_WALLET_LIB, ...(exists(SF_WALLET_ROUTE_ALIAS) ? [SF_WALLET_ROUTE_ALIAS] : [])].flatMap((d) => listSourceFiles(d));
  assert.ok(files.length > 0, 'wallet UI directories exist but contain no .ts/.tsx files');
  return files;
}

const PRIVY_CONTEXT = /\b(?:not|future|slot|abstraction|requires|configured)\b/i;

test('honesty: every line mentioning Privy says it is not configured / future / a slot / an abstraction / requires configuration', () => {
  const offenders: string[] = [];
  let mentions = 0;
  for (const file of walletUiFiles()) {
    read(file).split('\n').forEach((line, i) => {
      if (!/privy/i.test(line)) return;
      mentions++;
      if (!PRIVY_CONTEXT.test(line)) offenders.push(`${rel(file)}:${i + 1} ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(offenders, [], `Privy must not be presented as an active integration (a mention is only allowed on a line that also contains not|future|slot|abstraction|requires|configured). Mentions found: ${mentions}.\n  ${offenders.join('\n  ')}`);
});

test('honesty: wallet UI does not import or load a Privy SDK', () => {
  const offenders: string[] = [];
  for (const file of walletUiFiles()) {
    stripComments(read(file)).split('\n').forEach((line, i) => {
      if (/(?:from|import|require)\s*\(?\s*['"]@?privy/i.test(line) || /privy\.io|PrivyProvider|usePrivy\b|@privy-io/i.test(line)) offenders.push(`${rel(file)}:${i + 1} ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(offenders, [], `Privy SDK usage means an active integration, which this phase must not claim:\n  ${offenders.join('\n  ')}`);
});

test('honesty: no "paid"/"confirmed" text that is gated on a non-finalized status (heuristic)', () => {
  const hits = walletUiFiles().flatMap((file) => scanPaidClaims(read(file)).map((h) => `${rel(file)}:${h.line} ${h.reason}: ${h.text}`));
  assert.deepEqual(hits, [], `payment must only be described as paid/confirmed when FINALIZED:\n  ${hits.join('\n  ')}`);
});

const DISPLAYED_SANDBOX = /['"`>][^'"`<]*\bsandbox\b|\bsandbox\b[^'"`<]*['"`<]/i;

test('honesty: a sandbox label string is present in wallet UI text', () => {
  const files = walletUiFiles();
  const withLabel = files.filter((f) => DISPLAYED_SANDBOX.test(stripComments(read(f))));
  assert.ok(withLabel.length > 0, 'no wallet UI file contains a displayed "sandbox" string');
  assert.ok(withLabel.some((f) => f.startsWith(SF_WALLET_COMPONENTS)), 'the sandbox label must live in a wallet component, not only in lib');
});

test('honesty: every wallet page renders a sandbox label (directly or via a component it imports)', () => {
  requireDir(SF_WALLET_PAGE, 'storefront wallet pages');
  const pages = listSourceFiles(SF_WALLET_PAGE).filter((f) => /\/page\.tsx$/.test(f));
  assert.ok(pages.length > 0, `no page.tsx under ${rel(SF_WALLET_PAGE)}`);
  const missing = pages.filter((page) => !storefrontClosure(page).some((f) => DISPLAYED_SANDBOX.test(stripComments(read(f))))).map(rel);
  assert.deepEqual(missing, [], `these wallet pages show no sandbox label anywhere in their import tree: ${missing.join(', ')}`);
});

test('honesty: the sandbox label states devnet / not real funds', () => {
  const all = walletUiFiles().map((f) => stripComments(read(f))).join('\n');
  assert.match(all, /devnet/i, 'wallet UI must say devnet');
  assert.match(all, /not\s+for\s+real\s+funds|no\s+real\s+(?:funds|money)|not\s+real\s+(?:funds|money)/i, 'wallet UI must state the sandbox does not use real funds');
});
