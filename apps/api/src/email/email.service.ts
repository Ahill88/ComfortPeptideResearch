import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { EmailValidationError } from './email.errors';
import { isKnownTemplate, isValidEmailAddress, validateDedupeKey, validateTemplateData } from './email.validation';
import type { EmailEnqueueInput, EmailPort } from './email.types';

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * The EMAIL_PORT implementation. enqueue() validates, inserts ONE EmailOutbox row and returns; it never contacts a provider, so a
 * provider outage cannot reach the caller. Idempotent on `dedupeKey` (unique column): a duplicate insert (P2002, also under
 * parallel calls) counts as success and keeps the first row. Invalid input throws EmailValidationError (a caller bug; the message
 * never contains the address or any data value). A database failure other than the duplicate is NOT swallowed: the message was
 * not recorded, so the caller must know.
 */
@Injectable()
export class EmailService implements EmailPort {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EmailEnqueueInput): Promise<void> {
    if (typeof input !== 'object' || input === null) throw new EmailValidationError('input must be an object');
    if (!isValidEmailAddress(input.to)) throw new EmailValidationError('recipient address is not valid');
    if (!isKnownTemplate(input.template)) throw new EmailValidationError('unknown template');
    const data = validateTemplateData(input.template, input.data);
    const dedupeKey = validateDedupeKey(input.dedupeKey);
    try {
      await this.prisma.emailOutbox.create({
        data: { toEmail: input.to, template: input.template, data: data as Prisma.InputJsonObject, dedupeKey },
      });
    } catch (error) {
      if (dedupeKey && isUniqueViolation(error)) return; // already queued: idempotent success
      throw error;
    }
  }
}
