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

/**
 * Thrown when a value cannot be given one single canonical form (undefined, NaN, a Date, a
 * circular reference...). Hashing such a value would make "the same request" depend on accidents
 * of serialization, so it is refused instead (Module 3.4).
 */
export class NonCanonicalValueError extends Error {
  readonly code = 'NON_CANONICAL_VALUE';

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Cannot canonicalize value at ${path}: ${reason}`);
    this.name = 'NonCanonicalValueError';
  }
}

/** A stored hash names a version this build has no function for. Never guess: fail loudly. */
export class UnknownHashVersionError extends Error {
  readonly code = 'UNKNOWN_HASH_VERSION';

  constructor(readonly version: number) {
    super(`No request hash function is registered for version ${version}`);
    this.name = 'UnknownHashVersionError';
  }
}

/** The client-supplied idempotency key is not acceptable (a 400, never a database problem). */
export class InvalidIdempotencyKeyError extends Error {
  readonly code = 'INVALID_IDEMPOTENCY_KEY';

  constructor(reason: string) {
    super(`Invalid idempotency key: ${reason}`);
    this.name = 'InvalidIdempotencyKeyError';
  }
}
