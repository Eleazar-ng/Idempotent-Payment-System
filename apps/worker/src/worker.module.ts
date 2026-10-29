import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@app/config';
import type { Env } from '@app/config';
import { DbModule } from '@app/db';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';
import { OUTBOX_LOOP_OPTIONS, OutboxRelayService } from './outbox-relay.service';
import type { OutboxLoopOptions } from './outbox-relay.service';

@Module({
  imports: [AppConfigModule, DbModule],
  controllers: [WorkerController],
  providers: [
    WorkerService,
    {
      provide: OUTBOX_LOOP_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): OutboxLoopOptions => ({
        pollIntervalMs: config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }),
        relay: {
          batchSize: config.get('OUTBOX_BATCH_SIZE', { infer: true }),
          maxAttempts: config.get('OUTBOX_MAX_ATTEMPTS', { infer: true }),
          leaseMs: config.get('OUTBOX_LEASE_MS', { infer: true }),
          deliveryTimeoutMs: config.get('OUTBOX_DELIVERY_TIMEOUT_MS', { infer: true }),
          retry: {
            baseDelayMs: config.get('OUTBOX_RETRY_BASE_MS', { infer: true }),
            maxDelayMs: Math.max(
              config.get('OUTBOX_RETRY_MAX_MS', { infer: true }),
              config.get('OUTBOX_RETRY_BASE_MS', { infer: true }),
            ),
          },
        },
      }),
    },
    OutboxRelayService,
  ],
})
export class WorkerModule {}
