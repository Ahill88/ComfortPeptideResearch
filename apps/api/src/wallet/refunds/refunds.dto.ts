import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Documentation-only shape of the request body. There is intentionally NO destination, address,
 * wallet, mint or source field: the destination is derived server-side from the original purchase.
 * The controller rejects any property not listed here.
 */
export class RequestRefundBody {
  @ApiProperty({ description: 'Order to refund (must be PAID with a finalized credits purchase).' })
  orderId!: string;

  @ApiPropertyOptional({
    description: 'USDC base units (6 decimals) as a decimal string. Omit to refund the full remaining refundable amount.',
    example: '1000000',
  })
  amountAtomic?: string;

  @ApiProperty({ description: 'Why the refund is issued (3-500 characters). Recorded in the audit log.' })
  reason!: string;
}

export const REQUEST_REFUND_KEYS: readonly string[] = ['orderId', 'amountAtomic', 'reason'];
