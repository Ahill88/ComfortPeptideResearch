import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAuditService } from '../admin/admin-audit.service';
import { PrismaService } from '../prisma.service';
import { OUTBOX_DEFAULT_LIMIT, type ListEmailOutboxQuery } from './email-admin.dto';
import { redactText } from './email.redact';
import { domainOf } from './email.validation';

export interface EmailOutboxItem {
  id: string;
  /** Domain only. The full address is never returned by any admin route. */
  toDomain: string;
  template: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface OutboxRow {
  id: string;
  toEmail: string;
  template: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

const SELECT = { id: true, toEmail: true, template: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true } as const;

export function toOutboxItem(row: OutboxRow): EmailOutboxItem {
  return {
    id: row.id,
    toDomain: domainOf(row.toEmail),
    template: row.template,
    status: row.status,
    attempts: row.attempts,
    // Stored already redacted; redacting again is cheap insurance for rows written by other code paths.
    lastError: row.lastError === null ? null : redactText(row.lastError),
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  };
}

const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(JSON.stringify([row.createdAt.getTime(), row.id])).toString('base64url');
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [time, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof time !== 'number' || !Number.isFinite(time) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('shape');
    const createdAt = new Date(time);
    if (Number.isNaN(createdAt.getTime())) throw new Error('date');
    return { createdAt, id };
  } catch {
    throw new BadRequestException('Invalid cursor.');
  }
}

@Injectable()
export class EmailAdminService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AdminAuditService) {}

  async list(query: ListEmailOutboxQuery): Promise<{ items: EmailOutboxItem[]; nextCursor: string | null }> {
    const limit = query.limit ?? OUTBOX_DEFAULT_LIMIT;
    const and: object[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      and.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] });
    }
    const rows = await this.prisma.emailOutbox.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: SELECT,
    });
    const page = rows.slice(0, limit);
    return { items: page.map(toOutboxItem), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
  }

  /** FAILED -> PENDING only, attempts reset. Conditional update: a row that is not FAILED answers 409, an unknown id 404. */
  async retry(id: string, actor: { id: string; ip: string | null }): Promise<EmailOutboxItem> {
    const changed = await this.prisma.emailOutbox.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, lastError: null, nextAttemptAt: new Date() },
    });
    const row = await this.prisma.emailOutbox.findUnique({ where: { id }, select: SELECT });
    if (!row) throw new NotFoundException('Email not found.');
    if (changed.count !== 1) throw new ConflictException('Only failed emails can be retried.');
    await this.audit.record({ adminId: actor.id, action: 'email.retry', targetType: 'email_outbox', targetId: id, detail: { template: row.template }, ip: actor.ip });
    return toOutboxItem(row);
  }
}
