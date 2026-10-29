import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DB } from '@app/db';
import type { Database } from '@app/db';
import { OutboxRelay } from './outbox-relay';
import type { OutboxRelayOptions } from './outbox-relay';

export const OUTBOX_LOOP_OPTIONS = Symbol('OUTBOX_LOOP_OPTIONS');

export interface OutboxLoopOptions {
  relay: OutboxRelayOptions;
  /** How long to sleep when a pass found nothing to do. */
  pollIntervalMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the relay forever: pass, and if the batch was full go straight round again (there is more
 * waiting), otherwise sleep a little. A failed pass is logged and retried, never fatal.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly relay: OutboxRelay;
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(DB) db: Kysely<Database>,
    @Inject(OUTBOX_LOOP_OPTIONS) private readonly options: OutboxLoopOptions,
  ) {
    this.relay = new OutboxRelay(db, {
      log: (level, message) => this.logger[level](message),
      ...options.relay,
    });
  }

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.loop; // lets the pass in progress finish, so no delivery is cut off half way
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let busy = false;
      try {
        const summary = await this.relay.runOnce();
        busy = summary.claimed >= this.options.relay.batchSize;
        if (summary.claimed > 0) {
          this.logger.log(
            `outbox pass: ${summary.delivered} delivered, ${summary.retried} to retry, ${summary.dead} dead, ${summary.skipped} skipped`,
          );
        }
      } catch (error) {
        this.logger.error(`outbox pass failed: ${String(error)}`);
      }
      if (!busy && !this.stopping) await sleep(this.options.pollIntervalMs);
    }
  }
}
