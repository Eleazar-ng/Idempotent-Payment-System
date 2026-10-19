import type { AttemptStatus, IntentStatus } from '../../payments-core/src';
import type { PaymentAttemptStatus, PaymentIntentStatus } from './database.types';

/**
 * The status unions exist twice on purpose: payments-core owns the state machine and must not
 * depend on the database layer, while database.types.ts describes the tables. These compile-time
 * assertions fail the build if the two ever disagree, so a status added in one place cannot be
 * forgotten in the other.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// If either line stops compiling, the two definitions have drifted apart.
const attemptStatusesAgree: Equal<AttemptStatus, PaymentAttemptStatus> = true;
const intentStatusesAgree: Equal<IntentStatus, PaymentIntentStatus> = true;

describe('status types', () => {
  it('payments-core and the database types agree (checked by the compiler)', () => {
    expect(attemptStatusesAgree).toBe(true);
    expect(intentStatusesAgree).toBe(true);
  });
});
