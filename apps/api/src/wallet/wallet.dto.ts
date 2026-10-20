import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const ADDRESS_DOC = 'Public Solana address (base58, 32-byte ed25519 key). Never send private keys or seed phrases.';

export class LinkChallengeDto {
  @ApiProperty({ description: ADDRESS_DOC, example: '11111111111111111111111111111112' })
  @IsString()
  @Length(32, 44)
  @Matches(/^[1-9A-HJ-NP-Za-km-z]+$/, { message: 'address must be base58' })
  address!: string;
}

export class AssociateWalletDto {
  @ApiProperty({ description: ADDRESS_DOC, example: '11111111111111111111111111111112' })
  @IsString()
  @Length(32, 44)
  @Matches(/^[1-9A-HJ-NP-Za-km-z]+$/, { message: 'address must be base58' })
  address!: string;

  @ApiProperty({ description: 'The `challenge` token returned by POST /v1/wallet/link-challenge for this account and address (valid 5 minutes).' })
  @IsString()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, { message: 'challenge is malformed' })
  challenge!: string;

  @ApiProperty({ description: 'Base64 of the 64-byte detached ed25519 signature, made by the wallet that owns `address`, over the exact `message` returned with the challenge. A signature only; never send key material.' })
  @IsString()
  @Matches(/^[A-Za-z0-9+/]{86}==$/, { message: 'signature must be base64 of a 64-byte ed25519 signature' })
  signature!: string;

  @ApiProperty({ enum: ['privy', 'sandbox'], description: '"privy" is rejected unless PRIVY_APP_ID is configured. "sandbox" is a browser-held devnet key, not Privy.' })
  @IsIn(['privy', 'sandbox'])
  provider!: 'privy' | 'sandbox';
}

export class CreateOnRampDto {
  @ApiProperty({ description: 'Amount to spend in USD cents (integer). MoonPay enforces its own limits and fees.', example: 5000 })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountUsdCents!: number;
}

export class PrepareTransferDto {
  @ApiProperty({ description: 'Destination Solana wallet address (owner address, not a token account).' })
  @IsString()
  @Length(32, 44)
  destination!: string;

  @ApiPropertyOptional({ description: 'USDC base units (6 decimals) as a decimal string of digits. Mutually exclusive with max.', example: '2500000' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,20}$/, { message: 'amountAtomic must be a string of digits' })
  amountAtomic?: string;

  @ApiPropertyOptional({ description: 'Send the full spendable balance.' })
  @IsOptional()
  @IsBoolean()
  max?: boolean;
}

export class SubmitTransferDto {
  @ApiProperty({ description: 'Base64 of the transaction signed by the customer wallet. Must be exactly the prepared message.' })
  @IsString()
  @MaxLength(4928)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'signedTransaction must be base64' })
  signedTransaction!: string;
}
