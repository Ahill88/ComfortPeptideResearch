import assert from 'node:assert/strict';

// Appended to the original suite. Uses its instrumentation, token scanning, screenshots and a11y detectors.
export async function operationsQa({ check, fake, newContext, login, shot, findOrder, callServerAction, logLen, logSince, contrastOffenders, smallTargets, FAKE, BASE }) {
  await fake('/__control/ops-seed', {});
  const context = await newContext();
  const page = await login(context, 'owner@example.test');
  page.setDefaultTimeout(12000);
  const state = () => fake('/__control/ops-state');
  const stock = async () => (await state()).stock.find((p) => p.productId === 'prd_bpc157');
  const posts = async (since, suffix) => (await logSince(since)).filter((l) => l.method === 'POST' && l.path.endsWith(suffix));
  const stockDetail = async () => { await page.goto('/inventory'); await page.getByRole('button', { name: 'Stock details for BPC157-5MG' }).click(); await page.locator('[data-movement]').first().waitFor(); };
  const refundOrder = await findOrder('priya.raman@example.test');
  const refundPath = `/orders/${refundOrder.id}`;
  const refundPanel = page.locator('section[aria-labelledby="refund-h"]');
  const seedRefund = (body = {}) => fake('/__control/refund-state', { id: refundOrder.id, orderStatus: 'PAID', status: null, network: 'solana-devnet', ...body });
  const requestRefund = async () => { await page.getByLabel('Refund reason', { exact: true }).fill('Customer requested a full refund.'); await page.getByRole('button', { name: 'Review refund', exact: true }).click(); await page.getByRole('button', { name: 'Confirm refund request' }).click(); await page.locator('[data-refund-status]', { hasText: 'REQUESTED' }).waitFor(); };
  const submitRefund = async () => { await page.getByRole('button', { name: 'Review submission' }).click(); await page.getByRole('button', { name: 'Submit refund', exact: true }).click(); };

  await check('operations navigation: owner home and primary links for inventory, compliance and email', async () => {
    for (const href of ['/inventory', '/compliance', '/email']) {
      assert.equal(await page.locator(`nav[aria-label="Primary"] a[href="${href}"]`).count(), 1);
      assert.equal(await page.locator(`main .link-list a[href="${href}"]`).count(), 1);
    }
  });

  await check('inventory: API sellable count is not double-subtracted; SKU/name search, low stock and empty state', async () => {
    await page.goto('/inventory');
    const item = await stock();
    assert.equal(await page.locator('[data-inventory="prd_bpc157"] [data-on-hand]').innerText(), String(item.onHand));
    assert.equal(item.reserved, 7);
    await page.getByLabel('Search SKU or product name').fill('bpc');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.waitForURL(/q=bpc/);
    assert.equal(await page.locator('[data-inventory]').count(), 1);
    await page.goto('/inventory?lowStockOnly=true');
    assert.equal(await page.locator('[data-inventory]').count(), 2);
    await page.goto('/inventory?q=not-a-product');
    await page.getByText('No products match these filters.').waitFor();
    await page.goto('/inventory?q=%25');
    assert.equal(await page.locator('[data-inventory]').count(), 0, 'percent search is literal');
  });

  await check('inventory: list and newest-first ledger paging, no duplicate products or movements', async () => {
    await fake('/__control/bulk-inventory', { n: 35 });
    await page.goto('/inventory');
    assert.equal(await page.locator('[data-inventory]').count(), 25);
    await page.getByRole('button', { name: 'Load more products' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-inventory]').length === 38);
    assert.equal(new Set(await page.locator('[data-inventory]').evaluateAll((e) => e.map((r) => r.dataset.inventory))).size, 38);
    await page.getByRole('button', { name: 'Stock details for BPC157-5MG' }).click();
    await page.locator('[data-movement]').first().waitFor();
    assert.equal(await page.locator('[data-movement]').count(), 50);
    await page.getByRole('button', { name: 'Load more movements' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-movement]').length === 56);
    const dates = await page.locator('[data-movement] time').evaluateAll((e) => e.map((r) => r.dateTime));
    assert.deepEqual(dates, [...dates].sort().reverse());
    await shot(page, '40-inventory-ledger');
  });

  await check('inventory adjustment: signed preview, reason, confirmation, double-click guard, ledger and audit result', async () => {
    const before = (await stock()).onHand;
    await page.getByLabel('Change in units').fill('+5');
    assert.equal(await page.getByRole('button', { name: 'Review adjustment' }).isDisabled(), true, 'reason required');
    await page.getByLabel('Adjustment reason').fill('Cycle count: five additional units.');
    await page.getByRole('button', { name: 'Review adjustment' }).click();
    assert.ok((await page.locator('[aria-label="Confirm stock adjustment"]').innerText()).includes(`${before + 5} sellable`));
    assert.equal((await stock()).onHand, before, 'review writes nothing');
    await shot(page, '41-inventory-confirm');
    await fake('/__control/config', { delayMs: 250 });
    const since = await logLen();
    await page.getByRole('button', { name: 'Confirm adjustment', exact: true }).dblclick();
    await page.locator('.msg-ok', { hasText: 'Adjustment accepted: +5' }).waitFor();
    assert.equal((await stock()).onHand, before + 5);
    assert.equal((await posts(since, '/adjust')).length, 1);
    await page.locator('[data-movement]', { hasText: 'Cycle count: five additional units.' }).waitFor();
    const audit = (await state()).audit.find((a) => a.action === 'inventory.adjust');
    assert.equal(audit.detail.onHandAfter, before + 5);
    assert.ok(await page.getByRole('link', { name: 'View product audit log' }).isVisible());
    await fake('/__control/config', { delayMs: 0 });
    await page.getByLabel('Change in units').fill('-2');
    await page.getByLabel('Adjustment reason').fill('Damaged vials removed.');
    await page.getByRole('button', { name: 'Review adjustment' }).click();
    await page.getByRole('button', { name: 'Confirm adjustment', exact: true }).click();
    await page.locator('.msg-ok', { hasText: 'Adjustment accepted: -2' }).waitFor();
    assert.equal((await stock()).onHand, before + 3);
  });

  await check('inventory: negative result, zero, fraction and excessive delta blocked before any API mutation', async () => {
    const since = await logLen();
    await page.getByLabel('Adjustment reason').fill('Invalid counts should never be sent.');
    for (const value of ['-99999', '0', '1.5', '100001']) {
      await page.getByLabel('Change in units').fill(value);
      assert.equal(await page.getByRole('button', { name: 'Review adjustment' }).isDisabled(), true, value);
    }
    await page.getByLabel('Change in units').fill('-99999');
    await page.getByText('This would make sellable stock negative. Remove fewer units.').waitFor();
    assert.equal((await posts(since, '/adjust')).length, 0);
    await shot(page, '42-inventory-negative');
  });

  await check('inventory: stale preview loses race, API 409 shown, real stock re-read and review invalidated', async () => {
    await page.getByLabel('Change in units').fill('-2');
    await page.getByLabel('Adjustment reason').fill('Concurrent count check.');
    await page.getByRole('button', { name: 'Review adjustment' }).click();
    await fake('/__control/stock', { productId: 'prd_bpc157', onHand: 1 });
    await page.getByRole('button', { name: 'Confirm adjustment', exact: true }).click();
    await page.locator('.msg-error', { hasText: 'The adjustment would take stock below zero.' }).waitFor();
    assert.equal(await page.locator('[data-stock-current]').innerText(), '1 sellable units');
    assert.equal(await page.getByRole('button', { name: 'Confirm adjustment', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Review adjustment' }).isDisabled(), true);
    assert.equal((await stock()).onHand, 1);
  });

  await check('inventory: owner threshold accepts zero, positive and null (clear), audits each change', async () => {
    for (const value of ['0', '5', '']) {
      await page.getByLabel('Threshold (OWNER)').fill(value);
      await page.getByRole('button', { name: 'Save threshold' }).click();
      await page.locator('.msg-ok', { hasText: 'Low-stock threshold updated.' }).waitFor();
      assert.equal((await stock()).lowStockThreshold, value === '' ? null : Number(value));
    }
    assert.equal((await state()).audit.filter((a) => a.action === 'inventory.threshold').length, 3);
  });

  await check('order totals: stored subtotal/shipping/tax in list and detail; legacy total-only without invented breakdown', async () => {
    await page.goto(refundPath);
    const o = await fake(`/__control/order?id=${refundOrder.id}`);
    const panel = page.locator('[aria-labelledby="totals-h"]');
    for (const label of ['Subtotal', 'Shipping', 'Tax', 'Total']) assert.ok((await panel.innerText()).includes(label));
    assert.equal(o.totalCents, o.subtotalCents + o.shippingCents + o.taxCents);
    assert.ok((await panel.innerText()).includes('$8.83'));
    const legacy = await findOrder('chloe.tran@example.test');
    await page.goto(`/orders/${legacy.id}`);
    assert.deepEqual(await panel.locator('dt').allInnerTexts(), ['Total']);
    assert.ok((await panel.innerText()).includes('Legacy order'));
    await page.goto('/orders?tab=all');
    const row = page.locator('tr', { hasText: 'chloe.tran@example.test' });
    assert.ok((await row.innerText()).includes('Legacy: total only'));
    assert.equal(await row.getByText('Shipping', { exact: false }).count(), 0);
  });

  await check('refund: exact allowedActions controls eligibility, reason and full amount reviewed, request only sends reason', async () => {
    await seedRefund({ allowedActions: ['add-note'] }); await page.goto(refundPath);
    assert.equal(await page.getByRole('button', { name: 'Review refund', exact: true }).count(), 0);
    await seedRefund({ allowedActions: ['start-packing', 'refund', 'add-note'] }); await page.reload();
    await page.getByRole('button', { name: 'Review refund', exact: true }).click();
    await page.getByText('Enter a refund reason (1 to 500 characters).').waitFor();
    await page.getByLabel('Refund reason', { exact: true }).fill('Customer requested a full refund.');
    await page.getByRole('button', { name: 'Review refund', exact: true }).click();
    const before = await fake(`/__control/order?id=${refundOrder.id}`);
    assert.equal(before.refund, null);
    assert.ok((await refundPanel.innerText()).includes('$123.83'));
    await shot(page, '43-refund-review');
    const since = await logLen();
    await fake('/__control/config', { delayMs: 200 });
    await page.getByRole('button', { name: 'Confirm refund request' }).dblclick();
    await page.locator('[data-refund-status]', { hasText: 'REQUESTED' }).waitFor();
    const calls = await posts(since, '/refund'); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { reason: 'Customer requested a full refund.' });
    const after = await fake(`/__control/order?id=${refundOrder.id}`);
    assert.equal(after.status, 'PAID');
    assert.equal(after.refund.amountAtomic, String(after.totalCents * 10000));
    assert.deepEqual(Object.keys(after.refund).sort(), ['id', 'status', 'amountAtomic', 'txSignature', 'requestedAt', 'failureReason'].sort());
    await fake('/__control/config', { delayMs: 0 });
  });

  await check('refund: signer unavailable 503 is explicit, request remains REQUESTED and can be submitted later', async () => {
    await fake('/__control/config', { signerAvailable: false });
    await submitRefund();
    await refundPanel.getByText('Refund signing is not available.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-refund-status]').innerText(), 'REQUESTED');
    assert.equal((await fake(`/__control/order?id=${refundOrder.id}`)).refund.txSignature, null);
    await shot(page, '44-refund-signer-503');
    await fake('/__control/config', { signerAvailable: true });
  });

  await check('refund: submit once, pack/ship hidden during SUBMITTED even when allowedActions includes them, safe explorer and bounded polling finalizes', async () => {
    await fake('/__control/config', { delayMs: 200, refundOutcome: 'finalize', refundChecks: 2 });
    const before = (await stock()).onHand;
    const since = await logLen();
    await page.getByRole('button', { name: 'Review submission' }).click();
    await page.getByRole('button', { name: 'Submit refund', exact: true }).dblclick();
    await page.locator('[data-refund-status]', { hasText: 'SUBMITTED' }).waitFor();
    assert.equal((await posts(since, '/refund/submit')).length, 1);
    assert.equal(await page.getByRole('button', { name: 'Start packing', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Mark shipped', exact: true }).count(), 0);
    const r = (await fake(`/__control/order?id=${refundOrder.id}`)).refund;
    const link = refundPanel.getByRole('link', { name: 'View refund on Solana Explorer' });
    assert.equal(await link.getAttribute('href'), `https://explorer.solana.com/tx/${r.txSignature}?cluster=devnet`);
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('[data-testid="refund-poll"]').getAttribute('aria-live'), 'polite');
    await shot(page, '45-refund-submitted');
    await page.locator('[data-refund-status]', { hasText: 'FINALIZED' }).waitFor({ timeout: 25000 });
    assert.equal(await page.locator('.order-head .chip').innerText(), 'Refunded');
    assert.equal((await stock()).onHand, before + 2, 'unshipped reservation released once');
    const verified = await posts(since, '/refund/verify'); assert.equal(verified.length, 2);
    await page.waitForTimeout(5200);
    assert.equal((await posts(since, '/refund/verify')).length, 2, 'polling stops at FINALIZED');
    await shot(page, '46-refund-finalized');
    await fake('/__control/config', { delayMs: 0 });
  });

  await check('refund: FAILED reason shown, no further polling, new request only with API permission', async () => {
    await seedRefund({ status: 'SUBMITTED', allowedActions: ['start-packing', 'add-note'] });
    await fake('/__control/config', { refundOutcome: 'fail', refundChecks: 1 });
    // Let the fake derive the post-failure allowedActions, as the real service does.
    await seedRefund({ status: 'SUBMITTED', allowedActions: null });
    await page.reload();
    await page.getByRole('button', { name: 'Verify refund now' }).click();
    await page.locator('[data-refund-status]', { hasText: 'FAILED' }).waitFor();
    await refundPanel.getByText(/Refund transaction failed on chain/).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Review refund', exact: true }).isVisible());
    const since = await logLen(); await page.waitForTimeout(5200);
    assert.equal((await posts(since, '/refund/verify')).length, 0);
    await shot(page, '47-refund-failed');
    await requestRefund();
  });

  await check('refund: shipped-before-submit conflict reconciles the order and removes submit control', async () => {
    await fake('/__control/transition', { id: refundOrder.id, to: 'SHIPPED' });
    await submitRefund();
    await refundPanel.getByText('Shipped orders cannot be refunded here.', { exact: true }).waitFor();
    assert.equal(await page.locator('.order-head .chip').innerText(), 'Shipped');
    assert.equal(await page.getByRole('button', { name: 'Review submission' }).count(), 0);
  });

  await check('refund: stale packing/shipping requests hit 409 and reconcile to SUBMITTED; both operations blocked by API', async () => {
    await fake('/__control/config', { refundOutcome: 'stuck' });
    for (const [status, action] of [['PAID', 'Start packing'], ['PROCESSING', 'Mark shipped']]) {
      await seedRefund({ orderStatus: status }); await page.reload();
      if (status === 'PROCESSING') { await page.getByRole('button', { name: action, exact: true }).click(); await page.getByLabel('Carrier', { exact: true }).selectOption('UPS'); await page.getByLabel('Tracking number').fill('RACE123456'); await page.getByRole('button', { name: 'Review shipment' }).click(); }
      await seedRefund({ orderStatus: status, status: 'SUBMITTED' });
      await page.getByRole('button', { name: status === 'PAID' ? action : 'Confirm: mark shipped', exact: true }).click();
      await page.locator('[aria-labelledby="actions-h"] .msg-error', { hasText: 'A refund is in progress for this order.' }).waitFor();
      assert.equal(await page.getByRole('button', { name: action, exact: true }).count(), 0);
      assert.equal((await fake(`/__control/order?id=${refundOrder.id}`)).status, status);
    }
  });

  await check('refund: known mainnet link, unknown/absent network and unsafe signature never create an explorer link', async () => {
    for (const [network, signature, want] of [['solana-mainnet', undefined, true], ['solana-unknown', undefined, false], [null, undefined, false], ['solana-devnet', 'javascript:alert(1)', false]]) {
      await seedRefund({ status: 'FINALIZED', orderStatus: 'REFUNDED', network, ...(signature ? { signature } : {}) }); await page.reload();
      const link = refundPanel.getByRole('link', { name: 'View refund on Solana Explorer' });
      assert.equal(await link.count(), want ? 1 : 0);
      if (want) assert.ok(!(await link.getAttribute('href')).includes('?'));
    }
  });

  await check('refund: stuck SUBMITTED stops polling after two minutes; manual verify and resume remain available', async () => {
    await seedRefund({ status: 'SUBMITTED' });
    const clockPage = await context.newPage();
    try {
      await clockPage.clock.install(); await clockPage.goto(refundPath);
      await clockPage.locator('[data-testid="refund-poll"]').waitFor();
      const since = await logLen();
      for (let i = 0; i < 27; i++) { await clockPage.clock.runFor(5000); await clockPage.waitForTimeout(120); if (await clockPage.getByText('Automatic checks stopped.', { exact: false }).count()) break; }
      await clockPage.getByText('Automatic checks stopped.', { exact: false }).waitFor();
      const count = (await posts(since, '/refund/verify')).length;
      assert.ok(count > 0 && count <= 24, `bounded checks: ${count}`);
      await clockPage.clock.runFor(30000); await clockPage.waitForTimeout(250);
      assert.equal((await posts(since, '/refund/verify')).length, count);
      assert.ok(await clockPage.getByRole('button', { name: 'Verify refund now' }).isEnabled());
      assert.ok(await clockPage.getByRole('button', { name: 'Resume automatic checks' }).isEnabled());
      await shot(clockPage, '48-refund-poll-stopped');
    } finally { await clockPage.close(); }
  });

  await check('refund: verify API error is displayed, automatic polling pauses and retry stays available', async () => {
    await fake('/__control/config', { refundVerifyError: true });
    await page.reload();
    await refundPanel.getByText('The admin API reported an error. Try again.', { exact: true }).waitFor({ timeout: 16000 });
    await page.getByRole('button', { name: 'Resume automatic checks' }).waitFor();
    assert.ok(!(await refundPanel.innerText()).includes('RPC unavailable internal text'));
    await fake('/__control/config', { refundVerifyError: false });
    await page.goto('/compliance');
  });

  await check('compliance: source, last run, counts, one-list limitations and OWNER refresh confirmation', async () => {
    assert.ok((await page.locator('main').innerText()).includes('one list: OFAC SDN'));
    assert.ok((await page.locator('main').innerText()).includes('shipping addresses'));
    assert.equal(await page.locator('[data-address-count]').innerText(), '1050');
    await page.getByRole('button', { name: 'Review list refresh' }).click();
    assert.equal((await state()).sanctions.addressCount, 1050);
    await fake('/__control/config', { delayMs: 200 }); const since = await logLen();
    await page.getByRole('button', { name: 'Confirm list refresh', exact: true }).dblclick();
    await page.getByText('Sanctions list refreshed.', { exact: true }).waitFor();
    assert.equal((await posts(since, '/sanctions/refresh')).length, 1);
    assert.equal(await page.locator('[data-address-count]').innerText(), '1051');
    await fake('/__control/config', { delayMs: 0 });
    await shot(page, '49-compliance-status');
  });

  await check('compliance: 503 failure retains stored count and displays last-run error; force explains 50% bypass and is audited', async () => {
    await fake('/__control/config', { sanctionsOutcome: 'shrink' });
    await page.getByRole('button', { name: 'Review list refresh' }).click(); await page.getByRole('button', { name: 'Confirm list refresh', exact: true }).click();
    await page.locator('.msg-error', { hasText: 'shrank implausibly' }).waitFor();
    assert.equal(await page.locator('[data-address-count]').innerText(), '1051');
    assert.ok((await page.locator('dl').innerText()).includes('FAILED'));
    await page.getByLabel('Force refresh: accept a large drop in address count').check();
    await page.getByRole('button', { name: 'Review list refresh' }).click();
    assert.ok((await page.locator('[aria-label="Confirm sanctions refresh"]').innerText()).includes('more than 50%'));
    await shot(page, '50-compliance-force-review');
    await page.getByRole('button', { name: 'Confirm forced refresh', exact: true }).click();
    await page.getByText('Sanctions list refreshed.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-address-count]').innerText(), '400');
    assert.equal((await state()).audit.find((a) => a.action === 'sanctions.refresh').detail.force, true);
    await fake('/__control/config', { sanctionsOutcome: 'empty' });
    await page.getByLabel('Force refresh: accept a large drop in address count').check();
    await page.getByRole('button', { name: 'Review list refresh' }).click(); await page.getByRole('button', { name: 'Confirm forced refresh', exact: true }).click();
    await page.locator('.msg-error', { hasText: 'holds no digital currency addresses' }).waitFor();
    assert.equal(await page.locator('[data-address-count]').innerText(), '400');
    await fake('/__control/config', { sanctionsOutcome: 'ok' });
  });

  await check('compliance: never-loaded and concurrent refresh states are explicit', async () => {
    const previous = (await state()).sanctions;
    await fake('/__control/sanctions-state', { source: previous.source, lastRun: null, addressCount: 0 }); await page.reload();
    await page.getByText('Never loaded: no completed run recorded.').waitFor();
    await fake('/__control/config', { sanctionsOutcome: 'busy' });
    await page.getByRole('button', { name: 'Review list refresh' }).click(); await page.getByRole('button', { name: 'Confirm list refresh', exact: true }).click();
    await page.getByText('A refresh is already running.', { exact: true }).waitFor();
    await fake('/__control/sanctions-state', previous); await fake('/__control/config', { sanctionsOutcome: 'ok' });
  });

  await check('email outbox: domain-only contract, every status, paging and FAILED filter', async () => {
    await page.goto('/email');
    assert.equal(await page.locator('[data-email]').count(), 50);
    const text = await page.locator('table').innerText();
    assert.ok(!text.includes('@') && !text.includes('token='));
    for (const status of ['PENDING', 'SENDING', 'SENT', 'FAILED']) assert.ok(text.includes(status));
    await page.getByRole('button', { name: 'Load more emails' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-email]').length === 57);
    assert.equal(new Set(await page.locator('[data-email]').evaluateAll((e) => e.map((r) => r.dataset.email))).size, 57);
    await page.getByLabel('Delivery status').selectOption('FAILED'); await page.getByRole('button', { name: 'Apply filter' }).click(); await page.waitForURL(/status=FAILED/);
    assert.ok((await page.locator('[data-email] .chip').allInnerTexts()).every((s) => s === 'FAILED'));
    await shot(page, '51-email-failed');
  });

  await check('email: retry failed resets attempts, removes row from FAILED filter, audit and double-click guard', async () => {
    await fake('/__control/config', { delayMs: 200 }); const since = await logLen();
    await page.getByRole('button', { name: 'Retry failed email email_000', exact: true }).dblclick();
    await page.locator('.msg-ok', { hasText: 'Email email_000 re-queued.' }).waitFor();
    assert.equal((await posts(since, '/email_000/retry')).length, 1);
    assert.equal(await page.locator('[data-email="email_000"]').count(), 0);
    const row = (await state()).outbox.find((r) => r.id === 'email_000'); assert.equal(row.status, 'PENDING'); assert.equal(row.attempts, 0); assert.equal(row.lastError, null);
    assert.ok((await state()).audit.some((a) => a.action === 'email.retry' && a.targetId === row.id));
    await fake('/__control/config', { delayMs: 0 });
  });

  await check('email: stale retry returns 409, refreshes filtered rows, sent messages have no retry', async () => {
    await fake('/__control/email-state', { id: 'email_004', status: 'SENT', sentAt: new Date().toISOString() });
    await page.getByRole('button', { name: 'Retry failed email email_004', exact: true }).click();
    await page.getByText('Only failed emails can be retried.', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-email="email_004"]'));
    await page.goto('/email?status=SENT');
    assert.equal(await page.getByRole('button', { name: /Retry failed/ }).count(), 0);
  });

  await check('operations: API errors stay inline, arbitrary 503 bodies private and refresh recovers', async () => {
    await fake('/__control/config', { failInventory: true, failEmail: true });
    await page.goto('/inventory'); await page.getByText('Inventory could not be loaded:', { exact: false }).waitFor();
    assert.ok(!(await page.locator('main').innerText()).includes('Internal database'));
    await page.goto('/email'); await page.getByText('Outbox could not be loaded:', { exact: false }).waitFor();
    assert.ok(!(await page.locator('main').innerText()).includes('Internal provider'));
    await fake('/__control/config', { failInventory: false, failEmail: false });
  });

  await check('STAFF operations: stock adjustment allowed; threshold, refunds, sanctions refresh and email denied in UI/server/API', async () => {
    const staffContext = await newContext();
    try {
      const staff = await login(staffContext, 'staff@example.test');
      assert.equal(await staff.locator('a[href="/email"]').count(), 0);
      await staff.goto('/email'); await staff.getByRole('heading', { name: 'Forbidden' }).waitFor(); assert.equal(await staff.locator('table').count(), 0);
      await staff.goto('/inventory'); await staff.getByRole('button', { name: 'Stock details for BPC157-5MG' }).click();
      assert.equal(await staff.getByLabel('Threshold (OWNER)').isDisabled(), true);
      const hostile = await callServerAction(staff, 'setInventoryThreshold', ['prd_bpc157', 99]); assert.ok(hostile.text.includes('Only an owner can do that.'));
      await staff.getByLabel('Change in units').fill('1'); await staff.getByLabel('Adjustment reason').fill('Staff count correction.');
      await staff.getByRole('button', { name: 'Review adjustment' }).click(); await staff.getByRole('button', { name: 'Confirm adjustment', exact: true }).click(); await staff.locator('.msg-ok', { hasText: 'Adjustment accepted: +1' }).waitFor();
      await staff.goto('/compliance'); assert.equal(await staff.getByRole('button', { name: 'Review list refresh' }).count(), 0);
      assert.ok((await callServerAction(staff, 'refreshSanctions', [true])).text.includes('Only an owner can do that.'));
      await seedRefund(); await staff.goto(refundPath); assert.equal(await staff.getByRole('button', { name: 'Review refund', exact: true }).count(), 0);
      for (const action of ['request', 'submit', 'verify']) assert.ok((await callServerAction(staff, 'runRefundAction', [refundOrder.id, action, 'x'])).text.includes('Only an owner can do that.'));
      // Email actions are in the owner's bundle; replay using STAFF's cookie by borrowing that page's exported references.
      const cookies = await staffContext.cookies();
      const token = cookies.find((c) => /admin_session/.test(c.name)).value;
      const ownerCookies = await context.cookies();
      await page.goto('/email'); await context.addCookies(cookies);
      for (const [name, args] of [['listEmailOutbox', ['', '']], ['retryEmail', ['email_008']]]) assert.ok((await callServerAction(page, name, args)).text.includes('Only an owner can do that.'));
      await context.addCookies(ownerCookies);
      for (const [path, method, body] of [['/inventory/prd_bpc157/threshold', 'POST', { lowStockThreshold: 1 }], [`/orders/${refundOrder.id}/refund`, 'POST', { reason: 'x' }], [`/orders/${refundOrder.id}/refund/submit`, 'POST', {}], [`/orders/${refundOrder.id}/refund/verify`, 'POST', {}], ['/compliance/sanctions/refresh', 'POST', {}], ['/email/outbox', 'GET'], ['/email/outbox/email_008/retry', 'POST', {}]]) {
        const r = await fetch(`${FAKE}/v1/admin${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.equal(r.status, 403, path);
      }
      await shot(staff, '52-staff-refund');
    } finally { await staffContext.close(); }
  });

  await check('operations: forged-origin adjustment is refused; malformed/unknown API requests give 400/404 and no session gives 401', async () => {
    await stockDetail();
    const before = (await stock()).onHand;
    const hostile = await callServerAction(page, 'adjustInventory', ['prd_bpc157', 'BPC157-5MG', 1, 'x'], { origin: 'http://evil.example' });
    assert.ok(!hostile.text.includes('"ok":true')); assert.equal((await stock()).onHand, before);
    const token = (await context.cookies()).find((c) => /admin_session/.test(c.name)).value;
    for (const [path, method, body, code] of [['/inventory?cursor=bad', 'GET', null, 400], ['/inventory?limit=101', 'GET', null, 400], ['/inventory/no-such/ledger', 'GET', null, 404], ['/email/outbox?status=BOGUS', 'GET', null, 400], ['/email/outbox?cursor=bad', 'GET', null, 400], ['/email/outbox/no-such/retry', 'POST', {}, 404], [`/orders/${refundOrder.id}/refund`, 'POST', { reason: 'x', amountAtomic: '1' }, 400]]) {
      const r = await fetch(`${FAKE}/v1/admin${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.equal(r.status, code, path);
    }
    for (const path of ['/inventory', '/compliance/sanctions', '/email/outbox']) assert.equal((await fetch(`${FAKE}/v1/admin${path}`)).status, 401);
  });

  await check('operations accessibility: desktop/mobile no overflow, 44px controls, contrast and live result regions', async () => {
    const mobile = await newContext({ width: 390, height: 844 });
    try {
      const phone = await login(mobile, 'owner@example.test');
      for (const browserPage of [page, phone]) {
        for (const path of ['/inventory', '/compliance', '/email', refundPath]) {
          await browserPage.goto(path);
          if (path === '/inventory') { await browserPage.getByRole('button', { name: 'Stock details for BPC157-5MG' }).click(); await browserPage.getByLabel('Change in units').fill('2'); await browserPage.getByLabel('Adjustment reason').fill('Accessibility review.'); await browserPage.getByRole('button', { name: 'Review adjustment' }).click(); }
          if (path === '/compliance') { await browserPage.getByLabel('Force refresh: accept a large drop in address count').check(); await browserPage.getByRole('button', { name: 'Review list refresh' }).click(); }
          if (path === refundPath) { await browserPage.getByLabel('Refund reason', { exact: true }).fill('Accessibility review.'); await browserPage.getByRole('button', { name: 'Review refund', exact: true }).click(); }
          assert.ok(await browserPage.locator('[aria-live="polite"]').count());
          assert.deepEqual(await smallTargets(browserPage), [], `targets ${path}`);
          assert.deepEqual(await contrastOffenders(browserPage), [], `contrast ${path}`);
          assert.ok((await browserPage.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, `overflow ${path}`);
          if (browserPage === phone) await shot(phone, `53-mobile-${path === refundPath ? 'refund' : path.slice(1)}`, false);
        }
      }
    } finally { await mobile.close(); }
  });

  await check('operations: session expires during adjustment confirmation; action clears cookie and redirects without mutation', async () => {
    await stockDetail(); const before = (await stock()).onHand;
    await page.getByLabel('Change in units').fill('1'); await page.getByLabel('Adjustment reason').fill('Expired confirmation.'); await page.getByRole('button', { name: 'Review adjustment' }).click();
    await fake('/__control/expire-sessions', {});
    await page.getByRole('button', { name: 'Confirm adjustment', exact: true }).click();
    await page.waitForURL(/\/sign-in\?reason=expired/);
    assert.equal((await stock()).onHand, before);
    assert.equal((await context.cookies()).filter((c) => /admin_session/.test(c.name)).length, 0);
  });
  await context.close();
  void BASE;
}
