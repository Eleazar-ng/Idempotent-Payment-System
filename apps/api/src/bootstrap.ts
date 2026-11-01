import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, parseLogLevel } from '@app/observability';
import { ApiModule } from './api.module';

/**
 * Shared Nest application options.
 *
 * `rawBody: true` makes Nest keep the exact bytes of each request on `req.rawBody`.
 * Webhook signatures (Stage 7) must be verified against the raw bytes, never against a
 * re-serialized copy of the parsed JSON, or valid signatures will fail (Module 5).
 * Tests import this constant too, so removing it breaks a test instead of breaking prod.
 */
export const NEST_APP_OPTIONS = { rawBody: true } as const;

export async function createApp(): Promise<NestExpressApplication> {
  const logger = new JsonLogger({ level: parseLogLevel(process.env.LOG_LEVEL), service: 'api' });
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { ...NEST_APP_OPTIONS, logger });
  app.enableShutdownHooks();
  return app;
}
