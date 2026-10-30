import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { AttemptStatus, RecoveryDecision } from '../../payments-core/src';
import type { Database, FindingSource, ReconciliationFinding } from './database.types';
import { transitionAttempt } from './attempts';
import { completeKey } from './idempotency';
import { enqueuePaymentEvent } from './outbox';
import { paymentResult } from './payment-response';
import { applyProcessorOutcome, getPayment } from './payments';

/** An attempt recovery may need to look at, with everything the decision needs. */
export interface RecoveryCandidate {
  attemptId: number;
  intentId: number;
  merchantId: number;
  orderId: string;
  status: AttemptStatus;
  chargeId: string | null;
  /** The processor idempotency key, also sent as `metadata.reference`: how the charge is found. */
  reference: string;
  amount: number;
  currency: string;
  idleMs: number;
  ageMs: number;
}

export interface CandidateOptions {
  now: Date;
  /** `calling_processor` (and `abandoned`) attempts idle at least this long are looked at. */
  stuckAfterMs: number;
  /** `processing` and `requires_action` attempts idle at least this long are looked at. */
  pendingAfterMs: number;
  limit: number;
}

/**
 * The attempts worth asking the processor about, oldest first. Selection only: whether anything
 * happens is decided by `decideRecovery` and applied by `applyRecoveryDecision`.
 */
export async function findRecoveryCandidates(db: Kysely<Database>, options: CandidateOptions): Promise<RecoveryCandidate[]> {
  const stuckBefore = new Date(options.now.getTime() - options.stuckAfterMs);
  const pendingBefore = new Date(options.now.getTime() - options.pendingAfterMs);
  const rows = await db
    .selectFrom('payment_attempts as a')
    .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
    .select([
      'a.id as attempt_id',
      'a.status',
      'a.processor_charge_id',
      'a.processor_idempotency_key',
      'a.created_at',
      'a.updated_at',
      'i.id as intent_id',
      'i.merchant_id',
      'i.order_id',
      'i.amount',
      'i.currency',
    ])
    .where((eb) =>
      eb.or([
        eb.and([eb('a.status', 'in', ['calling_processor', 'abandoned']), eb('a.updated_at', '<=', stuckBefore)]),
        eb.and([eb('a.status', 'in', ['processing', 'requires_action']), eb('a.updated_at', '<=', pendingBefore)]),
      ]),
    )
    .orderBy('a.updated_at')
    .orderBy('a.id')
    .limit(options.limit)
    .execute();
  return rows.map((r) => toCandidate(r, options.now));
}

interface CandidateRow {
  attempt_id: number;
  status: AttemptStatus;
  processor_charge_id: string | null;
  processor_idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  intent_id: number;
  merchant_id: number;
  order_id: string;
  amount: number;
  currency: string;
}

function toCandidate(r: CandidateRow, now: Date): RecoveryCandidate {
  return {
    attemptId: r.attempt_id,
    intentId: r.intent_id,
    merchantId: r.merchant_id,
    orderId: r.order_id,
    status: r.status,
    chargeId: r.processor_charge_id,
    reference: r.processor_idempotency_key,
    amount: r.amount,
    currency: r.currency,
    idleMs: Math.max(0, now.getTime() - r.updated_at.getTime()),
    ageMs: Math.max(0, now.getTime() - r.created_at.getTime()),
  };
}

/**
 * What the reconciler compares: every attempt created inside the lookback, plus every attempt that is not
 * final whatever its age (a payment that is still unresolved is always worth another look).
 */
export async function loadAttemptsForReconciliation(
  db: Kysely<Database>,
  options: { now: Date; createdAfter: Date },
): Promise<RecoveryCandidate[]> {
  const rows = await db
    .selectFrom('payment_attempts as a')
    .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
    .select([
      'a.id as attempt_id',
      'a.status',
      'a.processor_charge_id',
      'a.processor_idempotency_key',
      'a.created_at',
      'a.updated_at',
      'i.id as intent_id',
      'i.merchant_id',
      'i.order_id',
      'i.amount',
      'i.currency',
    ])
    .where((eb) =>
      eb.or([eb('a.created_at', '>=', options.createdAfter), eb('a.status', 'not in', ['created', 'succeeded', 'failed'])]),
    )
    .orderBy('a.id')
    .execute();
  return rows.map((r) => toCandidate(r, options.now));
}

