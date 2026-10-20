import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class SubmitCheckoutDto {
  @ApiProperty({
    description:
      'Base64 of the serialized transaction returned by prepare, signed by the customer wallet. Must be signed by the customer; unsigned or altered transactions are rejected.',
    maxLength: 2048,
  })
  @IsString()
  @MinLength(16)
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'signedTransactionBase64 must be base64' })
  signedTransactionBase64!: string;
}

export class PrepareCheckoutResponse {
  @ApiProperty({ example: 'chk_9f2c0e2f6b5d4a43a3b1d5a1f0c8e7aa' }) paymentReference!: string;
  @ApiProperty({ description: 'USDC base units (6 decimals) as a decimal string.', example: '250000000' }) amountAtomic!: string;
  @ApiProperty({ description: 'Display price derived from integer cents.', example: '250.00' }) amountUsd!: string;
  @ApiProperty({ description: 'Merchant treasury owner address.' }) merchant!: string;
  @ApiProperty({ example: 'solana-devnet' }) network!: string;
  @ApiProperty({ description: 'USDC mint address.' }) mint!: string;
  @ApiProperty({ description: 'Estimated network fee in lamports (decimal string), paid by the customer wallet in SOL.', example: '5000' }) feeLamports!: string;
  @ApiProperty({ description: 'Unsigned legacy transaction (base64). The customer signs it with their own wallet.' }) unsignedTransactionBase64!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: [String] }) disclosures!: string[];
}

export class SubmitCheckoutResponse {
  @ApiProperty() paymentReference!: string;
  @ApiProperty() txSignature!: string;
  @ApiProperty({ enum: ['SUBMITTED', 'CONFIRMED', 'FINALIZED'] }) status!: string;
  @ApiProperty({ description: 'True when the identical signed payload was already submitted.' }) idempotent!: boolean;
}

class CheckoutPaymentStatus {
  @ApiProperty() paymentReference!: string;
  @ApiProperty({ enum: ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'] }) status!: string;
  @ApiProperty({ description: 'USDC base units as a decimal string.' }) amountAtomic!: string;
  @ApiProperty({ nullable: true, type: String }) txSignature!: string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finalizedAt!: string | null;
}

class CheckoutReservationStatus {
  @ApiProperty({ enum: ['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'] }) status!: string;
  @ApiProperty({ description: 'USDC base units as a decimal string.' }) amountAtomic!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class CheckoutStatusResponse {
  @ApiProperty() orderId!: string;
  @ApiProperty({ enum: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] }) orderStatus!: string;
  @ApiProperty({ nullable: true, type: () => CheckoutPaymentStatus }) payment!: CheckoutPaymentStatus | null;
  @ApiProperty({ nullable: true, type: () => CheckoutReservationStatus }) reservation!: CheckoutReservationStatus | null;
}

export class CheckoutErrorResponse {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ example: 'Order is not awaiting payment' }) message!: string | string[];
  @ApiProperty({ example: 'Conflict' }) error!: string;
}
