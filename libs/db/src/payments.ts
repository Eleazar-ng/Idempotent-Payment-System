import type { Kysely } from 'kysely';
import { processorIdempotencyKey } from '../../payments-core/src';
import type { AttemptStatus, ProcessorOutcome } from '../../payments-core/src';
import type { Database, PaymentAttempt, PaymentIntent } from './database.types';
import { transitionAttempt } from './attempts';
import type { TransitionResult } from './attempts';
import { attachAttempt } from './idempotency';
import { postAttemptSuccess } from './ledger';

export interface BeginAttemptInput {
  merchantId: number;
  orderId: string;
  /** Integer minor units (kobo, cents). */
  amount: number;
  currency: string;
  /** The payment method token; stored on the attempt so any retry can rebuild the identical charge request. */
  paymentSource: string;
  /** If given, the claimed idempotency key is linked to the new attempt in the same transaction. */
  idempotencyKey?: string;
}

/** What happened when a payment was requested for an order. Only `started` means "go and charge". */
export type BeginAttemptResult =
  /** A fresh attempt exists in `created`, with its processor idempotency key already persisted. */
  | { outcome: 'started'; intent: PaymentIntent; attempt: PaymentAttempt }
  /** The order exists with a different amount or currency. Never silently charge the other one. */
  | { outcome: 'order_conflict'; intent: PaymentIntent }
  /** The order is already paid. No new attempt, no new charge. */
  | { outcome: 'already_paid'; intent: PaymentIntent; attempt: PaymentAttempt | undefined }
  | { outcome: 'order_canceled'; intent: PaymentIntent }
  /**
   * Another attempt for this order is not finished (failure modes 2.4 and 2.7). Whichever request
   * got there first owns it; this one must not start a second charge.
   */
  | { outcome: 'attempt_in_progress'; intent: PaymentIntent; activeAttempt: PaymentAttempt };

/** The two constraints that say "another attempt for this intent got there first". */
const ATTEMPT_RACE_CONSTRAINTS = new Set([
  'payment_attempts_one_active_per_intent',
  'payment_attempts_number_per_intent',
]);

function sqlError(error: unknown): { code?: string; constraint?: string } {
  return typeof error === 'object' && error !== null ? (error as { code?: string; constraint?: string }) : {};
}

const MAX_ROUNDS = 3;

/**
 * Finds or creates the payment intent for an order and creates the next attempt for it, in one
 * transaction. This is where double charges for the SAME ORDER are stopped, whatever idempotency
 * keys the callers used: two requests with different keys both reach this point, and the partial
 * unique index `payment_attempts_one_active_per_intent` lets only one of them insert an attempt.
 *
 * The processor idempotency key is derived from the attempt and persisted in the same insert, so it
 * exists durably before anything can call the processor (Module 2.3).
 */
export async function beginAttempt(db: Kysely<Database>, input: BeginAttemptInput): Promise<BeginAttemptResult> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      return await db.transaction().execute((trx) => beginInTransaction(trx, input));
    } catch (error) {
      const { code, constraint } = sqlError(error);
      const lostRace = code === '23505' && constraint !== undefined && ATTEMPT_RACE_CONSTRAINTS.has(constraint);
      // PY004: the intent stopped being open between our read and our insert (paid or canceled).
      if (!lostRace && code !== 'PY004') throw error;

      const intent = await findIntent(db, input.merchantId, input.orderId);
      const active = intent && (await findActiveAttempt(db, intent.id));
      if (intent && active) return { outcome: 'attempt_in_progress', intent, activeAttempt: active };
      // Otherwise the competing attempt already ended (or the intent changed): look again.
    }
  }
  throw new Error(`beginAttempt: could not settle order ${input.orderId} after ${MAX_ROUNDS} rounds`);
}

