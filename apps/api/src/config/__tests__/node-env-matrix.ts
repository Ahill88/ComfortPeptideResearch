/** NODE_ENV values every safety gate must be exercised against. Only development and test are non-production. */
export const NODE_ENV_MATRIX: readonly (string | undefined)[] = [undefined, '', 'development', 'test', 'staging', 'prod', 'Production', 'production', 'production '];

export const ALLOWED_NODE_ENVS: readonly (string | undefined)[] = ['development', 'test'];
export const DENIED_NODE_ENVS: readonly (string | undefined)[] = NODE_ENV_MATRIX.filter((value) => !ALLOWED_NODE_ENVS.includes(value));

export const label = (value: string | undefined): string => (value === undefined ? '<unset>' : JSON.stringify(value));
export const isAllowed = (value: string | undefined): boolean => ALLOWED_NODE_ENVS.includes(value);

/** An env object for pure functions: an unset NODE_ENV has no key at all. */
export const envOf = (NODE_ENV: string | undefined, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  (NODE_ENV === undefined ? { ...extra } : { NODE_ENV, ...extra }) as NodeJS.ProcessEnv;

/** Runs `fn` with process.env.NODE_ENV set (or deleted for undefined) and always restores it. */
export async function withNodeEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.NODE_ENV;
  try {
    if (value === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = value;
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}
