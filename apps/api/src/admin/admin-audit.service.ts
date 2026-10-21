import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AdminAuditInput } from './admin.types';

/** Append-only trail of back-office actions. Never put passwords, tokens, MFA seeds or full card/wallet data in `detail`. */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AdminAuditInput): Promise<void> {
    await this.prisma.adminAuditEvent.create({
      data: {
        adminId: input.adminId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        detail: (input.detail ?? undefined) as object | undefined,
        ip: input.ip ?? null,
      },
    });
  }
}
