# Observability (Stage 10)

Three things, in the order you reach for them during an incident: **alerts** say something is wrong, **metrics** say what and
how much, **logs** say which payment. A request id ties a client's report to the log lines it caused.

## Logs

Every process writes one JSON object per line to stdout (`JsonLogger`, `libs/observability`):

```json
{"time":"2026-10-30T14:02:11.402Z","level":"warn","service":"api","context":"PaymentsService","requestId":"3f0c…","message":"attempt 812: unknown outcome (timeout), try 1"}
```

- `LOG_LEVEL` is `debug`, `info` (default), `warn` or `error`.
- **Request id.** Every API request gets one. A caller's `X-Request-Id` is kept if it is 1 to 64 plain characters
  (`A-Z a-z 0-9 . _ : -`); anything else is replaced, because the id lands in every log line and a hostile one (newlines,
  megabytes) must not. It is echoed in the response header and attached to every log line written while that request runs,
  including lines written after an `await` (it travels in `AsyncLocalStorage`).
- **Redaction.** Keys matching `secret|token|authorization|password|signature|api-key|cookie|source|card` are replaced with
  `[redacted]` at any depth, and free text is scrubbed for `Bearer …` and `v1=<hex>` values. Matching is by key *name*, so a
  field added next year called `webhook_secret` is covered without anyone remembering. `source` is in the list because it is the
  customer's payment token.
- Log lines carry **attempt ids** in their text, never card data, secrets or request bodies. Ids belong in logs; they never
  belong in metric labels.

## Metrics

`GET /metrics` on the API (port `API_PORT`) and on the worker (port `WORKER_HTTP_PORT`, default 3002), Prometheus text format.
If `METRICS_TOKEN` is set both require `Authorization: Bearer <token>` (compared in constant time). With no token they are open:
fine on a private network, wrong on the internet. Health probes never need the token.

**Label rule (tested):** a label holds a small fixed set of values: a status, a result, a kind, a route *pattern*. Never a merchant,
order, attempt, charge or key. One value per customer turns a metrics server into a database that runs out of memory. Requests
that match no route share the single label `unmatched`, so a scanner cannot create series.

### From the API

| Metric | Labels | Meaning |
|---|---|---|
| `http_requests_total` | method, route, status_class | Requests by route pattern (`/v1/payments/:id`). |
| `http_request_duration_seconds` | method, route | Latency histogram. |
| `idempotency_claims_total` | result | `claimed`, `replay`, `in_flight`, `mismatch`. A rising `mismatch` is a client bug. |
| `payment_outcomes_total` | result | How requests that did the work ended: `succeeded`, `declined`, `processing`, `requires_action`, `unknown`, `rejected`. |
| `processor_calls_total` | result | Each call to the processor, classified. `unknown` means money may have moved. |
| `processor_call_duration_seconds` | | Per call, timeouts included. |
| `webhook_events_total` | result | `applied`, `duplicate`, `ignored`, `conflict`, `mismatch`, `unmatched`, `rejected_signature`, `rejected_payload`, `raw_body_unavailable`. |

### From the worker (jobs)

| Metric | Labels | Meaning |
|---|---|---|
| `outbox_deliveries_total` | result | `delivered`, `retried`, `dead`, `skipped`. |
| `recovery_actions_total` | action | `applied`, `abandoned`, `failed_unreached`, `keys_completed`, `claims_released`, `repaired`. |
| `recovery_runs_total` | job, result | Runs of `sweeper`, `reconciler`, `outbox` that finished `ok` or ended in `error`. |
| `reconciliation_findings_recorded_total` | kind | Findings written or seen again. |

### From the worker (state, read from the database at each scrape)

These are the ones that catch what counters cannot: *nothing happening*. A counter of deliveries is flat both when there is
nothing to deliver and when the relay is dead; the age of the oldest due event tells them apart.

| Metric | Meaning |
|---|---|
| `outbox_events{status}` | Events by status; `dead` should be 0. |
| `outbox_oldest_due_age_seconds` | How long the oldest due event has waited (0 if none). Events scheduled for later are not lag. |
| `payment_attempts_in_state{status}` | Non-final attempts by status. |
| `payment_attempts_oldest_idle_seconds{status}` | The longest any non-final attempt has sat unchanged. Recovery should keep this small. |
| `reconciliation_findings_open{kind}` | Unresolved discrepancies. A kind with none left reads 0. |
| `attempts_missing_outbox_event` | Must be 0. |
| `ledger_invariant_violations` | Must be 0. |
| `stats_scrape_errors_total` | Scrapes where the database could not be read. The gauges then keep their **last** values: an outage shows as an error, never as a reassuring zero. |

The state gauges live on the worker only, so the same series is not exported twice. That makes the worker's own scrape a
dependency of every recovery alert, which is why `WorkerMetricsMissing` exists.

