import { UnauthorizedException } from '@nestjs/common';
import { type IdentityRequest, resolveRequestIdentity } from '../wallet/customer-identity';
import type { OrderIdentity } from './orders.service';

/**
 * The optional identity for POST /v1/orders, from the ONE shared resolver (wallet/customer-identity). No identity is not an
 * error here: development/test still accept an anonymous body email, and OrdersService answers 401 for an order without an
 * identity in every production-like runtime. Everything else the resolver throws (for example 403 for a session cookie on a
 * state-changing request without an allow-listed Origin) is deliberately NOT swallowed.
 */
export function resolveOrderIdentity(req: IdentityRequest | undefined): OrderIdentity | null {
  try {
    const identity = resolveRequestIdentity(req);
    return identity.source === 'session' ? { email: identity.email, customerId: identity.customerId } : { email: identity.email };
  } catch (error) {
    if (error instanceof UnauthorizedException) return null;
    throw error;
  }
}
