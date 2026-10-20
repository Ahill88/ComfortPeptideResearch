// Runs every test suite and reports real aggregate counts. Exits non-zero if any test fails.
// Usage: node tests/run-all.mjs [substring-filter]
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const api = join(root, 'apps/api');

function collect(dir, pattern) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full, pattern));
    else if (pattern.test(name)) out.push(full);
  }
  return out;
}

const filter = process.argv[2];
const hasDatabase = Boolean(process.env.TEST_DATABASE_URL);
const isIntegration = (file) => file.endsWith('.integration.test.ts');
const allSuites = [
  ...collect(join(root, 'tests'), /\.test\.ts$/),
  ...collect(join(api, 'src'), /\.test\.ts$/),
]
  // authentication-eligibility.test is imported by commerce-workflows.test; run it once through that file.
  .filter((file) => !file.endsWith('tests/authentication-eligibility.test.ts'))
  .filter((file) => !filter || file.includes(filter))
  .sort();
// Integration suites need a real Postgres. Without TEST_DATABASE_URL they are reported as SKIPPED, never as passed.
const skipped = hasDatabase ? [] : allSuites.filter(isIntegration);
const suites = allSuites.filter((file) => !skipped.includes(file));
for (const file of skipped) console.log(`SKIP  ${relative(root, file)}  (set TEST_DATABASE_URL to run)`);

let pass = 0;
let fail = 0;
const failedSuites = [];
for (const file of suites) {
  const run = spawnSync('pnpm', ['--dir', api, 'exec', 'ts-node', '--project', 'tsconfig.json', '--transpile-only', file], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  const output = `${run.stdout}${run.stderr}`;
  const p = Number(/^ℹ pass (\d+)/m.exec(output)?.[1] ?? 0);
  const f = Number(/^ℹ fail (\d+)/m.exec(output)?.[1] ?? 0);
  const crashed = run.status !== 0 && p + f === 0;
  pass += p;
  fail += f + (crashed ? 1 : 0);
  const label = relative(root, file);
  console.log(`${f || crashed ? 'FAIL' : ' ok '}  ${label}  (${p} passed, ${f} failed${crashed ? ', suite crashed' : ''})`);
  if (f || crashed) {
    failedSuites.push(label);
    for (const line of output.split('\n').filter((l) => /^✖ /.test(l) && !/failing tests/.test(l)).slice(0, 8)) console.log(`        ${line}`);
    if (crashed) console.log(output.split('\n').slice(-12).map((l) => `        ${l}`).join('\n'));
  }
}
console.log(`\n${suites.length} suites run, ${skipped.length} skipped, ${pass} passed, ${fail} failed`);
if (failedSuites.length) console.log(`failing suites:\n  ${failedSuites.join('\n  ')}`);
process.exit(fail ? 1 : 0);
