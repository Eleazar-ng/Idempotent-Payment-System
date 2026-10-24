import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { assertValidIdempotencyKey, requestHasher } from '@app/payments-core';
import type { RequestFingerprint, RequestHasher } from '@app/payments-core';
import type { Database, IdempotencyKey, Json } from './database.types';

/** The response a completed request produced; what every duplicate gets back, byte for meaning. */
export interface StoredResponse {
  status: number;
  body: Json | null;
}

export interface ClaimInput {
  merchantId: number;
  /** The client's Idempotency-Key. Validated before any query. */
  key: string;
  /** What the key is bound to: the operation and the request body. */
  request: RequestFingerprint;
  /** Only tests that exercise hash versioning need to pass this. */
  hasher?: RequestHasher;
}

/**
 * The four things that can happen when a request arrives with an idempotency key (Module 3.3).
 * Exactly one concurrent caller for a key ever gets `claimed`.
 */
export type ClaimResult =
  /** First time this key is seen: the caller now owns it and must do the work, then completeKey(). */
  | { outcome: 'claimed'; record: IdempotencyKey }
  /** The same request already finished: return `response` as-is and do no work. */
  | { outcome: 'replay'; record: IdempotencyKey; response: StoredResponse }
  /** The same request is still being processed by someone else: answer 409, tell the client to retry. */
  | { outcome: 'in_flight'; record: IdempotencyKey }
  /** The key was used with a different request: answer 422. Checked before everything else. */
  | { outcome: 'mismatch'; record: IdempotencyKey };

/**
 * Rounds of insert-then-read before giving up. More than one is needed only when the existing row
 * is deleted (by expiry cleanup) in the instant between our failed insert and our read.
 */
const MAX_CLAIM_ROUNDS = 5;

/**
 * Atomically claims an idempotency key, or says what already happened to it (Module 3.2).
 *
 * The claim is one statement, `INSERT ... ON CONFLICT DO NOTHING`, so the database decides who is
 * first. There is no "check, then insert" window for two requests to both slip through. A loser
 * of the race learns about the winner from a second, plain read.
 *
 * Calling conventions that matter:
 * - Call it on the pool (autocommit), NOT inside a long transaction. The claim has to be visible
 *   to other requests immediately, so they see `in_flight`; a claim held inside an open
 *   transaction makes every duplicate wait on that transaction's row lock instead.
 * - It must run at READ COMMITTED (Postgres' default). Under REPEATABLE READ the follow-up read
 *   could not see the winner's row.
 *
 * The hash is computed here with the current version and stored with that version number; an
 * existing row is compared using ITS OWN version, so changing the hash function later cannot turn
 * a client's retry into a false mismatch.
 */
