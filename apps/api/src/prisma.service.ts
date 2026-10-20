import { Injectable, OnModuleDestroy } from '@nestjs/common'; import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  // Prisma connects on first query so API documentation remains available in a dependency-free local preview.
  async onModuleDestroy() { await this.$disconnect(); }
}
