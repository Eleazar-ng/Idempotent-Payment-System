import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@app/payments-core';
import type { Env } from '@app/config';
import type { WebhookConfigInput } from './schemas';

export interface Delivery {
  at: string;
  status?: number;
  error?: string;
}

export interface StoredEvent {
  id: string;
  type: string;
  created: number;
  /** The exact bytes that were (or will be) sent and signed. */
  body: string;
  held: boolean;
  deliveries: Delivery[];
}

export interface WebhookSettings {
  url: string | null;
  mode: 'immediate' | 'hold';
  duplicates: number;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends signed webhooks the way real processors do: at least once, so duplicates, retries after a
 * failed delivery, and (with `hold` + `flush`) arbitrary ordering. Your receiver (Stage 7) has to be
 * correct under all of them; this service exists to make each one reproducible on demand.
 */
@Injectable()
export class WebhookService {
  private settings: WebhookSettings;
  private events: StoredEvent[] = [];
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly config: ConfigService<Env, true>) {
    this.settings = this.defaults();
  }

  private defaults(): WebhookSettings {
    return {
      url: this.config.get('FAKE_PROCESSOR_WEBHOOK_URL', { infer: true }) ?? null,
      mode: 'immediate',
      duplicates: 0,
      maxRetries: 3,
      retryDelayMs: 1000,
      timeoutMs: 2000,
    };
  }

  configure(input: WebhookConfigInput): WebhookSettings {
    const { url, ...rest } = input;
    this.settings = {
      ...this.settings,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(url !== undefined ? { url } : {}),
    };
    return this.getSettings();
  }

  getSettings(): WebhookSettings {
    return { ...this.settings };
  }

  /** Records an event and, unless events are being held, starts delivering it. */
  emit(type: string, object: unknown): StoredEvent {
    const created = Math.floor(Date.now() / 1000);
    const id = `evt_${randomBytes(8).toString('hex')}`;
    const event: StoredEvent = {
      id,
      type,
      created,
      body: JSON.stringify({ id, object: 'event', type, created, data: { object } }),
      held: this.settings.mode === 'hold',
      deliveries: [],
    };
    this.events.push(event);
    if (!event.held) this.track(this.deliver(event));
    return event;
  }

  /** Delivers every held event, one after another, in the chosen order. */
  async flush(order: 'fifo' | 'reverse' = 'fifo'): Promise<number> {
    const held = this.events.filter((e) => e.held);
    if (order === 'reverse') held.reverse();
    for (const event of held) {
      event.held = false;
      await this.deliver(event);
    }
    return held.length;
  }

  /** Sends an event again (a processor operator pressing "resend"). */
  async redeliver(eventId: string): Promise<boolean> {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) return false;
    await this.deliver(event);
    return true;
  }

  listEvents(): StoredEvent[] {
    return this.events.map((e) => ({ ...e, deliveries: [...e.deliveries] }));
  }

  /** Resolves when no delivery is in progress. For tests, which must not race background work. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  reset(): void {
    this.events = [];
    this.settings = this.defaults();
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** 1 + `duplicates` copies, each retried on failure. Every copy is signed with a fresh timestamp. */
  private async deliver(event: StoredEvent): Promise<void> {
    if (!this.settings.url) return;
    for (let copy = 0; copy <= this.settings.duplicates; copy++) {
      await this.postWithRetries(event);
    }
  }

  private async postWithRetries(event: StoredEvent): Promise<void> {
    const { url, maxRetries, retryDelayMs, timeoutMs } = this.settings;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const delivery: Delivery = { at: new Date().toISOString() };
      event.deliveries.push(delivery);
      try {
        const response = await fetch(url as string, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WEBHOOK_SIGNATURE_HEADER]: signWebhook({
              secret: this.config.get('PROCESSOR_WEBHOOK_SECRET', { infer: true }),
              payload: event.body,
              timestamp: Math.floor(Date.now() / 1000),
            }),
          },
          body: event.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        delivery.status = response.status;
        if (response.ok) return;
      } catch (error) {
        delivery.error = error instanceof Error ? error.message : String(error);
      }
      if (attempt < maxRetries) await sleep(retryDelayMs);
    }
  }
}
