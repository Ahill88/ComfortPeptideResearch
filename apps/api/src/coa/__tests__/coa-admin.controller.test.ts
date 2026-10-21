/**
 * Admin COA controllers with a recording service double: role matrix enforced from the @AdminRoles metadata by a role-aware test guard,
 * multipart handling (limits, type-blind) through the real upload interceptor, status codes and argument plumbing. No database.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { type CanActivate, type ExecutionContext, type INestApplication, ForbiddenException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ADMIN_ROLES_KEY } from '../../admin/admin.decorators';
import { AdminSessionGuard } from '../../admin/admin-session.guard';
import { AdminCatalogController, AdminCoasController, AdminLotsController, CoaUploadInterceptor } from '../coa-admin.controller';
import { CoaAdminService } from '../coa-admin.service';

/** x-test-role: OWNER | STAFF (id admin-owner / admin-staff). Enforces @AdminRoles exactly like the real guard does. */
class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const role = request.headers['x-test-role'];
    if (role !== 'OWNER' && role !== 'STAFF') throw new UnauthorizedException('Admin sign-in required.');
    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(ADMIN_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (allowed?.length && !allowed.includes(role)) throw new ForbiddenException('Not permitted for this admin role.');
    request.admin = { id: `admin-${role.toLowerCase()}`, email: 'x@example.test', name: role, role };
    return true;
  }
}

const calls = [] as Array<{ method: string; args: any[] }>;
const record = (method: string) => async (...args: any[]) => {
  calls.push({ method, args });
  return method === 'getFile' ? { bytes: Buffer.from('%PDF-1.4 x'), sha256: 'a'.repeat(64) } : { ok: method };
};
const serviceDouble = Object.fromEntries(
  ['listProducts', 'publishProduct', 'unpublishProduct', 'listLots', 'createLot', 'getLot', 'upload', 'getFile', 'publish', 'revoke', 'delete', 'retryAnchor'].map((name) => [name, record(name)]),
);

let app: INestApplication;
let base = '';
before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminCatalogController, AdminLotsController, AdminCoasController],
    providers: [{ provide: CoaAdminService, useValue: serviceDouble }, CoaUploadInterceptor],
  })
    .overrideGuard(AdminSessionGuard)
    .useFactory({ factory: (reflector: Reflector) => new RoleGuard(reflector), inject: [Reflector] })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(async () => {
  await app?.close();
});

