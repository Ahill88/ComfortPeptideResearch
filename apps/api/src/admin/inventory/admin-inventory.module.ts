import { Module } from '@nestjs/common';
import { CommerceModule } from '../../commerce/commerce.module';
import { AdminInventoryController } from './admin-inventory.controller';
import { AdminInventoryService } from './admin-inventory.service';

/** Session guard and audit service come from the global AdminCoreModule; Prisma from the global PrismaModule. */
@Module({ imports: [CommerceModule], controllers: [AdminInventoryController], providers: [AdminInventoryService] })
export class AdminInventoryModule {}
