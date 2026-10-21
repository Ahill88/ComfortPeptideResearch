import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isNonProductionRuntime } from '../../config/runtime';
import {
  type ComplianceScreen,
  type ComplianceScreenInput,
  type ComplianceScreenResult,
  SCREENING_NOT_READY_MESSAGE,
} from '../../wallet/transfers/compliance-screen';
import { SANCTIONS_CONFIG, type SanctionsConfig } from './sanctions.config';
import { SanctionsService } from './sanctions.service';

/** At most one "list not loaded" warning per minute per process. */
const NOT_READY_WARN_EVERY_MS = 60_000;

/**
 * The default ComplianceScreen (token COMPLIANCE_SCREEN): refuses an address that is on the sanctions list.
 *
 *  - list loaded           -> exact match (plus case-insensitive for EVM-style addresses) over EVERY currency in the list.
 *  - list never loaded     -> development/test: ALLOW with a warning log; every other runtime (production, unset, unknown NODE_ENV):
 *                             503 "Compliance screening is not ready." (fail closed).
 *  - SANCTIONS_SCREENING=off -> honoured only in development/test (see sanctions.config.ts); ignored elsewhere.
 *  - any other failure while deciding (database error) -> 503, never "allowed".
 *
 * Addresses are never logged here.
 */
@Injectable()
export class SanctionsComplianceScreen implements ComplianceScreen {
  private readonly logger = new Logger(SanctionsComplianceScreen.name);
  private lastNotReadyWarning = 0;
  /** Overridable in tests. */
  clock: () => number = () => Date.now();
  /** Overridable in tests; defaults to the live environment. */
  env: Record<string, string | undefined> = process.env;

  constructor(
    private readonly sanctions: SanctionsService,
    @Inject(SANCTIONS_CONFIG) private readonly config: SanctionsConfig,
  ) {}

  async screen(input: ComplianceScreenInput): Promise<ComplianceScreenResult> {
    if (this.config.mode === 'off') return { allowed: true };
    const addresses = [input.sourceAddress, input.destinationAddress].filter((a): a is string => typeof a === 'string' && a.trim() !== '');
    if (addresses.length === 0) return { allowed: true };

    let ready: boolean;
    let listed = false;
    try {
      ready = await this.sanctions.isReady();
      if (ready) listed = await this.sanctions.findListed(addresses);
    } catch {
      this.logger.error('Sanctions screening could not read the list (database error); refusing.');
      throw new ServiceUnavailableException(SCREENING_NOT_READY_MESSAGE);
    }
    if (!ready) {
      if (isNonProductionRuntime(this.env)) {
        const now = this.clock();
        if (now - this.lastNotReadyWarning >= NOT_READY_WARN_EVERY_MS || this.lastNotReadyWarning === 0) {
          this.lastNotReadyWarning = now;
          this.logger.warn('Sanctions list has not loaded yet: screening FAILS OPEN in this development/test runtime. Other runtimes fail closed.');
        }
        return { allowed: true };
      }
      throw new ServiceUnavailableException(SCREENING_NOT_READY_MESSAGE);
    }
    return listed ? { allowed: false, code: 'SANCTIONS', reason: 'sanctions-list-match' } : { allowed: true };
  }
}
