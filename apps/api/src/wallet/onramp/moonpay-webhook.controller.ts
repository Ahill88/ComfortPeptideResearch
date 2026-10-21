import { BadRequestException, Controller, Headers, HttpCode, Inject, Logger, OnModuleInit, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isNonProductionRuntime } from '../../config/runtime';
import { MOONPAY_WEBHOOK_CONFIG, MoonPayWebhookConfig } from './moonpay-webhook.config';
import { MOONPAY_SIGNATURE_HEADER, verifyMoonPaySignature } from './moonpay-webhook.signature';
import { InvalidWebhookPayloadError, MoonPayWebhookService } from './moonpay-webhook.service';

/**
 * Legitimate MoonPay retry bursts (up to 9 attempts per event, plus many concurrent purchases from a few source
 * addresses) must not be throttled into failure, so this route gets a dedicated generous per-client limit instead of
 * the global 120/min "default" bucket. It is not unthrottled: a flood of bad-signature requests is still capped
 * (each costs one HMAC over at most the 100kb body limit, and no JSON parsing or DB access, so rejection stays cheap).
 */
export const MOONPAY_WEBHOOK_THROTTLE = { limit: 600, ttl: 60_000 } as const;

/**
 * POST /v1/webhooks/moonpay. Called by MoonPay, so no identity or admin guard applies; the ONLY authentication is the
 * Moonpay-Signature-V2 HMAC over the exact raw body. configureApp() hands this route's body over as an untouched
 * Buffer (the signature covers raw bytes, not a re-serialised object) and nothing is JSON-parsed before verification.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class MoonPayWebhookController implements OnModuleInit {
  private readonly logger = new Logger(MoonPayWebhookController.name);
  /** Time source in epoch milliseconds (overridable in tests). */
  clock: () => number = () => Date.now();

  constructor(
    private readonly service: MoonPayWebhookService,
    @Inject(MOONPAY_WEBHOOK_CONFIG) private readonly config: MoonPayWebhookConfig,
  ) {}

  onModuleInit() {
    if (!this.config.webhookKey && !isNonProductionRuntime(process.env)) {
      this.logger.warn('MOONPAY_WEBHOOK_KEY is not set: POST /v1/webhooks/moonpay answers 503 and processes nothing, so on-ramp intents will not leave CREATED');
    }
  }

  @Post('moonpay')
  @HttpCode(200)
  @Throttle({ default: { ...MOONPAY_WEBHOOK_THROTTLE } })
  @ApiOperation({ summary: 'MoonPay buy webhook receiver. Authenticated only by the Moonpay-Signature-V2 header. Updates on-ramp intent status and the audit trail; never credits, pays or writes balances.' })
  @ApiResponse({ status: 200, description: 'Acknowledged (processed, duplicate, stale, unknown intent, mismatch for manual review, or an event type that is ignored).' })
  @ApiResponse({ status: 400, description: 'Authentic request whose body is not valid JSON or lacks required BuyTransaction fields.' })
  @ApiResponse({ status: 401, description: 'Missing, malformed, wrong or stale signature. Nothing is processed.' })
  @ApiResponse({ status: 503, description: 'MOONPAY_WEBHOOK_KEY is not configured. Nothing is processed (fail closed).' })
  async receive(@Req() req: { body?: unknown }, @Headers(MOONPAY_SIGNATURE_HEADER) signature: string | undefined) {
    const key = this.config.webhookKey;
    if (!key) throw new ServiceUnavailableException('MoonPay webhooks are not configured');

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verdict = verifyMoonPaySignature({
      header: signature,
      rawBody,
      key,
      nowSeconds: Math.floor(this.clock() / 1000),
      toleranceSeconds: this.config.toleranceSeconds,
    });
    if (!verdict.ok) {
      // One generic 401 for every reason (no oracle). A stale-but-authentic request is logged distinctly: it means a
      // retry arrived after the tolerance window (or clocks drifted) and the event was NOT applied.
      if (verdict.reason === 'stale') {
        this.logger.warn(`MoonPay webhook rejected: authentic signature with a stale timestamp (age ${verdict.ageSeconds}s, tolerance ${this.config.toleranceSeconds}s)`);
      } else {
        this.logger.warn(`MoonPay webhook rejected: ${verdict.reason} signature`);
      }
      throw new UnauthorizedException('Invalid signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Body is not valid JSON');
    }
    try {
      await this.service.handleEvent(payload);
    } catch (error) {
      if (error instanceof InvalidWebhookPayloadError) throw new BadRequestException(error.message);
      throw error;
    }
    return { received: true };
  }
}
