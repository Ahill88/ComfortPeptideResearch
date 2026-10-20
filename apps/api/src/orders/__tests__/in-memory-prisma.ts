/**
 * Minimal in-memory stand-in for the PrismaService surface OrdersService uses. It enforces the same unique
 * constraints as the real schema (Customer.email, Order(customerId, idempotencyKey)) and raises Prisma-style P2002.
 * Not a test file (no `.test.ts` suffix).
 */
export type Product = { id: string; priceCents: number; active: boolean; lots: Array<{ code: string }> };

function uniqueViolation(target: string): Error {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });
}

export function createInMemoryPrisma(seedProducts: Product[] = []) {
  const state = {
    customers: [] as Array<{ id: string; email: string }>,
    orders: [] as any[],
    products: seedProducts,
    seq: 0,
    /** Test hook: runs once, just before the first order insert, to simulate a concurrent winner. */
    beforeOrderCreate: undefined as undefined | (() => void),
  };
  const nextId = (prefix: string) => `${prefix}-${++state.seq}`;

  const prisma = {
    product: {
      findMany: async (args: any) =>
        state.products.filter((product) => args.where.id.in.includes(product.id) && product.active === args.where.active),
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
          status: 'PENDING_PAYMENT',
          totalCents: data.totalCents,
          currency: 'USD',
          researchAcknowledgedAt: data.researchAcknowledgedAt,
          createdAt: new Date(),
          items: data.items.create.map((item: any) => ({ id: nextId('item'), orderId: id, ...item })),
        };
        state.orders.push(order);
        return order;
      },
    },
  };
  return { prisma, state };
}
