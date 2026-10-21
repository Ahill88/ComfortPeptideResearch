import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'anchor' ? [] : sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

const OWN_DIRS = [join(__dirname, '..'), join(__dirname, '..', '..', 'catalog')];

test('custody scanners: the word "secret" does not appear in the COA core or catalog sources', () => {
  const offenders = OWN_DIRS.flatMap(sources).filter((file) => /secret/i.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the COA core never selects file bytes in a list/detail query and never logs them', () => {
  for (const file of sources(OWN_DIRS[0])) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/console\.(log|info|warn|error)/.test(text), `${file} uses console`);
    assert.ok(!/logger\.\w+\([^)]*(bytes|buffer)/i.test(text), `${file} logs file content`);
  }
});

test('every admin COA route sits behind AdminSessionGuard and the OWNER-only routes declare @AdminRoles', () => {
  const text = readFileSync(join(__dirname, '..', 'coa-admin.controller.ts'), 'utf8');
  assert.equal((text.match(/@UseGuards\(AdminSessionGuard\)/g) ?? []).length, 3, 'three admin controllers, each guarded');
  assert.equal((text.match(/@AdminRoles\('OWNER'\)/g) ?? []).length, 5, 'product publish/unpublish, coa publish/revoke, anchor retry');
  assert.ok(!text.includes("@AdminRoles('STAFF')"));
});
