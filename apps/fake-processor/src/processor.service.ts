import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { canonicalize } from '@app/payments-core';
import { chargeRequestSchema } from './schemas';
import type { ChargeRequest, Fault, Outcome, RuleInput } from './schemas';
import { WebhookService } from './webhook.service';

export type ChargeStatus = 'succeeded' | 'failed' | 'requires_action' | 'pending';

export interface Charge {
  id: string;
  object: 'charge';
  amount: number;
  currency: string;
  status: ChargeStatus;
  failure_code: string | null;
  source: string;
  metadata: Record<string, string>;
  created: number;
}

export interface Rule {
  id: string;
  match: { source?: string; reference?: string; idempotencyKey?: string };
  outcome?: Outcome;
  fault?: Fault;
  declineCode?: string;
  processingDelayMs?: number;
  responseDelayMs?: number;
  times: number | null;
  used: number;
}

/** What the HTTP layer must do with a request: reply, or kill the connection. */
export interface Exchange {
  action: 'respond' | 'drop';
  status: number;
  body: unknown;
  headers: Record<string, string>;
  responseDelayMs: number;
}

interface StoredResponse {
  status: number;
  body: unknown;
}

interface IdempotencyRecord {
  fingerprint: string;
  createdAt: number;
  /** Absent while the first request is still being processed. */
  response?: StoredResponse;
}

/** Magic `source` values, like Stripe's test cards, so a demo needs no setup. */
export const DEFAULT_SOURCE_BEHAVIOR: Record<string, { outcome: Outcome; declineCode?: string }> = {
  tok_declined: { outcome: 'decline', declineCode: 'card_declined' },
  tok_insufficient_funds: { outcome: 'decline', declineCode: 'insufficient_funds' },
  tok_requires_action: { outcome: 'requires_action' },
  tok_pending: { outcome: 'pending' },
};

/** Like Stripe, keys are remembered for 24 hours. After that the same key is a brand new request. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorExchange(
  status: number,
  type: string,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  responseDelayMs = 0,
): Exchange {
  return {
    action: 'respond',
    status,
    body: { error: { type, code, message, ...extra } },
    headers: {},
    responseDelayMs,
  };
}

/**
 * A stand-in for a payment processor with a Stripe-style contract: charges, an idempotency window,
 * and switches to make it misbehave in exactly the ways real ones do. State is in memory; it is
 * a different company's system, so it deliberately shares nothing with our database.
 */
@Injectable()
export class ProcessorService {
  private charges = new Map<string, Charge>();
  private records = new Map<string, IdempotencyRecord>();
  private rules: Rule[] = [];
  private clockOffsetMs = 0;

  constructor(private readonly webhooks: WebhookService) {}

  now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /** Jumps this processor's clock forward, to test what happens when an idempotency key expires. */
  advanceClock(ms: number): void {
    this.clockOffsetMs += ms;
  }

  // ---- charges -----------------------------------------------------------------------------

