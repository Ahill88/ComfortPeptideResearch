import { Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiConflictResponse, ApiHeader, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminRoles, CurrentAdmin, RequestIp } from '../admin/admin.decorators';
import type { AdminPrincipal } from '../admin/admin.types';
import { ListEmailOutboxQuery } from './email-admin.dto';
import { EmailAdminService } from './email-admin.service';

/** Outbox visibility for the owner. Never returns a full address, a message body or a link: only the recipient domain. */
@ApiTags('admin-email')
@ApiHeader({ name: 'Authorization', required: true, description: 'Bearer <admin session token>.' })
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@UseGuards(AdminSessionGuard)
@AdminRoles('OWNER')
@Controller('admin/email/outbox')
export class EmailAdminController {
  constructor(private readonly emails: EmailAdminService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List outbound email (newest first, keyset pagination). OWNER only.' })
  @ApiOkResponse({ description: '{ items: [{ id, toDomain, template, status, attempts, lastError, createdAt, sentAt }], nextCursor }' })
  list(@Query() query: ListEmailOutboxQuery) {
    return this.emails.list(query);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Re-queue a FAILED email (attempts reset). OWNER only; audited as email.retry.' })
  @ApiNotFoundResponse({ description: 'Unknown id.' })
  @ApiConflictResponse({ description: 'The email is not FAILED.' })
  retry(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.emails.retry(id, { id: admin.id, ip });
  }
}
