import { Module } from '@nestjs/common';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';

/** Session guard and audit service come from the global AdminCoreModule; Prisma from the global PrismaModule. */
@Module({ controllers: [AdminOrdersController], providers: [AdminOrdersService] })
export class AdminOrdersModule {}
