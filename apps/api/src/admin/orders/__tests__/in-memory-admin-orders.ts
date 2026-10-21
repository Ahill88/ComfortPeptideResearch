/**
 * In-memory stand-in for the PrismaService surface AdminOrdersService uses for detail + transitions (list queries are
 * exercised against real PostgreSQL in the integration test). Not a test file (no `.test.ts` suffix).
 *
 * Transactions record undo closures so a throw rolls back exactly this transaction's writes, even while other
 * transactions interleave. Each Prisma-like call is atomic (no await between its read and write), mirroring a row
 * lock on `updateMany ... WHERE status = <expected>`.
 */
export type OrderRow = {
  id: string;
  customerId: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: Date;
  shippingAddress: string | null;
};

export function createAdminOrdersDouble() {
  const state = {
    customers: [{ id: 'cust-1', email: 'buyer@example.test', name: 'Bea Buyer' }] as Array<{ id: string; email: string; name: string | null }>,
    orders: [] as OrderRow[],
    items: [] as Array<{ id: string; orderId: string; productId: string; lotCode: string; quantity: number; unitCents: number }>,
    shipments: [] as any[],
    events: [] as any[],
    products: [{ id: 'prod-1', sku: 'SKU-1', name: 'Test peptide' }] as Array<{ id: string; sku: string; name: string }>,
    admins: [{ id: 'admin-1', name: 'Owner One' }] as Array<{ id: string; name: string }>,
    purchases: [] as any[],
    audits: [] as any[],
    seq: 0,
    failAuditWrites: false,
    /** Makes shipment.findFirst miss, so the insert's unique constraint is what fires. */
    blindPrecheck: false,
    /** Awaited inside every updateMany after the guard check, to widen race windows deterministically. */
    afterFlip: undefined as undefined | (() => Promise<void>),
  };
  const id = (prefix: string) => `${prefix}-${++state.seq}`;

  const client = (undo: Array<() => void>) => ({
    order: {
      findUnique: async (args: any) => {
        const order = state.orders.find((candidate) => candidate.id === args.where.id);
        if (!order) return null;
        return {
          ...order,
          customer: state.customers.find((customer) => customer.id === order.customerId),
          items: state.items.filter((item) => item.orderId === order.id),
          shipments: state.shipments.filter((shipment) => shipment.orderId === order.id).sort((a, b) => a.shippedAt.getTime() - b.shippedAt.getTime()),
          events: state.events.filter((event) => event.orderId === order.id),
        };
      },
      updateMany: async (args: any) => {
        const order = state.orders.find((candidate) => candidate.id === args.where.id && candidate.status === args.where.status);
        if (!order) return { count: 0 };
        const previous = order.status;
        order.status = args.data.status;
        undo.push(() => {
          order.status = previous;
        });
        await state.afterFlip?.();
        return { count: 1 };
      },
      groupBy: async () => {
        const tally = new Map<string, number>();
        for (const order of state.orders) tally.set(order.status, (tally.get(order.status) ?? 0) + 1);
        return [...tally].map(([status, count]) => ({ status, _count: { _all: count } }));
      },
    },
    orderEvent: {
      create: async (args: any) => {
        const row = { id: id('evt'), createdAt: new Date(Date.now() + state.seq), fromStatus: null, toStatus: null, note: null, adminId: null, ...args.data };
        state.events.push(row);
        undo.push(() => state.events.splice(state.events.indexOf(row), 1));
        return row;
      },
    },
    shipment: {
      findFirst: async (args: any) => state.blindPrecheck ? null : state.shipments.find((s) => s.orderId === args.where.orderId && s.trackingNumber === args.where.trackingNumber) ?? null,
      create: async (args: any) => {
        if (state.shipments.some((s) => s.orderId === args.data.orderId && s.trackingNumber === args.data.trackingNumber)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: id('shp'), shippedAt: new Date(), deliveredAt: null, note: null, ...args.data };
        state.shipments.push(row);
        undo.push(() => state.shipments.splice(state.shipments.indexOf(row), 1));
        return row;
      },
      updateMany: async (args: any) => {
        const hit = state.shipments.filter((s) => s.orderId === args.where.orderId && s.deliveredAt === null);
        for (const row of hit) {
          row.deliveredAt = args.data.deliveredAt;
          undo.push(() => {
            row.deliveredAt = null;
          });
        }
        return { count: hit.length };
      },
    },
    product: { findMany: async (args: any) => state.products.filter((p) => args.where.id.in.includes(p.id)) },
    adminUser: { findMany: async (args: any) => state.admins.filter((a) => args.where.id.in.includes(a.id)) },
    cryptoTransaction: {
      findMany: async (args: any) => state.purchases.filter((p) => p.orderId === args.where.orderId && p.type === args.where.type),
    },
  });

  const prisma = {
    ...client([]),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const undo: Array<() => void> = [];
      try {
        return await fn(client(undo));
      } catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      }
    },
  };

  const audit = {
    record: async (input: any) => {
      if (state.failAuditWrites) throw new Error('audit store down');
      state.audits.push(input);
    },
  };

  const addOrder = (overrides: Partial<OrderRow> & { status?: string } = {}): OrderRow => {
    const order: OrderRow = {
      id: id('order'),
      customerId: 'cust-1',
      status: 'PAID',
      totalCents: 2500,
      currency: 'USD',
      createdAt: new Date('2026-10-01T12:00:00.000Z'),
      shippingAddress: '1 Lab Way, Boston, MA',
      ...overrides,
    };
    state.orders.push(order);
    state.items.push({ id: id('item'), orderId: order.id, productId: 'prod-1', lotCode: 'LOT-1', quantity: 2, unitCents: 1250 });
    return order;
  };

  return { prisma, audit, state, addOrder };
}