async function beginInTransaction(trx: Kysely<Database>, input: BeginAttemptInput): Promise<BeginAttemptResult> {
  const created = await trx
    .insertInto('payment_intents')
    .values({
      merchant_id: input.merchantId,
      order_id: input.orderId,
      amount: input.amount,
      currency: input.currency,
    })
    .onConflict((oc) => oc.columns(['merchant_id', 'order_id']).doNothing())
    .returningAll()
    .executeTakeFirst();
  const intent = created ?? (await findIntent(trx, input.merchantId, input.orderId));
  if (!intent) throw new Error('beginAttempt: intent vanished after upsert');

  if (intent.amount !== input.amount || intent.currency !== input.currency) {
    return { outcome: 'order_conflict', intent };
  }
  if (intent.status === 'succeeded') {
    const paid = await trx
      .selectFrom('payment_attempts')
      .selectAll()
      .where('payment_intent_id', '=', intent.id)
      .where('status', '=', 'succeeded')
      .executeTakeFirst();
    return { outcome: 'already_paid', intent, attempt: paid };
  }
  if (intent.status === 'canceled') {
    return { outcome: 'order_canceled', intent };
  }

  const latest = await trx
    .selectFrom('payment_attempts')
    .select((eb) => eb.fn.max('attempt_number').as('latest'))
    .where('payment_intent_id', '=', intent.id)
    .executeTakeFirst();
  const attemptNumber = Number(latest?.latest ?? 0) + 1;

  const attempt = await trx
    .insertInto('payment_attempts')
    .values({
      payment_intent_id: intent.id,
      attempt_number: attemptNumber,
      processor_idempotency_key: processorIdempotencyKey(intent.id, attemptNumber),
      payment_source: input.paymentSource,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  if (input.idempotencyKey !== undefined) {
    const linked = await attachAttempt(trx, input.merchantId, input.idempotencyKey, attempt.id);
    if (!linked) throw new Error('beginAttempt: the idempotency key could not be linked to the new attempt');
  }
  return { outcome: 'started', intent, attempt };
}

export function findIntent(
  db: Kysely<Database>,
  merchantId: number,
  orderId: string,
): Promise<PaymentIntent | undefined> {
  return db
    .selectFrom('payment_intents')
    .selectAll()
    .where('merchant_id', '=', merchantId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
}

/** The attempt that currently blocks new ones: anything not `failed` (abandoned included). */
export function findActiveAttempt(db: Kysely<Database>, intentId: number): Promise<PaymentAttempt | undefined> {
  return db
    .selectFrom('payment_attempts')
    .selectAll()
    .where('payment_intent_id', '=', intentId)
    .where('status', '<>', 'failed')
    .executeTakeFirst();
}

export interface PaymentRecord {
  intent: PaymentIntent;
  latestAttempt: PaymentAttempt | undefined;
}

/** A payment as it is right now, scoped to the merchant so one merchant can never read another's. */
export async function getPayment(
  db: Kysely<Database>,
  merchantId: number,
  intentId: number,
): Promise<PaymentRecord | undefined> {
  const intent = await db
    .selectFrom('payment_intents')
    .selectAll()
    .where('id', '=', intentId)
    .where('merchant_id', '=', merchantId)
    .executeTakeFirst();
  if (!intent) return undefined;
  const latestAttempt = await db
    .selectFrom('payment_attempts')
    .selectAll()
    .where('payment_intent_id', '=', intent.id)
    .orderBy('attempt_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  return { intent, latestAttempt };
}

export function getAttempt(db: Kysely<Database>, attemptId: number): Promise<PaymentAttempt | undefined> {
  return db.selectFrom('payment_attempts').selectAll().where('id', '=', attemptId).executeTakeFirst();
}

/**
 * Applies what the processor said to the attempt, as one conditional transition (Stage 2).
 *
 * A success is booked in the SAME transaction (Stage 6): the status change and the ledger posting
 * commit together or not at all, and the database refuses a commit that has one without the other
 * (migration 0006). If `db` is already a transaction it joins it, so the caller can add its own
 * writes (the stored API response); otherwise this opens one. Every path that can learn "it
 * succeeded" (this API call, the webhook handler, reconciliation) goes through here, which is how
 * they all converge on one set of entries.
 *
 * `unknown` changes nothing, on purpose: not knowing is not a reason to move the attempt anywhere.
 * `abandoned` and recovery (Stage 9) deal with attempts that stay unknown.
 */
export async function applyProcessorOutcome(
  db: Kysely<Database>,
  attemptId: number,
  outcome: ProcessorOutcome,
  from: AttemptStatus | readonly AttemptStatus[],
  options: { feeBps: number },
): Promise<TransitionResult | { outcome: 'no_change' }> {
  switch (outcome.kind) {
    case 'succeeded':
      return inTransaction(db, async (trx) => {
        const result = await transitionAttempt(trx, attemptId, 'succeeded', {
          from,
          processorChargeId: outcome.chargeId,
        });
        // `already_applied`: another path got there first. Booking is idempotent (same posting
        // key), so this is a no-op if it did its job and a repair if it somehow did not.
        if (result.outcome === 'applied' || result.outcome === 'already_applied') {
          await postAttemptSuccess(trx, attemptId, options);
        }
        return result;
      });
    case 'requires_action':
      return transitionAttempt(db, attemptId, 'requires_action', { from, processorChargeId: outcome.chargeId });
    case 'processing':
      return transitionAttempt(db, attemptId, 'processing', { from, processorChargeId: outcome.chargeId });
    case 'declined':
      return transitionAttempt(db, attemptId, 'failed', {
        from,
        failureReason: outcome.code,
        ...(outcome.chargeId ? { processorChargeId: outcome.chargeId } : {}),
      });
    case 'rejected':
      return transitionAttempt(db, attemptId, 'failed', { from, failureReason: `processor_rejected:${outcome.code}` });
    case 'unknown':
      return { outcome: 'no_change' };
  }
}

function inTransaction<T>(db: Kysely<Database>, work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  return db.isTransaction ? work(db) : db.transaction().execute(work);
}