  async createCharge(idempotencyKey: string | undefined, rawBody: unknown): Promise<Exchange> {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      return errorExchange(
        400,
        'invalid_request_error',
        'idempotency_key_required',
        'POST /v1/charges requires an Idempotency-Key header of 1 to 255 characters.',
      );
    }
    const parsed = chargeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return errorExchange(400, 'invalid_request_error', 'parameter_invalid', issue.message, {
        param: issue.path.join('.'),
      });
    }
    const request = parsed.data;

    const rule = this.takeRule({
      source: request.source,
      reference: request.metadata.reference,
      idempotencyKey,
    });
    const delay = rule?.responseDelayMs ?? 0;

    if (rule?.fault === 'gateway_error') {
      return errorExchange(503, 'api_error', 'gateway_unavailable', 'Upstream unavailable.', {}, delay);
    }
    if (rule?.fault === 'drop_before') {
      return { action: 'drop', status: 0, body: null, headers: {}, responseDelayMs: delay };
    }

    const exchange = await this.process(idempotencyKey, request, rule);

    // From here on the charge exists and is stored. What follows only affects what the caller sees.
    if (rule?.fault === 'error_after') {
      return errorExchange(500, 'api_error', 'internal_error', 'Something went wrong on our end.', {}, delay);
    }
    if (rule?.fault === 'drop_after') {
      return { action: 'drop', status: 0, body: null, headers: {}, responseDelayMs: delay };
    }
    return { ...exchange, responseDelayMs: delay };
  }

  private async process(key: string, request: ChargeRequest, rule: Rule | undefined): Promise<Exchange> {
    const fingerprint = canonicalize(request);
    const existing = this.lookup(key);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return errorExchange(
          400,
          'idempotency_error',
          'idempotency_key_reused',
          'Keys for idempotent requests can only be used with the same parameters they were first used with.',
        );
      }
      if (!existing.response) {
        return errorExchange(
          409,
          'idempotency_error',
          'idempotency_key_in_use',
          'A request with this key is still being processed. Retry shortly.',
        );
      }
      return {
        action: 'respond',
        ...existing.response,
        headers: { 'Idempotent-Replayed': 'true' },
        responseDelayMs: 0,
      };
    }

    const record: IdempotencyRecord = { fingerprint, createdAt: this.now() };
    this.records.set(key, record);

    if (rule?.processingDelayMs) await sleep(rule.processingDelayMs);

    const chosen = rule?.outcome
      ? { outcome: rule.outcome, declineCode: rule.declineCode }
      : (DEFAULT_SOURCE_BEHAVIOR[request.source] ?? { outcome: 'succeed' as Outcome });
    const charge = this.applyOutcome(request, chosen.outcome, rule?.declineCode ?? chosen.declineCode);

    record.response =
      charge.status === 'failed'
        ? {
            status: 402,
            body: {
              error: {
                type: 'card_error',
                code: charge.failure_code,
                message: `The charge was declined (${charge.failure_code}).`,
                charge: charge.id,
              },
            },
          }
        : { status: 200, body: { ...charge } };

    return { action: 'respond', ...record.response, headers: {}, responseDelayMs: 0 };
  }

  private lookup(key: string): IdempotencyRecord | undefined {
    const record = this.records.get(key);
    if (record && this.now() - record.createdAt > IDEMPOTENCY_WINDOW_MS) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  private applyOutcome(request: ChargeRequest, outcome: Outcome, declineCode?: string): Charge {
    const status: ChargeStatus =
      outcome === 'succeed' ? 'succeeded' : outcome === 'decline' ? 'failed' : outcome;
    const charge: Charge = {
      id: `ch_${randomBytes(8).toString('hex')}`,
      object: 'charge',
      amount: request.amount,
      currency: request.currency,
      status,
      failure_code: status === 'failed' ? (declineCode ?? 'card_declined') : null,
      source: request.source,
      metadata: request.metadata,
      created: Math.floor(this.now() / 1000),
    };
    this.charges.set(charge.id, charge);
    if (status === 'succeeded') this.webhooks.emit('charge.succeeded', { ...charge });
    if (status === 'failed') this.webhooks.emit('charge.failed', { ...charge });
    return charge;
  }

  getCharge(id: string): Charge | undefined {
    const charge = this.charges.get(id);
    return charge && { ...charge };
  }

  listCharges(filter: { reference?: string } = {}): Charge[] {
    return [...this.charges.values()]
      .filter((c) => filter.reference === undefined || c.metadata.reference === filter.reference)
      .map((c) => ({ ...c }));
  }

  /**
   * Settles a charge that was `pending` or `requires_action` (the customer finished 3-D Secure, the
   * bank answered), and sends the webhook. Note the idempotent replay of the ORIGINAL request keeps
   * returning the original snapshot (`pending`), exactly as a real processor does; only a fresh read
   * or the webhook shows the new truth.
   */
  resolveCharge(
    id: string,
    outcome: 'succeeded' | 'failed',
    failureCode?: string,
  ): { result: 'resolved'; charge: Charge } | { result: 'not_found' } | { result: 'not_resolvable'; status: ChargeStatus } {
    const charge = this.charges.get(id);
    if (!charge) return { result: 'not_found' };
    if (charge.status !== 'pending' && charge.status !== 'requires_action') {
      return { result: 'not_resolvable', status: charge.status };
    }
    charge.status = outcome;
    charge.failure_code = outcome === 'failed' ? (failureCode ?? 'card_declined') : null;
    this.webhooks.emit(outcome === 'succeeded' ? 'charge.succeeded' : 'charge.failed', { ...charge });
    return { result: 'resolved', charge: { ...charge } };
  }

  // ---- rules -------------------------------------------------------------------------------

  addRule(input: RuleInput): Rule {
    const { times, match, ...rest } = input;
    const rule: Rule = {
      id: `rule_${randomBytes(4).toString('hex')}`,
      ...rest,
      match: match ?? {},
      times: times === undefined ? 1 : times,
      used: 0,
    };
    this.rules.push(rule);
    return { ...rule };
  }

  listRules(): Rule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  clearRules(): void {
    this.rules = [];
  }

  /** The first live rule that matches wins, and the request uses up one of its `times`. */
  private takeRule(request: { source: string; reference?: string; idempotencyKey: string }): Rule | undefined {
    const rule = this.rules.find(
      (r) =>
        (r.times === null || r.used < r.times) &&
        (r.match.source === undefined || r.match.source === request.source) &&
        (r.match.reference === undefined || r.match.reference === request.reference) &&
        (r.match.idempotencyKey === undefined || r.match.idempotencyKey === request.idempotencyKey),
    );
    if (rule) rule.used++;
    return rule && { ...rule };
  }

  stats(): { charges: number; idempotencyKeys: number; byStatus: Record<string, number> } {
    const byStatus: Record<string, number> = {};
    for (const c of this.charges.values()) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return { charges: this.charges.size, idempotencyKeys: this.records.size, byStatus };
  }

  reset(): void {
    this.charges.clear();
    this.records.clear();
    this.rules = [];
    this.clockOffsetMs = 0;
    this.webhooks.reset();
  }
}
