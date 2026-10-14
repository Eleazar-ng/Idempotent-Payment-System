import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * The worker is a plain Nest application context (no HTTP server).
 * Stage 0 only proves it boots with valid config; BullMQ processors, the outbox relay,
 * the stuck-attempt sweeper and reconciliation are added in Stages 5 to 10.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('worker started (no jobs registered yet)');
}

void main();
