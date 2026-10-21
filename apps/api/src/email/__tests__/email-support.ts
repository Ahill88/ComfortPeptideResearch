/**
 * Shared test doubles for the email suites (not a test file). InMemoryEmailPrisma implements exactly the EmailOutbox surface the
 * service, worker and admin service use. Every write method is one synchronous step (like a single SQL statement), with an awaited
 * yield before it so concurrent callers interleave: updateMany compare-and-set is therefore atomic here, as in Postgres.
 */
import { ConsoleLogger, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { EmailConfig } from '../email.config';
import type { EmailProvider, OutboundEmail, SendResult } from '../email.provider';

type Row = Record<string, any>;
const time = (v: unknown) => (v instanceof Date ? v.getTime() : v);

function matches(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const actual = row[key];
    if (cond === null) return actual === null || actual === undefined;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      const a = time(actual) as number;
      return Object.entries(cond as Row).every(([op, v]) => {
        if (op === 'lt') return actual != null && a < (time(v) as number);
        if (op === 'lte') return actual != null && a <= (time(v) as number);
        if (op === 'gt') return actual != null && a > (time(v) as number);
        if (op === 'gte') return actual != null && a >= (time(v) as number);
        throw new Error(`in-memory prisma: unsupported operator ${op}`);
      });
    }
    return actual === cond;
  });
}

let seq = 0;
export class InMemoryEmailPrisma {
  rows: Row[] = [];
  /** Make the next create() fail with this error (then reset). */
  failNextCreate: Error | null = null;

  emailOutbox = {
    create: async (args: { data: Row }) => {
      await Promise.resolve();
      if (this.failNextCreate) {
        const error = this.failNextCreate;
        this.failNextCreate = null;
        throw error;
      }
      const d = args.data;
      if (d.dedupeKey && this.rows.some((r) => r.dedupeKey === d.dedupeKey)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on dedupeKey', { code: 'P2002', clientVersion: 'in-memory' });
      }
      const row: Row = {
        id: `c${String(++seq).padStart(6, '0')}${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        toEmail: d.toEmail,
        template: d.template,
        data: JSON.parse(JSON.stringify(d.data)),
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        providerMessageId: null,
        dedupeKey: d.dedupeKey ?? null,
        createdAt: new Date(),
        nextAttemptAt: new Date(),
        sentAt: null,
        ...Object.fromEntries(Object.entries(d).filter(([k]) => ['status', 'attempts', 'createdAt', 'nextAttemptAt', 'sentAt', 'lastError'].includes(k))),
      };
      this.rows.push(row);
      return { ...row };
    },
    findMany: async (args: { where?: Row; orderBy?: Row | Row[]; take?: number; select?: Row } = {}) => {
      await Promise.resolve();
      let out = this.rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r }));
      const orders = ([] as Row[]).concat(args.orderBy ?? []);
      out.sort((a, b) => {
        for (const order of orders) {
          const [[field, dir]] = Object.entries(order) as [string, 'asc' | 'desc'][];
          const x = time(a[field]) as any;
          const y = time(b[field]) as any;
          if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
        }
        return 0;
      });
      if (args.take) out = out.slice(0, args.take);
      if (args.select) out = out.map((r) => Object.fromEntries(Object.keys(args.select!).map((k) => [k, r[k]])));
      return out;
    },
    findUnique: async (args: { where: { id: string }; select?: Row }) => {
      await Promise.resolve();
      const row = this.rows.find((r) => r.id === args.where.id);
      if (!row) return null;
      return args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]])) : { ...row };
    },
    updateMany: async (args: { where: Row; data: Row }) => {
      await Promise.resolve();
      const hit = this.rows.filter((r) => matches(r, args.where));
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    },
    deleteMany: async (args: { where: Row }) => {
      await Promise.resolve();
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !matches(r, args.where));
      return { count: before - this.rows.length };
    },
  };

  /** Inserts a row directly with given fields (for arranging states). */
  seed(fields: Row): Row {
    const row: Row = {
      id: `seed${String(++seq).padStart(6, '0')}`,
      toEmail: 'buyer@example.com',
      template: 'password_reset',
      data: { link: 'https://shop.example.com/reset-password?token=TOKENVALUE0123456789abcdef' },
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      providerMessageId: null,
      dedupeKey: null,
      createdAt: new Date(),
      nextAttemptAt: new Date(),
      sentAt: null,
      ...fields,
    };
    this.rows.push(row);
    return row;
  }
}

export class FakeClock {
  constructor(public current = new Date('2026-10-21T12:00:00.000Z')) {}
  now = (): Date => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeProvider implements EmailProvider {
  readonly name = 'fake';
  sent: OutboundEmail[] = [];
  behavior: (message: OutboundEmail) => Promise<SendResult> | SendResult = (m) => ({ ok: true, providerMessageId: `fake-${m.id}` });
  delayMs = 0;
  async send(message: OutboundEmail): Promise<SendResult> {
    this.sent.push(message);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.behavior(message);
  }
}

export const testConfig = (overrides: Partial<EmailConfig> = {}): EmailConfig => ({
  provider: 'console',
  apiKey: null,
  from: null,
  workerIntervalMs: 0,
  devFiles: false,
  devOutboxDir: '/tmp/helix-dev-mail-test-unused',
  storefrontUrl: 'https://shop.example.com',
  ...overrides,
});

/** Captures every Nest Logger line (all levels) until restore(). */
export function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const sink = (level: string) => (message: unknown, ...rest: unknown[]) => void lines.push(`${level} ${String(message)} ${rest.map(String).join(' ')}`.trim());
  Logger.overrideLogger({ log: sink('log'), warn: sink('warn'), error: sink('error'), debug: sink('debug'), verbose: sink('verbose'), setLogLevels: () => undefined } as any);
  return { lines, restore: () => Logger.overrideLogger(new ConsoleLogger()) };
}

export const TOKEN = 'TOKENVALUE0123456789abcdef';
export const verificationData = { link: `https://shop.example.com/verify-email?token=${TOKEN}`, name: 'Ada Lovelace' };