export async function claimKey(db: Kysely<Database>, input: ClaimInput): Promise<ClaimResult> {
  assertValidIdempotencyKey(input.key);
  const hasher = input.hasher ?? requestHasher;
  const fresh = hasher.hash(input.request); // also validates the body before any query

  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const inserted = await db
      .insertInto('idempotency_keys')
      .values({
        merchant_id: input.merchantId,
        idempotency_key: input.key,
        request_hash: fresh.hash,
        hash_version: fresh.version,
      })
      .onConflict((oc) => oc.columns(['merchant_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return { outcome: 'claimed', record: inserted };
    }

    const existing = await db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('merchant_id', '=', input.merchantId)
      .where('idempotency_key', '=', input.key)
      .executeTakeFirst();

    if (!existing) {
      continue; // deleted in the gap: try to claim it again
    }
    return classifyExisting(existing, input.request, hasher);
  }

  throw new Error(
    `claimKey: could not settle idempotency key for merchant ${input.merchantId} after ${MAX_CLAIM_ROUNDS} rounds`,
  );
}

function classifyExisting(
  existing: IdempotencyKey,
  request: RequestFingerprint,
  hasher: RequestHasher,
): ClaimResult {
  // Payload mismatch wins over everything, including a finished request: replaying the response of
  // a DIFFERENT request would hand the client a result for something it never asked for.
  const sameRequest = hasher.matches(
    { hash: existing.request_hash, version: existing.hash_version },
    request,
  );
  if (!sameRequest) {
    return { outcome: 'mismatch', record: existing };
  }

  if (existing.completed_at !== null && existing.response_status !== null) {
    return {
      outcome: 'replay',
      record: existing,
      response: { status: existing.response_status, body: existing.response_body ?? null },
    };
  }
  return { outcome: 'in_flight', record: existing };
}

export interface CompleteInput {
  merchantId: number;
  key: string;
  /** What to store and replay. `status` is the HTTP status; `body` is any JSON (omit for none). */
  response: { status: number; body?: Json };
  /** Link the key to the payment attempt it produced, in the same write as the response. */
  attemptId?: number;
}

export type CompleteResult =
  /** This call stored the response. */
  | { outcome: 'completed'; record: IdempotencyKey }
  /**
   * The key had already been completed (by an earlier call). Nothing was changed; `response` is
   * the ORIGINAL one, and it is the one the caller must send, whatever it computed itself.
   */
  | { outcome: 'already_completed'; record: IdempotencyKey; response: StoredResponse }
  | { outcome: 'not_found' };

/**
 * Stores the response for a claimed key, once (Module 3.4). One conditional UPDATE
 * (`WHERE completed_at IS NULL`): the first call wins, later calls change nothing and get the
 * stored response back. The database independently freezes a completed row.
 *
 * Pass a transaction to commit the response together with the work it describes.
 */
export async function completeKey(db: Kysely<Database>, input: CompleteInput): Promise<CompleteResult> {
  assertValidIdempotencyKey(input.key);
  const { status, body } = input.response;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError(`completeKey: response status must be an integer from 100 to 599, got ${status}`);
  }

  const updated = await db
    .updateTable('idempotency_keys')
    .set({
      response_status: status,
      response_body: body === undefined ? null : JSON.stringify(body),
      completed_at: sql<Date>`now()`,
      ...(input.attemptId !== undefined ? { attempt_id: input.attemptId } : {}),
    })
    .where('merchant_id', '=', input.merchantId)
    .where('idempotency_key', '=', input.key)
    .where('completed_at', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (updated) {
    return { outcome: 'completed', record: updated };
  }

  const current = await db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('merchant_id', '=', input.merchantId)
    .where('idempotency_key', '=', input.key)
    .executeTakeFirst();

  if (!current) {
    return { outcome: 'not_found' };
  }
  return {
    outcome: 'already_completed',
    record: current,
    response: { status: current.response_status as number, body: current.response_body ?? null },
  };
}

/**
 * Gives up a claim so the client's retry can start fresh: for a request that failed before it
 * caused any side effect (a validation error, an outage before the attempt existed).
 *
 * It only deletes a claim that is still in flight AND has no payment attempt linked. Once an
 * attempt exists money may be moving, so the claim must stay until it completes. Returns whether
 * a claim was released.
 */
export async function releaseClaim(db: Kysely<Database>, merchantId: number, key: string): Promise<boolean> {
  assertValidIdempotencyKey(key);
  const result = await db
    .deleteFrom('idempotency_keys')
    .where('merchant_id', '=', merchantId)
    .where('idempotency_key', '=', key)
    .where('completed_at', 'is', null)
    .where('attempt_id', 'is', null)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/**
 * Records which payment attempt a claimed key produced, in the same transaction that creates the
 * attempt. From this moment `releaseClaim` refuses to delete the claim: money may be about to move,
 * so the key must stay until the request completes or recovery resolves it.
 *
 * Returns false if the key is already completed, or already linked to a different attempt.
 */
export async function attachAttempt(
  db: Kysely<Database>,
  merchantId: number,
  key: string,
  attemptId: number,
): Promise<boolean> {
  assertValidIdempotencyKey(key);
  const result = await db
    .updateTable('idempotency_keys')
    .set({ attempt_id: attemptId })
    .where('merchant_id', '=', merchantId)
    .where('idempotency_key', '=', key)
    .where('completed_at', 'is', null)
    .where((eb) => eb.or([eb('attempt_id', 'is', null), eb('attempt_id', '=', attemptId)]))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
