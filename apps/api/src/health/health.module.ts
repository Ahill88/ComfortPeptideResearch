import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * GET /health (liveness) and GET /health/ready (readiness). PrismaService comes from the global PrismaModule.
 *
 * main.ts sets the global prefix "v1", so by default these are served at /v1/health and /v1/health/ready. To also
 * serve them at the unprefixed /health paths that probes usually expect, main.ts must call
 * `app.setGlobalPrefix('v1', { exclude: HEALTH_PREFIX_EXCLUDE })`.
 */
@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}

/** Pass as `exclude` to setGlobalPrefix so the probes are reachable without the version prefix. */
export const HEALTH_PREFIX_EXCLUDE = ['health', 'health/ready'];
