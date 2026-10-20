import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OrdersService } from '../apps/api/src/orders/orders.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { SolanaUsdcProcessor } from '../apps/api/src/payments/solana-usdc.processor';
import './authentication-eligibility.test';

const product = {
  id: 'product-a',
  priceCents: 1250,
  lots: [{ code: 'LOT-A' }],
};

const treasury = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const signature = '5Yv3jS1dSGmHz4B1bYy3hDJxJ7ivUHrb2dny1sy9aPDAZHqj7Qq3YHGG4PBymKFEZ1tZdhuxjG6xTY4MMqE1DX5h';

function createOrdersService(products = [product]) {
  const createdOrders: any[] = [];
  const prisma = {
    product: { findMany: async () => products },
    customer: {
      findUnique: async () => null,
      create: async (input: any) => ({ id: 'customer-1', ...input.data }),
    },
    order: {
      findUnique: async () => null,
      create: async (input: any) => {
        createdOrders.push(input.data);
        return { id: 'order-1', currency: 'USD', status: 'PENDING_PAYMENT', createdAt: new Date(), ...input.data, items: [] };
      },
    },
  };

  return { service: new OrdersService(prisma as any), createdOrders };
}

test('cart arithmetic persists the product price and summed quantity total in cents', async () => {
  const { service, createdOrders } = createOrdersService([{ ...product, priceCents: 1999 }]);

  await service.create({
    email: 'researcher@example.test',
    shippingAddress: '1 Lab Way',
    items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 3 }],
    researchUseAcknowledged: true,
    idempotencyKey: 'order-cart-arithmetic',
  });

  assert.equal(createdOrders[0].totalCents, 5997);
  assert.equal(createdOrders[0].items.create[0].unitCents, 1999);
  assert.equal(createdOrders[0].items.create[0].quantity, 3);
  assert.ok(createdOrders[0].researchAcknowledgedAt instanceof Date);
  // The client-chosen key is bookkeeping only; it is never used as the global Order.id.
  assert.equal(createdOrders[0].id, undefined);
  assert.equal(createdOrders[0].idempotencyKey, 'order-cart-arithmetic');
  assert.match(createdOrders[0].requestHash, /^[0-9a-f]{64}$/);
});

test('cart rejects an unavailable product and a lot that does not belong to the product', async () => {
  const unavailable = createOrdersService([]).service;
  await assert.rejects(
    unavailable.create({ email: 'researcher@example.test', shippingAddress: '1 Lab Way', items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 1 }], researchUseAcknowledged: true, idempotencyKey: 'order-unavailable-product' }),
    /Unavailable product in order/,
  );

  const invalidLot = createOrdersService().service;
  await assert.rejects(
    invalidLot.create({ email: 'researcher@example.test', shippingAddress: '1 Lab Way', items: [{ productId: 'product-a', lotCode: 'LOT-OTHER', quantity: 1 }], researchUseAcknowledged: true, idempotencyKey: 'order-invalid-lot' }),
    /Invalid lot/,
  );
});

test('cart requires research-use acknowledgement', async () => {
  const { service } = createOrdersService();

  await assert.rejects(
    service.create({ email: 'researcher@example.test', shippingAddress: '1 Lab Way', items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 1 }], idempotencyKey: 'order-missing-acknowledgement' } as any),
    /Research-use acknowledgement is required/,
  );
});

function createPaymentsService(order: any = null, payment: any = null) {
  const updates: any[] = [];
  const ledgerEntries: any[] = [];
  const jobs: any[] = [];
  let currentPayment = payment;
  const prisma = {
    order: {
      findUnique: async () => order,
      update: async (input: any) => { updates.push({ type: 'order', input }); },
    },
    payment: {
      create: async (input: any) => ({ id: 'payment-1', ...input.data }),
      findUnique: async () => currentPayment,
      findUniqueOrThrow: async () => currentPayment,
      update: async (input: any) => { updates.push({ type: 'payment', input }); },
      updateMany: async (input: any) => {
        updates.push({ type: 'payment', input });
        currentPayment = { ...currentPayment, ...input.data };
        return { count: 1 };
      },
    },
    ledgerEntry: { createMany: async (input: any) => { ledgerEntries.push(...input.data); } },
    $transaction: async (work: (tx: any) => unknown) => work(prisma),
  };
  const queue = { add: async (...args: any[]) => { jobs.push(args); } };

  return { service: new PaymentsService(prisma as any, queue as any), updates, ledgerEntries, jobs };
}

