import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminAuthController, AdminUsersController } from './admin-auth.controller';
import { ADMIN_AUTH_CLOCK, AdminAuthService } from './admin-auth.service';

/** Back-office sign-in (password + mandatory TOTP), sessions, admin user management and the audit log read API. */
@Module({ imports: [AdminCoreModule], controllers: [AdminAuthController, AdminUsersController], providers: [AdminAuthService, { provide: ADMIN_AUTH_CLOCK, useFactory: () => () => Date.now() }], exports: [AdminAuthService] })
export class AdminAuthModule {}
