import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JsonLogger, parseLogLevel } from '@app/observability';
import { WorkerModule } from './worker.module';

/**
 * The worker is a plain Nest application context (no HTTP server).
 * Today it runs the outbox relay (Stage 8). The stuck-attempt sweeper and reconciliation join it in Stage 9.
 */
async function main(): Promise<void> {
  const logger = new JsonLogger({ level: parseLogLevel(process.env.LOG_LEVEL), service: 'worker' });
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger });
  app.enableShutdownHooks();
  new Logger('main').log('worker started (outbox relay, recovery sweeper, reconciler)');
}

void main();
