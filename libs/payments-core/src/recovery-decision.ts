import type { AttemptStatus } from './payment-states';
import type { ProcessorOutcome } from './processor-outcome';

/**
 * What to do with an attempt, given what the processor says about its charge (Module 9).
 *
 * One pure function serves both the sweeper (which looks up one charge per stuck attempt) and the
 * reconciler (which compares everything in bulk), so the two can never disagree about what a given
 * pair of facts means. The rule behind every branch: move an attempt only when the processor has told
 * us something definitive and the move is legal; when the two sides contradict a FINAL state, do not
 * overwrite money state on the strength of a lookup, record a finding for a human instead.
 */
export type ChargeStatus = 'succeeded' | 'failed' | 'requires_action' | 'pending';

export interface ChargeSnapshot {
  id: string;
  status: ChargeStatus;
  amount: number;
  currency: string;
  failureCode?: string | null;
}

export interface AttemptSnapshot {
  status: AttemptStatus;
  /** Null until the processor has told us the charge id. */
  chargeId: string | null;
  amount: number;
  currency: string;
  /** Milliseconds since the attempt last changed. */
  idleMs: number;
  /** Milliseconds since the attempt was created (the processor's idempotency window runs from here). */
  ageMs: number;
}

export interface RecoveryPolicy {
  /** A `calling_processor` attempt idle this long is not just slow: its request is gone. Must exceed the API's worst-case call time. */
  stuckAfterMs: number;
  /** An `abandoned` attempt with no charge at the processor, older than this, never reached it. Must exceed the processor's idempotency window. */
  abandonedGraceMs: number;
}

export type FindingKind =
  /** The customer's money moved but we hold the attempt as failed. Needs a refund or a manual fix. */
  | 'paid_but_failed'
  /** We hold the attempt as failed but the processor still has an open charge that may yet capture. */
  | 'failed_but_charge_open'
  /** We booked a success; the processor says that charge did not succeed. */
  | 'succeeded_but_charge_not_succeeded'
  /** We booked a success; the processor has no such charge. */
  | 'success_without_charge'
  /** The attempt says it has a charge (processing, requires_action) but the processor has none. */
  | 'charge_missing'
  | 'amount_mismatch'
  /** The attempt is bound to one charge id, the processor's charge for our reference has another. */
  | 'charge_id_conflict'
  /** A charge at the processor that none of our attempts explains. */
  | 'orphan_charge'
  /** A charge exists for an attempt that was never sent (status created). */
  | 'unexpected_charge';

export type RecoveryDecision =
  /** The two sides agree. */
  | { action: 'none' }
  /** Nothing definitive yet; look again later. */
  | { action: 'wait'; reason: string }
  /** The processor told us the outcome: apply it through applyProcessorOutcome. */
  | { action: 'apply'; outcome: ProcessorOutcome }
  /** No trace of the charge, but too early to say it never happened: record "unknown", which keeps blocking new attempts. */
  | { action: 'abandon' }
  /** Abandoned, and the processor still has nothing after its idempotency window: it never got the request. */
  | { action: 'fail_unreached' }
  | { action: 'finding'; kind: FindingKind; detail: string };

const finding = (kind: FindingKind, detail: string): RecoveryDecision => ({ action: 'finding', kind, detail });

export function decideRecovery(
  attempt: AttemptSnapshot,
  charge: ChargeSnapshot | null,
  policy: RecoveryPolicy,
): RecoveryDecision {
  return charge === null ? decideWithoutCharge(attempt, policy) : decideWithCharge(attempt, charge, policy);
}

