import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { OnRampProvider, OnRampQuote, WalletFeatureFlags } from '../contracts';
import { WalletRuntimeConfig } from '../wallet.config';

/**
 * MoonPay parameters used here were checked against dev.moonpay.com on 2026-10-20:
 *   widget/on-ramp/customization/parameters, widget/on-ramp/customization/url-signing,
 *   widget/on-ramp/customization/ip-matching, and the public /v3/currencies list (usdc_sol).
 * Verified: apiKey, currencyCode, walletAddress, baseCurrencyCode, baseCurrencyAmount
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
  /** Customer's public IP; when present (and a valid IP literal) it is keyed-hashed into allowedIpAddress via createAllowedIpHash. */
  customerIp?: string;
}

export const MOONPAY_DISCLOSURES = [
  'MoonPay (not Helix & Field) performs identity verification and payment processing for this purchase, under MoonPay\'s own terms.',
  'Fees and exchange rates are set by MoonPay and are shown by MoonPay before you confirm. This quote contains no estimate.',
  'Purchased USDC is delivered to your own wallet address. Helix & Field does not custody it and cannot reverse a delivery.',
  'Availability, limits and settlement time are determined by MoonPay and may vary by region and payment method.',
];

/** HMAC-SHA256 over the query string (including the leading "?"), base64, per MoonPay URL signing docs. */
export function createMoonPayUrlSignature(queryWithQuestionMark: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret).update(queryWithQuestionMark).digest('base64');
}

/** Domain-separation label for the allowedIpAddress subkey. Never reuse it for anything else. */
const ALLOWED_IP_DOMAIN = 'helix-allowed-ip-v1';

/**
 * allowedIpAddress value: HMAC-SHA256(subkey, ip), base64, where subkey = HMAC-SHA256(signingSecret, 'helix-allowed-ip-v1').
 *
 * The URL-signing secret must never act as an oracle: with HMAC(signingSecret, ip) a caller-influenced "ip" string
 * (e.g. a spoofable forwarded header) would return a valid URL-signing MAC for attacker-chosen text. The derived
 * subkey is one-way from the secret and domain-separated, so these hashes can never be valid URL signatures, and
 * the raw IP is not recoverable from the URL without the secret.
 */
export function createAllowedIpHash(ip: string, signingSecret: string): string {
  const subkey = createHmac('sha256', signingSecret).update(ALLOWED_IP_DOMAIN).digest();
  return createHmac('sha256', subkey).update(ip).digest('base64');
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
      // baseCurrencyAmount is documented as a positive integer, so fractional dollars cannot be pre-filled.
      throw new BadRequestException('MoonPay purchases must be a whole number of US dollars');
    }

    const params: Array<[string, string]> = [
      ['apiKey', apiKey],
      ['currencyCode', MOONPAY_SOLANA_USDC_CURRENCY_CODE],
      ['walletAddress', input.destinationAddress],
      ['baseCurrencyCode', 'usd'],
      ['baseCurrencyAmount', String(input.intendedUsdCents / 100)],
      ['externalCustomerId', input.customerId],
      ['externalTransactionId', input.intentId],
    ];
    // Only a real IP literal is bound; anything else (empty, junk, a crafted string) is dropped, never hashed.
    if (input.customerIp && isIP(input.customerIp) !== 0) {
      params.push(['allowedIpAddress', createAllowedIpHash(input.customerIp, signingSecret)]);
    }
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
