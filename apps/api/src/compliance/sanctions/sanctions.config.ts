import { isNonProductionRuntime, type EnvLike } from '../../config/runtime';

/** Value stored in SanctionsListRun.source / SanctionsAddress.source. One public list today: the OFAC SDN list. */
export const SANCTIONS_SOURCE = 'OFAC_SDN';

/**
 * Official Treasury (OFAC) Sanctions List Service export of the SDN list in the "legacy" XML format. The older
 * `https://www.treasury.gov/ofac/downloads/sdn.xml` address answers 302 to this host. Verified, see docs/compliance/sanctions-screening.md.
 */
export const DEFAULT_SANCTIONS_LIST_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';

export const SANCTIONS_CONFIG = Symbol('SANCTIONS_CONFIG');
export const SANCTIONS_FETCHER = Symbol('SANCTIONS_FETCHER');

export type SanctionsMode = 'enforce' | 'off';

export interface SanctionsConfig {
  /** Effective mode: `off` only when requested AND the runtime is development/test. */
  mode: SanctionsMode;
  /** True when `off` was requested but ignored because this runtime is production-like. */
  offIgnored: boolean;
  /** Set when SANCTIONS_SCREENING held something other than enforce/off (treated as enforce). */
  invalidMode: string | null;
  listUrl: string;
  /** 0 disables every automatic refresh (startup and periodic). The admin endpoint still works. */
  refreshHours: number;
  /** Non-production runtimes only: plain-http list URLs (local fixtures). */
  allowInsecureUrl: boolean;
  /** NODE_ENV=test boots many Nest apps; the automatic job stays off there unless SANCTIONS_REFRESH_IN_TEST=true. */
  autoRefreshAllowed: boolean;
}

const MAX_REFRESH_HOURS = 24 * 90;

export function loadSanctionsConfig(env: EnvLike = process.env): SanctionsConfig {
  const requested = (env.SANCTIONS_SCREENING ?? '').trim().toLowerCase();
  const wantsOff = requested === 'off';
  const nonProduction = isNonProductionRuntime(env);
  const invalidMode = requested !== '' && requested !== 'off' && requested !== 'enforce' ? requested.slice(0, 20) : null;

  const rawHours = (env.SANCTIONS_REFRESH_HOURS ?? '').trim();
  let refreshHours = 24;
  if (rawHours !== '') {
    const parsed = Number(rawHours);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_REFRESH_HOURS) {
      throw new Error(`SANCTIONS_REFRESH_HOURS must be a whole number from 0 to ${MAX_REFRESH_HOURS} (0 disables automatic refresh).`);
    }
    refreshHours = parsed;
  }

  const rawUrl = (env.SANCTIONS_LIST_URL ?? '').trim();
  const listUrl = rawUrl === '' ? DEFAULT_SANCTIONS_LIST_URL : rawUrl;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(listUrl);
  } catch {
    throw new Error('SANCTIONS_LIST_URL must be an absolute https URL.');
  }
  if (parsedUrl.protocol !== 'https:' && !(nonProduction && parsedUrl.protocol === 'http:')) {
    throw new Error('SANCTIONS_LIST_URL must be an https URL.');
  }

  return {
    mode: wantsOff && nonProduction ? 'off' : 'enforce',
    offIgnored: wantsOff && !nonProduction,
    invalidMode,
    listUrl,
    refreshHours,
    allowInsecureUrl: nonProduction,
    autoRefreshAllowed: env.NODE_ENV === 'test' ? env.SANCTIONS_REFRESH_IN_TEST === 'true' : true,
  };
}

/** The list URL without credentials, query or fragment: safe to show to an admin. */
export function describeListSource(listUrl: string): string {
  try {
    const url = new URL(listUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}
