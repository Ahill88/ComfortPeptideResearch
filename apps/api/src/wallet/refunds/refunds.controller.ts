import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminTokenGuard } from '../../wallet-admin/admin-token.guard';
import { REQUEST_REFUND_KEYS, RequestRefundBody } from './refunds.dto';
import { RefundsService } from './refunds.service';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const STATUSES = ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'];
/**
 * The admin token is a shared secret and carries no per-person identity, so refunds are attributed to this
 * fixed label until a real admin identity is wired. It is never read from the request.
 */
export const REFUND_ACTOR_ID = 'admin-token';

/**
 * Admin-only refund operations (merchant-signed treasury -> customer wallet transfers).
 *
 * Access requires the `x-admin-token` header to equal ADMIN_API_TOKEN (constant-time comparison; denied when
 * unset; enforced in every NODE_ENV including production). NO endpoint accepts a destination address:
 * the destination is always derived server-side from the original purchase, and unknown body properties are
 * rejected. The platform never debits or moves customer funds.
 */
@ApiTags('wallet-admin-refunds')
@ApiHeader({ name: 'x-admin-token', required: true, description: 'Must equal the server ADMIN_API_TOKEN. All requests are denied when it is unset.' })
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin token, or ADMIN_API_TOKEN is not configured.' })
@UseGuards(AdminTokenGuard)
@Controller('admin/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('request')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a PREPARED refund for a PAID order. Destination is derived server-side.' })
  @ApiBody({ type: RequestRefundBody })
  @ApiOkResponse({ description: 'The PREPARED refund.' })
  @ApiBadRequestResponse({ description: 'Invalid body or unknown property (e.g. a destination).' })
  @ApiConflictResponse({ description: 'Order not refundable or amount exceeds the remaining refundable amount.' })
  request(@Body() body: unknown) {
    const parsed = parseRequestBody(body);
    return this.refunds.requestRefund(parsed.orderId, parsed.amountAtomic, parsed.reason, REFUND_ACTOR_ID);
  }

  @Post(':refundId/submit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Obtain the merchant signature, verify it, and broadcast the refund.' })
  @ApiOkResponse({ description: 'The SUBMITTED refund.' })
  @ApiServiceUnavailableResponse({ description: 'No merchant signer is bound (fails closed) or Solana RPC is unavailable.' })
  submit(@Param('refundId') refundId: string, @Body() body?: unknown) {
    assertNoBody(body);
    return this.refunds.prepareAndSubmit(parseId(refundId));
  }

  @Post(':refundId/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Verify the refund transfer on chain and finalize it (idempotent).' })
  @ApiOkResponse({ description: 'Verification outcome and the refund.' })
  verify(@Param('refundId') refundId: string, @Body() body?: unknown) {
    assertNoBody(body);
    return this.refunds.verifyRefund(parseId(refundId));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List refunds, newest first.' })
  @ApiOkResponse({ description: 'Refund rows (amounts as decimal strings).' })
  list(@Query('orderId') orderId?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.refunds.list({
      orderId: orderId === undefined ? undefined : parseId(orderId, 'orderId'),
      status: status === undefined ? undefined : parseStatus(status),
      limit: limit === undefined ? undefined : parseLimit(limit),
    });
  }
}

function parseId(value: unknown, name = 'refundId'): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new BadRequestException(`${name} is invalid`);
  return value;
}

function parseStatus(value: unknown): string {
  if (typeof value !== 'string' || !STATUSES.includes(value)) throw new BadRequestException('status is invalid');
  return value;
}

function parseLimit(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be 1-200');
  return n;
}

/** submit/verify take no input beyond the path id (in particular, no destination). */
function assertNoBody(body: unknown): void {
  if (body && typeof body === 'object' && Object.keys(body).length > 0) throw new BadRequestException('This endpoint accepts no body');
}

function parseRequestBody(body: unknown): { orderId: string; amountAtomic: bigint | undefined; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A JSON body is required');
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !REQUEST_REFUND_KEYS.includes(key));
  if (unknown.length > 0) throw new BadRequestException(`Unsupported properties: ${unknown.join(', ')}. The refund destination is derived server-side.`);
  const orderId = parseId(input.orderId, 'orderId');
  if (typeof input.reason !== 'string') throw new BadRequestException('reason is required');
  let amountAtomic: bigint | undefined;
  if (input.amountAtomic !== undefined) {
    if (typeof input.amountAtomic !== 'string' || !/^[0-9]{1,18}$/.test(input.amountAtomic)) {
      throw new BadRequestException('amountAtomic must be a decimal string of USDC base units');
    }
    amountAtomic = BigInt(input.amountAtomic);
    if (amountAtomic <= 0n) throw new BadRequestException('amountAtomic must be greater than zero');
  }
  return { orderId, amountAtomic, reason: input.reason };
}
