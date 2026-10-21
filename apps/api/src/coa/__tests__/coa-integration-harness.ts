/**
 * Shared bootstrap for the DB-backed COA suites (imported only by *.integration.test.ts, which tests/run-all.mjs skips without
 * TEST_DATABASE_URL). REAL PostgreSQL, REAL AdminSessionGuard (OWNER / STAFF sessions inserted directly), REAL AdminAuditService.
 * The anchor port is a recording double whose behaviour a test can swap. Refuses non-local databases. Everything created here is
 * tagged and removed by cleanup(); nothing is truncated.
 */
import { createHash, randomBytes } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suites (run tests/run-all.mjs to see them reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
}
if (['public', 'dev'].includes(parsed.searchParams.get('schema') ?? 'public')) {
  throw new Error('Refusing to run the COA suites in the shared public/dev schema: set ?schema=<your own schema>.');
}
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

export const PUBLISHER = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
export const TX_SIGNATURE = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

export type PortCall = { coaId: string; kind: 'PUBLISH' | 'REVOKE'; statusAtCall?: string };
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** A minimal valid-looking PDF whose bytes are unique per `seed`, so every call has a distinct SHA-256. */
export function pdfBytes(seed: string, padTo = 0): Buffer {
  const body = Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n% ${seed}\ntrailer<<>>\n%%EOF\n`, 'latin1');
  return padTo > body.length ? Buffer.concat([body, Buffer.alloc(padTo - body.length, 0x20)]) : body;
}

export interface Harness {
  tag: string;
  base: string;
  prisma: import('../../prisma.service').PrismaService;
  tokens: { owner: string; staff: string; staff2: string };
  admins: { owner: { id: string; name: string }; staff: { id: string; name: string }; staff2: { id: string; name: string } };
  port: { calls: PortCall[]; behavior: (input: { coaId: string; kind: 'PUBLISH' | 'REVOKE' }) => Promise<void> | void };
  anchorInfo: { network: string | null; publisher: string | null; anchoringEnabled: boolean };
  product: { id: string; slug: string; name: string; sku: string };
  call(method: string, path: string, options?: { token?: string | null; json?: unknown; form?: FormData; headers?: Record<string, string> }): Promise<{ status: number; headers: Headers; body: any; raw: Buffer }>;
  upload(lotId: string, options?: { token?: string | null; bytes?: Buffer; seed?: string; name?: string; type?: string; fields?: Record<string, string | undefined>; skipFile?: boolean }): ReturnType<Harness['call']>;
  mkLot(code?: string, productId?: string): Promise<{ id: string; code: string }>;
  mkProduct(label: string, active?: boolean): Promise<{ id: string; slug: string; name: string; sku: string }>;
  /** upload + publish as OWNER; returns the published AdminCoa */
  uploadAndPublish(lotId: string, seed: string, fields?: Record<string, string | undefined>): Promise<any>;
  track: { lots: string[]; products: string[]; customers: string[] };
  cleanup(): Promise<void>;
}

export const VALID_FIELDS = { labName: 'Janoshik Analytical', labReportId: 'JA-2026-0001', testedAt: '2026-10-01', method: 'HPLC', purityPercent: '98.50', notes: 'Batch tested for identity and purity.' };

export async function bootHarness(label: string): Promise<Harness> {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../prisma.service');
  const { AdminCoreModule } = await import('../../admin/admin-core.module');
  const { hashSessionToken } = await import('../../admin/admin-session.guard');
  const { CoaModule } = await import('../coa.module');
  const { COA_ANCHOR_PORT } = await import('../coa.types');
  const { COA_ANCHOR_INFO } = await import('../coa-anchor-info');
  const { CatalogModule } = await import('../../catalog/catalog.module');
  const { OrdersModule } = await import('../../orders/orders.module');
  const { securityHeaders } = await import('../../config/security-headers');

  const tag = `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.replace(/[^A-Za-z0-9]/g, '');
  const prisma = new PrismaService();
  await prisma.$connect();
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class RealPrismaModule {}

  const adminIds: string[] = [];
  const mkAdmin = async (key: string, role: 'OWNER' | 'STAFF', name: string) => {
    const row = await prisma.adminUser.create({ data: { email: `${tag}-${key}@example.test`, name, role, passwordHash: 'x', mfaSeedEnc: 'x' } });
    adminIds.push(row.id);
    const token = randomBytes(32).toString('base64url');
    await prisma.adminSession.create({ data: { adminId: row.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
    return { id: row.id, name: row.name, token };
  };
  const owner = await mkAdmin('owner', 'OWNER', 'Olivia Owner');
  const staff = await mkAdmin('staff', 'STAFF', 'Sam Staff');
  const staff2 = await mkAdmin('staff2', 'STAFF', 'Sue Staff');

  const port: Harness['port'] = { calls: [], behavior: () => undefined };
  const anchorInfo: Harness['anchorInfo'] = { network: 'solana-devnet', publisher: PUBLISHER, anchoringEnabled: true };
  const portDouble = {
    async requestAnchor(input: { coaId: string; kind: 'PUBLISH' | 'REVOKE' }) {
      // Records the coa's status at call time: proves the call happens AFTER the transaction committed.
      const row = await prisma.coa.findUnique({ where: { id: input.coaId }, select: { status: true } });
      port.calls.push({ ...input, statusAtCall: row?.status });
      await port.behavior(input);
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      RealPrismaModule,
      AdminCoreModule,
      CatalogModule,
      OrdersModule,
      CoaModule.register({ providers: [{ provide: COA_ANCHOR_PORT, useValue: portDouble }, { provide: COA_ANCHOR_INFO, useValue: anchorInfo }] }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.use(securityHeaders({ NODE_ENV: 'test' }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const tokens = { owner: owner.token, staff: staff.token, staff2: staff2.token };

  const track = { lots: [] as string[], products: [] as string[], customers: [] as string[] };
  const call: Harness['call'] = async (method, path, options = {}) => {
    const token = options.token === undefined ? tokens.owner : options.token;
    const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) };
    if (options.json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: options.form ?? (options.json === undefined ? undefined : JSON.stringify(options.json)) });
    const raw = Buffer.from(await res.arrayBuffer());
    let body: any = null;
    if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(raw.toString('utf8'));
    return { status: res.status, headers: res.headers, body, raw };
  };

  const mkProduct: Harness['mkProduct'] = async (name, active = true) => {
    const row = await prisma.product.create({ data: { sku: `SKU-${tag}-${name}`, slug: `slug-${tag}-${name}`.toLowerCase(), name: `Peptide ${name} ${tag}`, active, priceCents: 1250, inventory: 10 } });
    track.products.push(row.id);
    return { id: row.id, slug: row.slug, name: row.name, sku: row.sku };
  };
  const product = await mkProduct('main');
  let lotSeq = 0;
  const mkLot: Harness['mkLot'] = async (code, productId) => {
    lotSeq += 1;
    const row = await prisma.lot.create({ data: { code: code ?? `LOT-${tag}-${lotSeq}`, productId: productId ?? product.id, coaKey: 'PENDING-NO-COA', purity: 0 } });
    track.lots.push(row.id);
    return { id: row.id, code: row.code };
  };

  const upload: Harness['upload'] = (lotId, options = {}) => {
    const form = new FormData();
    const fields = { ...VALID_FIELDS, ...(options.fields ?? {}) };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
    if (!options.skipFile) {
      const bytes = options.bytes ?? pdfBytes(options.seed ?? `${tag}-${Math.random()}`);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: options.type ?? 'application/pdf' }), options.name ?? 'report.pdf');
    }
    return call('POST', `/v1/admin/lots/${lotId}/coas`, { token: options.token, form });
  };

  const uploadAndPublish: Harness['uploadAndPublish'] = async (lotId, seed, fields) => {
    const up = await upload(lotId, { seed, fields });
    if (up.status !== 201) throw new Error(`upload failed ${up.status} ${JSON.stringify(up.body)}`);
    const pub = await call('POST', `/v1/admin/coas/${up.body.id}/publish`, { json: { confirmSha256: up.body.file.sha256 } });
    if (pub.status !== 200) throw new Error(`publish failed ${pub.status} ${JSON.stringify(pub.body)}`);
    return pub.body;
  };

  const cleanup = async () => {
    try {
      // Lots created through the API are found by their tagged code.
      const lots = await prisma.lot.findMany({ where: { OR: [{ id: { in: track.lots } }, { code: { contains: tag } }] }, select: { id: true } });
      const lotIds = lots.map((lot) => lot.id);
      const coas = await prisma.coa.findMany({ where: { lotId: { in: lotIds } }, select: { id: true } });
      const coaIds = coas.map((coa) => coa.id);
      // Customers created through POST /v1/orders are found by their tagged (lower-cased) email.
      const customers = await prisma.customer.findMany({ where: { OR: [{ id: { in: track.customers } }, { email: { contains: tag.toLowerCase() } }] }, select: { id: true } });
      const customerIds = customers.map((customer) => customer.id);
      const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
      await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ adminId: { in: adminIds } }, { targetId: { in: [...coaIds, ...lotIds, ...track.products] } }] } });
      await prisma.coaAnchor.deleteMany({ where: { coaId: { in: coaIds } } });
      await prisma.coaFile.deleteMany({ where: { coaId: { in: coaIds } } });
      await prisma.coa.deleteMany({ where: { id: { in: coaIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orders.map((order) => order.id) } } });
      await prisma.order.deleteMany({ where: { id: { in: orders.map((order) => order.id) } } });
      await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
      await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
      await prisma.product.deleteMany({ where: { id: { in: track.products } } });
      await prisma.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  };

  return {
    tag,
    base,
    prisma,
    tokens,
    admins: { owner: { id: owner.id, name: owner.name }, staff: { id: staff.id, name: staff.name }, staff2: { id: staff2.id, name: staff2.name } },
    port,
    anchorInfo,
    product,
    call,
    upload,
    mkLot,
    mkProduct,
    uploadAndPublish,
    track,
    cleanup,
  };
}
