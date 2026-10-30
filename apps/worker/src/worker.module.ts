import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@app/config';
import type { Env } from '@app/config';
import { DbModule } from '@app/db';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';
import { OUTBOX_LOOP_OPTIONS, OutboxRelayService } from './outbox-relay.service';
import type { OutboxLoopOptions } from './outbox-relay.service';
import { PROCESSOR_LOOKUP, RECOVERY_OPTIONS, RecoveryService } from './recovery.service';
import type { RecoveryLoopOptions } from './recovery.service';
import { ProcessorLookup } from './processor-lookup';

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
    {
      provide: PROCESSOR_LOOKUP,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new ProcessorLookup({
          baseUrl: config.get('PROCESSOR_BASE_URL', { infer: true }),
          timeoutMs: config.get('PROCESSOR_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: RECOVERY_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): RecoveryLoopOptions => {
        const policy = {
          stuckAfterMs: config.get('RECOVERY_STUCK_AFTER_MS', { infer: true }),
          abandonedGraceMs: config.get('RECOVERY_ABANDONED_GRACE_MS', { infer: true }),
        };
        const feeBps = config.get('PLATFORM_FEE_BPS', { infer: true });
        return {
          sweepIntervalMs: config.get('RECOVERY_INTERVAL_MS', { infer: true }),
          reconcileIntervalMs: config.get('RECONCILIATION_INTERVAL_MS', { infer: true }),
          sweeper: {
            ...policy,
            feeBps,
            pendingAfterMs: config.get('RECOVERY_PENDING_AFTER_MS', { infer: true }),
            claimStaleAfterMs: config.get('RECOVERY_CLAIM_STALE_AFTER_MS', { infer: true }),
            batchSize: config.get('RECOVERY_BATCH_SIZE', { infer: true }),
            concurrency: 5,
          },
          reconciler: { ...policy, feeBps, lookbackMs: config.get('RECONCILIATION_LOOKBACK_MS', { infer: true }) },
        };
      },
    },
    RecoveryService,
  ],
})
export class WorkerModule {}