test('payment intents require acknowledgement, pending order state, and a valid devnet treasury', async () => {
  const previousTreasury = process.env.SOLANA_USDC_TREASURY;
  delete process.env.SOLANA_USDC_TREASURY;
  const pendingOrder = { id: 'order-1', totalCents: 5997, status: 'PENDING_PAYMENT', researchAcknowledgedAt: new Date() };

  try {
    await assert.rejects(createPaymentsService(pendingOrder).service.createIntent('order-1', 'solana-usdc'), /valid Solana devnet USDC destination/);
    await assert.rejects(
      createPaymentsService({ ...pendingOrder, researchAcknowledgedAt: null }).service.createIntent('order-1', 'solana-usdc'),
      /acknowledgement is required/,
    );
    await assert.rejects(
      createPaymentsService({ ...pendingOrder, status: 'PAID' }).service.createIntent('order-1', 'solana-usdc'),
      /not awaiting payment/,
    );

    process.env.SOLANA_USDC_TREASURY = treasury;
    const intent = await createPaymentsService(pendingOrder).service.createIntent('order-1', 'solana-usdc');
    assert.deepEqual(intent, {
      paymentId: 'payment-1',
      network: 'solana-devnet',
      asset: 'USDC',
      mint: treasury,
      amountAtomic: '59970000',
      recipient: treasury,
      reference: 'payment-1',
      expiresAt: intent.expiresAt,
    });
  } finally {
    if (previousTreasury === undefined) delete process.env.SOLANA_USDC_TREASURY;
    else process.env.SOLANA_USDC_TREASURY = previousTreasury;
  }
});

test('confirmation accepts only valid Solana signatures and expires pending intents atomically', async () => {
  const expired = { id: 'payment-1', status: 'PENDING', txSignature: null, expiresAt: new Date(Date.now() - 1) };
  const { service, jobs, updates } = createPaymentsService(null, expired);

  await assert.rejects(service.submitConfirmation('payment-1', '0'.repeat(64)), /Invalid Solana transaction signature format/);
  await assert.rejects(service.submitConfirmation('payment-1', signature), /Payment intent expired/);
  assert.equal(jobs.length, 0);
  assert.deepEqual(updates, [{
    type: 'payment',
    input: { where: { id: 'payment-1', status: 'PENDING', txSignature: null }, data: { status: 'EXPIRED' } },
  }]);
});

test('repeated valid confirmations use an idempotent verification job and reject changed signatures', async () => {
  const pending = { id: 'payment-1', status: 'PENDING', txSignature: null, expiresAt: new Date(Date.now() + 60_000) };
  const { service, jobs, updates } = createPaymentsService(null, pending);

  assert.deepEqual(await service.submitConfirmation('payment-1', signature), { status: 'verification_pending' });
  assert.deepEqual(await service.submitConfirmation('payment-1', signature), { status: 'verification_pending' });
  assert.deepEqual(updates[0], {
    type: 'payment',
    input: { where: { id: 'payment-1', status: 'PENDING', txSignature: null }, data: { txSignature: signature } },
  });
  assert.equal(jobs.length, 2);
  assert.equal(updates.length, 1);
  const [firstJobId, secondJobId] = jobs.map(([, , options]) => options.jobId);
  assert.equal(firstJobId, secondJobId);
  assert.match(firstJobId, /^verify-[a-f0-9]{64}$/);
  assert.ok(!firstJobId.includes(':'));
  for (const job of jobs) {
    assert.deepEqual(job, ['verify-solana-usdc', { paymentId: 'payment-1', signature }, {
      jobId: firstJobId,
      removeOnComplete: true,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    }]);
  }

  const changed = createPaymentsService(null, { ...pending, txSignature: signature }).service;
  await assert.rejects(changed.submitConfirmation('payment-1', '6'.repeat(64)), /different transaction reference/);
});

test('settlement is impossible without independently verified RPC transaction data', async () => {
  const { service, updates, ledgerEntries } = createPaymentsService();

  await assert.rejects(service.recordConfirmedPayment('payment-1'), /RPC transaction verification/);
  await assert.rejects(new SolanaUsdcProcessor().process({} as any), /exact RPC verification/);
  assert.equal(updates.length, 0);
  assert.equal(ledgerEntries.length, 0);
});
