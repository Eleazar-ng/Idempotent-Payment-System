import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DB } from '@app/db';
import type { Database } from '@app/db';
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
  ) {
    const log = (level: 'warn' | 'error', message: string) => this.logger[level](message);
    const sweeper = new RecoverySweeper(db, lookup, { log, ...options.sweeper });
    const reconciler = new Reconciler(db, lookup, { log, ...options.reconciler });
    this.loops = [
      new PeriodicLoop(
        async () => {
          const s = await sweeper.runOnce();
          if (s.examined + s.keysCompleted + s.claimsReleased > 0) {
            this.logger.log(`recovery pass: ${JSON.stringify(s)}`);
          }
        },
        options.sweepIntervalMs,
        (e) => this.logger.error(`recovery pass failed: ${String(e)}`),
      ),
      new PeriodicLoop(
        async () => {
          this.logger.log(`reconciliation: ${JSON.stringify(await reconciler.runOnce())}`);
        },
        options.reconcileIntervalMs,
        (e) => this.logger.error(`reconciliation failed (nothing changed): ${String(e)}`),
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