export type ApplyRecoveryResult =
  | { applied: true; attemptStatus: AttemptStatus | 'unchanged' }
  /** Nothing to do, or someone else moved the attempt first. The state is not wrong; try again next pass. */
  | { applied: false; reason: 'nothing_to_do' | 'stale' | 'already_applied' | 'finding' };

const FROM = {
  succeeded: ['calling_processor', 'processing', 'abandoned'],
  declined: ['calling_processor', 'processing', 'requires_action', 'abandoned'],
  processing: ['calling_processor', 'requires_action'],
  requires_action: ['calling_processor', 'processing'],
} as const;

/**
 * Carries out a decision that changes state. Everything it does, including finishing the idempotency
 * key the original request left hanging, happens in ONE transaction, and every step is conditional on
 * the status the decision was made against, so a race with the API, a webhook or another sweeper
 * ends with one winner and no damage (the loser reports `stale`).
 */
export async function applyRecoveryDecision(
  db: Kysely<Database>,
  candidate: RecoveryCandidate,
  decision: RecoveryDecision,
  options: { feeBps: number },
): Promise<ApplyRecoveryResult> {
  const run = <T>(work: (trx: Kysely<Database>) => Promise<T>) =>
    db.isTransaction ? work(db) : db.transaction().execute(work);

  switch (decision.action) {
    case 'none':
    case 'wait':
      return { applied: false, reason: 'nothing_to_do' };
    case 'finding':
      return { applied: false, reason: 'finding' };

    case 'apply':
      return run(async (trx) => {
        const outcome = decision.outcome;
        if (outcome.kind === 'succeeded' && candidate.status === 'requires_action') {
          // requires_action -> succeeded is not a legal edge; the legal route goes through processing.
          await transitionAttempt(trx, candidate.attemptId, 'processing', { from: 'requires_action' });
        }
        const from =
          outcome.kind === 'succeeded'
            ? FROM.succeeded
            : outcome.kind === 'declined'
              ? FROM.declined
              : outcome.kind === 'processing'
                ? FROM.processing
                : outcome.kind === 'requires_action'
                  ? FROM.requires_action
                  : undefined;
        if (!from) return { applied: false, reason: 'nothing_to_do' } as const;

        const result = await applyProcessorOutcome(trx, candidate.attemptId, outcome, from, options);
        if (result.outcome === 'stale' || result.outcome === 'not_found' || result.outcome === 'no_change') {
          return { applied: false, reason: 'stale' } as const;
        }
        // Already there (a webhook or another sweeper won): applyProcessorOutcome has re-checked the
        // booking and the merchant event; finishing a still-open key is the remaining repair.
        await completeOpenKeyForAttempt(trx, candidate.attemptId);
        if (result.outcome === 'already_applied') return { applied: false, reason: 'already_applied' } as const;
        return { applied: true, attemptStatus: result.attempt.status } as const;
      });

    case 'abandon':
      return run(async (trx) => {
        const result = await transitionAttempt(trx, candidate.attemptId, 'abandoned', { from: 'calling_processor' });
        if (result.outcome !== 'applied') return { applied: false, reason: 'stale' } as const;
        await completeOpenKeyForAttempt(trx, candidate.attemptId);
        return { applied: true, attemptStatus: 'abandoned' } as const;
      });

    case 'fail_unreached':
      return run(async (trx) => {
        const result = await transitionAttempt(trx, candidate.attemptId, 'failed', {
          from: 'abandoned',
          failureReason: 'never_reached_processor',
        });
        if (result.outcome !== 'applied') return { applied: false, reason: 'stale' } as const;
        await enqueuePaymentEvent(trx, candidate.attemptId);
        await completeOpenKeyForAttempt(trx, candidate.attemptId);
        return { applied: true, attemptStatus: 'failed' } as const;
      });
  }
}

/**
 * Finishes the idempotency key a dead request left in flight, storing exactly the answer the API would
 * have given for the payment as it is now. A client that retries with the same key then gets that answer
 * instead of "still in progress" forever. No-op if the key is already complete or there is none.
 */