function decideWithoutCharge(attempt: AttemptSnapshot, policy: RecoveryPolicy): RecoveryDecision {
  switch (attempt.status) {
    case 'created':
    case 'failed':
      return { action: 'none' };
    case 'calling_processor':
      return attempt.idleMs >= policy.stuckAfterMs
        ? { action: 'abandon' }
        : { action: 'wait', reason: 'call may still be in flight' };
    case 'abandoned':
      return attempt.ageMs >= policy.abandonedGraceMs
        ? { action: 'fail_unreached' }
        : { action: 'wait', reason: 'inside the processor idempotency window' };
    case 'processing':
    case 'requires_action':
      return finding('charge_missing', `attempt is ${attempt.status} (charge ${attempt.chargeId ?? 'unknown'}) but the processor has no such charge`);
    case 'succeeded':
      return finding('success_without_charge', `attempt succeeded (charge ${attempt.chargeId ?? 'unknown'}) but the processor has no such charge`);
  }
}

function decideWithCharge(attempt: AttemptSnapshot, charge: ChargeSnapshot, policy: RecoveryPolicy): RecoveryDecision {
  if (attempt.status === 'created') {
    return finding('unexpected_charge', `charge ${charge.id} exists for an attempt that was never sent`);
  }
  if (charge.amount !== attempt.amount || charge.currency !== attempt.currency) {
    return finding('amount_mismatch', `processor charge ${charge.id} is ${charge.amount} ${charge.currency}, payment is ${attempt.amount} ${attempt.currency}`);
  }
  if (attempt.chargeId !== null && attempt.chargeId !== charge.id) {
    return finding('charge_id_conflict', `attempt is bound to ${attempt.chargeId}, processor reference points at ${charge.id}`);
  }

  // A request that may still be running gets time to finish its own bookkeeping first.
  if (attempt.status === 'calling_processor' && attempt.idleMs < policy.stuckAfterMs) {
    return { action: 'wait', reason: 'call may still be in flight' };
  }

  switch (charge.status) {
    case 'succeeded':
      switch (attempt.status) {
        case 'succeeded':
          return { action: 'none' };
        case 'failed':
          return finding('paid_but_failed', `processor charge ${charge.id} succeeded but the attempt is failed`);
        default:
          return { action: 'apply', outcome: { kind: 'succeeded', chargeId: charge.id } };
      }
    case 'failed':
      switch (attempt.status) {
        case 'failed':
          return { action: 'none' };
        case 'succeeded':
          return finding('succeeded_but_charge_not_succeeded', `attempt succeeded but processor charge ${charge.id} failed`);
        default:
          return { action: 'apply', outcome: { kind: 'declined', code: charge.failureCode ?? 'card_declined', chargeId: charge.id } };
      }
    case 'pending':
      switch (attempt.status) {
        case 'calling_processor':
          return { action: 'apply', outcome: { kind: 'processing', chargeId: charge.id } };
        case 'requires_action':
          return { action: 'apply', outcome: { kind: 'processing', chargeId: charge.id } };
        case 'processing':
          return { action: 'wait', reason: 'charge still pending at the processor' };
        case 'abandoned':
          return { action: 'wait', reason: 'charge pending; waiting for a final answer' };
        case 'succeeded':
          return finding('succeeded_but_charge_not_succeeded', `attempt succeeded but processor charge ${charge.id} is still pending`);
        case 'failed':
          return finding('failed_but_charge_open', `attempt failed but processor charge ${charge.id} is still pending`);
      }
    // eslint-disable-next-line no-fallthrough
    case 'requires_action':
      switch (attempt.status) {
        case 'calling_processor':
        case 'processing':
          return { action: 'apply', outcome: { kind: 'requires_action', chargeId: charge.id } };
        case 'requires_action':
          return { action: 'none' };
        case 'abandoned':
          return { action: 'wait', reason: 'charge needs customer action; waiting for a final answer' };
        case 'succeeded':
          return finding('succeeded_but_charge_not_succeeded', `attempt succeeded but processor charge ${charge.id} still needs customer action`);
        case 'failed':
          return finding('failed_but_charge_open', `attempt failed but processor charge ${charge.id} still needs customer action`);
      }
  }
}
