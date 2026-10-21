#!/usr/bin/env node
// Build only apps/admin in a new temp directory, with its own .next and a dependency symlink (no install/importer).
// Starts only loopback :3790 / :3791 and stops only its own children, including on failure or Ctrl-C.
import { cp, mkdir, mkdtemp, open, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
for (const port of [3790, 3791]) await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
const work = await mkdtemp(join(temp, 'admin-operations-'));
const app = join(work, 'apps/admin');
const output = join(work, 'artifacts');
await mkdir(dirname(app), { recursive: true });
await mkdir(output);
await cp(join(root, 'apps/admin'), app, { recursive: true, filter: (path) => !['node_modules', '.next', '.turbo', 'tsconfig.tsbuildinfo', 'next-env.d.ts'].includes(basename(path)) && !basename(path).startsWith('.next-') });
await symlink(join(root, 'apps/admin/node_modules'), join(app, 'node_modules'), 'dir');
const next = createRequire(join(root, 'apps/admin/package.json')).resolve('next/dist/bin/next');
const children = new Set();
const env = { ...process.env, API_URL: 'http://127.0.0.1:3790/v1', ADMIN_API_TOKEN: 'fake-wallet-token', STOREFRONT_PUBLIC_URL: 'https://shop.example.test', NEXT_TELEMETRY_DISABLED: '1' };
async function start(args, cwd, name, extra = {}) {
  const log = await open(join(work, `${name}.log`), 'a');
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); }); });
  children.add(child);
  await log.close();
  return child;
}
async function stopAll() {
  const mine = [...children];
  for (const child of mine) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } }
  await Promise.all(mine.map(async (child) => {
    await Promise.race([child.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (children.has(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } await child.done; }
  }));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stopAll().finally(() => process.exit(1)); });
async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (!children.has(child)) throw Error(`Server exited: ${url}; inspect ${work}`);
    try { if ((await fetch(url)).ok) return; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Server not ready: ${url}`);
}
console.log(`Isolated admin QA: ${work}`);
try {
  const build = await start([next, 'build'], app, 'build');
  if ((await build.done).code !== 0) throw Error(`Admin build failed. See ${join(work, 'build.log')}`);
  console.log('Isolated production build passed. Starting fake API :3790 and admin :3791.');
  const fake = await start([join(root, 'tests/admin-ui/fake-admin-api.mjs')], root, 'fake-api', { PORT: '3790' });
  await ready('http://127.0.0.1:3790/__control/ops-state', fake);
  const server = await start([next, 'start', '-H', '127.0.0.1', '-p', '3791'], app, 'admin', { NODE_ENV: 'production' });
  await ready('http://127.0.0.1:3791/sign-in', server);
  const qa = spawn(process.execPath, [join(root, 'tests/admin-ui/admin-browser-qa.mjs')], { cwd: root, env: { ...env, QA_BASE_URL: 'http://127.0.0.1:3791', QA_FAKE_URL: 'http://127.0.0.1:3790', QA_PROD: '1', QA_OUTPUT: output }, detached: true, stdio: 'inherit' });
  children.add(qa);
  qa.done = new Promise((resolve, reject) => { qa.once('error', reject); qa.once('exit', (code) => { children.delete(qa); resolve({ code }); }); });
  process.exitCode = (await qa.done).code ?? 1;
} finally { await stopAll(); console.log(`Own QA processes stopped. Logs and screenshots: ${work}`); }
