#!/usr/bin/env node
// FAKE admin API for exercising apps/admin without the real API. In-memory, plain node:http, no dependencies.
// It implements the fixed admin contract (auth, users, audit, orders) under /v1, plus test-only control endpoints
// under /__control that let a browser check toggle behaviour (session expiry, unconfigured sign-in, other-admin
// transitions that provoke a 409, API failures). It is NOT the real API and proves nothing about it.
//
//   PORT=3190 node tests/admin-ui/fake-admin-api.mjs
//   Accepts owner@example.test or staff@example.test / password 'correct horse battery' / totp '123456'.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 3190);
const WALLET_TOKEN = process.env.FAKE_WALLET_TOKEN || 'fake-wallet-token';
const PASSWORD = 'correct horse battery';
const TOTP = '123456';
const SESSION_MS = 8 * 3600_000;

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

// ---------------------------------------------------------------- state
let admins, tokens, audit, orders, config, requestLog, seq;

function reset() {
  seq = 1000;
  admins = [
    { id: 'adm_owner_01', email: 'owner@example.test', name: 'Olivia Owner', role: 'OWNER', active: true, lastLoginAt: ago(600), createdAt: ago(60 * 24 * 60), password: PASSWORD },
    { id: 'adm_staff_01', email: 'staff@example.test', name: 'Sam Staff', role: 'STAFF', active: true, lastLoginAt: ago(1500), createdAt: ago(60 * 24 * 30), password: PASSWORD },
    { id: 'adm_staff_02', email: 'former@example.test', name: 'Frankie Former', role: 'STAFF', active: false, lastLoginAt: ago(60 * 24 * 9), createdAt: ago(60 * 24 * 40), password: PASSWORD },
  ];
  tokens = new Map();
  audit = [
    { adminEmail: 'owner@example.test', action: 'admin.create', targetType: 'AdminUser', targetId: 'adm_staff_01', detail: { role: 'STAFF' }, ip: '203.0.113.10', createdAt: ago(60 * 24 * 30) },
    { adminEmail: 'staff@example.test', action: 'order.start-packing', targetType: 'Order', targetId: 'cmoa1x9k0004fk2c7d9e0f00004', detail: { from: 'PAID', to: 'PROCESSING' }, ip: '203.0.113.22', createdAt: ago(190) },
    { adminEmail: null, action: 'auth.login.failed', targetType: 'AdminUser', targetId: 'unknown', detail: { reason: 'invalid' }, ip: '198.51.100.7', createdAt: ago(75) },
  ].map((row, i) => ({ id: `aud_seed_${i}`, ...row }));
  config = { unconfigured: false, failOrders: false, delayMs: 0 };
  requestLog = [];
  orders = buildOrders();
}

const ITEM = {
  bpc: { productId: 'prd_bpc157', sku: 'BPC157-5MG', name: 'BPC-157 5 mg vial', unitCents: 4900 },
  tb: { productId: 'prd_tb500', sku: 'TB500-10MG', name: 'TB-500 10 mg vial', unitCents: 7900 },
  ghk: { productId: 'prd_ghkcu', sku: 'GHKCU-50MG', name: 'GHK-Cu 50 mg vial', unitCents: 5400 },
  bac: { productId: 'prd_bacw30', sku: 'BACW-30ML', name: 'BAC Water 30 ml', unitCents: 900 },
};
const LOTS = { bpc: 'L24-0917-A', tb: 'L24-1002-C', ghk: 'L24-0821-B', bac: 'W24-0610-01' };

// Solana-like base58 signature (88 chars) built deterministically.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = (n) => Array.from({ length: 88 }, (_, i) => B58[(n * 7 + i * 13 + (i % 5) * n) % B58.length]).join('');

