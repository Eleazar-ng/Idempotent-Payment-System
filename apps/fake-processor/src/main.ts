import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from '@app/config';
import { FakeProcessorModule } from './fake-processor.module';

/**
 * A controllable stand-in for a payment processor (Stripe-style contract): charges with an
 * idempotency window, failure switches, signed webhooks, and a /_control API to drive them.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(FakeProcessorModule, { rawBody: true });
  app.enableShutdownHooks();
  const port = app.get<ConfigService<Env, true>>(ConfigService).get('FAKE_PROCESSOR_PORT');
  await app.listen(port);
  console.log(`fake-processor listening on :${port}`);
}

void main();
