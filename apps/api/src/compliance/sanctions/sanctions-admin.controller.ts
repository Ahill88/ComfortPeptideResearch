import { Body, Controller, Get, Header, HttpCode, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiServiceUnavailableResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { AdminAuditService } from '../../admin/admin-audit.service';
import { AdminRoles, CurrentAdmin, RequestIp } from '../../admin/admin.decorators';
import { AdminSessionGuard } from '../../admin/admin-session.guard';
import type { AdminPrincipal } from '../../admin/admin.types';
import { SanctionsService, type SanctionsStatusView } from './sanctions.service';

export class SanctionsRefreshBody {
  @ApiPropertyOptional({ description: 'Accept a drop of more than 50% in the address count versus the last successful run. An empty list is never accepted.' })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Back office view of the sanctions list. Session-guarded; refreshing is OWNER only and audited as `sanctions.refresh`. */
@ApiTags('compliance-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Admin sign-in required.' })
@UseGuards(AdminSessionGuard)
@Controller('admin/compliance/sanctions')
export class SanctionsAdminController {
  constructor(
    private readonly sanctions: SanctionsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Sanctions list status: source, last run, number of stored addresses' })
  @ApiOkResponse({ description: '{ source, lastRun: { fetchedAt, entryCount, status, error } | null, addressCount }' })
  status(): Promise<SanctionsStatusView> {
    return this.sanctions.status();
  }

  @Post('refresh')
  @HttpCode(200)
  @AdminRoles('OWNER')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Download and apply the sanctions list now (OWNER). On failure the previous data is kept.' })
  @ApiOkResponse({ description: 'Same shape as GET.' })
  @ApiForbiddenResponse({ description: 'Not an OWNER.' })
  @ApiServiceUnavailableResponse({ description: 'The refresh failed (redacted reason) or one is already running; the previous data is kept.' })
  async refresh(@Body() body: SanctionsRefreshBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null): Promise<SanctionsStatusView> {
    const force = body?.force === true;
    const result = await this.sanctions.refresh({ trigger: 'admin', force });
    await this.audit.record({
      adminId: admin.id,
      action: 'sanctions.refresh',
      targetType: 'sanctions',
      detail: { outcome: result.outcome, entryCount: result.entryCount, force, reason: result.reason },
      ip,
    });
    if (result.outcome !== 'OK') {
      throw new ServiceUnavailableException(result.reason ?? 'The sanctions list could not be refreshed.');
    }
    return this.sanctions.status();
  }
}
