/**
 * In-memory stand-in for the three admin tables (AdminUser, AdminSession, AdminAuditEvent). Implements exactly the Prisma
 * surface AdminSessionGuard, AdminAuditService and AdminAuthService use. Not a test file (no .test.ts suffix).
 * Each method is a single synchronous step, so check-and-set calls such as updateMany are atomic like a single SQL UPDATE.
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const actual = row[key];
    if (cond === null) return actual === null || actual === undefined;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('not' in cond) return cond.not === null ? actual !== null && actual !== undefined : actual !== cond.not;
      if ('lt' in cond) return actual !== null && actual !== undefined && actual < cond.lt;
      if ('gt' in cond) return actual !== null && actual !== undefined && actual > cond.gt;
      throw new Error(`in-memory prisma: unsupported filter on ${key}`);
    }
    return actual === cond;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
    else row[key] = value;
  }
}

let seq = 0;
const nextId = () => `${String(++seq).padStart(8, '0')}-${randomUUID()}`;

class Table {
  rows: Row[] = [];
  constructor(private readonly defaults: () => Row, private readonly uniques: string[], private readonly hooks: { include?: (row: Row, include: Row) => Row } = {}) {}

  private out(row: Row, args: Row = {}): Row {
    let copy: Row = { ...row };
    if (args.include && this.hooks.include) copy = this.hooks.include(copy, args.include);
    return copy;
  }

  async create(args: { data: Row }): Promise<Row> {
    for (const unique of this.uniques) {
      if (this.rows.some((r) => r[unique] === args.data[unique])) throw new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${unique}`, { code: 'P2002', clientVersion: 'in-memory' });
    }
    const row = { id: nextId(), ...this.defaults(), ...args.data };
    this.rows.push(row);
    return { ...row };
  }
  private find(where: Row): Row | undefined {
    return this.rows.find((r) => matches(r, where));
  }
  async findUnique(args: { where: Row; include?: Row }): Promise<Row | null> {
    const row = this.find(args.where);
    return row ? this.out(row, args) : null;
  }
  async findMany(args: { where?: Row; orderBy?: Row[] | Row; take?: number; skip?: number; cursor?: { id: string }; include?: Row } = {}): Promise<Row[]> {
    let rows = this.rows.filter((r) => matches(r, args.where));
    const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
    rows = [...rows].sort((a, b) => {
      for (const order of orderBy) {
        const [field, dir] = Object.entries(order)[0] as [string, 'asc' | 'desc'];
        const [x, y] = [a[field] instanceof Date ? a[field].getTime() : a[field], b[field] instanceof Date ? b[field].getTime() : b[field]];
        if (x === y) continue;
        return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1);
      }
      return 0;
    });
    if (args.cursor) {
      const index = rows.findIndex((r) => r.id === args.cursor!.id);
      rows = index < 0 ? [] : rows.slice(index + (args.skip ?? 0));
    }
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => this.out(r, args));
  }
  async count(args: { where?: Row } = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  async update(args: { where: Row; data: Row; select?: Row }): Promise<Row> {
    const row = this.find(args.where);
    if (!row) throw new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: 'in-memory' });
    applyData(row, args.data);
    return { ...row };
  }
  async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
    const targets = this.rows.filter((r) => matches(r, args.where));
    for (const row of targets) applyData(row, args.data);
    return { count: targets.length };
  }
  async deleteMany(args: { where?: Row } = {}): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  }
}

export function createInMemoryAdminPrisma() {
  const adminUser = new Table(() => ({ role: 'STAFF', active: true, failedLogins: 0, lockedUntil: null, lastLoginAt: null, lastTotpStep: null, createdAt: new Date() }), ['email']);
  const adminSession = new Table(() => ({ createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, ip: null, userAgent: null }), ['tokenHash'], {
    include: (row, include) => (include.admin ? { ...row, admin: { ...adminUser.rows.find((u) => u.id === row.adminId)! } } : row),
  });
  const adminAuditEvent = new Table(() => ({ adminId: null, targetId: null, detail: null, ip: null, createdAt: new Date() }), [], {
    include: (row) => ({ ...row, admin: row.adminId ? { email: adminUser.rows.find((u) => u.id === row.adminId)?.email ?? null } : null }),
  });
  const client = {
    adminUser, adminSession, adminAuditEvent,
    async $transaction(work: (tx: any) => Promise<any>): Promise<any> {
      return work(client);
    },
    async $connect() {},
    async $disconnect() {},
  };
  return client;
}
