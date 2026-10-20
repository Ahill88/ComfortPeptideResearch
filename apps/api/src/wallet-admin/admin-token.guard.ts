import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Fails closed: requests are denied unless ADMIN_API_TOKEN is set (non-empty) in the
 * server environment AND the `x-admin-token` header matches it. The comparison runs over
 * fixed-length SHA-256 digests with timingSafeEqual so neither content nor length leaks
 * through timing. The env var is read per request so rotation needs no restart.
 * Every denial returns the same message to avoid revealing which condition failed.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_API_TOKEN;
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const provided = request?.headers?.[ADMIN_TOKEN_HEADER];

    // Always perform the digest comparison so timing does not depend on which input is missing.
    const expectedDigest = digest(typeof expected === 'string' ? expected : '');
    const providedDigest = digest(typeof provided === 'string' ? provided : '');
    const matches = timingSafeEqual(expectedDigest, providedDigest);

    const configured = typeof expected === 'string' && expected.length > 0;
    const supplied = typeof provided === 'string' && provided.length > 0;
    if (!configured || !supplied || !matches) throw new UnauthorizedException('Admin token required.');
    return true;
  }
}
