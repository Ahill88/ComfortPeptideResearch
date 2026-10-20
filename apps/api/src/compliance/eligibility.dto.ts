import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const ELIGIBILITY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type EligibilityStatusValue = (typeof ELIGIBILITY_STATUSES)[number];

export class EligibilityReviewRequest {
  @ApiProperty({ description: 'Confirmation that the requester meets the applicable purchase requirements. Must be true.', example: true })
  @IsBoolean()
  attestation!: boolean;

  @ApiPropertyOptional({ description: 'Optional contextual information for a manual review.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class EligibilityDecisionRequest {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'], example: 'APPROVED' })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @ApiProperty({ description: 'Label of the human reviewer, recorded as reviewedBy (the shared admin token carries no identity).', example: 'compliance@example.com', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  reviewer!: string;

  @ApiPropertyOptional({ description: 'Reviewer notes. Replaces the stored notes when provided.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class EligibilityStatusResponse {
  @ApiProperty({ enum: ['NOT_REQUESTED', 'PENDING', 'APPROVED', 'REJECTED'], example: 'PENDING' })
  status!: 'NOT_REQUESTED' | EligibilityStatusValue;

  @ApiPropertyOptional({ format: 'date-time' })
  reviewedAt?: string;
}

export class EligibilityAdminResponse extends EligibilityStatusResponse {
  @ApiProperty() customerId!: string;
  @ApiPropertyOptional() reviewedBy?: string;
  @ApiPropertyOptional() notes?: string;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
}
