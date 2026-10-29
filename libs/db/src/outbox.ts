import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database, OutboxEvent } from './database.types';

export type PaymentEventType = 'payment.succeeded' | 'payment.failed';

/** The facts a merchant is told about. Built from the database, never from the caller's memory. */
export interface PaymentEventData {
  payment_id: string;
  order_id: string;
  amount: number;
  currency: string;
  attempt_id: number;
  attempt_number: number;
  failure_code: string | null;
}

export const paymentEventDedupeKey = (type: PaymentEventType, attemptId: number): string =>
  `${type}:attempt:${attemptId}`;

/**
 * Writes the outbox event for an attempt that has just reached a final state, in the SAME transaction
 * as that change. Idempotent: the dedupe key means the second path to the same fact writes nothing.
 *
 * Returns what happened, or undefined when the attempt is not in a state merchants are told about.
 */
export async function enqueuePaymentEvent(
  db: Kysely<Database>,
  attemptId: number,
): Promise<{ outcome: 'enqueued' | 'already_enqueued'; type: PaymentEventType } | undefined> {
  const row = await db
    .selectFrom('payment_attempts as a')
    .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
    .select([
      'a.id as attempt_id',
      'a.attempt_number',
      'a.status',
      'a.failure_reason',
      'i.id as intent_id',
      'i.merchant_id',
      'i.order_id',
      'i.amount',
      'i.currency',
    ])
    .where('a.id', '=', attemptId)
    .executeTakeFirst();
  if (!row) throw new Error(`enqueuePaymentEvent: no attempt ${attemptId}`);
  if (row.status !== 'succeeded' && row.status !== 'failed') return undefined;

  const type: PaymentEventType = row.status === 'succeeded' ? 'payment.succeeded' : 'payment.failed';
  const data: PaymentEventData = {
    payment_id: `pay_${row.intent_id}`,
    order_id: row.order_id,
    amount: row.amount,
    currency: row.currency,
    attempt_id: row.attempt_id,
    attempt_number: row.attempt_number,
    failure_code: row.status === 'failed' ? row.failure_reason : null,
  };

  const inserted = await db
    .insertInto('outbox_events')
    .values({
      dedupe_key: paymentEventDedupeKey(type, attemptId),
      merchant_id: row.merchant_id,
      event_type: type,
      payload: JSON.stringify(data),
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  return { outcome: inserted ? 'enqueued' : 'already_enqueued', type };
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  merchant_webhook_url: string | null;
  merchant_webhook_secret: string | null;
}

export interface ClaimOptions {
  now: Date;
  limit: number;
  /** How long the claim holds. After this, a crashed worker's rows become due for someone else. */
  leaseMs: number;
}

/**
 * Takes up to `limit` due events for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets any number of relays run side by side: each skips rows another
 * is claiming instead of waiting for them, so no event is claimed twice at the same moment. The claim
 * also bumps `attempts` and sets the lease, so even a worker that dies at once leaves a trace.
 */
export async function claimDueOutboxEvents(db: Kysely<Database>, options: ClaimOptions): Promise<ClaimedOutboxEvent[]> {
  const leaseEnd = new Date(options.now.getTime() + options.leaseMs);
  const claimed = await sql<{ id: number }>`
    UPDATE outbox_events SET attempts = attempts + 1, locked_until = ${leaseEnd}
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE status = 'pending'
        AND next_attempt_at <= ${options.now}
        AND (locked_until IS NULL OR locked_until <= ${options.now})
      ORDER BY next_attempt_at, id
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`.execute(db);
  if (claimed.rows.length === 0) return [];

  const rows = await db
    .selectFrom('outbox_events as e')
    .innerJoin('merchants as m', 'm.id', 'e.merchant_id')
    .selectAll('e')
    .select(['m.webhook_url as merchant_webhook_url', 'm.webhook_secret as merchant_webhook_secret'])
    .where('e.id', 'in', claimed.rows.map((r) => r.id))
    .orderBy('e.next_attempt_at')
    .orderBy('e.id')
    .execute();
  return rows as ClaimedOutboxEvent[];
}

/** Success always wins: even a worker whose lease ran out may record that the merchant said 2xx. */
export async function markOutboxDelivered(db: Kysely<Database>, id: number, now: Date): Promise<boolean> {
  const r = await db
    .updateTable('outbox_events')
    .set({ status: 'delivered', delivered_at: now, locked_until: null, last_error: null })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function markOutboxSkipped(db: Kysely<Database>, id: number, reason: string): Promise<boolean> {
  const r = await db
    .updateTable('outbox_events')
    .set({ status: 'skipped', locked_until: null, last_error: reason })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/**
 * Schedules the next try. `claimedAttempts` is a fence: if another worker has claimed the event since
 * (the lease expired while this one was slow), this stale report is ignored instead of overwriting theirs.
 */
export async function scheduleOutboxRetry(
  db: Kysely<Database>,
  id: number,
  claimedAttempts: number,
  nextAttemptAt: Date,
  error: string,
): Promise<boolean> {
  const r = await db
    .updateTable('outbox_events')
    .set({ next_attempt_at: nextAttemptAt, locked_until: null, last_error: error.slice(0, 1000) })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .where('attempts', '=', claimedAttempts)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function markOutboxDead(
  db: Kysely<Database>,
  id: number,
  claimedAttempts: number,
  error: string,
): Promise<boolean> {
  const r = await db
    .updateTable('outbox_events')
    .set({ status: 'dead', locked_until: null, last_error: error.slice(0, 1000) })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .where('attempts', '=', claimedAttempts)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/** A person fixed whatever was wrong (the merchant's endpoint, say) and wants the event tried again. */
export async function requeueDeadOutboxEvent(db: Kysely<Database>, id: number, now: Date): Promise<boolean> {
  const r = await db
    .updateTable('outbox_events')
    .set({ status: 'pending', attempts: 0, next_attempt_at: now, locked_until: null })
    .where('id', '=', id)
    .where('status', '=', 'dead')
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function listDeadOutboxEvents(db: Kysely<Database>): Promise<OutboxEvent[]> {
  return db.selectFrom('outbox_events').selectAll().where('status', '=', 'dead').orderBy('created_at').execute();
}

/**
 * Terminal attempts whose outbox event is missing. Healthy systems return nothing: the event is written
 * in the same transaction as the final status. Run by tests and, later, by reconciliation and health checks.
 */
export async function findAttemptsMissingOutboxEvent(db: Kysely<Database>): Promise<{ attempt_id: number; status: string }[]> {
  const rows = await sql<{ attempt_id: number; status: string }>`
    SELECT a.id AS attempt_id, a.status FROM payment_attempts a
    WHERE a.status IN ('succeeded', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM outbox_events e
        WHERE e.dedupe_key = CASE a.status WHEN 'succeeded' THEN 'payment.succeeded' ELSE 'payment.failed' END
                             || ':attempt:' || a.id)`.execute(db);
  return rows.rows;
}
