import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fetchSdnList, SanctionsFetchError } from '../sanctions-fetcher';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
const sample = fixture('sdn-sample.xml');

let server: Server;
let base: string;
const hits: Record<string, number> = {};
const handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/ok': (_req, res) => res.writeHead(200, { 'content-type': 'text/xml' }).end(sample),
  '/redirect': (_req, res) => res.writeHead(302, { location: '/step2' }).end(),
  '/step2': (_req, res) => res.writeHead(302, { location: '/ok' }).end(),
  '/loop': (_req, res) => res.writeHead(302, { location: '/loop' }).end(),
  '/down': (_req, res) => res.writeHead(503).end('maintenance https://hidden.example/?token=abc'),
  '/html': (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(fixture('not-sdn.html')),
  '/cut': (_req, res) => res.writeHead(200).end(fixture('sdn-truncated.xml')),
  '/big': (_req, res) => {
    res.writeHead(200);
    res.write(sample.subarray(0, 200));
    const slab = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < 1_000_000) {
        sent += slab.length;
        if (!res.write(slab)) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  },
  '/declared-big': (_req, res) => res.writeHead(200, { 'content-length': '999999999' }).end(),
  '/stall-headers': () => undefined,
  '/stall-body': (_req, res) => {
    res.writeHead(200);
    res.write(sample.subarray(0, 300));
  },
};

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    (handlers[path] ?? ((_q, r) => r.writeHead(404).end()))(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const fetchPath = (path: string, extra: Record<string, unknown> = {}) => fetchSdnList({ url: `${base}${path}`, allowInsecure: true, ...extra });
const failsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SanctionsFetchError, `expected SanctionsFetchError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });

test('downloads and parses a list, hashing exactly the bytes received', async () => {
  const result = await fetchPath('/ok');
  assert.equal(result.sha256, createHash('sha256').update(sample).digest('hex'));
  assert.equal(result.bytes, sample.length);
  assert.equal(result.addresses.length, 7);
  assert.equal(result.complete, true);
});

test('follows redirects by hand (the official URL answers 302 to signed storage)', async () => {
  const result = await fetchPath('/redirect');
  assert.equal(result.addresses.length, 7);
});

test('too many redirects fail the run', async () => {
  await failsWith(fetchPath('/loop'), 'redirects');
});

test('plain http is refused unless explicitly allowed (production-like runtimes never allow it)', async () => {
  await failsWith(fetchSdnList({ url: `${base}/ok` }), 'insecure_url');
  await failsWith(fetchSdnList({ url: `${base}/ok`, allowInsecure: false }), 'insecure_url');
});

test('an https list that redirects to http is refused', async () => {
  const fake = (async (url: string) => {
    if (String(url).startsWith('https://')) return new Response(null, { status: 302, headers: { location: 'http://example.test/list.xml' } });
    throw new Error('must not be requested');
  }) as unknown as typeof fetch;
  await failsWith(fetchSdnList({ url: 'https://example.test/list.xml', fetchImpl: fake }), 'insecure_url');
});

test('a non-200 answer fails with a redacted message (no URL, no provider text)', async () => {
  await assert.rejects(fetchPath('/down'), (error: unknown) => {
    assert.ok(error instanceof SanctionsFetchError);
    assert.equal(error.code, 'http_status');
    assert.doesNotMatch(error.publicMessage, /hidden|token|127\.0\.0\.1|maintenance/);
    return true;
  });
});

test('an HTML page and a truncated file are rejected, not stored', async () => {
  await failsWith(fetchPath('/html'), 'truncated');
  await failsWith(fetchPath('/cut'), 'truncated');
});

test('size cap: stops reading and fails once the decoded bytes exceed the limit', async () => {
  await failsWith(fetchPath('/big', { maxBytes: 300_000 }), 'too_large');
});

test('size cap: a declared Content-Length over the limit is refused before reading the body', async () => {
  await failsWith(fetchPath('/declared-big', { maxBytes: 1000 }), 'too_large');
});

test('timeout covers a server that never answers and one that stalls mid-body', async () => {
  const started = Date.now();
  await failsWith(fetchPath('/stall-headers', { timeoutMs: 300 }), 'timeout');
  await failsWith(fetchPath('/stall-body', { timeoutMs: 300 }), 'timeout');
  assert.ok(Date.now() - started < 5000);
});

test('an unreachable host is a network error with a generic message', async () => {
  await assert.rejects(fetchSdnList({ url: 'http://127.0.0.1:1/x', allowInsecure: true }), (error: unknown) => {
    assert.ok(error instanceof SanctionsFetchError);
    assert.equal(error.code, 'network');
    assert.doesNotMatch(error.publicMessage, /127\.0\.0\.1/);
    return true;
  });
});
