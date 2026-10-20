/**
 * The two ways a duplicate request is refused. A third outcome, replaying a completed response,
 * returns the stored status and body as they were, so it needs no mapping here.
 */
export type IdempotencyConflict = 'in_flight' | 'mismatch';

export interface ConflictResponse {
  status: number;
  body: { error: { code: string; message: string } };
  /** Suggested value for a Retry-After header, when retrying later makes sense. */
  retryAfterSeconds?: number;
}

export function conflictResponse(conflict: IdempotencyConflict): ConflictResponse {
  switch (conflict) {
    case 'in_flight':
      // 409: the first request is still being processed. Retrying later gets the real response.
      return {
        status: 409,
        retryAfterSeconds: 1,
        body: {
          error: {
            code: 'idempotency_request_in_progress',
            message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
          },
        },
      };
    case 'mismatch':
      // 422: same key, different request. Retrying can never succeed, so no Retry-After.
      return {
        status: 422,
        body: {
          error: {
            code: 'idempotency_key_reused',
            message: 'This Idempotency-Key was already used with a different request.',
          },
        },
      };
  }
}