function makeOrder(n, cfg) {
  const id = `cmoa1x9k${String(n).padStart(4, '0')}fk2c7d9e0f${String(n).padStart(5, '0')}`;
  const items = cfg.items.map(([key, quantity], i) => ({ id: `${id}_i${i}`, ...ITEM[key], lotCode: cfg.noLot === key ? null : LOTS[key], quantity }));
  const totalCents = items.reduce((s, it) => s + it.unitCents * it.quantity, 0) + (cfg.shippingCents ?? 0);
  const events = [{ id: `${id}_e0`, kind: 'STATUS', fromStatus: null, toStatus: 'PENDING_PAYMENT', note: null, adminName: null, createdAt: ago(cfg.ageMin + 12) }];
  const order = {
    id, status: 'PENDING_PAYMENT', totalCents, currency: 'USD', createdAt: ago(cfg.ageMin + 12),
    customer: { id: `cus_${n}`, email: cfg.email, name: cfg.name ?? null },
    itemCount: items.reduce((s, it) => s + it.quantity, 0),
    hasShipment: false, trackingNumber: null,
    shippingAddress: cfg.address ?? null, items,
    payment: cfg.status === 'PENDING_PAYMENT' || cfg.status === 'CANCELLED'
      ? { status: cfg.status === 'CANCELLED' ? 'EXPIRED' : 'AWAITING_SIGNATURE', amountAtomic: String(totalCents * 10000), txSignature: null, network: 'solana-devnet', finalizedAt: null }
      : { status: 'FINALIZED', amountAtomic: String(totalCents * 10000 + (n % 7)), txSignature: sig(n), network: cfg.network ?? 'solana-devnet', finalizedAt: ago(cfg.ageMin) },
    shipments: [], events,
  };
  const push = (to, minutes, note = null, admin = null) => {
    events.push({ id: `${id}_e${events.length}`, kind: 'STATUS', fromStatus: order.status, toStatus: to, note, adminName: admin, createdAt: ago(minutes) });
    order.status = to;
  };
  const path = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
  if (cfg.status === 'CANCELLED') push('CANCELLED', cfg.ageMin, 'Customer did not pay within the window.', 'Olivia Owner');
  else if (cfg.status === 'REFUNDED') { push('PAID', cfg.ageMin + 6); push('REFUNDED', Math.max(cfg.ageMin - 30, 1), 'Refunded at customer request.', 'Olivia Owner'); }
  else for (const s of path.slice(0, path.indexOf(cfg.status) + 1)) push(s, cfg.ageMin - path.indexOf(s) * 20, null, s === 'PAID' ? null : 'Sam Staff');
  if (['SHIPPED', 'DELIVERED'].includes(cfg.status)) {
    order.shipments.push({ id: `${id}_s0`, carrier: cfg.carrier ?? 'USPS', trackingNumber: cfg.tracking, shippedAt: ago(cfg.ageMin - 40), deliveredAt: cfg.status === 'DELIVERED' ? ago(Math.max(cfg.ageMin - 90, 1)) : null, note: null });
    order.hasShipment = true; order.trackingNumber = cfg.tracking;
  }
  if (cfg.note) events.push({ id: `${id}_en`, kind: 'NOTE', fromStatus: null, toStatus: null, note: cfg.note, adminName: 'Sam Staff', createdAt: ago(Math.max(cfg.ageMin - 5, 1)) });
  order.createdAt = events[0].createdAt;
  return order;
}

