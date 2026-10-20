import { ApiPropertyOptional } from '@nestjs/swagger';
import { CryptoTxStatus, OnRampStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Opaque row id cursor. Cursors identify rows in listings; they are never wallet addresses or amounts. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE, description: 'Page size (max 100).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  take?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned as nextCursor by the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CURSOR_PATTERN)
  cursor?: string;
}

export class TransactionsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: CryptoTxStatus, description: 'Filter by on-chain transaction status.' })
  @IsOptional()
  @IsEnum(CryptoTxStatus)
  status?: CryptoTxStatus;
}

export class FundingQuery extends PageQuery {
  @ApiPropertyOptional({ enum: OnRampStatus, description: 'Filter by on-ramp intent status.' })
  @IsOptional()
  @IsEnum(OnRampStatus)
  status?: OnRampStatus;
}

export class PaymentIntentsQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE, description: 'Page size for each list (max 100).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  take?: number;

  @ApiPropertyOptional({ description: 'Cursor for the Payment rows list.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CURSOR_PATTERN)
  paymentsCursor?: string;

  @ApiPropertyOptional({ description: 'Cursor for the PURCHASE CryptoTransaction rows list.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(CURSOR_PATTERN)
  purchasesCursor?: string;
}

export class SettlementsQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE, description: 'Number of days per page (max 100).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  take?: number;

  @ApiPropertyOptional({ example: '2026-10-20', description: 'Return days strictly before this UTC day (nextCursor of previous page).' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cursor?: string;
}
