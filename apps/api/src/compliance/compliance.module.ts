import { Module } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { EligibilityAdminController } from './eligibility-admin.controller';
import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';

@Module({
  controllers: [EligibilityController, EligibilityAdminController],
  providers: [EligibilityService, SessionGuard],
  exports: [EligibilityService],
})
export class ComplianceModule {}
