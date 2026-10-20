import { InvalidIdempotencyKeyError } from './errors';

/** Visible ASCII only (no spaces, control characters or unicode lookalikes), 1 to 255 characters. */
const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * Validates a client-supplied idempotency key. The database also checks the length, but this runs
 * first and gives the client a clear 400 instead of a constraint violation.
 */
export function assertValidIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new InvalidIdempotencyKeyError('must be a string');
  }
  if (key.length === 0) {
    throw new InvalidIdempotencyKeyError('must not be empty');
  }
  if (key.length > 255) {
    throw new InvalidIdempotencyKeyError('must be at most 255 characters');
  }
  if (!VALID_KEY.test(key)) {
    throw new InvalidIdempotencyKeyError('may contain only visible ASCII characters (no spaces)');
  }
}
