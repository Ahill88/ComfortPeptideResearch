import { ForbiddenException } from '@nestjs/common';

/** Minimal structural slice of PrismaService so the gate is trivially testable. */
export interface EligibilityReader {
  customerEligibility: {
    findUnique(args: { where: { customerId: string }; select?: { status: true } }): Promise<{ status: string } | null>;
  };
}

/**
 * Throws 403 unless the customer has an APPROVED CustomerEligibility record (missing, PENDING and
 * REJECTED all deny). Order.researchAcknowledgedAt is intentionally NOT consulted.
 */
export async function requireApprovedEligibility(prisma: EligibilityReader, customerId: string): Promise<void> {
  const row = await prisma.customerEligibility.findUnique({ where: { customerId }, select: { status: true } });
  if (row?.status !== 'APPROVED') throw new ForbiddenException('Customer eligibility has not been approved.');
}
