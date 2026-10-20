import { Body, Controller, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminTokenGuard } from '../wallet-admin/admin-token.guard';
import { EligibilityAdminResponse, EligibilityDecisionRequest } from './eligibility.dto';
import { EligibilityService } from './eligibility.service';

/**
 * The ONLY path that can set APPROVED/REJECTED. Protected by the same constant-time `x-admin-token` /
 * ADMIN_API_TOKEN guard as wallet-admin (fails closed when ADMIN_API_TOKEN is unset).
 */
@ApiTags('compliance-admin')
@ApiHeader({ name: 'x-admin-token', required: true, description: 'Must equal the server ADMIN_API_TOKEN. All requests are denied when it is unset.' })
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin token, or ADMIN_API_TOKEN is not configured.' })
@UseGuards(AdminTokenGuard)
@Controller('admin/eligibility')
export class EligibilityAdminController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Post(':customerId/decision')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Approve or reject a customer eligibility review request' })
  @ApiOkResponse({ type: EligibilityAdminResponse })
  @ApiNotFoundResponse({ description: 'No review request exists for the customer.' })
  decide(@Param('customerId') customerId: string, @Body() body: EligibilityDecisionRequest) {
    return this.eligibility.decide(customerId, body);
  }
}
