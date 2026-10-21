import { ForbiddenException } from '@nestjs/common';

/** Which customer-facing action is being screened. Recorded in the SANCTIONS_BLOCKED audit event (never the address). */
export type ScreenSurface = 'wallet_link' | 'onramp' | 'transfer' | 'checkout';

export interface ComplianceScreenInput {
  customerId: string;
  sourceAddress: string;
  destinationAddress: string;
  amountAtomic: bigint;
  mint: string;
  /** Optional; set by the four screened surfaces. */
  surface?: ScreenSurface;
}

export interface ComplianceScreenResult {
  allowed: boolean;
  /** Internal reason; not shown verbatim to the customer. */
  reason?: string;
  /** `SANCTIONS` = an address matched the sanctions list: call sites answer the generic 403 and audit SANCTIONS_BLOCKED. */
  code?: 'SANCTIONS';
}

/** The ONE customer-facing message for a refused wallet. Generic on purpose: it never mentions a list. */
export const WALLET_BLOCKED_MESSAGE = 'This wallet cannot be used.';
/** 503 body when the sanctions list has never loaded and the runtime is not development/test. */
export const SCREENING_NOT_READY_MESSAGE = 'Compliance screening is not ready.';

/**
 * Address-screening port used at wallet link, on-ramp intent creation, transfer preparation and checkout prepare.
 *
 * The default binding is the sanctions screen in `compliance/sanctions` (global module, token COMPLIANCE_SCREEN): exact-match screening
 * of wallet addresses against the public OFAC SDN list's digital-currency-address entries. It is address screening only (see
 * docs/compliance/sanctions-screening.md). A screen may throw ServiceUnavailableException when it cannot decide.
 */
export interface ComplianceScreen {
  screen(input: ComplianceScreenInput): Promise<ComplianceScreenResult>;
}

/** Test/fixture screen that allows everything. Production binds the sanctions screen instead. */
export class AllowAllComplianceScreen implements ComplianceScreen {
  async screen(): Promise<ComplianceScreenResult> {
    return { allowed: true };
  }
}

/**
 * Shared call-site rule: when the verdict is a sanctions match, audit SANCTIONS_BLOCKED with `{ surface }` ONLY (no address) and answer
 * 403 `{message: WALLET_BLOCKED_MESSAGE}`. Any other verdict is returned untouched for the caller's own handling.
 */
export async function refuseIfSanctioned(
  verdict: ComplianceScreenResult,
  surface: ScreenSurface,
  audit: (action: string, detail: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  if (verdict.allowed || verdict.code !== 'SANCTIONS') return;
  await audit('SANCTIONS_BLOCKED', { surface });
  throw new ForbiddenException(WALLET_BLOCKED_MESSAGE);
}
