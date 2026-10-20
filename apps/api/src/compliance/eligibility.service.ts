import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EligibilityAdminResponse, EligibilityDecisionRequest, EligibilityReviewRequest, EligibilityStatusResponse } from './eligibility.dto';

interface EligibilityRow {
  customerId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  notes: string | null;
}

/**
 * Persisted customer eligibility (CustomerEligibility), distinct from Order.researchAcknowledgedAt.
 *
 * Customers can only ever create or re-read a PENDING request. APPROVED/REJECTED can only be written by
 * `decide`, which is exposed solely behind the admin-token guard (see EligibilityAdminController).
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Customer-visible status. Never exposes reviewer identity or notes. */
  async status(customerId: string): Promise<EligibilityStatusResponse> {
    const row = await this.prisma.customerEligibility.findUnique({ where: { customerId } });
    return row ? this.publicView(row) : { status: 'NOT_REQUESTED' };
  }

  /**
   * Creates a PENDING record (idempotent: an existing PENDING or APPROVED record is returned unchanged,
   * so a customer can neither downgrade nor re-approve). A REJECTED record cannot be reopened by the
   * customer; a reviewer must act on it.
   */
  async requestReview(customerId: string, request: EligibilityReviewRequest): Promise<EligibilityStatusResponse> {
    if (request.attestation !== true) throw new BadRequestException('Attestation is required to request an eligibility review.');
    const row = await this.prisma.customerEligibility.upsert({
      where: { customerId },
      create: { customerId, status: 'PENDING', notes: request.note ?? null },
      update: {},
    });
    if (row.status === 'REJECTED') throw new ConflictException('Eligibility was reviewed and rejected; contact support to appeal.');
    return this.publicView(row);
  }

  /** Reviewer decision. Only callable from the admin-token-protected controller. */
  async decide(customerId: string, decision: EligibilityDecisionRequest): Promise<EligibilityAdminResponse> {
    const existing = await this.prisma.customerEligibility.findUnique({ where: { customerId } });
    if (!existing) throw new NotFoundException('No eligibility review request exists for this customer.');
    const row = await this.prisma.customerEligibility.update({
      where: { customerId },
      data: {
        status: decision.decision,
        reviewedAt: new Date(),
        reviewedBy: decision.reviewer,
        ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
      },
    });
    return this.adminView(row);
  }

  private publicView(row: EligibilityRow): EligibilityStatusResponse {
    return { status: row.status, ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}) };
  }

  private adminView(row: EligibilityRow): EligibilityAdminResponse {
    return {
      ...this.publicView(row),
      customerId: row.customerId,
      requestedAt: row.requestedAt.toISOString(),
      ...(row.reviewedBy ? { reviewedBy: row.reviewedBy } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
    };
  }
}
