import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Every metric the system exports, defined in one place so the names, labels and units can be reviewed
 * together and the alert rules in docs/observability.md can be checked against them.
 *
 * Label rule (tested): labels hold a small fixed set of values (a status, a result, a kind). Never a
 * merchant id, order id, attempt id, charge id, idempotency key or error text. One label value per
 * customer turns a metrics server into a database that runs out of memory.
 */
export interface AppMetrics {
  registry: Registry;

  // API: HTTP
  httpRequests: Counter<'method' | 'route' | 'status_class'>;
  httpDuration: Histogram<'method' | 'route'>;

  // API: authentication
  authAttempts: Counter<'result'>;

  // API: payment flow
  idempotencyClaims: Counter<'result'>;
  paymentOutcomes: Counter<'result'>;
  processorCalls: Counter<'result'>;
  processorCallDuration: Histogram<string>;
  webhookEvents: Counter<'result'>;

  // Worker: jobs
  outboxDeliveries: Counter<'result'>;
  recoveryActions: Counter<'action'>;
  recoveryRuns: Counter<'job' | 'result'>;
  findingsRecorded: Counter<'kind'>;

  // Worker: state read from the database at scrape time
  outboxEvents: Gauge<'status'>;
  outboxOldestDueAge: Gauge<string>;
  attemptsInState: Gauge<'status'>;
  attemptsOldestIdle: Gauge<'status'>;
  findingsOpen: Gauge<'kind'>;
  attemptsMissingOutboxEvent: Gauge<string>;
  ledgerViolations: Gauge<string>;
  statsScrapeErrors: Counter<string>;
}

const FAST = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createMetrics(options: { registry?: Registry; defaultMetrics?: boolean } = {}): AppMetrics {
  const registry = options.registry ?? new Registry();
  if (options.defaultMetrics) collectDefaultMetrics({ register: registry });
  const common = { registers: [registry] };

  return {
    registry,

    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests handled, by method, route pattern and status class (2xx, 4xx, ...).',
      labelNames: ['method', 'route', 'status_class'] as const,
      ...common,
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, by method and route pattern.',
      labelNames: ['method', 'route'] as const,
      buckets: FAST,
      ...common,
    }),

    authAttempts: new Counter({
      name: 'auth_attempts_total',
      help: 'API authentication attempts: ok, missing (no Authorization header) or invalid (any reason; the log says which).',
      labelNames: ['result'] as const,
      ...common,
    }),
    idempotencyClaims: new Counter({
      name: 'idempotency_claims_total',
      help: 'Outcome of claiming an idempotency key: claimed, replay, in_flight or mismatch.',
      labelNames: ['result'] as const,
      ...common,
    }),
    paymentOutcomes: new Counter({
      name: 'payment_outcomes_total',
      help: 'How a create-payment request that did the work ended: succeeded, declined, processing, requires_action, unknown, rejected.',
      labelNames: ['result'] as const,
      ...common,
    }),
    processorCalls: new Counter({
      name: 'processor_calls_total',
      help: 'Calls to the processor by classified result. `unknown` is the one to watch: money may have moved.',
      labelNames: ['result'] as const,
      ...common,
    }),
    processorCallDuration: new Histogram({
      name: 'processor_call_duration_seconds',
      help: 'Duration of one processor call, including calls that timed out.',
      buckets: FAST,
      ...common,
    }),
    webhookEvents: new Counter({
      name: 'webhook_events_total',
      help: 'Processor webhooks by result (applied, duplicate, conflict, mismatch, unmatched, rejected_signature, ...).',
      labelNames: ['result'] as const,
      ...common,
    }),

    outboxDeliveries: new Counter({
      name: 'outbox_deliveries_total',
      help: 'Merchant event delivery attempts by result: delivered, retried, dead, skipped.',
      labelNames: ['result'] as const,
      ...common,
    }),
    recoveryActions: new Counter({
      name: 'recovery_actions_total',
      help: 'State changes made by the sweeper and reconciler: applied, abandoned, failed_unreached, keys_completed, claims_released.',
      labelNames: ['action'] as const,
      ...common,
    }),
    recoveryRuns: new Counter({
      name: 'recovery_runs_total',
      help: 'Runs of the background jobs (sweeper, reconciler, outbox) by result: ok or error.',
      labelNames: ['job', 'result'] as const,
      ...common,
    }),
    findingsRecorded: new Counter({
      name: 'reconciliation_findings_recorded_total',
      help: 'Findings written or seen again, by kind.',
      labelNames: ['kind'] as const,
      ...common,
    }),

    outboxEvents: new Gauge({
      name: 'outbox_events',
      help: 'Outbox events by status (pending, delivered, dead, skipped).',
      labelNames: ['status'] as const,
      ...common,
    }),
    outboxOldestDueAge: new Gauge({
      name: 'outbox_oldest_due_age_seconds',
      help: 'Age of the oldest pending outbox event that is due now. 0 when nothing is waiting. A growing value means the relay is not keeping up.',
      ...common,
    }),
    attemptsInState: new Gauge({
      name: 'payment_attempts_in_state',
      help: 'Attempts that are not final, by status.',
      labelNames: ['status'] as const,
      ...common,
    }),
    attemptsOldestIdle: new Gauge({
      name: 'payment_attempts_oldest_idle_seconds',
      help: 'Longest time any non-final attempt has sat in a status without a change. Recovery should keep this small.',
      labelNames: ['status'] as const,
      ...common,
    }),
    findingsOpen: new Gauge({
      name: 'reconciliation_findings_open',
      help: 'Findings nobody has resolved, by kind. Each one is a discrepancy about money that a person must look at.',
      labelNames: ['kind'] as const,
      ...common,
    }),
    attemptsMissingOutboxEvent: new Gauge({
      name: 'attempts_missing_outbox_event',
      help: 'Final attempts with no merchant event. Must be 0: the event is written with the final status.',
      ...common,
    }),
    ledgerViolations: new Gauge({
      name: 'ledger_invariant_violations',
      help: 'Ledger invariants currently broken (debits not equal credits, success not booked, booking without success). Must be 0.',
      ...common,
    }),
    statsScrapeErrors: new Counter({
      name: 'stats_scrape_errors_total',
      help: 'Scrapes where the database could not be asked for the state gauges. Their values are then stale, not zero.',
      ...common,
    }),
  };
}
