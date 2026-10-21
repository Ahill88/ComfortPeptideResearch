import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminCoreModule } from '../../admin/admin-core.module';
import { PrismaService } from '../../prisma.service';
import { EMAIL_CONFIG, type EmailConfig } from '../email.config';
import { EmailConfigError } from '../email.errors';
import { EmailModule } from '../email.module';
import { EMAIL_PROVIDER } from '../email.provider';
import { EmailService } from '../email.service';
import { EMAIL_PORT, type EmailPort } from '../email.types';
import { EmailWorker } from '../email.worker';
import { InMemoryEmailPrisma } from './email-support';

const prismaDouble = new InMemoryEmailPrisma();
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: prismaDouble }], exports: [PrismaService] })
class FakePrismaModule {}

/** Stands in for any feature module (auth, orders): it injects EMAIL_PORT WITHOUT importing EmailModule. */
@Injectable()
class Consumer {
  constructor(@Inject(EMAIL_PORT) readonly email: EmailPort) {}
}
@Module({ providers: [Consumer], exports: [Consumer] })
class ConsumerModule {}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await run();
  } finally {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
const clean = { EMAIL_PROVIDER: undefined, EMAIL_API_KEY: undefined, EMAIL_FROM: undefined, EMAIL_WORKER_INTERVAL_MS: '0', STOREFRONT_PUBLIC_URL: undefined };

test('boot: the module registers, EMAIL_PORT resolves to EmailService and is injectable from a module that does not import EmailModule', async () => {
  await withEnv({ ...clean, NODE_ENV: 'test' }, async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule, ConsumerModule] }).compile();
    assert.ok(moduleRef.get(EMAIL_PORT) instanceof EmailService);
    assert.equal(moduleRef.get(Consumer).email, moduleRef.get(EMAIL_PORT));
    assert.ok(moduleRef.get(EmailWorker));
    assert.equal(moduleRef.get(EMAIL_PROVIDER).name, 'console');
    await moduleRef.get(EMAIL_PORT).enqueue({ to: 'a@example.com', template: 'password_reset', data: { link: 'https://shop.example.com/reset-password?token=t' }, dedupeKey: 'boot' });
    assert.equal(prismaDouble.rows.length, 1);
    await moduleRef.close();
  });
});

test('boot: an initialised app with the worker disabled starts no timer; closing clears it when enabled', async () => {
  await withEnv({ ...clean, NODE_ENV: 'test' }, async () => {
    const off = await Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule] }).compile();
    await off.init();
    assert.equal((off.get(EmailWorker) as any).timer, undefined);
    await off.close();
  });
  await withEnv({ ...clean, NODE_ENV: 'test', EMAIL_WORKER_INTERVAL_MS: '60000' }, async () => {
    const on = await Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule] }).compile();
    await on.init();
    assert.ok((on.get(EmailWorker) as any).timer);
    await on.close();
    assert.equal((on.get(EmailWorker) as any).timer, undefined);
  });
});

test('boot: production-like runtime without EMAIL_PROVIDER binds no transport (none)', async () => {
  for (const nodeEnv of ['production', undefined, 'staging']) {
    await withEnv({ ...clean, NODE_ENV: nodeEnv }, async () => {
      const moduleRef = await Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule] }).compile();
      assert.equal(moduleRef.get(EMAIL_PROVIDER), null);
      assert.equal((moduleRef.get(EMAIL_CONFIG) as EmailConfig).provider, 'none');
      await moduleRef.close();
    });
  }
});

test('boot: resend without credentials or with a bad sender stops startup with a clear error that never echoes values', async () => {
  await withEnv({ ...clean, NODE_ENV: 'production', EMAIL_PROVIDER: 'resend' }, async () => {
    await assert.rejects(
      () => Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule] }).compile(),
      (e: unknown) => e instanceof EmailConfigError && /EMAIL_API_KEY is required/.test(e.message) && /EMAIL_FROM is required/.test(e.message),
    );
  });
  await withEnv({ ...clean, NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_test_0123456789abcdefghij', EMAIL_FROM: 'nonsense' }, async () => {
    await assert.rejects(
      () => Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule] }).compile(),
      (e: unknown) => e instanceof EmailConfigError && /EMAIL_FROM must be a valid address/.test(e.message) && !e.message.includes('re_test'),
    );
  });
  await withEnv({ ...clean, NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_test_0123456789abcdefghij', EMAIL_FROM: 'Shop <orders@example.com>' }, async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, EmailModule] }).compile();
    assert.equal(moduleRef.get(EMAIL_PROVIDER).name, 'resend');
    await moduleRef.close();
  });
});

test('app.module registers EmailModule with one import line and one array entry', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
  assert.equal((src.match(/from '\.\/email\/email\.module'/g) ?? []).length, 1);
  assert.equal((src.match(/^\s+EmailModule,$/gm) ?? []).length, 1);
});

test('source hygiene: no "secret" wording and no NODE_ENV string comparisons in non-test email code; no node:child_process or HTTP clients besides fetch', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); } else if (name.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(__dirname, '..'));
  assert.ok(files.length >= 15);
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /secret/i, `${file} must not use the word secret`);
    assert.doesNotMatch(src, /NODE_ENV\s*[!=]==?|[!=]==?\s*['"`]production['"`]/, `${file} must use runtime.ts helpers`);
    assert.doesNotMatch(src, /child_process|require\(['"]https?['"]\)|from 'node:https?'|axios|nodemailer/, file);
  }
});
