/**
 * Operator tool: create a back-office admin directly in the database named by DATABASE_URL.
 *
 *   pnpm --filter @helix-field/api admin:create -- --email owner@example.com --name 'Ada Owner' --role OWNER
 *
 * Requires ADMIN_MFA_ENCRYPTION_KEY (>= 32 chars; the same value the API runs with). Works in any runtime, because it is how the
 * FIRST owner comes to exist. It generates a strong random password and an MFA seed, prints them ONCE to the terminal (stdout) and
 * stores only the scrypt hash and the AES-256-GCM-encrypted seed. Nothing is written to a file or a log. Refuses an existing email.
 * The credentials are shown on this terminal only: do not run it where output is captured or recorded.
 */
import { PrismaClient } from '@prisma/client';
import { parseArgs } from 'node:util';
import { EMAIL_PATTERN, MFA_KEY_ENV, MFA_KEY_MIN_LENGTH, createAdminCredentials, loadMfaKey, normalizeEmail } from '../src/admin/auth/credentials';

const USAGE = "Usage: admin:create -- --email <address> --name '<display name>' --role OWNER|STAFF";

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Load .env files the way the API does (apps/api, then repo root) without overriding variables already set. */
function loadEnvFiles(): void {
  const load = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (!load) return;
  for (const file of ['.env', '../../.env']) {
    try {
      load.call(process, file);
    } catch {
      /* file absent */
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } },
    strict: true,
  });

  const key = loadMfaKey(process.env);
  if (!key) fail(`Refusing: ${MFA_KEY_ENV} must be set to at least ${MFA_KEY_MIN_LENGTH} characters (generate one with: openssl rand -base64 32).`, 2);
  if (!process.env.DATABASE_URL) fail('Refusing: DATABASE_URL is not set.', 2);

  const email = normalizeEmail(values.email ?? '');
  const name = (values.name ?? '').trim();
  const role = values.role;
  // eslint-disable-next-line no-control-regex
  if (!EMAIL_PATTERN.test(email) || email.length > 254 || name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) || (role !== 'OWNER' && role !== 'STAFF')) fail(USAGE, 1);

  const prisma = new PrismaClient();
  try {
    if (await prisma.adminUser.findUnique({ where: { email } })) fail(`Refusing: an admin with email ${email} already exists.`, 2);
    const credentials = await createAdminCredentials(email, key as Buffer);
    const created = await prisma.adminUser.create({ data: { email, name, role: role as 'OWNER' | 'STAFF', passwordHash: credentials.passwordHash, mfaSeedEnc: credentials.mfaSeedEnc } });
    await prisma.adminAuditEvent.create({ data: { adminId: null, action: 'admin.user.create', targetType: 'admin', targetId: created.id, detail: { role: created.role, via: 'cli' } } });
    process.stdout.write(
      [
        `Admin account created: ${created.email} (${created.role})`,
        `Temporary password : ${credentials.password}`,
        `MFA otpauth URI    : ${credentials.otpauthUri}`,
        `MFA seed (base32)  : ${credentials.seedBase32}`,
        '',
        'Shown ONCE. Store the password in a password manager and enroll the MFA seed in an authenticator app now.',
        'Sign in at the admin UI, then change the password (POST /v1/admin/auth/change-password).',
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack that could include connection details.
  fail(`create-admin failed: ${error instanceof Error ? error.message.split('\n').filter(Boolean).slice(-1)[0] : 'unknown error'}`, 1);
});