export async function completeOpenKeyForAttempt(db: Kysely<Database>, attemptId: number): Promise<boolean> {
  const key = await db
    .selectFrom('idempotency_keys as k')
    .innerJoin('payment_attempts as a', 'a.id', 'k.attempt_id')
    .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
    .select(['k.merchant_id', 'k.idempotency_key', 'i.id as intent_id'])
    .where('k.attempt_id', '=', attemptId)
    .where('k.completed_at', 'is', null)
    .executeTakeFirst();
  if (!key) return false;

  const record = await getPayment(db, key.merchant_id, key.intent_id);
  if (!record) return false;
  const result = paymentResult(record.intent, record.latestAttempt);
  const done = await completeKey(db, {
    merchantId: key.merchant_id,
    key: key.idempotency_key,
    attemptId,
    response: { status: result.status, body: result.body as never },
  });
  return done.outcome !== 'already_completed';
}

/**
 * Keys still "in flight" although their attempt has moved on (a webhook finished the payment while the
 * request that started it was dead). Completes them. Attempts still in `calling_processor` are left to
 * the sweeper's decision, which may or may not change them.
 */
export async function completeOrphanedKeys(
  db: Kysely<Database>,
  options: { now: Date; olderThanMs: number; limit: number },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.olderThanMs);
  const rows = await db
    .selectFrom('idempotency_keys as k')
    .innerJoin('payment_attempts as a', 'a.id', 'k.attempt_id')
    .select('k.attempt_id')
    .where('k.completed_at', 'is', null)
    .where('k.created_at', '<=', cutoff)
    .where('a.status', 'not in', ['created', 'calling_processor'])
    .limit(options.limit)
    .execute();
  let completed = 0;
  for (const row of rows) {
    if (row.attempt_id !== null && (await db.transaction().execute((trx) => completeOpenKeyForAttempt(trx, row.attempt_id as number)))) {
      completed++;
    }
  }
  return completed;
}

/**
 * Deletes claims that never produced an attempt (the request died between claiming the key and starting
 * the payment), so the client's retry is treated as new. Safe because no attempt exists: money cannot
 * have moved. The age threshold keeps it from racing a request that is merely slow.
 */
