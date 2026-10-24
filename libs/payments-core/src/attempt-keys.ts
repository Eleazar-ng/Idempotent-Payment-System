/**
 * The idempotency key we send to the processor for an attempt (Module 2.3).
 *
 * It is DERIVED from the attempt's identity, not random, and it is stored on the attempt row before
 * any call is made. So every retry of the same attempt, from any request, worker or crashed-and-
 * restarted process, sends the same key and the processor collapses them into one charge. A new
 * attempt (after a decline) gets a new number and therefore a new key.
 *
 * Built from the intent id (unique across all merchants) and not from order_id (only unique per
 * merchant), because the processor sees one account: ours.
 */
export function processorIdempotencyKey(intentId: number, attemptNumber: number): string {
  if (!Number.isInteger(intentId) || intentId <= 0 || !Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new RangeError('intentId and attemptNumber must be positive integers');
  }
  return `pi_${intentId}_a${attemptNumber}`;
}
