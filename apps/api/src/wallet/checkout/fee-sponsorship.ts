import type { Message } from '@solana/web3.js';

/** WalletAuditEvent.action recorded once per sponsored prepare; also the per-customer daily cap's counter. */
export const FEE_SPONSORED_AUDIT_ACTION = 'CHECKOUT_FEE_SPONSORED';

export const DEFAULT_FEE_SPONSOR_MIN_LAMPORTS = 50_000_000n; // 0.05 SOL
export const DEFAULT_FEE_SPONSOR_MAX_PER_CUSTOMER_DAY = 20;
/** Upper bounds that only exist to reject typos (1,000,000 SOL / 10,000 sponsored checkouts per customer per day). */
export const MAX_FEE_SPONSOR_MIN_LAMPORTS = 1_000_000_000_000_000n;
export const MAX_FEE_SPONSOR_PER_CUSTOMER_DAY_CEILING = 10_000;

export interface FeeSponsorshipConfig {
  /** FEE_SPONSORSHIP=true (exact string). Off by default: the customer pays the fee in SOL. */
  enabled: boolean;
  /** If the sponsor's SOL balance is below this, sponsorship is unavailable (customer-pays fallback). */
  minSponsorLamports: bigint;
  /** Sponsored checkouts (prepares) one customer may have in any rolling 24 hours. */
  maxPerCustomerDay: number;
}

export const FEE_SPONSORSHIP_OFF: FeeSponsorshipConfig = Object.freeze({
  enabled: false,
  minSponsorLamports: DEFAULT_FEE_SPONSOR_MIN_LAMPORTS,
  maxPerCustomerDay: DEFAULT_FEE_SPONSOR_MAX_PER_CUSTOMER_DAY,
});

/**
 * Strict parser, run at startup (CHECKOUT_CONFIG provider). A bad value throws so the API refuses to boot rather
 * than silently running with a different fee policy than the operator intended (same approach as ONRAMP_*).
 *
 * FEE_SPONSORSHIP: unset/blank/"false" = off; the exact string "true" = on; anything else ("TRUE", "1", "yes")
 * is an error, never a silent "off".
 */
export function loadFeeSponsorshipConfig(env: NodeJS.ProcessEnv = process.env): FeeSponsorshipConfig {
  const flag = env.FEE_SPONSORSHIP;
  let enabled: boolean;
  if (flag === undefined || flag.trim() === '' || flag === 'false') enabled = false;
  else if (flag === 'true') enabled = true;
  else throw new Error(`FEE_SPONSORSHIP must be exactly "true" or "false" (got "${flag}")`);

  const minRaw = env.FEE_SPONSOR_MIN_LAMPORTS?.trim();
  let minSponsorLamports = DEFAULT_FEE_SPONSOR_MIN_LAMPORTS;
  if (minRaw) {
    if (!/^[1-9]\d{0,17}$/.test(minRaw) || BigInt(minRaw) > MAX_FEE_SPONSOR_MIN_LAMPORTS) {
      throw new Error(`FEE_SPONSOR_MIN_LAMPORTS must be a whole number of lamports between 1 and ${MAX_FEE_SPONSOR_MIN_LAMPORTS} (got "${minRaw}")`);
    }
    minSponsorLamports = BigInt(minRaw);
  }

  const capRaw = env.FEE_SPONSOR_MAX_PER_CUSTOMER_DAY?.trim();
  let maxPerCustomerDay = DEFAULT_FEE_SPONSOR_MAX_PER_CUSTOMER_DAY;
  if (capRaw) {
    if (!/^[1-9]\d{0,4}$/.test(capRaw) || Number(capRaw) > MAX_FEE_SPONSOR_PER_CUSTOMER_DAY_CEILING) {
      throw new Error(`FEE_SPONSOR_MAX_PER_CUSTOMER_DAY must be a whole number between 1 and ${MAX_FEE_SPONSOR_PER_CUSTOMER_DAY_CEILING} (got "${capRaw}")`);
    }
    maxPerCustomerDay = Number(capRaw);
  }
  return { enabled, minSponsorLamports, maxPerCustomerDay };
}

/** The fee payer of a compiled message: account index 0 (the first required signer). */
export function messageFeePayer(message: Message): string {
  return message.accountKeys[0].toBase58();
}

/**
 * Hard invariant for a SPONSORED message: the sponsor must be the fee payer (account index 0), must be a signer
 * and writable (that is how fees are paid), and must appear in NO instruction's account list, nor be a program
 * invoked by one. Then a signature by the sponsor cannot authorize any instruction. Throws a plain Error (the
 * caller maps it to an internal error) if it is ever violated.
 */
export function assertSponsorOnlyPaysFee(message: Message, sponsor: string): void {
  const sponsorIndex = message.accountKeys.findIndex((key) => key.toBase58() === sponsor);
  if (sponsorIndex !== 0) throw new Error('fee sponsor invariant violated: the sponsor is not the message fee payer (account index 0)');
  if (message.accountKeys.filter((key) => key.toBase58() === sponsor).length !== 1) {
    throw new Error('fee sponsor invariant violated: the sponsor appears more than once in the account keys');
  }
  for (const instruction of message.instructions) {
    if (instruction.programIdIndex === 0 || instruction.accounts.includes(0)) {
      throw new Error('fee sponsor invariant violated: the sponsor appears in an instruction');
    }
  }
}

/** The accounts that must sign, in signature order (the first `numRequiredSignatures` account keys). */
export function requiredSignersOf(message: Message): string[] {
  return message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
}
