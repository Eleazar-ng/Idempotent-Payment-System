import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * The worker is a plain Nest application context (no HTTP server).
 * Today it runs the outbox relay (Stage 8). The stuck-attempt sweeper and reconciliation join it in Stage 9.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('worker started (outbox relay running)');
}

void main();
