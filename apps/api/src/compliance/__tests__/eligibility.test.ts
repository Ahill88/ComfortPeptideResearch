import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminTokenGuard } from '../../wallet-admin/admin-token.guard';
import { EligibilityAdminController } from '../eligibility-admin.controller';
import { EligibilityController } from '../eligibility.controller';
import { requireApprovedEligibility } from '../eligibility.gate';
import { EligibilityService } from '../eligibility.service';
import { SessionGuard } from '../../auth/session.guard';

type Row = { customerId: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; requestedAt: Date; reviewedAt: Date | null; reviewedBy: string | null; notes: string | null };

function fakePrisma(seed: Row[] = []) {
  const rows = new Map(seed.map((r) => [r.customerId, r]));
  const customerEligibility = {
    findUnique: async ({ where }: { where: { customerId: string } }) => rows.get(where.customerId) ?? null,
    upsert: async ({ where, create }: { where: { customerId: string }; create: { customerId: string; status: Row['status']; notes: string | null }; update: object }) => {
      const existing = rows.get(where.customerId);
      if (existing) return existing;
      const row: Row = { ...create, requestedAt: new Date(), reviewedAt: null, reviewedBy: null };
      rows.set(row.customerId, row);
      return row;
    },
    update: async ({ where, data }: { where: { customerId: string }; data: Partial<Row> }) => {
      const row = { ...rows.get(where.customerId)!, ...data };
      rows.set(where.customerId, row);
      return row;
    },
  };
  return { prisma: { customerEligibility } as never, rows, customerEligibility };
}
const row = (status: Row['status'], extra: Partial<Row> = {}): Row => ({ customerId: 'c1', status, requestedAt: new Date(), reviewedAt: null, reviewedBy: null, notes: null, ...extra });

describe('EligibilityService', () => {
  it('reports NOT_REQUESTED when no record exists', async () => {
    assert.deepEqual(await new EligibilityService(fakePrisma().prisma).status('c1'), { status: 'NOT_REQUESTED' });
  });

  it('review requests create PENDING, never APPROVED', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new EligibilityService(prisma);
    assert.deepEqual(await service.requestReview('c1', { attestation: true, note: 'lab' }), { status: 'PENDING' });
    assert.equal(rows.get('c1')?.status, 'PENDING');
  });

  it('requires attestation', async () => {
    const service = new EligibilityService(fakePrisma().prisma);
    await assert.rejects(service.requestReview('c1', { attestation: false }), BadRequestException);
  });

  it('a customer cannot self-approve by re-requesting, and cannot reopen a rejection', async () => {
    const approved = fakePrisma([row('APPROVED', { reviewedAt: new Date() })]);
    assert.equal((await new EligibilityService(approved.prisma).requestReview('c1', { attestation: true })).status, 'APPROVED');
    const pending = fakePrisma([row('PENDING')]);
    assert.equal((await new EligibilityService(pending.prisma).requestReview('c1', { attestation: true })).status, 'PENDING');
    const rejected = fakePrisma([row('REJECTED')]);
    await assert.rejects(new EligibilityService(rejected.prisma).requestReview('c1', { attestation: true }), ConflictException);
    assert.equal(rejected.rows.get('c1')?.status, 'REJECTED');
  });

  it('customer-visible status hides reviewer identity and notes', async () => {
    const { prisma } = fakePrisma([row('APPROVED', { reviewedAt: new Date(0), reviewedBy: 'sec@example.com', notes: 'internal' })]);
    assert.deepEqual(await new EligibilityService(prisma).status('c1'), { status: 'APPROVED', reviewedAt: '1970-01-01T00:00:00.000Z' });
  });

  it('decide records status, reviewedAt, reviewedBy and notes; 404 without a request', async () => {
    const { prisma, rows } = fakePrisma([row('PENDING')]);
    const service = new EligibilityService(prisma);
    const out = await service.decide('c1', { decision: 'APPROVED', reviewer: 'sec@example.com', notes: 'ok' });
    assert.equal(out.status, 'APPROVED');
    assert.equal(out.reviewedBy, 'sec@example.com');
    assert.equal(out.notes, 'ok');
    assert.ok(rows.get('c1')?.reviewedAt instanceof Date);
    await assert.rejects(service.decide('missing', { decision: 'REJECTED', reviewer: 'x' }), NotFoundException);
  });
});

describe('controller protection', () => {
  const guards = (target: object) => Reflect.getMetadata(GUARDS_METADATA, target) as unknown[];
  it('decision endpoint is behind AdminTokenGuard; customer routes behind SessionGuard', () => {
    assert.ok(guards(EligibilityAdminController).includes(AdminTokenGuard));
    assert.ok(guards(EligibilityController).includes(SessionGuard));
  });
  it('the customer controller exposes no decision/approve handler', () => {
    const names = Object.getOwnPropertyNames(EligibilityController.prototype).filter((n) => n !== 'constructor');
    assert.deepEqual(names.sort(), ['requestReview', 'status']);
  });
});

describe('requireApprovedEligibility', () => {
  it('allows APPROVED only', async () => {
    await assert.doesNotReject(requireApprovedEligibility(fakePrisma([row('APPROVED')]).prisma, 'c1'));
    for (const seed of [[], [row('PENDING')], [row('REJECTED')]]) {
      await assert.rejects(requireApprovedEligibility(fakePrisma(seed).prisma, 'c1'), ForbiddenException);
    }
  });
});
