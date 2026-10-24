import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  applyProcessorOutcome,
  beginAttempt,
  claimKey,
  completeKey,
  DB,
  getPayment,
  releaseClaim,
  transitionAttempt,
} from '@app/db';
import type { BeginAttemptResult, Database, PaymentAttempt, PaymentIntent } from '@app/db';
import {
  assertValidIdempotencyKey,
  conflictResponse,
  InvalidIdempotencyKeyError,
} from '@app/payments-core';
import type { ProcessorOutcome } from '@app/payments-core';
import { paymentResult, paymentView, problem } from './payment-http';
import type { HttpResult } from './payment-http';
import { ProcessorClient } from './processor.client';

export const PAYMENT_FLOW_OPTIONS = Symbol('PAYMENT_FLOW_OPTIONS');

export interface PaymentFlowOptions {
  /** Extra tries after an unknown outcome, all with the same processor idempotency key. */
  callRetries: number;
  retryDelayMs: number;
}

const OPERATION = 'POST /v1/payments';

/** Strict on purpose: an unknown field is a 400, not something silently left out of the request hash. */
export const createPaymentSchema = z
  .object({
    order_id: z.string().min(1).max(255),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase ISO code'),
    source: z.string().min(1).max(255),
  })
  .strict();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The create-payment flow: the first place every earlier stage meets.
 *
 *   1. claim the idempotency key           (Stage 3)  duplicates stop here
 *   2. begin an attempt for the order      (Stage 5)  duplicates with OTHER keys stop here
 *   3. created -> calling_processor        (Stage 2)  committed BEFORE the call, so a crash is visible
 *   4. call the processor with the attempt's derived key, retrying unknown outcomes (Stage 4)
 *   5. apply the outcome AND store the response in one transaction
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    private readonly processor: ProcessorClient,
    @Inject(PAYMENT_FLOW_OPTIONS) private readonly options: PaymentFlowOptions,
  ) {}

  async createPayment(input: { merchantId: unknown; idempotencyKey: unknown; body: unknown }): Promise<HttpResult> {
    const merchantId = await this.authenticate(input.merchantId);
    if (typeof merchantId !== 'number') return merchantId;

    try {
      assertValidIdempotencyKey(input.idempotencyKey);
    } catch (error) {
      if (error instanceof InvalidIdempotencyKeyError) {
        return problem(400, 'invalid_idempotency_key', error.message);
      }
      throw error;
    }
    const key = input.idempotencyKey;

    const parsed = createPaymentSchema.safeParse(input.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return problem(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
    }
    const request = parsed.data;

    const claim = await claimKey(this.db, { merchantId, key, request: { operation: OPERATION, body: request } });
    switch (claim.outcome) {
      case 'mismatch': {
        const { status, body } = conflictResponse('mismatch');
        return { status, body, headers: {} };
      }
      case 'in_flight': {
        const { status, body, retryAfterSeconds } = conflictResponse('in_flight');
        return { status, body, headers: { 'Retry-After': String(retryAfterSeconds) } };
      }
      case 'replay':
        return {
          status: claim.response.status,
          body: claim.response.body,
          headers: { 'Idempotent-Replayed': 'true' },
        };
      case 'claimed':
        return this.runClaimed(merchantId, key, request);
    }
  }

  /** The payment as it is right now (a live read, not the stored snapshot). */
  async getPayment(merchantIdHeader: unknown, paymentId: string): Promise<HttpResult> {
    const merchantId = await this.authenticate(merchantIdHeader);
    if (typeof merchantId !== 'number') return merchantId;

    const match = /^pay_(\d{1,15})$/.exec(paymentId);
    const record = match ? await getPayment(this.db, merchantId, Number(match[1])) : undefined;
    if (!record) return problem(404, 'payment_not_found', 'No such payment.');
    return { status: 200, body: paymentView(record.intent, record.latestAttempt), headers: {} };
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Stand-in for real authentication (Stage 11): the merchant is named in X-Merchant-Id. The one
   * rule that matters already holds: every query below is scoped to this merchant.
   */
  private async authenticate(header: unknown): Promise<number | HttpResult> {
    const id = typeof header === 'string' && /^\d{1,15}$/.test(header) ? Number(header) : undefined;
    const merchant =
      id === undefined
        ? undefined
        : await this.db.selectFrom('merchants').select('id').where('id', '=', id).executeTakeFirst();
    return merchant ? merchant.id : problem(401, 'unknown_merchant', 'Missing or unknown X-Merchant-Id.');
  }

  private async runClaimed(
    merchantId: number,
    key: string,
    request: z.infer<typeof createPaymentSchema>,
  ): Promise<HttpResult> {
    let attemptExists = false;
    try {
      const begun = await beginAttempt(this.db, {
        merchantId,
        orderId: request.order_id,
        amount: request.amount,
        currency: request.currency,
        paymentSource: request.source,
        idempotencyKey: key,
      });

      if (begun.outcome === 'started') {
        attemptExists = true;
        return await this.charge(merchantId, key, begun.intent, begun.attempt);
      }
      return await this.refuse(merchantId, key, begun);
    } catch (error) {
      // Before an attempt exists nothing happened, so the client's retry may start fresh. After one
      // exists the claim must stay: money may be moving, and recovery (Stage 9) owns it from here.
      if (!attemptExists) {
        await releaseClaim(this.db, merchantId, key).catch((e: unknown) =>
          this.logger.error(`could not release claim ${key}: ${String(e)}`),
        );
      }
      throw error;
    }
  }

  /** Answers for the cases where no attempt was started. */
  private async refuse(
    merchantId: number,
    key: string,
    begun: Exclude<BeginAttemptResult, { outcome: 'started' }>,
  ): Promise<HttpResult> {
    if (begun.outcome === 'attempt_in_progress') {
      // Transient: another request owns this order right now. Do NOT store this answer under the
      // key, or the client's later retry would be told "in progress" forever. Let the key go.
      await releaseClaim(this.db, merchantId, key);
      return problem(
        409,
        'payment_already_in_progress',
        'A payment for this order is already being processed.',
        { payment: paymentView(begun.intent, begun.activeAttempt) },
        { 'Retry-After': '1' },
      );
    }

    const result =
      begun.outcome === 'order_conflict'
        ? problem(422, 'order_mismatch', 'This order already exists with a different amount or currency.')
        : begun.outcome === 'already_paid'
          ? problem(409, 'order_already_paid', 'This order has already been paid.', {
              payment: paymentView(begun.intent, begun.attempt),
            })
          : problem(409, 'order_canceled', 'This order was canceled.');
    return this.store(merchantId, key, result);
  }

  private async charge(
    merchantId: number,
    key: string,
    intent: PaymentIntent,
    attempt: PaymentAttempt,
  ): Promise<HttpResult> {
    // Committed BEFORE the call. If we crash mid-call the attempt says so, and the sweeper (Stage 9)
    // knows exactly which attempts to look at.
    const moved = await transitionAttempt(this.db, attempt.id, 'calling_processor', { from: 'created' });
    if (moved.outcome !== 'applied') {
      throw new Error(`attempt ${attempt.id} was expected in "created" but is not`);
    }

    const outcome = await this.callProcessor(intent, attempt);
    return this.settle(merchantId, key, intent, attempt, outcome);
  }

  /**
   * Asks the processor, and asks AGAIN after an unknown outcome. That is safe only because every
   * call carries the attempt's persisted key: the processor collapses all of them into one charge.
   * A definitive answer (success, decline, rejection) is never retried.
   */
  private async callProcessor(intent: PaymentIntent, attempt: PaymentAttempt): Promise<ProcessorOutcome> {
    let outcome: ProcessorOutcome = { kind: 'unknown', reason: 'not_called' };
    for (let tryNumber = 0; tryNumber <= this.options.callRetries; tryNumber++) {
      outcome = await this.processor.charge({
        idempotencyKey: attempt.processor_idempotency_key,
        amount: intent.amount,
        currency: intent.currency,
        source: attempt.payment_source,
        metadata: {
          reference: attempt.processor_idempotency_key,
          attempt_id: String(attempt.id),
          order_id: intent.order_id,
        },
      });
      if (outcome.kind !== 'unknown') return outcome;

      this.logger.warn(`attempt ${attempt.id}: unknown outcome (${outcome.reason}), try ${tryNumber + 1}`);
      if (tryNumber < this.options.callRetries) await sleep(this.options.retryDelayMs * 2 ** tryNumber);
    }
    return outcome; // still unknown: the attempt stays in calling_processor for recovery
  }

  /**
   * Records the outcome and the response in ONE transaction, so there is never a moment where the
   * attempt has changed but the key does not yet hold the matching answer (Module 3.4). Stage 6
   * adds the ledger posting to this same transaction.
   *
   * The response is built from a fresh read inside the transaction, not from our local `outcome`:
   * if a webhook resolved the attempt first, our transition reports `stale` and the truth wins.
   */
  private async settle(
    merchantId: number,
    key: string,
    intent: PaymentIntent,
    attempt: PaymentAttempt,
    outcome: ProcessorOutcome,
  ): Promise<HttpResult> {
    return this.db.transaction().execute(async (trx) => {
      await applyProcessorOutcome(trx, attempt.id, outcome, 'calling_processor');

      const record = await getPayment(trx, merchantId, intent.id);
      const result = paymentResult(record?.intent ?? intent, record?.latestAttempt ?? attempt);

      const done = await completeKey(trx, {
        merchantId,
        key,
        attemptId: attempt.id,
        response: { status: result.status, body: result.body as never },
      });
      return done.outcome === 'already_completed'
        ? { status: done.response.status, body: done.response.body, headers: {} }
        : result;
    });
  }

  /** Stores a deterministic, permanent answer under the key and returns whatever is stored. */
  private async store(merchantId: number, key: string, result: HttpResult): Promise<HttpResult> {
    const done = await completeKey(this.db, {
      merchantId,
      key,
      response: { status: result.status, body: result.body as never },
    });
    return done.outcome === 'already_completed'
      ? { status: done.response.status, body: done.response.body, headers: {} }
      : result;
  }
}
