// Isolated browser fixture, not an authentication implementation. Never used by the application.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function createFakeAuthApi() {
  const customers = new Map();
  const sessions = new Map();
  const tokens = new Map();
  const mailbox = [];
  const events = [];
  const fixturePassword = 'fixture-password-123';
  let sessionMode = 'normal';
  const view = (c) => ({ id: c.id, email: c.email, name: c.name, emailVerified: c.emailVerified, mfaEnabled: c.mfaEnabled });
  const add = (email, verified = true) => {
    const customer = { id: randomBytes(8).toString('hex'), email, name: 'Fixture researcher', password: fixturePassword, emailVerified: verified, mfaEnabled: false, addresses: [] };
    customers.set(email, customer); return customer;
  };
  const reset = () => { customers.clear(); sessions.clear(); tokens.clear(); mailbox.length = 0; events.length = 0; sessionMode = 'normal'; add('unverified@example.org', false); add('existing@example.org'); };
  reset();
  const issueLink = (customer, purpose) => {
    const token = randomBytes(32).toString('base64url');
    tokens.set(token, { customer, purpose }); mailbox.push({ email: customer.email, purpose, token });
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin === 'http://localhost:3391') { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); }
    res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    if (req.method === 'OPTIONS') return send(204);
    const url = new URL(req.url, 'http://localhost:3390');
    let body = {};
    try { let text = ''; for await (const chunk of req) text += chunk; if (text) body = JSON.parse(text); } catch { return send(400, { message: 'Invalid request.' }); }
    if (url.pathname === '/__qa/reset') { reset(); return send(204); }
    if (url.pathname === '/__qa/mailbox') return send(200, mailbox);
    if (url.pathname === '/__qa/events') return send(200, events);
    if (url.pathname === '/__qa/expire') { sessions.clear(); return send(204); }
    if (url.pathname === '/__qa/session-mode') { sessionMode = body.mode; return send(204); }
    const path = url.pathname.replace(/^\/v1/, '');
    events.push({ path, method: req.method, origin: origin ?? null, identityHeader: req.headers['x-customer-email'] ?? null, cookie: Boolean(req.headers.cookie?.includes('hf_session=')) });
    if (path.startsWith('/auth') && !['GET', 'HEAD'].includes(req.method) && origin !== 'http://localhost:3391') return send(403, { message: 'Origin not allowed.' });
    const cookieToken = /(?:^|;\s*)hf_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const customer = sessions.get(cookieToken);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const okMessage = { message: 'Check your email to verify your account.' };
    if (path === '/auth/register') {
      if (!email || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) return send(400, { message: 'Validation failed.' });
      if (!customers.has(email)) { const c = add(email, false); c.name = body.name ?? null; c.password = body.password; issueLink(c, 'verify'); }
      return send(202, okMessage);
    }
    if (path === '/auth/email-verification/confirm') {
      const link = tokens.get(body.token);
      if (!link || link.purpose !== 'verify') return send(400, { message: 'Invalid or expired link.' });
      tokens.delete(body.token); link.customer.emailVerified = true; return send(204);
    }
    if (path === '/auth/login') {
      const c = customers.get(email);
      if (!c || c.password !== body.password) return send(401, { message: 'Invalid sign-in.' });
      if (!c.emailVerified) return send(403, { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email first.' });
      if (c.mfaEnabled && !body.totp) return send(401, { code: 'MFA_REQUIRED', message: 'Enter your authentication code.' });
      if (c.mfaEnabled && body.totp !== '234567') return send(401, { message: 'Invalid sign-in.' });
      const token = randomBytes(32).toString('base64url'); sessions.delete(cookieToken); sessions.set(token, c);
      return send(200, { customer: view(c) }, { 'Set-Cookie': `hf_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
    }
    if (path === '/auth/logout') { sessions.delete(cookieToken); return send(204, undefined, { 'Set-Cookie': 'hf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }); }
    if (path === '/auth/password-reset/request') {
      const c = customers.get(email); if (c) issueLink(c, 'reset');
      return send(202, { message: 'If an account exists for that email, a reset link is on its way.' });
    }
    if (path === '/auth/password-reset/confirm') {
      const link = tokens.get(body.token);
      if (!link || link.purpose !== 'reset') return send(400, { message: 'Invalid or expired link.' });
      if (typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 256) return send(400, { message: 'Password policy.' });
      tokens.delete(body.token); link.customer.password = body.newPassword;
      for (const [key, c] of sessions) if (c === link.customer) sessions.delete(key);
      return send(204);
    }
    if (path === '/auth/session' && sessionMode === 'down') return send(503, { message: 'internal database stack and private data' });
    if (path === '/auth/session' && sessionMode === 'malformed') return send(200, { customer: { email: 'fake@example.org', verified: true } });
    if (!customer) return send(401, { message: 'Authentication required.' });
    if (path === '/auth/session') return send(200, { customer: view(customer) });
    if (path === '/account/eligibility') return send(200, { status: 'NOT_REQUESTED' });
    if (path === '/auth/profile') { if (req.method === 'PATCH') customer.name = body.name; return send(200, view(customer)); }
    if (path === '/auth/mfa/enroll') {
      if (customer.mfaEnabled) return send(409, { message: 'MFA is already enabled.' });
      const seedBase32 = 'JBSWY3DPEHPK3PXP'; customer.pendingMfa = true;
      return send(201, { seedBase32, otpauthUri: `otpauth://totp/Helix:${encodeURIComponent(customer.email)}?secret=${seedBase32}&issuer=Helix` });
    }
    if (path === '/auth/mfa/enroll/confirm') {
      if (!customer.pendingMfa || body.code !== '123456') return send(400, { message: 'Invalid code.' });
      customer.pendingMfa = false; customer.mfaEnabled = true; return send(204);
    }
    if (path === '/auth/mfa/disable') {
      if (body.password !== customer.password || body.code !== '345678') return send(403, { message: 'Invalid password or code.' });
      customer.mfaEnabled = false; return send(204);
    }
    if (path === '/auth/addresses' && req.method === 'GET') return send(200, { items: customer.addresses });
    if (path === '/auth/addresses' && req.method === 'POST') {
      if (customer.addresses.length >= 20) return send(409, { message: 'Address limit reached.' });
      const address = { ...body, id: randomBytes(8).toString('hex'), isDefault: customer.addresses.length === 0 || body.isDefault === true };
      if (address.isDefault) customer.addresses.forEach((a) => { a.isDefault = false; });
      customer.addresses.push(address); return send(201, address);
    }
    if (path.startsWith('/auth/addresses/')) {
      const id = decodeURIComponent(path.split('/').at(-1));
      const address = customer.addresses.find((a) => a.id === id);
      if (!address) return send(404, { message: 'Address not found.' });
      if (req.method === 'DELETE') {
        customer.addresses = customer.addresses.filter((a) => a.id !== id);
        if (address.isDefault && customer.addresses.length) customer.addresses[0].isDefault = true;
        return send(204);
      }
      const wasDefault = address.isDefault;
      if (body.isDefault) customer.addresses.forEach((a) => { a.isDefault = false; });
      Object.assign(address, body); address.isDefault = body.isDefault === true || wasDefault;
      return send(200, address);
    }
    return send(404, { message: 'Not found.' });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createFakeAuthApi();
  server.listen(3390, '127.0.0.1', () => console.log('Auth browser fixture listening on 3390'));
}
