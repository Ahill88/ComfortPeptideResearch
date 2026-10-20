import { Module, OnModuleInit } from '@nestjs/common';
import { ComplianceModule } from '../compliance/compliance.module';
import { assertAuthReadyForEnvironment } from './auth-startup.check';
import { AccountController } from './account.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';

@Module({ imports: [ComplianceModule], controllers: [AuthController, AccountController], providers: [AuthService, SessionGuard] })
export class AuthModule implements OnModuleInit {
  /** Fails production startup unless email verification, password reset, and MFA are server-backed. */
  onModuleInit(): void {
    assertAuthReadyForEnvironment();
  }
}