## Health

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /health` | The process is up. Never touches the database. | Liveness: restart if it fails. |
| `GET /health/ready` | The database answers `select 1` within `READINESS_TIMEOUT_MS`. `503 {"status":"unavailable","failed":["database"]}` otherwise, with no error text (it can carry hostnames). | Readiness: take out of rotation, do not restart. |

The split is deliberate. If liveness depended on the database, a database outage would make an orchestrator restart every healthy API
process at once, and they would all come back to the same outage.

## Alerts

`docs/alerts.yml` holds the Prometheus rules. `libs/observability/src/alerts.spec.ts` checks that every metric an alert uses exists in the
real registry and that every runbook link below resolves, so a rename cannot leave an alert silently watching nothing.

*Critical* means money may be wrong: page someone. *Warning* means look during working hours.

## Runbooks

### Ledger invariant broken

`ledger_invariant_violations > 0`. The database should make this impossible (deferred constraint triggers refuse a commit that
leaves a success unbooked or a transaction unbalanced), so treat it as a serious bug or someone with direct database access.
Run `checkLedgerInvariants(db)` for the exact rows. Stop deploying. The ledger is append-only: correct it with a reversing
transaction, never an `UPDATE`.

### Final attempt without merchant event

`attempts_missing_outbox_event > 0`. The event is written in the same transaction as the final status, so a gap means a code path
changed status without it. `findAttemptsMissingOutboxEvent(db)` lists them; `enqueuePaymentEvent(db, attemptId)` repairs one (idempotent).
Then find the path that skipped it.

### Money discrepancy finding

`reconciliation_findings_open{kind=…} > 0`. List with `listOpenFindings(db)`. Each row has the attempt, the charge and what disagreed.
Look at the processor's dashboard for the charge, decide what is true, fix the books by the proper route (a reversing ledger
transaction, a manual refund), then `resolveFinding(db, id, 'what you did')`. The note is mandatory and is kept. A finding a person
resolved never reopens on its own, even if the discrepancy persists. A finding the system closed ("no longer observed") reopens if it returns.

| Kind | Usually means |
|---|---|
| `paid_but_failed` | We marked it failed, the processor took the money. Refund or re-attribute. |
| `success_without_charge` | We booked a success the processor has no record of. Most serious. |
| `succeeded_but_charge_not_succeeded` | Charge refunded or reversed at the processor. |
| `amount_mismatch`, `charge_id_conflict` | Same reference, different amount or charge. |
| `orphan_charge` | A charge we have no attempt for. |
| `webhook_conflict`, `webhook_mismatch`, `webhook_unmatched` | A webhook that contradicted our records. |

### Stuck attempts

`payment_attempts_oldest_idle_seconds{status=…}` is high. The sweeper normally takes `calling_processor` attempts after
`RECOVERY_STUCK_AFTER_MS` (2 min), pending ones after `RECOVERY_PENDING_AFTER_MS` (15 min) and fails abandoned ones after the
25 hour grace. If one is older, first check `SweeperStalled`/`BackgroundJobsFailing`, then the sweeper log lines for that attempt
(`left unchanged: …` means the processor lookup failed, which is correct behaviour while the processor is down). A
`finding` log line means the processor contradicted us and a person must decide (see above).

### Background jobs

`BackgroundJobsFailing`, `SweeperStalled`, `WorkerMetricsMissing`, `StateGaugesStale`. Check the worker is running and
`GET :3002/health/ready`. Errors are logged as `recovery pass failed`, `reconciliation failed (nothing changed)` or `outbox pass failed`.
A failed reconciliation changes nothing by design, including closing findings. If the database is the problem, the readiness probe says so.

### Outbox

`outbox_oldest_due_age_seconds` growing: the relay is not keeping up or is down. `outbox_events{status="dead"} > 0`: events used all
`OUTBOX_MAX_ATTEMPTS` against a merchant endpoint. `listDeadOutboxEvents(db)` shows the last error; after the merchant fixes their endpoint,
`requeueDeadOutboxEvent(db, id, now)` puts one back.

### Processor outcomes unknown

More than 5% of calls end `unknown` (timeout, reset, 5xx, malformed). Money may have moved without us knowing. Nothing is lost: the attempt
stays `calling_processor` and the sweeper looks it up by reference. The action is upstream: processor status page, network, `PROCESSOR_TIMEOUT_MS`.
Expect `payment_outcomes_total{result="unknown"}` and then `recovery_actions_total{action="applied"}` to follow.

### Webhook signatures failing

`rejected_signature` rising. Either the secret was rotated on one side only (`PROCESSOR_WEBHOOK_SECRET` accepts a list during rotation) or someone is posting forged events.
Nothing from a rejected request is stored or applied. Check clock skew too: timestamps older than five minutes are refused.

### API errors and latency

`ApiServerErrors`, `ApiSlow`. Find the route with `sum by (route) (rate(http_requests_total{status_class="5xx"}[5m]))`, then search the logs by the
`requestId` from a failing response header.

## Deliberate differences from the lectures

1. **Plain `prom-client` and a JSON logger of about eighty lines, not a tracing stack.** A request id across logs answers "what happened to this
   request" for a system with two processes. Distributed tracing earns its cost with more services than this.
2. **State gauges are read from Postgres at scrape time**, not maintained as counters in memory. They survive restarts and cannot drift, at the price of a few
   small queries per scrape.
3. **The worker runs its own tiny HTTP listener** instead of being unobservable: a worker nobody can scrape is the one that fails silently.