const call = async (method: string, path: string, role: string | null, json?: unknown, form?: FormData) => {
  const res = await fetch(`${base}/v1/admin${path}`, {
    method,
    headers: { ...(role ? { 'x-test-role': role } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

const ID = 'c'.repeat(25);
const SHA = 'ab'.repeat(32);
type Route = [method: string, path: string, body: unknown, ownerOnly: boolean, expectedStatus: number, serviceMethod: string];
const ROUTES: Route[] = [
  ['GET', '/catalog/products', undefined, false, 200, 'listProducts'],
  ['POST', `/catalog/products/${ID}/publish`, {}, true, 200, 'publishProduct'],
  ['POST', `/catalog/products/${ID}/unpublish`, {}, true, 200, 'unpublishProduct'],
  ['GET', '/lots', undefined, false, 200, 'listLots'],
  ['POST', '/lots', { productId: ID, code: 'LOT-1' }, false, 201, 'createLot'],
  ['GET', `/lots/${ID}`, undefined, false, 200, 'getLot'],
  ['GET', `/coas/${ID}/file`, undefined, false, 200, 'getFile'],
  ['POST', `/coas/${ID}/publish`, { confirmSha256: SHA }, true, 200, 'publish'],
  ['POST', `/coas/${ID}/revoke`, { reason: 'why' }, true, 200, 'revoke'],
  ['DELETE', `/coas/${ID}`, undefined, false, 204, 'delete'],
  ['POST', `/coas/${ID}/anchor/retry`, { kind: 'PUBLISH' }, true, 200, 'retryAnchor'],
];

test('role matrix: no session 401 everywhere; STAFF 403 exactly on the five OWNER-only routes (service never called); OWNER passes all', async () => {
  for (const [method, path, body, ownerOnly, status, serviceMethod] of ROUTES) {
    calls.length = 0;
    assert.equal((await call(method, path, null, body)).status, 401, `${method} ${path} anon`);
    const staff = await call(method, path, 'STAFF', body);
    assert.equal(staff.status, ownerOnly ? 403 : status, `${method} ${path} STAFF`);
    assert.deepEqual(calls.map((c) => c.method), ownerOnly ? [] : [serviceMethod], `${method} ${path} STAFF reaches the service only when allowed`);
    calls.length = 0;
    assert.equal((await call(method, path, 'OWNER', body)).status, status, `${method} ${path} OWNER`);
    assert.deepEqual(calls.map((c) => c.method), [serviceMethod]);
  }
  assert.equal(ROUTES.filter((route) => route[3]).length, 5);
  const upload = new FormData();
  upload.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'a.pdf');
  assert.equal((await call('POST', `/lots/${ID}/coas`, null, undefined, upload)).status, 401);
  calls.length = 0;
  const staffUpload = new FormData();
  staffUpload.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'a.pdf');
  assert.equal((await call('POST', `/lots/${ID}/coas`, 'STAFF', undefined, staffUpload)).status, 201, 'STAFF may upload drafts');
});

test('actor plumbing: the service receives the session principal and role, never anything from the body', async () => {
  calls.length = 0;
  await call('POST', `/coas/${ID}/publish`, 'OWNER', { confirmSha256: SHA, adminId: 'evil', role: 'OWNER' });
  const [id, confirm, actor] = calls[0].args;
  assert.equal(id, ID);
  assert.equal(confirm, SHA);
  assert.equal(actor.id, 'admin-owner');
  assert.equal(actor.role, 'OWNER');
  calls.length = 0;
  await call('DELETE', `/coas/${ID}`, 'STAFF');
  assert.equal(calls[0].args[1].role, 'STAFF');
  assert.equal(calls[0].args[1].id, 'admin-staff');
});

test('upload: multipart reaches the service with the file bytes and text fields; the declared MIME type is passed through untouched (the service decides from bytes)', async () => {
  calls.length = 0;
  const form = new FormData();
  form.append('labName', 'Lab');
  form.append('purityPercent', '98.5');
  form.append('file', new Blob(['%PDF-1.4 hello'], { type: 'image/png' }), 'weird.name');
  const res = await call('POST', `/lots/${ID}/coas`, 'OWNER', undefined, form);
  assert.equal(res.status, 201);
  const [lotId, file, fields] = calls[0].args;
  assert.equal(lotId, ID);
  assert.equal(file.buffer.toString(), '%PDF-1.4 hello');
  assert.equal(file.mimetype, 'image/png');
  assert.equal(fields.labName, 'Lab');
  assert.equal(fields.purityPercent, '98.5');
});

test('upload: a file over the multer limit, a second file, or too many fields is a 400 (never 413/500) and never reaches the service', async () => {
  calls.length = 0;
  const big = new FormData();
  big.append('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 2, 0x20)]), 'big.pdf');
  const tooBig = await call('POST', `/lots/${ID}/coas`, 'OWNER', undefined, big);
  assert.equal(tooBig.status, 400, tooBig.text);
  assert.match(tooBig.text, /10 MB/);

  const two = new FormData();
  two.append('file', new Blob(['%PDF-1']), 'a.pdf');
  two.append('file', new Blob(['%PDF-2']), 'b.pdf');
  assert.equal((await call('POST', `/lots/${ID}/coas`, 'OWNER', undefined, two)).status, 400);

  const other = new FormData();
  other.append('attachment', new Blob(['%PDF-1']), 'a.pdf');
  assert.equal((await call('POST', `/lots/${ID}/coas`, 'OWNER', undefined, other)).status, 400, 'a file under another field name is rejected');

  const fat = new FormData();
  fat.append('notes', 'n'.repeat(5000));
  assert.equal((await call('POST', `/lots/${ID}/coas`, 'OWNER', undefined, fat)).status, 400, 'oversized text field');
  assert.deepEqual(calls, []);
});

test('upload without multipart (plain JSON) reaches the service with no file, which rejects it (400 in the service)', async () => {
  calls.length = 0;
  const res = await call('POST', `/lots/${ID}/coas`, 'OWNER', { labName: 'x' });
  assert.equal(res.status, 201, 'the controller defers to the service, which validates; the double accepts');
  assert.equal(calls[0].args[1], undefined);
});

test('DTO validation happens before the service: publish/revoke/retry/lot bodies and list queries', async () => {
  calls.length = 0;
  assert.equal((await call('POST', `/coas/${ID}/publish`, 'OWNER', {})).status, 400);
  assert.equal((await call('POST', `/coas/${ID}/revoke`, 'OWNER', { reason: 'r'.repeat(501) })).status, 400);
  assert.equal((await call('POST', `/coas/${ID}/revoke`, 'OWNER', { reason: '   ' })).status, 400);
  assert.equal((await call('POST', `/coas/${ID}/anchor/retry`, 'OWNER', { kind: 'publish' })).status, 400);
  assert.equal((await call('POST', '/lots', 'STAFF', { code: 'x' })).status, 400);
  assert.equal((await call('GET', '/lots?limit=1000', 'STAFF')).status, 400);
  assert.equal((await call('GET', '/lots?limit=abc', 'STAFF')).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await call('GET', '/lots?limit=5&q=abc&productId=p1&cursor=zzz', 'STAFF')).status, 200);
  assert.deepEqual({ ...calls[0].args[0] }, { limit: 5, q: 'abc', productId: 'p1', cursor: 'zzz' });
});

test('responses: JSON routes are no-store; the admin file route is a private PDF with nosniff; DELETE is an empty 204', async () => {
  const list = await call('GET', '/lots', 'STAFF');
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const file = await call('GET', `/coas/${ID}/file`, 'STAFF');
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('content-disposition'), 'inline');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('cache-control') ?? '', /private/);
  const del = await call('DELETE', `/coas/${ID}`, 'OWNER');
  assert.equal(del.status, 204);
  assert.equal(del.text, '');
});
