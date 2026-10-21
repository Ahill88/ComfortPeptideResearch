/**
 * In-memory stand-in for the four customer-account tables (Customer, CustomerSession, CustomerToken, CustomerAddress).
 * Implements exactly the Prisma surface AuthService, AccountService and CustomerSessionService use. Not a test file.
 * Every method is a single synchronous step, so conditional updateMany calls are atomic like one SQL UPDATE. $transaction runs the
 * callback against the same store with NO rollback (the services only throw before they write inside a transaction).
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;

const time = (value: unknown): any => (value instanceof Date ? value.getTime() : value);

function matches(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const actual = row[key];
    if (cond === null) return actual === null || actual === undefined;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('not' in cond) return cond.not === null ? actual !== null && actual !== undefined : actual !== cond.not;
      if ('lt' in cond) return actual !== null && actual !== undefined && time(actual) < time(cond.lt);
      if ('gt' in cond) return actual !== null && actual !== undefined && time(actual) > time(cond.gt);
      if ('startsWith' in cond) return typeof actual === 'string' && actual.startsWith(cond.startsWith);
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
const nextId = () => `c${String(++seq).padStart(8, '0')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const known = (code: string, message: string) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'in-memory' });

class Table {
  rows: Row[] = [];
  constructor(private readonly defaults: () => Row, private readonly uniques: string[], private readonly hooks: { include?: (row: Row, include: Row) => Row } = {}) {}

  private out(row: Row, args: Row = {}): Row {
    const copy: Row = { ...row };
    return args.include && this.hooks.include ? this.hooks.include(copy, args.include) : copy;
  }
  private find(where: Row): Row | undefined {
    return this.rows.find((r) => matches(r, where));
  }
  async create(args: { data: Row }): Promise<Row> {
    for (const unique of this.uniques) {
      if (this.rows.some((r) => r[unique] === args.data[unique])) throw known('P2002', `Unique constraint failed on ${unique}`);
    }
    const row = { id: nextId(), ...this.defaults(), ...args.data };
    this.rows.push(row);
    return { ...row };
  }
  async findUnique(args: { where: Row; include?: Row }): Promise<Row | null> {
    const row = this.find(args.where);
    return row ? this.out(row, args) : null;
  }
  async findFirst(args: { where?: Row; orderBy?: Row[] | Row } = {}): Promise<Row | null> {
    return (await this.findMany({ ...args, take: 1 }))[0] ?? null;
  }
  async findMany(args: { where?: Row; orderBy?: Row[] | Row; take?: number; include?: Row } = {}): Promise<Row[]> {
    const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
    let rows = this.rows.filter((r) => matches(r, args.where));
    rows = [...rows].sort((a, b) => {
      for (const order of orderBy) {
        const [field, dir] = Object.entries(order)[0] as [string, 'asc' | 'desc'];
        const [x, y] = [time(a[field]) as any, time(b[field]) as any];
        if (x === y) continue;
        return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1);
      }
      return 0;
    });
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => this.out(r, args));
  }
  async count(args: { where?: Row } = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  async update(args: { where: Row; data: Row }): Promise<Row> {
    const row = this.find(args.where);
    if (!row) throw known('P2025', 'Record not found');
    applyData(row, args.data);
    return { ...row };
  }
  async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
    const targets = this.rows.filter((r) => matches(r, args.where));
    for (const row of targets) applyData(row, args.data);
    return { count: targets.length };
  }
  async delete(args: { where: Row }): Promise<Row> {
    const row = this.find(args.where);
    if (!row) throw known('P2025', 'Record not found');
    this.rows = this.rows.filter((r) => r !== row);
    return { ...row };
  }
  async deleteMany(args: { where?: Row } = {}): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  }
}

export function createInMemoryCustomerPrisma() {
  const customer = new Table(
    () => ({ name: null, createdAt: new Date(), passwordHash: null, emailVerifiedAt: null, mfaSeedEnc: null, mfaEnabledAt: null, lastTotpStep: null, failedLogins: 0, lockedUntil: null, lastLoginAt: null }),
    ['email'],
  );
  const customerSession = new Table(() => ({ createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, ip: null, userAgent: null }), ['tokenHash'], {
    include: (row, include) => {
      if (!include.customer) return row;
      const owner = customer.rows.find((c) => c.id === row.customerId)!;
      return { ...row, customer: { id: owner.id, email: owner.email } };
    },
  });
  const customerToken = new Table(() => ({ usedAt: null, createdAt: new Date() }), ['tokenHash']);
  const customerAddress = new Table(() => ({ label: null, line2: null, isDefault: false, createdAt: new Date() }), []);
  const client = {
    customer, customerSession, customerToken, customerAddress,
    async $transaction(work: (tx: any) => Promise<any>): Promise<any> {
      return work(client);
    },
    async $connect() {},
    async $disconnect() {},
  };
  return client;
}
