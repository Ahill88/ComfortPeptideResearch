import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const apiRoot = join(__dirname, '../apps/api');
const sourceRoot = join(apiRoot, 'src');
const sourceFiles = readdirSync(sourceRoot, { recursive: true })
  .filter((file) => typeof file === 'string' && file.endsWith('.ts'))
  .map((file) => join(sourceRoot, file));

function source(): string {
  return [...sourceFiles, join(apiRoot, 'prisma/schema.prisma')].map((file) => readFileSync(file, 'utf8')).join('\n');
}

function schema(): string {
  return readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');
}

test('non-production sessions are visibly constrained', () => {
  const implementation = source();

  assert.match(
    implementation,
    /development.{0,120}(session|auth)|(session|auth).{0,120}development/i,
    'Add an explicit, user-visible non-production session constraint (for example a development banner and restricted test identity).',
  );
});

test('account routes require a server-validated session', () => {
  const implementation = source();

  assert.match(implementation, /@Controller\(['"](?:account|accounts)['"]\)/, 'Add account routes before enabling account features.');
  assert.match(
    implementation,
    /@UseGuards\([^)]*(?:Session|Auth)[^)]*\)|@RequireSession\(/,
    'Protect every account route with a server-validated session guard.',
  );
});

test('production startup requires server-backed email verification, password reset, and MFA', () => {
  const implementation = source();

  for (const capability of ['email verification', 'password reset', 'MFA']) {
    assert.match(
      implementation,
      new RegExp(capability.replace(' ', '.{0,80}'), 'i'),
      `Implement persisted, server-backed ${capability} before allowing production startup.`,
    );
  }
  assert.match(
    implementation,
    /NODE_ENV\s*={2,3}\s*['"]production['"].{0,300}(email|verification|reset|mfa)|(email|verification|reset|mfa).{0,300}NODE_ENV\s*={2,3}\s*['"]production['"]/i,
    'Fail production startup when email verification, password reset, or MFA is not server-backed.',
  );
});

test('customer eligibility is persisted separately from research-use acknowledgement', () => {
  const databaseSchema = schema();

  assert.match(databaseSchema, /model\s+Order\s*\{[^}]*researchAcknowledgedAt/s, 'Keep the order-level research-use acknowledgement.');
  assert.match(
    databaseSchema,
    /model\s+Customer\s*\{[^}]*eligib/i,
    'Add a distinct customer eligibility record or field; RUO acknowledgement alone must not establish eligibility.',
  );
  assert.doesNotMatch(
    databaseSchema,
    /model\s+Order\s*\{[^}]*eligib/i,
    'Do not derive eligibility from the research-use acknowledgement timestamp.',
  );
});
