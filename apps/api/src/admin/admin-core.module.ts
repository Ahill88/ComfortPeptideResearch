import { Global, Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';
import { AdminSessionGuard } from './admin-session.guard';

/** Shared back-office plumbing (session guard + audit trail). Global so admin feature modules just `@UseGuards(AdminSessionGuard)`. */
@Global()
@Module({ providers: [AdminSessionGuard, AdminAuditService], exports: [AdminSessionGuard, AdminAuditService] })
export class AdminCoreModule {}
