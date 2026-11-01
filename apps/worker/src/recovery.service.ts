import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DB } from '@app/db';
import type { Database } from '@app/db';
import { METRICS } from '@app/observability';
import type { AppMetrics } from '@app/observability';
import { PeriodicLoop } from './periodic-loop';
import { ProcessorLookup } from './processor-lookup';
import { RecoverySweeper } from './recovery-sweeper';
import type { RecoverySweeperOptions } from './recovery-sweeper';
import { Reconciler } from './reconciler';
import type { ReconcilerOptions } from './reconciler';

export const RECOVERY_OPTIONS = Symbol('RECOVERY_OPTIONS');
export const PROCESSOR_LOOKUP = Symbol('PROCESSOR_LOOKUP');

export interface RecoveryLoopOptions {
  sweeper: RecoverySweeperOptions;
  sweepIntervalMs: number;
  reconciler: ReconcilerOptions;
  reconcileIntervalMs: number;
}

/** Runs the sweeper and the reconciler on their own timers. */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly loops: PeriodicLoop[];

  constructor(
    @Inject(DB) db: Kysely<Database>,
    @Inject(PROCESSOR_LOOKUP) lookup: ProcessorLookup,
    @Inject(RECOVERY_OPTIONS) options: RecoveryLoopOptions,
    @Inject(METRICS) metrics: AppMetrics,
  ) {
    const log = (level: 'warn' | 'error', message: string) => this.logger[level](message);
    const onFinding = (kind: string) => metrics.findingsRecorded.inc({ kind });
    const sweeper = new RecoverySweeper(db, lookup, { log, onFinding, ...options.sweeper });
    const reconciler = new Reconciler(db, lookup, { log, onFinding, ...options.reconciler });
    const ran = (job: string, result: 'ok' | 'error') => metrics.recoveryRuns.inc({ job, result });
    this.loops = [
      new PeriodicLoop(
        async () => {
          const s = await sweeper.runOnce();
          ran('sweeper', 'ok');
          metrics.recoveryActions.inc({ action: 'applied' }, s.applied);
          metrics.recoveryActions.inc({ action: 'abandoned' }, s.abandoned);
          metrics.recoveryActions.inc({ action: 'failed_unreached' }, s.failedUnreached);
          metrics.recoveryActions.inc({ action: 'keys_completed' }, s.keysCompleted);
          metrics.recoveryActions.inc({ action: 'claims_released' }, s.claimsReleased);
          if (s.examined + s.keysCompleted + s.claimsReleased > 0) {
            this.logger.log(`recovery pass: ${JSON.stringify(s)}`);
          }
        },
        options.sweepIntervalMs,
        (e) => {
          ran('sweeper', 'error');
          this.logger.error(`recovery pass failed: ${String(e)}`);
        },
      ),
      new PeriodicLoop(
        async () => {
          const r = await reconciler.runOnce();
          ran('reconciler', 'ok');
          metrics.recoveryActions.inc({ action: 'repaired' }, r.repaired);
          this.logger.log(`reconciliation: ${JSON.stringify(r)}`);
        },
        options.reconcileIntervalMs,
        (e) => {
          ran('reconciler', 'error');
          this.logger.error(`reconciliation failed (nothing changed): ${String(e)}`);
        },
      ),
    ];
  }

  onApplicationBootstrap(): void {
    this.loops.forEach((l) => l.start());
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.loops.map((l) => l.stop()));
  }
}