function buildOrders() {
  return [
    makeOrder(4, { status: 'PAID', ageMin: 14, email: 'priya.raman@example.test', name: 'Priya Raman', items: [['bpc', 2], ['bac', 1]], shippingCents: 800,
      address: 'Priya Raman\nBuilding C, Unit 4120, Riverbend Commons at Old Mill Crossing\n18450 North Meridian Parkway, Suite 220 (rear loading entrance)\nSouth Bend Heights, IN 46601\nUnited States' }),
    makeOrder(5, { status: 'PAID', ageMin: 55, email: 'marcus.albrecht@example.test', name: 'Marcus Albrecht-Vandenberg', items: [['tb', 1], ['ghk', 1], ['bpc', 1]], shippingCents: 2500,
      address: 'Marcus Albrecht-Vandenberg\nc/o Institut fuer Angewandte Laboratoriumsforschung, Abteilung Wareneingang\nHinter der Kleinen Mühlenstraße 117–121, Gebäude 7B, 3. Obergeschoss, Raum 3.14\n80331 München\nGermany\nTel. for courier: +49 89 5550 0147', note: 'Customer asked for signature on delivery.' }),
    makeOrder(6, { status: 'PAID', ageMin: 130, email: 'chloe.tran@example.test', name: null, items: [['ghk', 1]], shippingCents: 600, address: null }),
    makeOrder(7, { status: 'PROCESSING', ageMin: 210, email: 'dev.patel@example.test', name: 'Dev Patel', items: [['bpc', 1], ['tb', 1]], shippingCents: 800, noLot: 'tb',
      address: 'Dev Patel\n2210 Harbor View Terrace, Apt 9F\nSeattle, WA 98101\nUnited States' }),
    makeOrder(8, { status: 'PROCESSING', ageMin: 300, email: 'lena.fischer@example.test', name: 'Lena Fischer', items: [['bac', 3], ['bpc', 2]], shippingCents: 800,
      address: 'Lena Fischer\n77 Quarry Lane\nBurlington, VT 05401\nUnited States' }),
    makeOrder(9, { status: 'SHIPPED', ageMin: 1500, email: 'tomas.novak@example.test', name: 'Tomas Novak', items: [['tb', 2]], shippingCents: 800, carrier: 'UPS', tracking: '1Z999AA10123456784', network: 'solana-mainnet-beta',
      address: 'Tomas Novak\n501 Elm Street\nAustin, TX 78701\nUnited States' }),
    makeOrder(10, { status: 'DELIVERED', ageMin: 4000, email: 'grace.okoye@example.test', name: 'Grace Okoye', items: [['ghk', 2], ['bac', 1]], shippingCents: 800, carrier: 'FedEx', tracking: '794644790138',
      address: 'Grace Okoye\n9 Cedar Court\nPortland, OR 97201\nUnited States' }),
    makeOrder(11, { status: 'PENDING_PAYMENT', ageMin: 8, email: 'ines.moreau@example.test', name: 'Ines Moreau', items: [['bpc', 1]], shippingCents: 800,
      address: 'Ines Moreau\n12 Rue des Lilas\n69003 Lyon\nFrance' }),
    makeOrder(12, { status: 'CANCELLED', ageMin: 2800, email: 'omar.haddad@example.test', name: 'Omar Haddad', items: [['tb', 1]], shippingCents: 800,
      address: 'Omar Haddad\n40 Willow Way\nDenver, CO 80202\nUnited States' }),
    makeOrder(13, { status: 'REFUNDED', ageMin: 6000, email: 'sofia.rossi@example.test', name: 'Sofia Rossi', items: [['bpc', 1]], shippingCents: 800,
      address: 'Sofia Rossi\n3 Harbour Road\nBoston, MA 02110\nUnited States' }),
  ];
}

function bulk(n) {
  for (let i = 0; i < n; i += 1) {
    orders.push(makeOrder(100 + i, { status: 'PAID', ageMin: 400 + i * 7, email: `bulk${i}@example.test`, name: `Bulk Customer ${i}`, items: [['bpc', 1 + (i % 3)]], shippingCents: 800, address: `Bulk Customer ${i}\n${i + 1} Test Avenue\nTestville, TX 73301\nUnited States` }));
  }
}

reset();

// ---------------------------------------------------------------- helpers
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const empty = (res, status = 204) => { res.writeHead(status); res.end(); };
const sorted = () => [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100_000) throw new Error('too large'); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function authenticate(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const record = tokens.get(match[1]);
  if (!record || record.expired || record.expiresAt <= Date.now()) return null;
  const admin = admins.find((a) => a.id === record.adminId);
  if (!admin || !admin.active) return null;
  return { token: match[1], record, admin };
}

function addAudit(adminEmail, action, targetType, targetId, detail, req) {
  audit.unshift({ id: `aud_${++seq}`, adminEmail, action, targetType, targetId, detail, ip: req.socket.remoteAddress?.replace('::ffff:', '') ?? null, createdAt: new Date().toISOString() });
}

const publicAdmin = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role });
const userRow = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt });

function allowedActions(order) {
  const map = { PENDING_PAYMENT: ['cancel'], PAID: ['start-packing'], PROCESSING: ['ship'], SHIPPED: ['mark-delivered'], DELIVERED: [], CANCELLED: [], REFUNDED: [] };
  return [...map[order.status], 'add-note'];
}
const detail = (o) => ({ ...o, allowedActions: allowedActions(o) });
const summary = (o) => ({ id: o.id, status: o.status, totalCents: o.totalCents, currency: o.currency, createdAt: o.createdAt, customer: o.customer, itemCount: o.itemCount, hasShipment: o.hasShipment, trackingNumber: o.trackingNumber });

