import {
  ArgumentsHost,
  BadRequestException,
  CallHandler,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { ChainUnavailableError } from './contracts';
import { ChainRejectedError } from './chain/chain-errors';
import { findSecretFields } from './secret-fields';

/** Rejects any request whose JSON body contains secret-looking fields (checked before validation strips unknown keys). */
@Injectable()
export class NoSecretMaterialGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ body?: unknown }>();
    if (findSecretFields(request.body).length > 0) {
      throw new BadRequestException('Private keys, seed phrases and other secrets must never be sent to this service');
    }
    return true;
  }
}

/** Recursively converts bigint to decimal strings so JSON.stringify never throws and no precision is lost. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Date) return value;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonSafe(item)]));
  }
  return value;
}

@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(toJsonSafe));
  }
}

/** Maps chain adapter errors that escape services to HTTP errors. */
@Catch(ChainUnavailableError, ChainRejectedError)
export class ChainErrorFilter implements ExceptionFilter {
  catch(error: ChainUnavailableError | ChainRejectedError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    const exception: HttpException =
      error instanceof ChainUnavailableError
        ? new ServiceUnavailableException('Solana network is unavailable; try again shortly')
        : new BadRequestException('The network rejected the request');
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
