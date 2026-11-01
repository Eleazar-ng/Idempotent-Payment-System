import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './database.types';
import { findAttemptsMissingOutboxEvent } from './outbox';
import { checkLedgerInvariants } from './invariants';

export interface OperationalStats {
  /** Outbox events by status (all four statuses always present). */
  outboxByStatus: Record<'pending' | 'delivered' | 'skipped' | 'dead', number>;
  /** Seconds the oldest pending event that is already due has been waiting; 0 if none. */
  outboxOldestDueSeconds: number;
  /** Non-final attempts by status (all five always present). */
  attemptsByStatus: Record<'created' | 'calling_processor' | 'processing' | 'requires_action' | 'abandoned', number>;
  /** Longest idle time per non-final status, in seconds; 0 if none. */
  attemptsOldestIdleSeconds: Record<'created' | 'calling_processor' | 'processing' | 'requires_action' | 'abandoned', number>;
  openFindingsByKind: Record<string, number>;
  attemptsMissingOutboxEvent: number;
  ledgerViolations: number;
}

const OUTBOX_STATUSES = ['pending', 'delivered', 'skipped', 'dead'] as const;
const OPEN_STATUSES = ['created', 'calling_processor', 'processing', 'requires_action', 'abandoned'] as const;

/**
 * Everything the "state gauges" need, from the database, in one place. Read-only and cheap enough to run
 * on every scrape (all of it hits small partial indexes or the non-final slice of the attempts table).
 * `now` is a parameter so tests control the clock.
 */
export async function collectOperationalStats(db: Kysely<Database>, now: Date = new Date()): Promise<OperationalStats> {
  const [outbox, due, attempts, findings, missing, violations] = await Promise.all([
    db.selectFrom('outbox_events').select(['status', sql<string>`count(*)`.as('n')]).groupBy('status').execute(),
    db
      .selectFrom('outbox_events')
      .select(sql<Date | null>`min(next_attempt_at)`.as('oldest'))
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', now)
      .executeTakeFirst(),
    db
      .selectFrom('payment_attempts')
      .select(['status', sql<string>`count(*)`.as('n'), sql<Date>`min(updated_at)`.as('oldest')])
      .where('status', 'in', [...OPEN_STATUSES])
      .groupBy('status')
      .execute(),
    db
      .selectFrom('reconciliation_findings')
      .select(['kind', sql<string>`count(*)`.as('n')])
      .where('status', '=', 'open')
      .groupBy('kind')
      .execute(),
    findAttemptsMissingOutboxEvent(db),
    checkLedgerInvariants(db),
  ]);

  const outboxByStatus = Object.fromEntries(OUTBOX_STATUSES.map((s) => [s, 0])) as OperationalStats['outboxByStatus'];
  for (const r of outbox) outboxByStatus[r.status] = Number(r.n);

  const attemptsByStatus = Object.fromEntries(OPEN_STATUSES.map((s) => [s, 0])) as OperationalStats['attemptsByStatus'];
  const attemptsOldestIdleSeconds = Object.fromEntries(OPEN_STATUSES.map((s) => [s, 0])) as OperationalStats['attemptsOldestIdleSeconds'];
  for (const r of attempts) {
    const status = r.status as (typeof OPEN_STATUSES)[number];
    attemptsByStatus[status] = Number(r.n);
    attemptsOldestIdleSeconds[status] = Math.max(0, (now.getTime() - new Date(r.oldest).getTime()) / 1000);
  }

  return {
    outboxByStatus,
    outboxOldestDueSeconds: due?.oldest ? Math.max(0, (now.getTime() - new Date(due.oldest).getTime()) / 1000) : 0,
    attemptsByStatus,
    attemptsOldestIdleSeconds,
    openFindingsByKind: Object.fromEntries(findings.map((f) => [f.kind, Number(f.n)])),
    attemptsMissingOutboxEvent: missing.length,
    ledgerViolations: violations.length,
  };
}