export async function releaseStaleClaims(
  db: Kysely<Database>,
  options: { now: Date; olderThanMs: number },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.olderThanMs);
  const result = await db
    .deleteFrom('idempotency_keys')
    .where('attempt_id', 'is', null)
    .where('completed_at', 'is', null)
    .where('created_at', '<=', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

// ---- findings ----------------------------------------------------------------------------------

/** What the system writes when a finding stops being observed. Anything else was written by a person. */
export const AUTO_RESOLUTION = 'no longer observed';

export interface FindingInput {
  kind: string;
  source: FindingSource;
  dedupeKey: string;
  attemptId?: number | null;
  chargeId?: string | null;
  detail: string;
  now: Date;
}

/**
 * Records a discrepancy, once. Seeing it again bumps `seen_count` and `last_seen_at` (and reopens it if
 * it had been resolved and came back), instead of creating a second row.
 */
export async function recordFinding(
  db: Kysely<Database>,
  input: FindingInput,
): Promise<{ outcome: 'created' | 'seen_again'; id: number }> {
  const row = await db
    .insertInto('reconciliation_findings')
    .values({
      dedupe_key: input.dedupeKey,
      kind: input.kind,
      source: input.source,
      attempt_id: input.attemptId ?? null,
      charge_id: input.chargeId ?? null,
      detail: input.detail,
      first_seen_at: input.now,
      last_seen_at: input.now,
    })
    .onConflict((oc) =>
      oc.column('dedupe_key').doUpdateSet({
        seen_count: sql`reconciliation_findings.seen_count + 1`,
        last_seen_at: input.now,
        detail: input.detail,
        // A finding closed by the system ("no longer observed") that comes back is open again. One closed
        // by a person stays closed: they looked, decided, and said why; the discrepancy may well persist
        // forever (a charge that was refunded still reads as succeeded) and must not nag every run.
        status: sql`CASE WHEN reconciliation_findings.status = 'resolved' AND reconciliation_findings.resolution <> ${AUTO_RESOLUTION} THEN 'resolved' ELSE 'open' END`,
        resolved_at: sql`CASE WHEN reconciliation_findings.status = 'resolved' AND reconciliation_findings.resolution <> ${AUTO_RESOLUTION} THEN reconciliation_findings.resolved_at ELSE NULL END`,
        resolution: sql`CASE WHEN reconciliation_findings.status = 'resolved' AND reconciliation_findings.resolution <> ${AUTO_RESOLUTION} THEN reconciliation_findings.resolution ELSE NULL END`,
      }),
    )
    .returning(['id', sql<boolean>`(xmax = 0)`.as('inserted')])
    .executeTakeFirstOrThrow();
  return { outcome: row.inserted ? 'created' : 'seen_again', id: row.id };
}

export async function resolveFinding(db: Kysely<Database>, id: number, resolution: string, now: Date): Promise<boolean> {
  if (resolution.trim() === '') throw new Error('a resolution must say what was done');
  const r = await db
    .updateTable('reconciliation_findings')
    .set({ status: 'resolved', resolved_at: now, resolution })
    .where('id', '=', id)
    .where('status', '=', 'open')
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/**
 * After a full comparison: an open finding whose subject was EXAMINED in this pass and not flagged again
 * describes a discrepancy that is gone (a late webhook landed, a charge was settled). Closes it, saying
 * so ("no longer observed").
 *
 * Findings about things that were not examined (an attempt older than the lookback, a charge outside it)
 * stay open: silence about something nobody looked at is not evidence it was fixed, and a money
 * discrepancy must never be closed by simply ageing out of the window.
 */
export async function resolveFindingsNoLongerObserved(
  db: Kysely<Database>,
  options: {
    sources: readonly FindingSource[];
    seenBefore: Date;
    now: Date;
    examinedAttemptIds: ReadonlySet<number>;
    examinedChargeIds: ReadonlySet<string>;
  },
): Promise<number> {
  const open = await db
    .selectFrom('reconciliation_findings')
    .select(['id', 'attempt_id', 'charge_id'])
    .where('source', 'in', [...options.sources])
    .where('status', '=', 'open')
    .where('last_seen_at', '<', options.seenBefore)
    .execute();
  const ids = open
    .filter((f) =>
      f.attempt_id !== null
        ? options.examinedAttemptIds.has(f.attempt_id)
        : f.charge_id !== null && options.examinedChargeIds.has(f.charge_id),
    )
    .map((f) => f.id);
  if (ids.length === 0) return 0;
  const r = await db
    .updateTable('reconciliation_findings')
    .set({ status: 'resolved', resolved_at: options.now, resolution: AUTO_RESOLUTION })
    .where('id', 'in', ids)
    .where('status', '=', 'open')
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

export async function listOpenFindings(db: Kysely<Database>, kind?: string): Promise<ReconciliationFinding[]> {
  let q = db.selectFrom('reconciliation_findings').selectAll().where('status', '=', 'open');
  if (kind) q = q.where('kind', '=', kind);
  return q.orderBy('first_seen_at').orderBy('id').execute();
}

/**
 * Webhook events recorded as conflict, mismatch or unmatched (Stage 7) get a finding, so they have an
 * owner and a resolution instead of sitting in a table nobody reads. Idempotent.
 */
export async function ingestWebhookAttentionAsFindings(db: Kysely<Database>, now: Date): Promise<number> {
  const events = await db
    .selectFrom('webhook_events')
    .select(['id', 'event_id', 'result', 'attempt_id', 'detail', 'payload'])
    .where('result', 'in', ['conflict', 'mismatch', 'unmatched'])
    .execute();
  let created = 0;
  for (const event of events) {
    const charge = (event.payload as { data?: { object?: { id?: unknown } } }).data?.object?.id;
    // Create-only: once someone has owned and resolved it, ingesting again must not reopen it.
    const inserted = await db
      .insertInto('reconciliation_findings')
      .values({
        dedupe_key: `webhook_event:${event.id}`,
        kind: `webhook_${event.result}`,
        source: 'webhook',
        attempt_id: event.attempt_id,
        charge_id: typeof charge === 'string' ? charge : null,
        detail: `event ${event.event_id}: ${event.detail ?? event.result}`,
        first_seen_at: now,
        last_seen_at: now,
      })
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) created++;
  }
  return created;
}
