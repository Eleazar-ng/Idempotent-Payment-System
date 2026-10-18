import { createStateMachine } from './state-machine';

/**
 * The payment attempt machine (Module 5.3, with the Module 8.8 correction: refunds and disputes
 * are separate entities, so they are not attempt statuses).
 *
 *   created ─► calling_processor ─┬─► processing ──────┬─► succeeded
 *                                 ├─► requires_action ─┤─► failed
 *                                 ├─► succeeded        └─► abandoned
 *                                 ├─► failed
 *                                 └─► abandoned ─┬─► succeeded   (reconciliation found it did succeed)
 *                                                └─► failed      (reconciliation found it did not)
 *
 * Must match migration 0002 exactly; a test enforces that.
 */
export const attemptMachine = createStateMachine({
  name: 'payment_attempt',
  initial: 'created',
  transitions: {
    created: ['calling_processor'],
    calling_processor: ['processing', 'requires_action', 'succeeded', 'failed', 'abandoned'],
    processing: ['requires_action', 'succeeded', 'failed', 'abandoned'],
    requires_action: ['processing', 'failed'],
    abandoned: ['succeeded', 'failed'],
    succeeded: [],
    failed: [],
  },
});

/** The payment intent machine (Module 5.9): did this order get paid, ultimately? */
export const intentMachine = createStateMachine({
  name: 'payment_intent',
  initial: 'open',
  transitions: {
    open: ['succeeded', 'canceled'],
    succeeded: [],
    canceled: [],
  },
});

export type AttemptStatus = (typeof attemptMachine.statuses)[number];
export type IntentStatus = (typeof intentMachine.statuses)[number];

/**
 * An attempt is "active" in every status except failed. This is exactly the predicate of the
 * database's partial unique index (at most one active attempt per intent), and it deliberately
 * includes abandoned: an unknown outcome blocks a new attempt until it is resolved, because it
 * may still turn out to have succeeded (see migration 0003).
 */
export function isActiveAttemptStatus(status: AttemptStatus): boolean {
  return status !== 'failed';
}
