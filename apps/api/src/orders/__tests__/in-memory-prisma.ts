/**
 * Minimal in-memory stand-in for the PrismaService surface OrdersService + InventoryService use. It enforces the same unique
 * constraints as the real schema (Customer.email, Order(customerId, idempotencyKey), InventoryAdjustment(orderId, productId, kind))
 * and raises Prisma-style P2002; `product.updateMany` is the same conditional update the real database runs; `$transaction`
 * undoes exactly its own writes when the callback throws, so "a failing line rolls back every reservation" is real here too.
 * Real concurrency (row locks, deadlocks) is covered by the integration test, not by this double. Not a test file.
 */
export type Product = {
  id: string;
  priceCents: number;
  active: boolean;
  lots: Array<{ code: string }>;
  /** Defaults to 10_000 so fixtures that are not about stock never run out. */
  inventory?: number;
  name?: string;
};

function uniqueViolation(target: string): Error {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });
}

export function createInMemoryPrisma(seedProducts: Product[] = []) {
  for (const product of seedProducts) {
    product.inventory ??= 10_000;
    product.name ??= product.id;
  }
  const state = {
    customers: [] as Array<{ id: string; email: string }>,
    orders: [] as any[],
    products: seedProducts as Array<Product & { inventory: number; name: string }>,
    ledger: [] as Array<{ id: string; productId: string; delta: number; kind: string; reason: string | null; orderId: string | null; adminId: string | null }>,
    seq: 0,
    transactions: 0,
    /** Test hook: runs once, just before the first order insert, to simulate a concurrent winner. */
    beforeOrderCreate: undefined as undefined | (() => void),
  };
  const nextId = (prefix: string) => `${prefix}-${++state.seq}`;

  const client = (undo: Array<() => void>) => ({
    product: {
      findMany: async (args: any) =>
        state.products.filter((product) => args.where.id.in.includes(product.id) && (args.where.active === undefined || product.active === args.where.active)),
      findUnique: async (args: any) => state.products.find((product) => product.id === args.where.id) ?? null,
      updateMany: async (args: any) => {
        const hit = state.products.filter((product) => product.id === args.where.id && (args.where.inventory?.gte === undefined || product.inventory >= args.where.inventory.gte));
        for (const product of hit) {
          const change = args.data.inventory;
          const delta = change.increment ?? -change.decrement;
          product.inventory += delta;
          undo.push(() => {
            product.inventory -= delta;
          });
        }
        return { count: hit.length };
      },
    },
    inventoryAdjustment: {
      create: async (args: any) => {
        const data = args.data;
        if (data.orderId && state.ledger.some((row) => row.orderId === data.orderId && row.productId === data.productId && row.kind === data.kind)) {
          throw uniqueViolation('InventoryAdjustment.orderId_productId_kind');
        }
        const row = { id: nextId('adj'), orderId: null, adminId: null, reason: null, ...data };
        state.ledger.push(row);
        undo.push(() => state.ledger.splice(state.ledger.indexOf(row), 1));
        return row;
      },
      createMany: async (args: any) => {
        let count = 0;
        for (const data of args.data) {
          if (data.orderId && state.ledger.some((row) => row.orderId === data.orderId && row.productId === data.productId && row.kind === data.kind)) {
            if (args.skipDuplicates) continue;
            throw uniqueViolation('InventoryAdjustment.orderId_productId_kind');
          }
          const row = { id: nextId('adj'), orderId: null, adminId: null, reason: null, ...data };
          state.ledger.push(row);
          undo.push(() => state.ledger.splice(state.ledger.indexOf(row), 1));
          count += 1;
        }
        return { count };
      },
      findMany: async (args: any) => state.ledger.filter((row) => row.orderId === args.where.orderId && row.kind === args.where.kind),
    },
    customer: {
      findUnique: async (args: any) => state.customers.find((customer) => customer.email === args.where.email) ?? null,
      create: async (args: any) => {
        if (state.customers.some((customer) => customer.email === args.data.email)) throw uniqueViolation('Customer.email');
        const customer = { id: nextId('cust'), email: args.data.email };
        state.customers.push(customer);
        return customer;
      },
    },
    order: {
      findUnique: async (args: any) => {
        const scope = args.where.customerId_idempotencyKey;
        const found = state.orders.find((order) => order.customerId === scope.customerId && order.idempotencyKey === scope.idempotencyKey);
        return found ?? null;
      },
      updateMany: async (args: any) => {
        const mustBeUnreleased = 'inventoryReleasedAt' in args.where && args.where.inventoryReleasedAt === null;
        const hit = state.orders.filter((order) => order.id === args.where.id && (!mustBeUnreleased || order.inventoryReleasedAt == null));
        for (const order of hit) {
          const previous = { ...order };
          Object.assign(order, args.data);
          undo.push(() => Object.assign(order, previous));
        }
        return { count: hit.length };
      },
      create: async (args: any) => {
        const hook = state.beforeOrderCreate;
        state.beforeOrderCreate = undefined;
        hook?.();
        const data = args.data;
        if (state.orders.some((order) => order.customerId === data.customerId && order.idempotencyKey === data.idempotencyKey)) {
          throw uniqueViolation('Order.customerId_idempotencyKey');
        }
        const id = nextId('order');
        const order = {
          id,
          customerId: data.customerId,
          idempotencyKey: data.idempotencyKey,
          requestHash: data.requestHash,
          shippingAddress: data.shippingAddress ?? null,
          status: 'PENDING_PAYMENT',
          subtotalCents: data.subtotalCents ?? null,
          shippingCents: data.shippingCents ?? 0,
          taxCents: data.taxCents ?? 0,
          totalCents: data.totalCents,
          expiresAt: data.expiresAt ?? null,
          inventoryReleasedAt: null,
          currency: 'USD',
          researchAcknowledgedAt: data.researchAcknowledgedAt,
          createdAt: new Date(),
          items: data.items.create.map((item: any) => ({ id: nextId('item'), orderId: id, ...item })),
        };
        state.orders.push(order);
        undo.push(() => state.orders.splice(state.orders.indexOf(order), 1));
        return order;
      },
    },
  });

  const prisma = {
    ...client([]),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      const undo: Array<() => void> = [];
      try {
        return await fn(client(undo));
      } catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      }
    },
  };
  return { prisma, state };
}
