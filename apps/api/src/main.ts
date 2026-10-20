import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './config/configure-app';
import { EnvValidationError, assertValidEnv } from './config/env.validation';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // Imported lazily so an invalid environment is reported as a clean startup error (AppModule's
  // ConfigModule runs the same validateEnv while loading .env).
  const { AppModule } = await import('./app.module');
  // process.env now includes .env values loaded by ConfigModule.
  for (const warning of assertValidEnv(process.env)) logger.warn(warning);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const { docs, trustProxy } = configureApp(app, process.env);
  const port = Number(process.env.PORT?.trim() || 3001);
  await app.listen(port);
  logger.log(`API listening on :${port} (docs ${docs ? 'enabled at /docs' : 'disabled'}, trust proxy ${JSON.stringify(trustProxy)})`);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) console.error(`Refusing to start. ${error.message}`);
  else console.error('Fatal error during startup', error);
  process.exit(1);
});
