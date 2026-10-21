import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  CANCEL_REASON_MAX,
  CARRIERS,
  type CarrierName,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  ORDER_NOTE_MAX,
  ORDER_STATUSES,
  SEARCH_QUERY_MAX,
  SHIP_NOTE_MAX,
  TRACKING_NUMBER_MAX,
  TRACKING_NUMBER_MIN,
  TRACKING_NUMBER_PATTERN,
} from './admin-orders.types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ListAdminOrdersQuery {
  @ApiPropertyOptional({ description: `Comma-separated statuses (${ORDER_STATUSES.join(', ')}).`, example: 'PAID,PROCESSING' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  status?: string;

  @ApiPropertyOptional({ description: 'Matches an order id prefix OR a customer email substring (case-insensitive).', maxLength: SEARCH_QUERY_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX)
  q?: string;

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

export class ShipOrderBody {
  @ApiProperty({ enum: CARRIERS })
  @IsIn(CARRIERS as unknown as string[])
  carrier!: CarrierName;

  @ApiProperty({ minLength: TRACKING_NUMBER_MIN, maxLength: TRACKING_NUMBER_MAX, pattern: TRACKING_NUMBER_PATTERN.source, example: '9400 1118 9922 3344 5566 77' })
  @Transform(trim)
  @IsString()
  @MinLength(TRACKING_NUMBER_MIN)
  @MaxLength(TRACKING_NUMBER_MAX)
  @Matches(TRACKING_NUMBER_PATTERN, { message: 'trackingNumber may contain only letters, numbers, spaces and hyphens and must start with a letter or number' })
  trackingNumber!: string;

  @ApiPropertyOptional({ maxLength: SHIP_NOTE_MAX })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SHIP_NOTE_MAX)
  note?: string;
}

export class CancelOrderBody {
  @ApiProperty({ minLength: 1, maxLength: CANCEL_REASON_MAX, example: 'Customer asked to cancel before paying.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CANCEL_REASON_MAX)
  reason!: string;
}

export class AddOrderNoteBody {
  @ApiProperty({ minLength: 1, maxLength: ORDER_NOTE_MAX })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(ORDER_NOTE_MAX)
  note!: string;
}
