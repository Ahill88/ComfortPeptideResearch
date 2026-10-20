import { Module } from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';
import { WalletAdminController } from './wallet-admin.controller';
import { WalletAdminService } from './wallet-admin.service';

/** Read-only admin reporting. PrismaService is provided by the global PrismaModule. */
@Module({
  controllers: [WalletAdminController],
  providers: [WalletAdminService, AdminTokenGuard],
})
export class WalletAdminModule {}
