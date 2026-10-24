import type { AttemptStatus } from './payment-states';

/** The status customers and merchants see. Deliberately coarser than the internal attempt machine. */
export type PaymentStatus = 'succeeded' | 'processing' | 'requires_action' | 'failed';

/**
 * Maps the latest attempt to the public status.
 *
 * `abandoned` and `calling_processor` are both "processing" to the outside: we are still working out
 * what happened, and saying "failed" would invite a second payment while the first may have
 * succeeded. Only a definitive `failed` attempt is reported as failed.
 */
export function derivePaymentStatus(latestAttempt: AttemptStatus | undefined): PaymentStatus {
  switch (latestAttempt) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'requires_action':
      return 'requires_action';
    default:
      return 'processing';
  }
}
