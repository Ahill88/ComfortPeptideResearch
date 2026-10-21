import type { INestApplication } from '@nestjs/common';
import { buildCorsOptions } from '../../config/http-options';

/** The same CORS options configureApp applies, so harness requests exercise the real allow-list + credentials setting. */
export function configureAppForTest(app: INestApplication): void {
  app.enableCors(buildCorsOptions(process.env));
}
