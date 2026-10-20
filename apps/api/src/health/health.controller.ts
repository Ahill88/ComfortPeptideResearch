import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';

/**
 * Unauthenticated probes for load balancers and orchestrators. They are exempt from every throttler bucket (by
 * name, so a new bucket must be added here too): a probe must never be answered 429, and probe traffic must not
 * consume the default per-IP budget of real clients behind the same address. Responses carry no configuration,
 * versions, hostnames or error details.
 */
@ApiTags('health')
@SkipThrottle({ default: true, money: true, auth: true })
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Liveness: the process is up and serving HTTP. Does not touch any dependency.' })
  @ApiOkResponse({ description: '{ "status": "ok" }' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Readiness: PostgreSQL answers SELECT 1 within 2 seconds. Redis is not required.' })
  @ApiOkResponse({ description: '{ "status": "ok" }' })
  @ApiServiceUnavailableResponse({ description: '{ "status": "unavailable" } (the database check failed or timed out).' })
  async ready() {
    if (!(await this.health.isDatabaseReady())) throw new ServiceUnavailableException({ status: 'unavailable' });
    return { status: 'ok' };
  }
}
