import type { Kysely } from 'kysely';
import { attemptMachine } from '../../payments-core/src';
import type { AttemptStatus } from '../../payments-core/src';
import type { Database, PaymentAttempt } from './database.types';

export interface TransitionOptions {
  /**
   * The status (or statuses) the caller believes the attempt is in right now. The update only
   * applies if the row is still in one of them, which is what makes it safe against a concurrent
   * writer (Module 4.4): a stale assumption matches zero rows instead of clobbering the truth.
   *
   * Every (from, to) pair must be a legal move. Pass several for events that may legitimately
   * arrive in more than one state, for example
   * `attemptMachine.legalPredecessors('succeeded')` for a webhook or reconciliation.
   */
  from: AttemptStatus | readonly AttemptStatus[];

  /** The processor's charge id. Set once; changing it later is refused by the database. */
  processorChargeId?: string;

  /** Required when moving to `failed`: support and reconciliation both need the reason. */
  failureReason?: string;
}

/**
 * What happened when we tried to move an attempt. The first two mean "the attempt is now in the
 * state you wanted", which is why a duplicate event is not an error. The last two mean it is not,
 * and the caller must decide what that means; the helper never guesses.
 */
export type TransitionResult =
  /** This call moved the attempt. Exactly one concurrent caller can get this outcome. */
  | { outcome: 'applied'; attempt: PaymentAttempt }
  /** Already in the target status, so a duplicate webhook, retry or redelivered message. Nothing changed. */
  | { outcome: 'already_applied'; attempt: PaymentAttempt }
  /** In some other status than expected (someone else moved it first). Nothing changed. */
  | { outcome: 'stale'; attempt: PaymentAttempt }
  | { outcome: 'not_found' };

/**
 * Moves a payment attempt to `to`, but only if it is still in the status the caller expects.
 *
 * It is one conditional UPDATE (`WHERE id = ? AND status IN (from...)`), so it needs no explicit
 * lock and no read before the write. Two requests racing to resolve the same attempt cannot both
 * win: Postgres re-checks the condition after waiting for the first writer, and the loser matches
 * zero rows. The database triggers (migration 0002) independently refuse any illegal move, so
 * this is the second of two layers, not the only one.
 *
 * Works with either a connection or a transaction, so a status change and the ledger posting that
 * goes with it can commit together (Module 8.5):
 *
 *   await db.transaction().execute(async (trx) => {
 *     const result = await transitionAttempt(trx, id, 'succeeded', { from: 'calling_processor', ... });
 *     if (result.outcome === 'applied') { ...post the ledger entries with trx... }
 *   });
 *
 * Throws InvalidTransitionError (before any query) if a requested move is not legal, and lets
 * database errors such as a changed charge id (PY002) propagate untouched.
 */
export async function transitionAttempt(
  db: Kysely<Database>,
  attemptId: number,
  to: AttemptStatus,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const from: readonly AttemptStatus[] =
    typeof options.from === 'string' ? [options.from] : options.from;

  if (from.length === 0) {
    throw new Error('transitionAttempt: `from` must name at least one status');
  }
  for (const status of from) {
    attemptMachine.assertTransition(status, to);
  }
  if (to === 'failed' && !options.failureReason) {
    throw new Error('transitionAttempt: `failureReason` is required when moving to "failed"');
  }

  const applied = await db
    .updateTable('payment_attempts')
    .set({
      status: to,
      ...(options.processorChargeId !== undefined
        ? { processor_charge_id: options.processorChargeId }
        : {}),
      ...(options.failureReason !== undefined ? { failure_reason: options.failureReason } : {}),
    })
    .where('id', '=', attemptId)
    .where('status', 'in', [...from])
    .returningAll()
    .executeTakeFirst();

  if (applied) {
    return { outcome: 'applied', attempt: applied };
  }

  // Zero rows matched. Find out why, so the caller can tell a duplicate from a lost race. This
  // read is informational only: the write above is what decided the outcome.
  const current = await db
    .selectFrom('payment_attempts')
    .selectAll()
    .where('id', '=', attemptId)
    .executeTakeFirst();

  if (!current) {
    return { outcome: 'not_found' };
  }
  return current.status === to
    ? { outcome: 'already_applied', attempt: current }
    : { outcome: 'stale', attempt: current };
}
