import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { REVOKE_REASON_MAX } from './coa-validation';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const DEFAULT_LOT_LIMIT = 25;
export const MAX_LOT_LIMIT = 100;
export const SEARCH_MAX = 100;

export class ListLotsQuery {
  @ApiPropertyOptional({ description: 'Only lots of this product.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive substring of lot code, product name or SKU.', maxLength: SEARCH_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LOT_LIMIT, default: DEFAULT_LOT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOT_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned as nextCursor by the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;
}

export class CreateLotBody {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  productId!: string;

  @ApiProperty({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$', example: 'BPC157-2026-01' })
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  code!: string;
}

export class PublishCoaBody {
  @ApiProperty({ description: 'The SHA-256 (hex) of the file as stored: must equal the hash shown for the draft, forcing a real review.' })
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  confirmSha256!: string;
}

export class RevokeCoaBody {
  @ApiProperty({ minLength: 1, maxLength: REVOKE_REASON_MAX })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(REVOKE_REASON_MAX)
  reason!: string;
}

export class AnchorRetryBody {
  @ApiProperty({ enum: ['PUBLISH', 'REVOKE'] })
  @IsIn(['PUBLISH', 'REVOKE'])
  kind!: 'PUBLISH' | 'REVOKE';
}
