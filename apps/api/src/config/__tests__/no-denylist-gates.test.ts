import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * Denylist shapes that fail open: `NODE_ENV !== <literal>` (anything unlisted passes) or `NODE_ENV === 'production'`.
 * Allowlist comparisons (`=== 'development' || === 'test'`) fail closed and are fine.
 */
const DENYLIST = /(NODE_ENV|nodeEnv)\s*!==?\s*['"`]|(NODE_ENV|nodeEnv)\s*===?\s*['"`]production['"`]|['"`]production['"`]\s*[!=]==?\s*\S*(NODE_ENV|nodeEnv)/;
/** Reviewed usages: none. Every NODE_ENV comparison in non-test source must be an allowlist. */
const EXEMPT: { file: string; includes: string }[] = [];

test('no non-test source uses a fail-open NODE_ENV denylist (use config/runtime.ts allowlist helpers)', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !DENYLIST.test(line)) return;
        if (EXEMPT.some((e) => e.file === rel && line.includes(e.includes))) return;
        offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, []);
});
