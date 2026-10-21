/** Shared HTTP test harness: boots the real AdminAuthModule over HTTP against any Prisma implementation. Not a test file. */
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';

export interface TestAdmin { id: string; email: string; password: string; seed: string; role: 'OWNER' | 'STAFF' }

export interface Harness {
  base: string;
  prisma: any;
  clock: { offsetMs: number };
  tag: string;
  app: INestApplication;
  service: import('../admin-auth.service').AdminAuthService;
  makeAdmin(role: 'OWNER' | 'STAFF', label: string, overrides?: Record<string, unknown>): Promise<TestAdmin>;
  /** Fresh TOTP code for the admin at the (possibly offset) service clock. */
  code(admin: TestAdmin, deltaSteps?: number): string;
  login(admin: TestAdmin, extra?: { password?: string; totp?: string }): Promise<Res>;
  /** Signs in with a valid code, clearing the replay marker first so one test can sign in several times. */
  freshLogin(admin: TestAdmin): Promise<{ token: string; expiresAt: string; admin: any }>;
  call(method: string, path: string, options?: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string }): Promise<Res>;
  close(): Promise<void>;
}
export interface Res { status: number; text: string; body: any; headers: Headers }

export const TEST_PASSWORD = 'correct horse battery staple 1!';

export async function startHarness(prisma: any, options: { throttleAuthLimit?: number; tag?: string } = {}): Promise<Harness> {
  if ((process.env.ADMIN_MFA_ENCRYPTION_KEY ?? '').length < 32) process.env.ADMIN_MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { APP_GUARD } = await import('@nestjs/core');
  const { Test } = await import('@nestjs/testing');
  const { ThrottlerModule } = await import('@nestjs/throttler');
  const { PrismaService } = await import('../../../prisma.service');
  const { AdminAuthModule } = await import('../admin-auth.module');
  const { ADMIN_AUTH_CLOCK, AdminAuthService } = await import('../admin-auth.service');
  const { buildThrottlerModuleOptions, RouteAwareThrottlerGuard } = await import('../../../config/rate-limit');
  const credentials = await import('../credentials');

  const clock = { offsetMs: 0 };
  const tag = options.tag ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class TestPrismaModule {}

  const imports: any[] = [TestPrismaModule, AdminAuthModule];
  const providers: any[] = [];
  if (options.throttleAuthLimit) {
    imports.push(ThrottlerModule.forRoot(buildThrottlerModuleOptions({ THROTTLE_AUTH_LIMIT: String(options.throttleAuthLimit) })));
    providers.push({ provide: APP_GUARD, useClass: RouteAwareThrottlerGuard });
  }
  const moduleRef = await Test.createTestingModule({ imports, providers }).overrideProvider(ADMIN_AUTH_CLOCK).useValue(() => Date.now() + clock.offsetMs).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const key = credentials.loadMfaKey(process.env) as Buffer;

  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}/v1${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, text, body: parsed, headers: res.headers };
  };
  const code: Harness['code'] = (admin, delta = 0) => credentials.totpCodeAt(admin.seed, Date.now() + clock.offsetMs + delta * 30_000);
  const login: Harness['login'] = (admin, extra = {}) => call('POST', '/admin/auth/login', { body: { email: admin.email, password: extra.password ?? admin.password, totp: extra.totp ?? code(admin) } });

  return {
    base, prisma, clock, tag, app,
    service: app.get(AdminAuthService),
    async makeAdmin(role, label, overrides = {}) {
      const seed = credentials.generateTotpSeed();
      const email = `${label}@${tag}.example.test`;
      const row = await prisma.adminUser.create({ data: { email, name: `Test ${label}`, role, passwordHash: await credentials.hashPassword(TEST_PASSWORD), mfaSeedEnc: credentials.encryptSeed(seed, key), ...overrides } });
      return { id: row.id, email, password: TEST_PASSWORD, seed, role };
    },
    code, login, call,
    async freshLogin(admin) {
      await prisma.adminUser.updateMany({ where: { id: admin.id }, data: { lastTotpStep: null } });
      const res = await login(admin);
      if (res.status !== 200) throw new Error(`freshLogin failed: ${res.status} ${res.text}`);
      return res.body;
    },
    async close() {
      await app.close();
    },
  };
}
