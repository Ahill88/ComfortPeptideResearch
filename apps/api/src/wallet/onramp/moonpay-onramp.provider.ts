import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { OnRampProvider, OnRampQuote, WalletFeatureFlags } from '../contracts';
import { isNonProductionRuntime } from '../../config/runtime';
import { WalletRuntimeConfig } from '../wallet.config';

/**
 * MoonPay parameters used here were checked against dev.moonpay.com on 2026-10-20:
 *   widget/on-ramp/customization/parameters, widget/on-ramp/customization/url-signing,
 *   widget/on-ramp/customization/ip-matching, and the public /v3/currencies list (usdc_sol).
 * Verified: apiKey, currencyCode, walletAddress, baseCurrencyCode, quoteCurrencyAmount
 * (positive integer of fiat units), externalCustomerId, externalTransactionId, allowedIpAddress.
 *
 * TODO(verified-docs-required): MoonPay webhook handling (event names, endpoint, signature
 * verification) is deliberately NOT implemented. The docs list buy webhooks, but this phase
 * ships no handler; until one is built against verified docs, on-ramp completion is never
 * inferred from MoonPay. Credits derive from the on-chain finalized balance only.
 */
export const MOONPAY_SOLANA_USDC_CURRENCY_CODE = 'usdc_sol';
export const MOONPAY_SANDBOX_HOST = 'https://buy-sandbox.moonpay.com';
export const MOONPAY_LIVE_HOST = 'https://buy.moonpay.com';

export interface MoonPayQuoteInput {
  customerId: string;
  destinationAddress: string;
  intendedUsdCents: number;
  /** Our OnRampIntent id; sent to MoonPay as externalTransactionId and used by the sandbox widget path. */
  intentId: string;
  /** Customer's public IP; when present (and a valid IP literal) it is canonicalized and keyed-hashed into allowedIpAddress via createAllowedIpHash. */
  customerIp?: string;
}

export const MOONPAY_DISCLOSURES = [
  'MoonPay (not Helix & Field) performs identity verification and payment processing for this purchase, under MoonPay\'s own terms.',
  'Fees and exchange rates are set by MoonPay. You buy a fixed amount of USDC; MoonPay adds its fees on top and shows the total you will pay before you confirm. This quote contains no estimate.',
  'Purchased USDC is delivered to your own wallet address. Helix & Field does not custody it and cannot reverse a delivery.',
  'Availability, limits and settlement time are determined by MoonPay and may vary by region and payment method.',
];

/** HMAC-SHA256 over the query string (including the leading "?"), base64, per MoonPay URL signing docs. */
export function createMoonPayUrlSignature(queryWithQuestionMark: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret).update(queryWithQuestionMark).digest('base64');
}

/**
 * Canonical text form of a customer IP, exactly as MoonPay's IP-matching page requires it before hashing (the match is an
 * exact string comparison of the hash, not a semantic comparison of the address), or null when `raw` is not a single
 * IP literal. Rules (https://dev.moonpay.com/widget/on-ramp/customization/ip-matching.md):
 *   - strip a port and square brackets ("[2001:db8::1]:443" -> "2001:db8::1", "203.0.113.42:8080" -> "203.0.113.42")
 *   - IPv4: dotted quad, no leading zeros (a leading-zero octet is ambiguous octal, so it is rejected, not guessed)
 *   - IPv4-mapped IPv6 ("::ffff:203.0.113.42") is unmapped to plain IPv4
 *   - IPv6: RFC 5952 (lowercase, longest run of zero groups compressed to "::", no leading zeros)
 * Anything else (lists, junk, a zone id, an empty string, text starting with "?") returns null and is never hashed.
 */
export function canonicalizeCustomerIp(raw: string): string | null {
  let value = raw.trim();
  if (!value || /[\s,?%/]/.test(value)) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  const family = isIP(value);
  if (family === 4) return canonicalIpv4(value);
  if (family !== 6) return null;
  const groups = parseIpv6(value);
  if (!groups) return null;
  // IPv4-mapped ::ffff:a.b.c.d (groups 0-4 zero, group 5 = 0xffff) is unmapped.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.length < 2) return hex.join(':');
  return `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.length).join(':')}`;
}

