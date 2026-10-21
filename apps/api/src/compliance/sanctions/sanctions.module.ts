import { Global, Module } from '@nestjs/common';
import { COMPLIANCE_SCREEN } from '../../wallet/wallet.tokens';
import { SanctionsAdminController } from './sanctions-admin.controller';
import { loadSanctionsConfig, SANCTIONS_CONFIG } from './sanctions.config';
import { SanctionsScheduler } from './sanctions.scheduler';
import { SanctionsComplianceScreen } from './sanctions.screen';
import { SanctionsService } from './sanctions.service';

/**
 * Sanctions address screening. Global so WalletModule/CheckoutModule resolve COMPLIANCE_SCREEN without importing it.
 * WalletModule no longer binds an allow-all default: bind a different screen by overriding COMPLIANCE_SCREEN in a test or by
 * replacing this module. PrismaService and AdminAuditService/AdminSessionGuard come from the global Prisma/AdminCore modules.
 */
@Global()
@Module({
  controllers: [SanctionsAdminController],
  providers: [
    { provide: SANCTIONS_CONFIG, useFactory: () => loadSanctionsConfig() },
    SanctionsService,
    SanctionsComplianceScreen,
    SanctionsScheduler,
    { provide: COMPLIANCE_SCREEN, useExisting: SanctionsComplianceScreen },
  ],
  exports: [COMPLIANCE_SCREEN, SanctionsService, SANCTIONS_CONFIG],
})
export class SanctionsModule {}
