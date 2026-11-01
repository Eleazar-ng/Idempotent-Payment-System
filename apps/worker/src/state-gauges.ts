import type { Kysely } from 'kysely';
import { collectOperationalStats } from '@app/db';
import type { Database, OperationalStats } from '@app/db';
import type { AppMetrics } from '@app/observability';

/** Copies a stats snapshot into the gauges. Label sets are reset first so a kind with no findings left reads 0, not its old value. */
export function applyStats(metrics: AppMetrics, stats: OperationalStats): void {
  metrics.outboxEvents.reset();
  for (const [status, n] of Object.entries(stats.outboxByStatus)) metrics.outboxEvents.set({ status }, n);
  metrics.outboxOldestDueAge.set(stats.outboxOldestDueSeconds);

  metrics.attemptsInState.reset();
  metrics.attemptsOldestIdle.reset();
  for (const [status, n] of Object.entries(stats.attemptsByStatus)) metrics.attemptsInState.set({ status }, n);
  for (const [status, s] of Object.entries(stats.attemptsOldestIdleSeconds)) metrics.attemptsOldestIdle.set({ status }, s);

  metrics.findingsOpen.reset();
  for (const [kind, n] of Object.entries(stats.openFindingsByKind)) metrics.findingsOpen.set({ kind }, n);

  metrics.attemptsMissingOutboxEvent.set(stats.attemptsMissingOutboxEvent);
  metrics.ledgerViolations.set(stats.ledgerViolations);
}

/**
 * Reads the database state into the gauges, once per scrape. If the database cannot be asked, the
 * gauges keep their last values and `stats_scrape_errors_total` counts the failure: an outage must show
 * up as an error, never as a reassuring zero.
 */
export async function refreshStateGauges(db: Kysely<Database>, metrics: AppMetrics, now = new Date()): Promise<boolean> {
  try {
    applyStats(metrics, await collectOperationalStats(db, now));
    return true;
  } catch {
    metrics.statsScrapeErrors.inc();
    return false;
  }
}
