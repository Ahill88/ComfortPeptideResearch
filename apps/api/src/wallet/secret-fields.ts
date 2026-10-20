/**
 * The platform never accepts key material. These helpers find request fields that
 * look like secrets so the API can reject them with 400 (values are never logged or echoed).
 */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /secret/,
  /private/,
  /privkey/,
  /seed/,
  /mnemonic/,
  /passphrase/,
  /recoveryphrase/,
  /keypair/,
  /wallet(file|json)/,
];

function normalize(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Returns the (non-secret) field names/paths that resemble secret material. Walks nested objects/arrays. */
export function findSecretFields(body: unknown, path = '', depth = 0): string[] {
  if (depth > 6 || body === null || typeof body !== 'object') return [];
  const found: string[] = [];
  if (Array.isArray(body)) {
    body.forEach((item, index) => found.push(...findSecretFields(item, `${path}[${index}]`, depth + 1)));
    return found;
  }
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    const norm = normalize(key);
    if (SECRET_KEY_PATTERNS.some((pattern) => pattern.test(norm))) found.push(here);
    found.push(...findSecretFields(value, here, depth + 1));
  }
  return found;
}
