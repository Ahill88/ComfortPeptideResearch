/** Shared HTTP harness: boots the real AuthModule over HTTP against any Prisma implementation. Not a test file. */
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { EmailEnqueueInput } from '../../email/email.types';
import type { AuthService } from '../auth.service';
import type { AccountService } from '../account.service';

export const TEST_PASSWORD = 'correct horse battery staple 1!';
export const ORIGIN = 'http://localhost:3000';

export interface Res { status: number; text: string; body: any; headers: Headers; cookies: string[] }
export interface TestCustomer { id: string; email: string; password: string; seed: string | null }
export interface CallOptions { body?: unknown; headers?: Record<string, string>; cookie?: string; origin?: string | null; rawBody?: string }

export interface Harness {
  base: string;
  prisma: any;
  tag: string;
  app: INestApplication;
  clock: { offsetMs: number };
  emails: EmailEnqueueInput[];
  auth: AuthService;
  account: AccountService;
  /** Fresh unique email at this harness's example.test domain. */
  email(label: string): string;
  call(method: string, path: string, options?: CallOptions): Promise<Res>;
  /** A verified customer with credentials (optionally MFA-enrolled, or any column override). */
  makeCustomer(label: string, overrides?: Record<string, unknown> & { mfa?: boolean }): Promise<TestCustomer>;
  /** TOTP code for the customer's seed at the (offset) service clock. */
  code(customer: TestCustomer, deltaSteps?: number): string;
  /** Signs in and returns the `hf_session=<token>` request cookie. */
  signIn(customer: TestCustomer, totp?: string): Promise<string>;
  /** The raw token from the most recent email to `to` with `template`. */
  tokenFor(to: string, template: 'email_verification' | 'password_reset'): string;
  emailsTo(to: string, template?: string): EmailEnqueueInput[];
  close(): Promise<void>;
}

export interface HarnessOptions { throttleAuthLimit?: number; tag?: string; noEmailPort?: boolean }

let passwordHashCache: Promise<string> | undefined;

export async function startHarness(prisma: any, options: HarnessOptions = {}): Promise<Harness> {
  if ((process.env.CUSTOMER_MFA_ENCRYPTION_KEY ?? '').length < 32) process.env.CUSTOMER_MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.STOREFRONT_ORIGIN = ORIGIN;
  delete process.env.STOREFRONT_PUBLIC_URL;
  const { Controller, Get, Global, HttpCode, Module, Post, UseGuards, ValidationPipe } = await import('@nestjs/common');
  const { APP_GUARD } = await import('@nestjs/core');
  const { Test } = await import('@nestjs/testing');
  const { ThrottlerModule } = await import('@nestjs/throttler');
  const { PrismaService } = await import('../../prisma.service');
  const { AuthModule } = await import('../auth.module');
  const { AuthService } = await import('../auth.service');
  const { AccountService } = await import('../account.service');
  const { CUSTOMER_AUTH_CLOCK, loadCustomerMfaKey } = await import('../auth.config');
  const { SessionGuard, CurrentSession } = await import('../session.guard');
  const { CustomerEmail } = await import('../../wallet/customer-identity');
  const { EMAIL_PORT } = await import('../../email/email.types');
  const { buildThrottlerModuleOptions, RouteAwareThrottlerGuard } = await import('../../config/rate-limit');
  const credentials = await import('../../admin/auth/credentials');
  const { configureAppForTest } = await import('./cors-for-test');

  const clock = { offsetMs: 0 };
  const emails: EmailEnqueueInput[] = [];
  const tag = options.tag ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const providers: any[] = [{ provide: PrismaService, useValue: prisma }, { provide: CUSTOMER_AUTH_CLOCK, useValue: () => Date.now() + clock.offsetMs }];
  if (!options.noEmailPort) providers.push({ provide: EMAIL_PORT, useValue: { enqueue: async (input: EmailEnqueueInput) => void emails.push(input) } });
  @Global()
  @Module({ providers, exports: providers.map((p) => p.provide) })
  class TestGlobalModule {}

  /** Stand-ins for wallet/checkout/orders: they identify the caller with the shared resolver only. */
  @Controller('_probe')
  class ProbeController {
    @Get('who') who(@CustomerEmail() email: string) { return { email }; }
    @Post('who') @HttpCode(200) whoPost(@CustomerEmail() email: string) { return { email }; }
    @Get('guarded') @UseGuards(SessionGuard) guarded(@CurrentSession() session: unknown) { return session; }
    @Post('guarded') @HttpCode(200) @UseGuards(SessionGuard) guardedPost(@CurrentSession() session: unknown) { return session; }
  }
  @Module({ controllers: [ProbeController], providers: [SessionGuard] })
  class ProbeModule {}

  const imports: any[] = [TestGlobalModule, AuthModule, ProbeModule];
  const extra: any[] = [];
  if (options.throttleAuthLimit) {
    imports.push(ThrottlerModule.forRoot(buildThrottlerModuleOptions({ THROTTLE_AUTH_LIMIT: String(options.throttleAuthLimit) })));
    extra.push({ provide: APP_GUARD, useClass: RouteAwareThrottlerGuard });
  }
  const moduleRef = await Test.createTestingModule({ imports, providers: extra }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configureAppForTest(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const key = loadCustomerMfaKey(process.env) as Buffer;
  const passwordHash = (passwordHashCache ??= credentials.hashPassword(TEST_PASSWORD));

  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.cookie) headers.cookie = opts.cookie;
    // State-changing calls carry the allow-listed Origin by default; pass origin:null to omit it or a string to override it.
    const origin = opts.origin === null ? undefined : (opts.origin ?? (method === 'GET' ? undefined : ORIGIN));
    if (origin !== undefined) headers.origin = origin;
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}/v1${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, text, body: parsed, headers: res.headers, cookies: res.headers.getSetCookie() };
  };
  const code: Harness['code'] = (customer, delta = 0) => credentials.totpCodeAt(customer.seed as string, Date.now() + clock.offsetMs + delta * 30_000);
  const emailsTo: Harness['emailsTo'] = (to, template) => emails.filter((e) => e.to === to && (!template || e.template === template));

  return {
    base, prisma, tag, app, clock, emails,
    auth: app.get(AuthService),
    account: app.get(AccountService),
    email: (label) => `${label}@${tag}.example.test`,
    call, code, emailsTo,
    async makeCustomer(label, overrides = {}) {
      const { mfa, ...columns } = overrides;
      const seed = mfa ? credentials.generateTotpSeed() : null;
      const email = `${label}@${tag}.example.test`;
      const row = await prisma.customer.create({
        data: {
          email, name: `Test ${label}`, passwordHash: await passwordHash, emailVerifiedAt: new Date(),
          ...(seed ? { mfaSeedEnc: credentials.encryptSeed(seed, key), mfaEnabledAt: new Date() } : {}),
          ...columns,
        },
      });
      return { id: row.id, email, password: TEST_PASSWORD, seed };
    },
    async signIn(customer, totp) {
      const res = await call('POST', '/auth/login', { body: { email: customer.email, password: customer.password, ...(totp ? { totp } : {}) } });
      if (res.status !== 200) throw new Error(`signIn failed: ${res.status} ${res.text}`);
      return (res.cookies[0] as string).split(';')[0];
    },
    tokenFor(to, template) {
      const mail = emailsTo(to, template).at(-1);
      if (!mail) throw new Error(`no ${template} email for ${to}`);
      return new URL(String(mail.data.link)).searchParams.get('token') as string;
    },
    async close() {
      await app.close();
    },
  };
}
