// Owns only the two processes it starts. Never attaches to or stops shared development servers.
// First mirror apps/storefront with tests/coa-ui/sync-storefront-copy.sh into the directory below.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const copy = join(temp, 'orders-history-storefront');
const output = join(temp, `orders-history-qa-${Date.now()}`);
await mkdir(output, { recursive: true });
for (const port of [3590, 3591]) {
  const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening'); await new Promise((resolve) => probe.close(resolve));
}
const children = [];
const start = (args, cwd, log, env = {}) => {
  const stream = createWriteStream(join(output, log));
  const child = spawn(process.execPath, args, { cwd, detached: true, env: { ...process.env, ...env }, stdio: ['ignore', stream, stream] });
  children.push(child); return child;
};
const ready = async (url, child) => {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`QA process exited before readiness: ${child.exitCode}`);
    try { await fetch(url, { signal: AbortSignal.timeout(3000) }); return; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  throw new Error(`Timed out waiting for ${url}`);
};
const stop = () => { for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ } } };
process.once('SIGINT', () => { stop(); process.exit(130); });
process.once('SIGTERM', () => { stop(); process.exit(143); });
let code = 1;
try {
  const fake = start(['tests/orders-history-ui/fake-orders-api.mjs'], root, 'fake-api.log');
  await ready('http://localhost:3590/__qa/requests', fake);
  const storefront = start([join(copy, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3591'], copy, 'storefront.log', { NEXT_PUBLIC_API_URL: 'http://localhost:3590/v1', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' });
  await ready('http://localhost:3591/orders', storefront);
  const qa = spawn(process.execPath, ['tests/orders-history-ui/browser-qa.mjs'], { cwd: root, env: { ...process.env, QA_OUTPUT: output }, stdio: 'inherit' });
  children.push(qa);
  [code] = await once(qa, 'exit');
} finally { stop(); }
console.log(`QA logs and screenshots: ${output}`);
process.exitCode = code ?? 1;
