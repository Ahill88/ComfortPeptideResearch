import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, NotEquals, ValidateIf } from 'class-validator';
import {
  ADJUST_REASON_MAX,
  DEFAULT_LEDGER_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_ADJUST_DELTA,
  MAX_LEDGER_LIMIT,
  MAX_LIST_LIMIT,
  SEARCH_QUERY_MAX,
} from './admin-inventory.types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Query strings are text: only the exact words true/false are booleans; anything else fails IsBoolean (400). */
const queryBoolean = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class ListInventoryQuery {
  @ApiPropertyOptional({ description: 'Matches SKU or name (case-insensitive substring).', maxLength: SEARCH_QUERY_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX)
  q?: string;

  @ApiPropertyOptional({ description: 'Only products with a threshold set and onHand <= threshold.' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  lowStockOnly?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned as nextCursor by the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class LedgerQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LEDGER_LIMIT, default: DEFAULT_LEDGER_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LEDGER_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned as nextCursor by the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class AdjustStockBody {
  @ApiProperty({ description: `Whole units to add (positive) or remove (negative); not 0, at most ${MAX_ADJUST_DELTA} in either direction.`, example: -3 })
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_ADJUST_DELTA)
  @Max(MAX_ADJUST_DELTA)
  delta!: number;

  @ApiProperty({ minLength: 1, maxLength: ADJUST_REASON_MAX, example: 'Cycle count correction.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(ADJUST_REASON_MAX)
  reason!: string;
}

export class SetThresholdBody {
  @ApiProperty({ nullable: true, minimum: 0, description: 'Alert when onHand is at or below this many units. null removes the alert.', example: 5 })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  lowStockThreshold!: number | null;
}
