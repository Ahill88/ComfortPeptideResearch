import { Inject, Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { readSessionCookieToken, type IdentityRequest, type SessionIdentity } from '../wallet/customer-identity';
import { CUSTOMER_AUTH_CLOCK, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_TOUCH_MS, USER_AGENT_MAX, sha256Hex, type AuthClock } from './auth.config';

export interface SessionRequestContext { ip: string | null; userAgent: string | null }

/** Server-side customer sessions (CustomerSession). The cookie holds a random token; only its SHA-256 is stored. */
@Injectable()
export class CustomerSessionService {
  private readonly logger = new Logger('CustomerSession');
  readonly clock: AuthClock;

  constructor(private readonly prisma: PrismaService, @Optional() @Inject(CUSTOMER_AUTH_CLOCK) clock?: AuthClock) {
    this.clock = clock ?? Date.now;
  }

  /** Creates a session and returns the token (shown to the client exactly once, in the cookie). */
  async create(customerId: string, context: SessionRequestContext): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    const expiresAt = new Date(now + SESSION_ABSOLUTE_MS);
    const row = await this.prisma.customerSession.create({
      data: { customerId, tokenHash: sha256Hex(token), createdAt: new Date(now), lastSeenAt: new Date(now), expiresAt, ip: context.ip, userAgent: context.userAgent?.slice(0, USER_AGENT_MAX) ?? null },
    });
    return { token, sessionId: row.id, expiresAt };
  }

  /**
   * The identity for a presented token, or null. Valid = exists, not revoked, inside the absolute lifetime (expiresAt and
   * createdAt + 30 days) and the idle lifetime (lastSeenAt + 7 days). lastSeenAt is refreshed at most once a minute.
   */
  async resolve(token: string): Promise<SessionIdentity | null> {
    const row = await this.prisma.customerSession.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { customer: { select: { id: true, email: true } } } });
    const now = this.clock();
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now || now - row.createdAt.getTime() > SESSION_ABSOLUTE_MS || now - row.lastSeenAt.getTime() > SESSION_IDLE_MS) return null;
    if (now - row.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
      await this.prisma.customerSession.updateMany({ where: { id: row.id, revokedAt: null }, data: { lastSeenAt: new Date(now) } });
    }
    return { customerId: row.customer.id, email: row.customer.email, sessionId: row.id };
  }

  async revoke(sessionId: string, customerId: string): Promise<void> {
    await this.prisma.customerSession.updateMany({ where: { id: sessionId, customerId, revokedAt: null }, data: { revokedAt: new Date(this.clock()) } });
  }

  async revokeByToken(token: string): Promise<void> {
    await this.prisma.customerSession.updateMany({ where: { tokenHash: sha256Hex(token), revokedAt: null }, data: { revokedAt: new Date(this.clock()) } });
  }

  /** Revokes every live session of a customer (password reset). Returns how many were revoked. */
  async revokeAll(customerId: string): Promise<number> {
    const result = await this.prisma.customerSession.updateMany({ where: { customerId, revokedAt: null }, data: { revokedAt: new Date(this.clock()) } });
    return result.count;
  }

  /** Never throws: an unreachable store means "no session" (the request is then treated as anonymous and fails closed where identity is required). */
  async resolveQuietly(token: string): Promise<SessionIdentity | null> {
    try {
      return await this.resolve(token);
    } catch (error) {
      this.logger.warn(`session lookup failed: ${(error as Error).name}`);
      return null;
    }
  }
}

/**
 * Attaches `req.customerSession` when the request carries a valid `hf_session` cookie. It decides nothing else: routes
 * choose to require an identity (resolveRequestIdentity) and that resolver enforces the CSRF Origin rule. Any client-supplied
 * value of the property is discarded first, so it can only ever be set from the session store.
 */
@Injectable()
export class CustomerSessionMiddleware implements NestMiddleware {
  constructor(private readonly sessions: CustomerSessionService) {}

  async use(req: IdentityRequest, _res: unknown, next: (error?: unknown) => void): Promise<void> {
    delete req.customerSession;
    const token = readSessionCookieToken(req.headers);
    if (token) {
      const identity = await this.sessions.resolveQuietly(token);
      if (identity) req.customerSession = identity;
    }
    next();
  }
}
