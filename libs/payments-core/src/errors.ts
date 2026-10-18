/**
 * Thrown when code asks for a status move the state machine does not allow.
 *
 * This is a programmer error, not a runtime condition to retry: it means the caller believed a
 * transition was legal when it is not. The database refuses the same moves (SQLSTATE PY001), so
 * this check fails fast, before any query, with a clearer message.
 */
export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';

  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    // Same wording as the database trigger, so logs read the same from either layer.
    super(`Invalid ${entity} status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
