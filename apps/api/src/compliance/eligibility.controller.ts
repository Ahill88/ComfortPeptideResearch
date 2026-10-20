import { Body, Controller, Get, Header, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthenticatedSession, CurrentSession, SessionGuard } from '../auth/session.guard';
import { EligibilityReviewRequest, EligibilityStatusResponse } from './eligibility.dto';
import { EligibilityService } from './eligibility.service';

/** Customer-facing eligibility routes. Customers can request a review but can never approve themselves. */
@ApiTags('compliance')
@ApiBearerAuth()
@ApiHeader({ name: 'x-customer-email', required: false, description: 'Development-only identity (non-production). Ignored (401) in production.' })
@ApiUnauthorizedResponse({ description: 'No valid server-validated session.' })
@UseGuards(SessionGuard)
@Controller('eligibility')
export class EligibilityController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the authenticated account eligibility status' })
  @ApiOkResponse({ type: EligibilityStatusResponse })
  status(@CurrentSession() session: AuthenticatedSession) { return this.eligibility.status(session.customerId); }

  @Post('review-requests')
  @ApiOperation({ summary: 'Request an eligibility review (creates a PENDING record; approval is reviewer-only)' })
  @ApiCreatedResponse({ type: EligibilityStatusResponse })
  requestReview(@CurrentSession() session: AuthenticatedSession, @Body() body: EligibilityReviewRequest) {
    return this.eligibility.requestReview(session.customerId, body);
  }
}
