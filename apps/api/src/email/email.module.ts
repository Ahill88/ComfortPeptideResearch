import { Global, Module } from '@nestjs/common';
import { EmailAdminController } from './email-admin.controller';
import { EmailAdminService } from './email-admin.service';
import { EMAIL_CONFIG, loadEmailConfig, type EmailConfig } from './email.config';
import { createEmailProvider, EMAIL_PROVIDER, type EmailProvider } from './email.provider';
import { EmailService } from './email.service';
import { EMAIL_PORT } from './email.types';
import { EmailWorker } from './email.worker';

/**
 * Transactional email. Global: any module injects `@Inject(EMAIL_PORT) email: EmailPort` and calls enqueue() without importing this.
 * The EMAIL_* environment is validated when the module is built (a bad value stops the API from starting). Providers:
 *   EMAIL_CONFIG    parsed environment
 *   EMAIL_PROVIDER  the transport (console | resend) or null for "none"
 *   EMAIL_PORT      -> EmailService (outbox insert only)
 * The EmailWorker sends from the outbox on a timer (EMAIL_WORKER_INTERVAL_MS, 0 disables). Session guard and audit come from the
 * global AdminCoreModule, Prisma from the global PrismaModule.
 */
@Global()
@Module({
  controllers: [EmailAdminController],
  providers: [
    { provide: EMAIL_CONFIG, useFactory: (): EmailConfig => loadEmailConfig(process.env) },
    { provide: EMAIL_PROVIDER, inject: [EMAIL_CONFIG], useFactory: (config: EmailConfig): EmailProvider | null => createEmailProvider(config) },
    EmailService,
    EmailWorker,
    EmailAdminService,
    { provide: EMAIL_PORT, useExisting: EmailService },
  ],
  exports: [EMAIL_PORT, EmailService, EMAIL_CONFIG],
})
export class EmailModule {}