function transition(order, to, admin, note = null) {
  order.events.push({ id: `${order.id}_e${order.events.length}_${++seq}`, kind: 'STATUS', fromStatus: order.status, toStatus: to, note, adminName: admin?.name ?? null, createdAt: new Date().toISOString() });
  order.status = to;
}

function page(items, url, limitDefault = 25) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || limitDefault, 1), 100);
  const cursor = url.searchParams.get('cursor');
  let start = 0;
  if (cursor) { const n = Number(Buffer.from(cursor, 'base64url').toString()); start = Number.isInteger(n) && n >= 0 ? n : 0; }
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { items: slice, nextCursor: next };
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const url = new URL(req.url, 'http://fake');
  const path = url.pathname;
  const method = req.method;

  // Test-only controls (no auth; this server is only ever bound to loopback).
  if (path.startsWith('/__control/')) {
    const body = method === 'POST' ? (await readBody(req)) ?? {} : {};
    if (path === '/__control/reset') { reset(); return json(res, 200, { ok: true }); }
    if (path === '/__control/expire-sessions') { for (const t of tokens.values()) t.expired = true; return json(res, 200, { ok: true, expired: tokens.size }); }
    if (path === '/__control/config') { Object.assign(config, body); return json(res, 200, config); }
    if (path === '/__control/bulk') { bulk(Number(body.n) || 40); return json(res, 200, { ok: true, total: orders.length }); }
    if (path === '/__control/tokens') return json(res, 200, { tokens: [...tokens.keys()] });
    if (path === '/__control/log') return json(res, 200, { log: requestLog });
    if (path === '/__control/order') return json(res, 200, orders.find((o) => o.id === url.searchParams.get('id')) ?? null);
    if (path === '/__control/orders') return json(res, 200, { orders: sorted().map((o) => ({ id: o.id, status: o.status, email: o.customer.email })) });
    if (path === '/__control/transition') {
      // Simulates ANOTHER admin moving an order, so a stale screen gets a 409 when it acts.
      const order = orders.find((o) => o.id === body.id);
      if (!order || !body.to) return json(res, 404, { message: 'no such order' });
      transition(order, body.to, { name: 'Other Admin' });
      if (body.to === 'SHIPPED') { order.hasShipment = true; order.trackingNumber = 'OTHER123456'; order.shipments.push({ id: `${order.id}_so`, carrier: 'USPS', trackingNumber: 'OTHER123456', shippedAt: new Date().toISOString(), deliveredAt: null, note: null }); }
      return json(res, 200, detail(order));
    }
    return json(res, 404, { message: 'unknown control endpoint' });
  }

  const finish = (status, authKind) => requestLog.push({ method, path: path + url.search, status, auth: authKind, at: new Date().toISOString() });
  const authKind = req.headers.authorization ? 'bearer' : req.headers['x-admin-token'] ? 'x-admin-token' : 'none';
  res.on('finish', () => finish(res.statusCode, authKind));

  if (!path.startsWith('/v1/')) return json(res, 404, { message: 'Not found' });
  const route = path.slice(3);

  // Existing wallet endpoints (token-based, unchanged by the admin session work): just enough to see the gate work.
  if (route.startsWith('/admin/wallets/')) {
    if (req.headers['x-admin-token'] !== WALLET_TOKEN) return json(res, 401, { message: 'Unauthorized' });
    if (route === '/admin/wallets/directory') {
      return json(res, 200, { items: [{ id: 'wal_1', email: 'priya.raman@example.test', address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', provider: 'PHANTOM', network: 'solana-devnet', createdAt: ago(900) }], nextCursor: null });
    }
    return json(res, 200, { items: [], nextCursor: null });
  }

  // ---- auth
  if (route === '/admin/auth/login' && method === 'POST') {
    if (config.unconfigured) return json(res, 503, { message: 'Admin sign-in is not configured.' });
    const body = await readBody(req);
    const admin = body && admins.find((a) => a.email === String(body.email).toLowerCase());
    if (!admin || !admin.active || admin.password !== body.password || body.totp !== TOTP) {
      addAudit(admin?.email ?? null, 'auth.login.failed', 'AdminUser', admin?.id ?? 'unknown', { reason: 'invalid' }, req);
      return json(res, 401, { message: 'Invalid sign-in.' });
    }
    const token = `fake_${randomBytes(24).toString('hex')}`;
    const expiresAt = Date.now() + SESSION_MS;
    tokens.set(token, { adminId: admin.id, expiresAt, expired: false });
    admin.lastLoginAt = new Date().toISOString();
    addAudit(admin.email, 'auth.login', 'AdminUser', admin.id, null, req);
    return json(res, 200, { token, expiresAt: new Date(expiresAt).toISOString(), admin: publicAdmin(admin) });
  }

  const auth = authenticate(req);
  if (!auth) return json(res, 401, { message: 'Unauthorized' });
  const { admin } = auth;

  if (route === '/admin/auth/me' && method === 'GET') {
    return json(res, 200, { admin: publicAdmin(admin), session: { expiresAt: new Date(auth.record.expiresAt).toISOString(), idleTimeoutSeconds: 1800 } });
  }
  if (route === '/admin/auth/logout' && method === 'POST') { auth.record.expired = true; addAudit(admin.email, 'auth.logout', 'AdminUser', admin.id, null, req); return empty(res); }
  if (route === '/admin/auth/change-password' && method === 'POST') {
    const body = await readBody(req);
    if (!body || body.currentPassword !== admin.password) return json(res, 400, { message: 'Current password is incorrect.' });
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 12) return json(res, 400, { message: 'New password must be at least 12 characters.' });
    admin.password = body.newPassword;
    addAudit(admin.email, 'auth.change-password', 'AdminUser', admin.id, null, req);
    return empty(res);
  }

  // ---- owner only
  const ownerOnly = route.startsWith('/admin/users') || route.startsWith('/admin/audit');
  if (ownerOnly && admin.role !== 'OWNER') return json(res, 403, { message: 'Forbidden: owner role required.' });

  if (route === '/admin/users' && method === 'GET') return json(res, 200, { items: admins.map(userRow) });
  if (route === '/admin/users' && method === 'POST') {
    const body = await readBody(req);
    if (!body?.email || !body?.name || !['OWNER', 'STAFF'].includes(body.role)) return json(res, 400, { message: 'email, name and role are required.' });
    if (admins.some((a) => a.email === String(body.email).toLowerCase())) return json(res, 409, { message: 'An admin with that email already exists.' });
    const temporaryPassword = randomBytes(12).toString('base64url');
    const seed = Array.from(randomBytes(20)).map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('');
    const created = { id: `adm_${++seq}`, email: String(body.email).toLowerCase(), name: String(body.name), role: body.role, active: true, lastLoginAt: null, createdAt: new Date().toISOString(), password: temporaryPassword };
    admins.push(created);
    addAudit(admin.email, 'admin.create', 'AdminUser', created.id, { role: created.role }, req);
    return json(res, 201, { admin: userRow(created), temporaryPassword, mfa: { otpauthUri: `otpauth://totp/Helix%20%26%20Field:${encodeURIComponent(created.email)}?secret=${seed}&issuer=Helix%20%26%20Field`, seedBase32: seed } });
  }
  let m = /^\/admin\/users\/([^/]+)\/deactivate$/.exec(route);
  if (m && method === 'POST') {
    const target = admins.find((a) => a.id === m[1]);
    if (!target) return json(res, 404, { message: 'Admin not found.' });
    if (target.id === admin.id) return json(res, 409, { message: 'You cannot deactivate yourself.' });
    if (target.role === 'OWNER' && admins.filter((a) => a.role === 'OWNER' && a.active).length <= 1) return json(res, 409, { message: 'At least one active owner is required.' });
    target.active = false;
    for (const t of tokens.values()) if (t.adminId === target.id) t.expired = true;
    addAudit(admin.email, 'admin.deactivate', 'AdminUser', target.id, null, req);
    return empty(res);
  }
  if (route === '/admin/audit' && method === 'GET') {
    const tt = url.searchParams.get('targetType');
    const ti = url.searchParams.get('targetId');
    const rows = audit.filter((r) => (!tt || r.targetType === tt) && (!ti || r.targetId === ti));
    return json(res, 200, page(rows, url, 50));
  }

  // ---- orders
  if (route.startsWith('/admin/orders')) {
    if (config.failOrders) return json(res, 500, { message: 'TypeError: Cannot read properties of undefined\n    at OrdersService.list (/srv/api/dist/orders.js:41:13)' });
    if (route === '/admin/orders/counts' && method === 'GET') {
      const counts = { PENDING_PAYMENT: 0, PAID: 0, PROCESSING: 0, SHIPPED: 0, DELIVERED: 0, CANCELLED: 0, REFUNDED: 0 };
      for (const o of orders) counts[o.status] += 1;
      return json(res, 200, { counts });
    }
    if (route === '/admin/orders' && method === 'GET') {
      const statuses = (url.searchParams.get('status') || '').split(',').filter(Boolean);
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const rows = sorted().filter((o) => (!statuses.length || statuses.includes(o.status)) && (!q || o.id.toLowerCase().includes(q) || o.customer.email.toLowerCase().includes(q)));
      const p = page(rows, url, 25);
      return json(res, 200, { items: p.items.map(summary), nextCursor: p.nextCursor });
    }
    m = /^\/admin\/orders\/([^/]+)(?:\/([a-z-]+))?$/.exec(route);
    if (m) {
      const order = orders.find((o) => o.id === m[1]);
      if (!order) return json(res, 404, { message: 'Order not found.' });
      if (!m[2] && method === 'GET') return json(res, 200, detail(order));
      if (m[2] && method === 'POST') {
        if (config.delayMs) await new Promise((r) => setTimeout(r, config.delayMs));
        const body = await readBody(req);
        if (body === null) return json(res, 400, { message: 'Malformed JSON.' });
        const a = m[2];
        const need = { 'start-packing': 'PAID', ship: 'PROCESSING', 'mark-delivered': 'SHIPPED', cancel: 'PENDING_PAYMENT' };
        if (a === 'notes') {
          if (typeof body.note !== 'string' || !body.note.trim()) return json(res, 400, { message: 'note is required.' });
          order.events.push({ id: `${order.id}_n${++seq}`, kind: 'NOTE', fromStatus: null, toStatus: null, note: body.note.trim(), adminName: admin.name, createdAt: new Date().toISOString() });
          addAudit(admin.email, 'order.note', 'Order', order.id, null, req);
          return json(res, 200, detail(order));
        }
        if (!need[a]) return json(res, 404, { message: 'Unknown action.' });
        if (order.status !== need[a]) return json(res, 409, { message: `Order is ${order.status}; ${a} requires ${need[a]}.` });
        if (a === 'ship') {
          if (!['USPS', 'UPS', 'FedEx', 'DHL', 'OTHER'].includes(body.carrier)) return json(res, 400, { message: 'carrier must be one of USPS, UPS, FedEx, DHL, OTHER.' });
          if (typeof body.trackingNumber !== 'string' || body.trackingNumber.length < 6) return json(res, 400, { message: 'trackingNumber is required.' });
          order.shipments.push({ id: `${order.id}_s${++seq}`, carrier: body.carrier, trackingNumber: body.trackingNumber, shippedAt: new Date().toISOString(), deliveredAt: null, note: body.note ?? null });
          order.hasShipment = true; order.trackingNumber = body.trackingNumber;
          transition(order, 'SHIPPED', admin, body.note ?? null);
        } else if (a === 'mark-delivered') {
          for (const s of order.shipments) s.deliveredAt ??= new Date().toISOString();
          transition(order, 'DELIVERED', admin);
        } else if (a === 'cancel') {
          if (typeof body.reason !== 'string' || !body.reason.trim()) return json(res, 400, { message: 'reason is required.' });
          transition(order, 'CANCELLED', admin, body.reason.trim());
        } else transition(order, 'PROCESSING', admin);
        addAudit(admin.email, `order.${a}`, 'Order', order.id, { status: order.status }, req);
        return json(res, 200, detail(order));
      }
    }
  }
  return json(res, 404, { message: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('fake api error:', error.message);
    if (!res.headersSent) json(res, 500, { message: 'fake api failure' });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake admin API listening on http://127.0.0.1:${PORT}/v1`));
