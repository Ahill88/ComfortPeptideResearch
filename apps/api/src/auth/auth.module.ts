import { Inject, Logger, MiddlewareConsumer, Module, NestModule, OnModuleInit, Optional } from '@nestjs/common';
import { ComplianceModule } from '../compliance/compliance.module';
import { EMAIL_PORT, type EmailPort } from '../email/email.types';
import { assertAuthReadyForEnvironment, authStartupWarnings } from './auth-startup.check';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRequestGuard, CookieSessionGuard } from './auth-request.guard';
import { CustomerSessionMiddleware, CustomerSessionService } from './customer-session.service';
import { SessionGuard } from './session.guard';

@Module({
  imports: [ComplianceModule],
  controllers: [AuthController, AccountController],
  providers: [AuthService, AccountService, CustomerSessionService, CustomerSessionMiddleware, SessionGuard, AuthRequestGuard, CookieSessionGuard],
  exports: [CustomerSessionService],
})
export class AuthModule implements NestModule, OnModuleInit {
  constructor(@Optional() @Inject(EMAIL_PORT) private readonly email?: EmailPort) {}

  /** Resolves the hf_session cookie on every request (attaches req.customerSession; decides nothing, see CustomerSessionMiddleware). */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CustomerSessionMiddleware).forRoutes('*');
  }

  /** Fails startup on a broken email-link or MFA key configuration (see auth-startup.check.ts); logs the non-fatal findings. */
  onModuleInit(): void {
    assertAuthReadyForEnvironment();
    const logger = new Logger('AuthStartup');
    for (const warning of authStartupWarnings(process.env, this.email !== undefined)) logger.warn(warning);
  }
}
