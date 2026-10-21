/**
 * In-memory PrismaService stand-in for the CustomerOrdersService read paths (not a test file: no `.test.ts` suffix).
 * It honours `where` (customerId/id, createdAt keyset, event kind), `orderBy`, `take` and, importantly, `select`:
 * a column the service does not select is NOT returned, so a leak through an unselected column cannot hide here.
 * Every select the service issues is recorded so tests can assert that staff columns are never requested.
 */
type Row = Record<string, any>;

export function createCustomerOrdersDouble() {
  const state = {
    customers: [] as Row[],
    orders: [] as Row[],
    items: [] as Row[],
    shipments: [] as Row[],
    events: [] as Row[],
    products: [] as Row[],
    purchases: [] as Row[],
    selects: [] as unknown[],
    seq: 0,
  };
  const id = (prefix: string) => `${prefix}${String(++state.seq).padStart(4, '0')}`;
  const cmp = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);
  const time = (v: any) => (v instanceof Date ? v.getTime() : v);

  function sortBy(rows: Row[], orderBy: any): Row[] {
    const specs: Array<Record<string, 'asc' | 'desc'>> = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((x, y) => {
      for (const spec of specs) {
        const [[key, dir]] = Object.entries(spec);
        const c = cmp(time(x[key]), time(y[key]));
        if (c) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  function matchOrder(row: Row, where: any): boolean {
    if (!where) return true;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.customerId !== undefined && row.customerId !== where.customerId) return false;
    if (where.OR) {
      return where.OR.some((clause: any) => {
        if (clause.createdAt?.lt) return row.createdAt.getTime() < clause.createdAt.lt.getTime();
        if (clause.AND) return row.createdAt.getTime() === clause.AND[0].createdAt.getTime() && row.id < clause.AND[1].id.lt;
        throw new Error('unsupported OR clause in double');
      });
    }
    return true;
  }

  function project(row: Row, select: Row, relations: Record<string, () => Row[]>): Row {
    const out: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      if (spec === true) {
        out[key] = row[key];
      } else if (spec && typeof spec === 'object' && relations[key]) {
        let related = relations[key]();
        const where = (spec as any).where;
        if (where?.kind) related = related.filter((r) => r.kind === where.kind);
        related = sortBy(related, (spec as any).orderBy);
        out[key] = related.map((r) => project(r, (spec as any).select, {}));
      } else {
        throw new Error(`unsupported select ${key}`);
      }
    }
    return out;
  }

  const relationsFor = (order: Row) => ({
    items: () => state.items.filter((i) => i.orderId === order.id),
    shipments: () => state.shipments.filter((s) => s.orderId === order.id),
    events: () => state.events.filter((e) => e.orderId === order.id),
  });

  const prisma = {
    customer: {
      findUnique: async (args: any) => {
        state.selects.push(args.select);
        const c = state.customers.find((x) => x.email === args.where.email);
        return c ? project(c, args.select, {}) : null;
      },
    },
    order: {
      findMany: async (args: any) => {
        state.selects.push(args.select);
        const rows = sortBy(state.orders.filter((o) => matchOrder(o, args.where)), args.orderBy);
        return rows.slice(0, args.take).map((o) => project(o, args.select, relationsFor(o)));
      },
      findFirst: async (args: any) => {
        state.selects.push(args.select);
        const o = state.orders.find((x) => matchOrder(x, args.where));
        return o ? project(o, args.select, relationsFor(o)) : null;
      },
    },
    product: {
      findMany: async (args: any) => {
        state.selects.push(args.select);
        return state.products.filter((p) => args.where.id.in.includes(p.id)).map((p) => project(p, args.select, {}));
      },
    },
    cryptoTransaction: {
      findFirst: async (args: any) => {
        state.selects.push(args.select);
        const w = args.where;
        const hit = sortBy(state.purchases.filter((p) => p.orderId === w.orderId && p.type === w.type && p.status === w.status), args.orderBy)[0];
        return hit ? project(hit, args.select, {}) : null;
      },
    },
  };

  const addCustomer = (email: string) => {
    const row = { id: id('cust'), email };
    state.customers.push(row);
    return row;
  };
  const addProduct = (over: Row = {}) => {
    const row = { id: id('prod'), slug: `slug-${state.seq}`, name: `Product ${state.seq}`, ...over };
    state.products.push(row);
    return row;
  };
  const addOrder = (customerId: string, over: Row = {}) => {
    const row = {
      id: id('ord'),
      customerId,
      status: 'PENDING_PAYMENT',
      totalCents: 2500,
      subtotalCents: 2500 as number | null,
      shippingCents: 0,
      taxCents: 0,
      currency: 'USD',
      createdAt: new Date('2026-10-01T12:00:00.000Z'),
      shippingAddress: '1 Lab Way, Boston, MA 02110' as string | null,
      ...over,
    };
    state.orders.push(row);
    return row;
  };
  const addItem = (orderId: string, productId: string, over: Row = {}) => {
    const row = { id: id('item'), orderId, productId, lotCode: 'LOT-1', quantity: 2, unitCents: 1250, ...over };
    state.items.push(row);
    return row;
  };
  const addShipment = (orderId: string, over: Row = {}) => {
    const row = {
      id: id('shp'),
      orderId,
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
      shippedAt: new Date('2026-10-03T12:00:00.000Z'),
      deliveredAt: null,
      note: 'STAFF-SHIPMENT-NOTE',
      createdByAdminId: 'admin-staff-1',
      ...over,
    };
    state.shipments.push(row);
    return row;
  };
  const addEvent = (orderId: string, over: Row = {}) => {
    const row = {
      id: id('evt'),
      orderId,
      kind: 'STATUS',
      fromStatus: null,
      toStatus: null,
      note: null,
      adminId: null,
      createdAt: new Date('2026-10-02T12:00:00.000Z'),
      ...over,
    };
    state.events.push(row);
    return row;
  };

  return { prisma, state, addCustomer, addProduct, addOrder, addItem, addShipment, addEvent };
}
