import type { Kysely } from 'kysely';
import type { WebhookEvent as ParsedEvent } from '@app/payments-core';
import type { Database, PaymentAttempt, WebhookEvent, WebhookEventResult } from './database.types';
import { transitionAttempt } from './attempts';
import { applyProcessorOutcome } from './payments';

export interface HandleWebhookInput {
  /** Which processor sent it. Event ids are only unique per source. */
  source: string;
  event: ParsedEvent;
  /** The verified payload, stored as received. */
  payload: unknown;
  /** Platform fee setting, passed through to the ledger posting a success triggers. */
  feeBps: number;
}

export type HandleWebhookResult =
  /** First time this event id was seen: it was handled and recorded, in one transaction. */
  | { duplicate: false; result: Exclude<WebhookEventResult, 'received'>; attemptId: number | null; detail: string | null }
  /** The event id was already handled. Nothing was done; `result` is what the first handling decided. */
  | { duplicate: true; result: Exclude<WebhookEventResult, 'received'> };

/**
 * Handles one verified webhook event, exactly once per (source, event id).
 *
 * Everything happens in ONE transaction: claim the event id, find the attempt, apply the outcome
 * (which also books the ledger), record the verdict. Consequences:
 *
 *  - Duplicates: a second delivery of the same event hits the unique key and does nothing. If the
 *    first is still running, the second waits on that key, then sees it finished.
 *  - Failure: if anything throws, the claim rolls back with the effect. The caller answers 5xx and the
 *    processor redelivers; nothing was half-done and nothing was marked as seen.
 *  - Disagreement is recorded, not forced: an amount or currency mismatch, an unknown charge, or an
 *    event that contradicts a final state is stored as `mismatch`, `unmatched` or `conflict` and
 *    acknowledged (retrying cannot change the answer). Those rows are what reconciliation works through.
 *  - Ordering: a "succeeded" for an attempt that is already succeeded (the API response won the race)
 *    is `already_applied`. An attempt that was waiting on the customer (`requires_action`) is stepped
 *    through `processing` first, because that is the only legal route to `succeeded`.
 */
export async function handleWebhookEvent(db: Kysely<Database>, input: HandleWebhookInput): Promise<HandleWebhookResult> {
  const run = (trx: Kysely<Database>) => handle(trx, input);
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

async function handle(trx: Kysely<Database>, { source, event, payload, feeBps }: HandleWebhookInput): Promise<HandleWebhookResult> {
  const claimed = await trx
    .insertInto('webhook_events')
    .values({ source, event_id: event.eventId, event_type: event.type, payload: JSON.stringify(payload) })
    .onConflict((oc) => oc.columns(['source', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!claimed) {
    const existing = await trx
      .selectFrom('webhook_events')
      .select('result')
      .where('source', '=', source)
      .where('event_id', '=', event.eventId)
      .executeTakeFirstOrThrow();
    return { duplicate: true, result: existing.result as Exclude<WebhookEventResult, 'received'> };
  }

  const verdict = await decide(trx, event, feeBps);

  await trx
    .updateTable('webhook_events')
    .set({
      result: verdict.result,
      attempt_id: verdict.attemptId,
      detail: verdict.detail,
      processed_at: new Date(),
    })
    .where('id', '=', claimed.id)
    .execute();

  return { duplicate: false, ...verdict };
}

interface Verdict {
  result: Exclude<WebhookEventResult, 'received'>;
  attemptId: number | null;
  detail: string | null;
}

const SUCCEEDABLE = ['calling_processor', 'processing', 'abandoned'] as const;
const FAILABLE = ['calling_processor', 'processing', 'requires_action', 'abandoned'] as const;

async function decide(trx: Kysely<Database>, event: ParsedEvent, feeBps: number): Promise<Verdict> {
  if (event.kind === 'ignored') {
    return { result: 'ignored', attemptId: null, detail: `no handler for ${event.type}` };
  }

  const { charge } = event;
  const found = await findAttempt(trx, charge.chargeId, charge.reference);
  if (!found) {
    return { result: 'unmatched', attemptId: null, detail: `no attempt for charge ${charge.chargeId} (reference ${charge.reference ?? 'none'})` };
  }
  const { attempt, amount, currency } = found;

  if (charge.amount !== amount || charge.currency !== currency) {
    return {
      result: 'mismatch',
      attemptId: attempt.id,
      detail: `event says ${charge.amount} ${charge.currency}, payment is ${amount} ${currency}`,
    };
  }
  if (attempt.processor_charge_id !== null && attempt.processor_charge_id !== charge.chargeId) {
    return {
      result: 'conflict',
      attemptId: attempt.id,
      detail: `attempt is bound to charge ${attempt.processor_charge_id}, event is for ${charge.chargeId}`,
    };
  }

  if (event.kind === 'charge_succeeded') {
    if (attempt.status === 'requires_action') {
      await transitionAttempt(trx, attempt.id, 'processing', { from: 'requires_action' });
    }
    const outcome = await applyProcessorOutcome(
      trx,
      attempt.id,
      { kind: 'succeeded', chargeId: charge.chargeId },
      SUCCEEDABLE,
      { feeBps },
    );
    return verdictOf(outcome, attempt.id, 'succeeded');
  }

  const outcome = await applyProcessorOutcome(
    trx,
    attempt.id,
    { kind: 'declined', code: charge.failureCode ?? 'card_declined', chargeId: charge.chargeId },
    FAILABLE,
    { feeBps },
  );
  return verdictOf(outcome, attempt.id, 'failed');
}

function verdictOf(
  outcome: Awaited<ReturnType<typeof applyProcessorOutcome>>,
  attemptId: number,
  wanted: 'succeeded' | 'failed',
): Verdict {
  switch (outcome.outcome) {
    case 'applied':
      return { result: 'applied', attemptId, detail: null };
    case 'already_applied':
      return { result: 'already_applied', attemptId, detail: null };
    case 'stale':
      // The processor says one thing and we hold the opposite, final answer. Never overwrite money
      // state on the strength of a message; park it for reconciliation.
      return { result: 'conflict', attemptId, detail: `processor says ${wanted}, attempt is ${outcome.attempt.status}` };
    case 'not_found':
    case 'no_change':
      throw new Error(`unexpected outcome ${outcome.outcome} for attempt ${attemptId}`);
  }
}

async function findAttempt(
  trx: Kysely<Database>,
  chargeId: string,
  reference: string | undefined,
): Promise<{ attempt: PaymentAttempt; amount: number; currency: string } | undefined> {
  const base = () =>
    trx
      .selectFrom('payment_attempts as a')
      .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
      .selectAll('a')
      .select(['i.amount as intent_amount', 'i.currency as intent_currency']);

  // The charge id is definitive once we have it. Before that (the response is still on its way, or was
  // lost) the reference we put in the charge request is the link back to the attempt.
  let row = await base().where('a.processor_charge_id', '=', chargeId).executeTakeFirst();
  if (!row && reference) row = await base().where('a.processor_idempotency_key', '=', reference).executeTakeFirst();
  if (!row) return undefined;

  const { intent_amount, intent_currency, ...attempt } = row;
  return { attempt: attempt as PaymentAttempt, amount: intent_amount, currency: intent_currency };
}

/** Events that need a human or reconciliation: disagreements and charges we cannot explain. */
export async function listWebhookEventsNeedingAttention(db: Kysely<Database>): Promise<WebhookEvent[]> {
  return db
    .selectFrom('webhook_events')
    .selectAll()
    .where('result', 'in', ['mismatch', 'conflict', 'unmatched'])
    .orderBy('received_at')
    .execute();
}
