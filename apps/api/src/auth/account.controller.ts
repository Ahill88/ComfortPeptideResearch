import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { EligibilityStatusResponse } from '../compliance/eligibility.dto';
import { EligibilityService } from '../compliance/eligibility.service';
import { AuthenticatedSession, CurrentSession, SessionGuard } from './session.guard';

/**
 * Account routes. Every route requires a server-validated session (SessionGuard). Outside production
 * only, the guard accepts the restricted development identity header `x-customer-email`; in production
 * it denies everything because no credential store or session issuer exists yet.
 */
@ApiTags('account')
@ApiBearerAuth()
@ApiHeader({ name: 'x-customer-email', required: false, description: 'Development-only identity (non-production). Ignored (401) in production.' })
@ApiUnauthorizedResponse({ description: 'No valid server-validated session.' })
@UseGuards(SessionGuard)
@Controller('account')
export class AccountController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Get('eligibility')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the authenticated customer eligibility status' })
  @ApiOkResponse({ type: EligibilityStatusResponse })
  eligibilityStatus(@CurrentSession() session: AuthenticatedSession) {
    return this.eligibility.status(session.customerId);
  }
}
