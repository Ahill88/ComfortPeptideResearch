export interface ComplianceScreenInput {
  customerId: string;
  sourceAddress: string;
  destinationAddress: string;
  amountAtomic: bigint;
  mint: string;
}

export interface ComplianceScreenResult {
  allowed: boolean;
  /** Internal reason; not shown verbatim to the customer. */
  reason?: string;
}

/**
 * Sanctions / address-screening port for outgoing transfers.
 *
 * PRODUCTION NOTE: the default {@link AllowAllComplianceScreen} allows everything and performs NO
 * screening. Production must bind COMPLIANCE_SCREEN to a real sanctions-screening provider before
 * enabling external sends. No other withdrawal limits are applied by this service.
 */
export interface ComplianceScreen {
  screen(input: ComplianceScreenInput): Promise<ComplianceScreenResult>;
}

export class AllowAllComplianceScreen implements ComplianceScreen {
  async screen(): Promise<ComplianceScreenResult> {
    return { allowed: true };
  }
}
