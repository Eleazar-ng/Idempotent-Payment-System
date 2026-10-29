import type { Kysely } from 'kysely';
import {
  assertValidRetryPolicy,
  buildMerchantEventBody,
  EVENT_ID_HEADER,
  merchantEventId,
  parseRetryAfterMs,
  PLATFORM_SIGNATURE_HEADER,
  retryDelayMs,
  signWebhook,
} from '@app/payments-core';
import type { RetryPolicy } from '@app/payments-core';
import {
  claimDueOutboxEvents,
  markOutboxDead,
  markOutboxDelivered,
  markOutboxSkipped,
  scheduleOutboxRetry,
} from '@app/db';
import type { ClaimedOutboxEvent, Database } from '@app/db';

export interface OutboxRelayOptions {
  /** Most events claimed in one pass. All of them are delivered concurrently. */
  batchSize: number;
  /** Total tries (the first delivery counts) before an event is parked as dead. */
  maxAttempts: number;
  /** How long a claim holds. Must comfortably exceed the delivery timeout. */
  leaseMs: number;
  deliveryTimeoutMs: number;
  /** Spacing between retries of one event. */
  retry: RetryPolicy;
  fetch?: typeof fetch;
  /** Injected so tests control time and jitter. */
  now?: () => Date;
  random?: () => number;
  log?: (level: 'warn' | 'error', message: string) => void;
}

export interface RelaySummary {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  skipped: number;
}

type Verdict = keyof Omit<RelaySummary, 'claimed'>;

/**
 * Delivers outbox events to merchants (Stage 8). At least once: an event is retried until the merchant
 * answers 2xx or the attempts run out, and a worker that dies mid-delivery just lets its lease expire.
 * Merchants deduplicate on the event id header, which is the same on every retry.
 *
 * Plain class, no Nest: the loop that calls runOnce() lives in OutboxRelayService, so tests can drive it
 * one deterministic pass at a time.
 */
export class OutboxRelay {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: OutboxRelayOptions,
  ) {
    assertValidRetryPolicy(options.retry);
    if (options.leaseMs <= options.deliveryTimeoutMs) {
      // A lease shorter than a delivery would let a second worker take an event that is still in flight.
      throw new RangeError('leaseMs must be longer than deliveryTimeoutMs');
    }
    if (options.maxAttempts < 1 || options.batchSize < 1) throw new RangeError('maxAttempts and batchSize must be >= 1');
  }

  async runOnce(): Promise<RelaySummary> {
    const now = this.now();
    const claimed = await claimDueOutboxEvents(this.db, {
      now,
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });

    // Concurrently, so one merchant that hangs for the full timeout cannot hold up (or outlast the lease of) the rest.
    const verdicts = await Promise.all(claimed.map((event) => this.handle(event)));

    const summary: RelaySummary = { claimed: claimed.length, delivered: 0, retried: 0, dead: 0, skipped: 0 };
    for (const verdict of verdicts) if (verdict) summary[verdict]++;
    return summary;
  }

  private async handle(event: ClaimedOutboxEvent): Promise<Verdict | undefined> {
    try {
      if (!event.merchant_webhook_url || !event.merchant_webhook_secret) {
        await markOutboxSkipped(this.db, event.id, 'no_webhook_url');
        return 'skipped';
      }

      const failure = await this.send(event, event.merchant_webhook_url, event.merchant_webhook_secret);
      if (!failure) {
        await markOutboxDelivered(this.db, event.id, this.now());
        return 'delivered';
      }
      return await this.fail(event, failure);
    } catch (error) {
      // Recording the result failed (database trouble). The lease will expire and the event comes round again.
      this.log('error', `outbox event ${event.id}: could not record the result: ${String(error)}`);
      return undefined;
    }
  }

  /** Returns undefined on success, otherwise why not. */
  private async send(
    event: ClaimedOutboxEvent,
    url: string,
    secret: string,
  ): Promise<{ error: string; retryAfterMs?: number } | undefined> {
    const body = buildMerchantEventBody({
      id: event.id,
      eventType: event.event_type,
      createdAt: event.created_at,
      payload: event.payload,
    });
    const timestamp = Math.floor(this.now().getTime() / 1000);
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PLATFORM_SIGNATURE_HEADER]: signWebhook({ secret, payload: body, timestamp }),
          [EVENT_ID_HEADER]: merchantEventId(event.id),
        },
        body,
        // A redirect would send a signed body somewhere the merchant never registered.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.deliveryTimeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return undefined;
      return {
        error: `http_${response.status}`,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), this.now().getTime()),
      };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') return { error: 'timeout' };
      return { error: `network: ${(error as Error).message}` };
    }
  }

  private async fail(event: ClaimedOutboxEvent, failure: { error: string; retryAfterMs?: number }): Promise<Verdict> {
    if (event.attempts >= this.options.maxAttempts) {
      this.log('error', `outbox event ${event.id} is dead after ${event.attempts} attempts: ${failure.error}`);
      await markOutboxDead(this.db, event.id, event.attempts, failure.error);
      return 'dead';
    }
    const wait = retryDelayMs(this.options.retry, event.attempts - 1, {
      random: this.options.random,
      minDelayMs: failure.retryAfterMs,
    });
    await scheduleOutboxRetry(this.db, event.id, event.attempts, new Date(this.now().getTime() + wait), failure.error);
    return 'retried';
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private log(level: 'warn' | 'error', message: string): void {
    this.options.log?.(level, message);
  }
}
