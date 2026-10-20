export type EnvLike = Record<string, string | undefined>;

/** NODE_ENV values the platform recognises. Anything else is unknown and gets production-like treatment. */
export const KNOWN_NODE_ENVS = ['development', 'test', 'production'] as const;

/**
 * True ONLY for the exact strings "development" and "test".
 *
 * Safety gates must use this (or its negation) instead of `NODE_ENV !== 'production'`: an unset,
 * misspelled ("prod", "Production") or custom ("staging") NODE_ENV would pass the weaker check and
 * silently unlock sandbox behaviour (header identity, mock completion, in-memory chain...).
 */
export function isNonProductionRuntime(env: EnvLike = process.env): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

/** NODE_ENV rendered for error messages: `<unset>` or a JSON-quoted string (so "production " is visible). */
export function describeNodeEnv(env: EnvLike = process.env): string {
  return env.NODE_ENV === undefined ? '<unset>' : JSON.stringify(env.NODE_ENV);
}

/** Inverse of isNonProductionRuntime: production, unset, or any unrecognised NODE_ENV. */
export function isProductionLikeRuntime(env: EnvLike = process.env): boolean {
  return !isNonProductionRuntime(env);
}

export function isKnownNodeEnv(env: EnvLike = process.env): boolean {
  return (KNOWN_NODE_ENVS as readonly (string | undefined)[]).includes(env.NODE_ENV);
}

export const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';
