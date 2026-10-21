import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const OUTBOX_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED'] as const;
export type OutboxStatusName = (typeof OUTBOX_STATUSES)[number];
export const OUTBOX_DEFAULT_LIMIT = 50;
export const OUTBOX_MAX_LIMIT = 100;

export class ListEmailOutboxQuery {
  @ApiPropertyOptional({ enum: OUTBOX_STATUSES })
  @IsOptional()
  @IsIn(OUTBOX_STATUSES as unknown as string[])
  status?: OutboxStatusName;

  @ApiPropertyOptional({ minimum: 1, maximum: OUTBOX_MAX_LIMIT, default: OUTBOX_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(OUTBOX_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}