function canonicalIpv4(value: string): string | null {
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some((o) => !/^(0|[1-9]\d{0,2})$/.test(o) || Number(o) > 255)) return null;
  return octets.join('.');
}

/** Parses a valid IPv6 literal (as accepted by net.isIP, no zone id) into eight 16-bit groups. */
function parseIpv6(value: string): number[] | null {
  let text = value.toLowerCase();
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = canonicalIpv4(tail[2]);
    if (!v4) return null;
    const [a, b, c, d] = v4.split('.').map(Number);
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * allowedIpAddress value, exactly as MoonPay documents it: base64(HMAC-SHA256(signingSecret, canonicalIp)), the SAME signing
 * key that signs the widget URL (MoonPay recomputes this from the IP it observes and compares the strings; any other key
 * or derivation makes IP matching, which is mandatory to go live, fail with "Unverified Connection").
 *
 * The input must be a canonical IP literal (see canonicalizeCustomerIp). That is what keeps the URL-signing key from acting
 * as an oracle: URL signatures are always computed over a query string that begins with "?", and a canonical IP literal
 * consists only of hex digits, "." and ":", so no value hashed here can ever equal a valid URL signature.
 */
export function createAllowedIpHash(ip: string, signingSecret: string): string {
  const canonical = canonicalizeCustomerIp(ip);
  if (canonical === null || canonical !== ip) throw new Error('allowedIpAddress must be hashed from a canonical IP literal');
  return createHmac('sha256', signingSecret).update(canonical).digest('base64');
}

/** True for loopback, private (RFC 1918 / ULA) and link-local addresses: addresses MoonPay can never observe from the internet. */
export function isNonPublicIp(canonical: string): boolean {
  if (canonical.includes(':')) return canonical === '::1' || canonical === '::' || /^f[cd]/.test(canonical) || /^fe[89ab]/.test(canonical);
  const [a, b] = canonical.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * The IP to bind the widget URL to. Normally the canonical caller IP. DEVELOPMENT/TEST ONLY: when the API sees a non-public
 * address (a browser on the same machine reaches it over localhost, but MoonPay sees the machine's public IP) and
 * ONRAMP_DEV_PUBLIC_IP holds a valid public IP, that IP is used instead so the widget can load while developing. The override is
 * ignored in every other runtime, so it cannot weaken IP matching where it matters.
 */
export function resolveWidgetClientIp(customerIp: string | undefined, env: { NODE_ENV?: string; ONRAMP_DEV_PUBLIC_IP?: string } = process.env): string | null {
  const canonical = customerIp ? canonicalizeCustomerIp(customerIp) : null;
  if (canonical && !isNonPublicIp(canonical)) return canonical;
  if (!isNonProductionRuntime(env)) return canonical;
  const override = env.ONRAMP_DEV_PUBLIC_IP ? canonicalizeCustomerIp(env.ONRAMP_DEV_PUBLIC_IP) : null;
  return override && !isNonPublicIp(override) ? override : canonical;
}

@Injectable()
export class MoonPayOnRampProvider implements OnRampProvider {
  constructor(
    private readonly flags: Pick<WalletFeatureFlags, 'enableRealMoonpay' | 'enableSolanaMainnet'>,
    private readonly config: Pick<WalletRuntimeConfig, 'moonpayPublishableKey' | 'moonpaySigningSecret' | 'treasuryAddress'>,
  ) {}

  async createQuote(input: MoonPayQuoteInput): Promise<OnRampQuote> {
    this.assertDestination(input.destinationAddress);
    if (!input.intentId) throw new Error('intentId is required');
    if (!Number.isSafeInteger(input.intendedUsdCents) || input.intendedUsdCents <= 0) {
      throw new BadRequestException('Amount must be a positive integer number of USD cents');
    }
    return this.flags.enableRealMoonpay ? this.realQuote(input) : this.sandboxQuote(input);
  }

  private sandboxQuote(input: MoonPayQuoteInput): OnRampQuote {
    return {
      provider: 'moonpay-sandbox',
      intendedUsdCents: input.intendedUsdCents,
      destinationAddress: input.destinationAddress,
      estimatedFeeUsdCents: null,
      estimatedUsdcAtomic: null,
      widgetUrl: `/wallet/sandbox-onramp?intent=${encodeURIComponent(input.intentId)}`,
      sandbox: true,
      disclosures: [
        'SANDBOX SIMULATION: no MoonPay account is contacted, no payment is taken, and the funds are fake devnet test balances.',
        ...MOONPAY_DISCLOSURES,
      ],
    };
  }

  private realQuote(input: MoonPayQuoteInput): OnRampQuote {
    const { moonpayPublishableKey: apiKey, moonpaySigningSecret: signingSecret } = this.config;
    if (!apiKey || !signingSecret) {
      throw new ServiceUnavailableException('MoonPay is enabled but MOONPAY_PUBLISHABLE_KEY / MOONPAY_SECRET_KEY are not configured');
    }
    let host: string;
    if (apiKey.startsWith('pk_test_')) host = MOONPAY_SANDBOX_HOST;
    else if (apiKey.startsWith('pk_live_')) {
      host = MOONPAY_LIVE_HOST;
      // MoonPay delivers mainnet USDC. Never aim live purchases at a deployment that is not on mainnet.
      if (!this.flags.enableSolanaMainnet) {
        throw new ServiceUnavailableException('A live MoonPay key requires ENABLE_SOLANA_MAINNET=true');
      }
    } else {
      throw new ServiceUnavailableException('MOONPAY_PUBLISHABLE_KEY must start with pk_test_ or pk_live_');
    }
    if (input.intendedUsdCents % 100 !== 0) {
      // quoteCurrencyAmount is documented as a positive integer (whole USDC), so fractional amounts cannot be pre-filled.
      throw new BadRequestException('MoonPay purchases must be a whole number of USDC');
    }

    const params: Array<[string, string]> = [
      ['apiKey', apiKey],
      ['currencyCode', MOONPAY_SOLANA_USDC_CURRENCY_CODE],
      ['walletAddress', input.destinationAddress],
      ['baseCurrencyCode', 'usd'],
      // Size the purchase in USDC, not dollars. Checked against MoonPay's buy_quote API on 2026-10-21 (usdc_sol, card): with
      // quoteCurrencyAmount=N the customer receives exactly N USDC and MoonPay's fees are added to what they pay, whereas a
      // dollar amount buys about 1.7% fewer USDC than the dollars entered (USDC was quoted at about $1.017) and so could leave
      // the order short. One dollar of intendedUsdCents is one USDC of target balance (the platform's own 1 USD = 1 USDC rule).
      ['quoteCurrencyAmount', String(input.intendedUsdCents / 100)],
      ['externalCustomerId', input.customerId],
      ['externalTransactionId', input.intentId],
    ];
    // Only a real IP literal is bound, in MoonPay's canonical form; anything else (empty, junk, a list, a crafted string) is
    // dropped, never hashed. Omitting the parameter makes MoonPay skip IP enforcement for the session (documented).
    const canonicalIp = resolveWidgetClientIp(input.customerIp);
    if (canonicalIp) params.push(['allowedIpAddress', createAllowedIpHash(canonicalIp, signingSecret)]);
    // Values are URL-encoded BEFORE signing; the signature covers exactly the bytes we send.
    const query = '?' + params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    const signature = createMoonPayUrlSignature(query, signingSecret);
    return {
      provider: 'moonpay',
      intendedUsdCents: input.intendedUsdCents,
      destinationAddress: input.destinationAddress,
      estimatedFeeUsdCents: null,
      estimatedUsdcAtomic: null,
      widgetUrl: `${host}/${query}&signature=${encodeURIComponent(signature)}`,
      sandbox: host === MOONPAY_SANDBOX_HOST,
      disclosures: [
        ...(host === MOONPAY_SANDBOX_HOST ? ['MoonPay SANDBOX environment: no real payment or real funds are involved.'] : []),
        ...MOONPAY_DISCLOSURES,
      ],
    };
  }

  /** The destination must be a valid address and never the platform treasury. */
  private assertDestination(address: string) {
    try {
      new PublicKey(address);
    } catch {
      throw new BadRequestException('Invalid destination address');
    }
    if (this.config.treasuryAddress && address === this.config.treasuryAddress) {
      throw new BadRequestException('The platform treasury cannot be an on-ramp destination');
    }
  }
}
