import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { buildCorsOptions, parseTrustProxy, shouldEnableDocs } from './http-options';
import { EnvLike } from './runtime';
import { securityHeaders } from './security-headers';

export const JSON_BODY_LIMIT = '100kb';

/**
 * MoonPay's webhook signature covers the exact bytes of the request body, which a parsed-then-re-serialised object
 * cannot reproduce. Requests for this one route are therefore read as an untouched Buffer (req.body) before the JSON
 * parser runs; the JSON parser skips any request whose body was already read. Matching mirrors Express routing
 * (case-insensitive, optional trailing slash) and ignores the global version prefix.
 */
export function isMoonPayWebhookRequest(req: { method?: string; url?: string }): boolean {
  if (req.method !== 'POST') return false;
  const path = (req.url ?? '').split('?')[0].split('#')[0].toLowerCase().replace(/\/+$/, '');
  return path === '/webhooks/moonpay' || path.endsWith('/webhooks/moonpay');
}

/**
 * Applies transport-level hardening to an Express-based Nest app. Business wiring (global prefix, validation
 * pipe) stays in main.ts. Call before app.listen()/app.init(). Returns what it enabled, for logging and tests.
 */
export function configureApp(app: NestExpressApplication, env: EnvLike = process.env): { docs: boolean; trustProxy: ReturnType<typeof parseTrustProxy>['value'] } {
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (trustProxy.error) throw new Error(trustProxy.error);

  app.disable('x-powered-by');
  // Default false: req.ip is the socket peer and X-Forwarded-For is never consulted.
  app.set('trust proxy', trustProxy.value);

  app.use(securityHeaders(env));
  app.useBodyParser('raw', { limit: JSON_BODY_LIMIT, type: isMoonPayWebhookRequest });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: JSON_BODY_LIMIT, extended: false });
  app.enableCors(buildCorsOptions(env));
  app.enableShutdownHooks();

  const docs = shouldEnableDocs(env);
  if (docs) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Helix & Field API').setDescription('Research commerce API').setVersion('1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, document);
  }
  return { docs, trustProxy: trustProxy.value };
}
