import { BadRequestException, Body, Controller, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminSessionGuard } from '../admin-session.guard';
import { AdminRoles, CurrentAdmin, RequestIp } from '../admin.decorators';
import type { AdminPrincipal } from '../admin.types';
import { AdminOrderRefundService } from './admin-order-refund.service';

export const REFUND_REASON_MAX = 500;
const NO_STORE = () => Header('Cache-Control', 'no-store');
const actorOf = (admin: AdminPrincipal, ip: string | null) => ({ id: admin.id, ip });

/**
 * Refund of a paid order, owner only (docs/api/admin-refunds.md). The body carries a reason and nothing else: there is no field for a
 * destination, an amount or a wallet, and any extra property is a 400. The destination is the customer's own linked wallet and the amount
 * is the exact paid amount, both derived server-side.
 */
@ApiTags('admin-orders')
@ApiHeader({ name: 'Authorization', required: true, description: 'Bearer <admin session token> of an OWNER.' })
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@ApiForbiddenResponse({ description: 'The signed-in admin is not an OWNER.' })
@UseGuards(AdminSessionGuard)
@AdminRoles('OWNER')
@Controller('admin/orders')
export class AdminOrderRefundController {
  constructor(private readonly refunds: AdminOrderRefundService) {}

  @Post(':id/refund')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'Create the refund request for a PAID or PROCESSING order (exact paid amount, to the customer wallet).' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail (refund.status REQUESTED).' })
  @ApiBadRequestResponse({ description: 'Missing/over-long reason or an unsupported property.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: 'Order is not PAID/PROCESSING (SHIPPED/DELIVERED included), a refund is already in progress, or the order has no refundable purchase.' })
  request(@Param('id') id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.refunds.request(id, parseReason(body), actorOf(admin, ip));
  }

  @Post(':id/refund/submit')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'Sign (through the bound merchant signing port) and broadcast the refund. Idempotent: it never pays twice.' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail (refund.status SUBMITTED).' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: 'No refund requested, or the order is no longer refundable.' })
  @ApiServiceUnavailableResponse({ description: 'Refund signing is not available (no merchant signer bound) or Solana RPC is unavailable.' })
  submit(@Param('id') id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    assertEmptyBody(body);
    return this.refunds.submit(id, actorOf(admin, ip));
  }

  @Post(':id/refund/verify')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'Re-read the refund transfer on chain; on FINALIZED the order becomes REFUNDED and unshipped stock is released.' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: 'No refund requested.' })
  verify(@Param('id') id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    assertEmptyBody(body);
    return this.refunds.verify(id, actorOf(admin, ip));
  }
}

function parseReason(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A JSON body with a reason is required.');
  const input = body as Record<string, unknown>;
  const unsupported = Object.keys(input).filter((key) => key !== 'reason');
  if (unsupported.length > 0) throw new BadRequestException('Only "reason" is accepted: the refund amount and destination are decided by the server.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > REFUND_REASON_MAX) throw new BadRequestException(`reason must be 1-${REFUND_REASON_MAX} characters.`);
  return reason;
}

function assertEmptyBody(body: unknown): void {
  if (body && typeof body === 'object' && Object.keys(body).length > 0) throw new BadRequestException('This endpoint accepts no body.');
}
