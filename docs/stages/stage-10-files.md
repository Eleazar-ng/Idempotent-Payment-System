# Stage 10: Observability. Files affected

Stage 10 makes the system explain itself. Logs become one JSON object per line with a request id and secrets redacted. Counters
and state gauges are exported to Prometheus from the API and from a small HTTP listener on the worker. Readiness is separated
from liveness. A rules file with runbooks says what to do when each alert fires, and a test keeps the rules honest against the real metrics.

**Totals:** 21 added (including this file), 23 modified, 0 removed. One new dependency (`prom-client` 15.1.3). No migration.
Everything not listed here is unchanged from Stage 9.

## Added

### Observability library (`libs/observability`)

| File | Purpose |
|---|---|
| `tsconfig.lib.json` | Library build settings (registered in `tsconfig.json`, `jest.config.js`, `nest-cli.json`). |
| `src/index.ts` | Public exports. |
| `src/metrics.ts` | Every metric in one place: counters, histograms, state gauges. `createMetrics()` gives an isolated registry. |
| `src/json-logger.ts` | `JsonLogger` (Nest `LoggerService`): level filter, request id on each line, redaction, never throws. |
| `src/redact.ts` | Key-name redaction and free-text scrubbing (`Bearer`, `v1=` signatures). |
| `src/request-context.ts` | `AsyncLocalStorage` request id, `requestIdMiddleware`, rule for accepting a caller's id. |
| `src/http-metrics.ts` | Request counter and histogram middleware, labelled by route pattern, never by url. |
| `src/metrics-auth.ts` | Constant-time bearer-token check for `/metrics`. |
| `src/observability.module.ts` | Global module providing one `METRICS` registry per process. |
| `src/observability.spec.ts` | 16 unit tests: redaction, logger, request ids, route labels, metric names, label cardinality, registry isolation. |
| `src/alerts.spec.ts` | 2 checks plus one per alert: every alert uses only metrics that exist, every runbook anchor resolves. |

### Database (`libs/db/src`)

| File | Purpose |
|---|---|
| `ops-stats.ts` | `collectOperationalStats`: outbox by status and lag, non-final attempts by status and idle time, open findings by kind, missing events, ledger violations. |
| `ops-stats.int-spec.ts` | Real Postgres: zero-filled on empty, counts, due versus scheduled, findings, repair (5). |

### API (`apps/api/src`)

| File | Purpose |
|---|---|
| `metrics.controller.ts` | `GET /metrics`, optional bearer token. |
| `observability.int-spec.ts` | Request ids, route-pattern labels, payment-flow counters, webhook counter, token, readiness with the database gone (12). |

### Worker (`apps/worker/src`)

| File | Purpose |
|---|---|
| `worker-http.service.ts` | The worker's listener: `/metrics`, `/health`, `/health/ready`. |
| `state-gauges.ts` | Copies database stats into gauges; keeps last values and counts an error when the database cannot be read. |
| `worker-http.int-spec.ts` | Gauges from real data, reset to zero, token, 404/405, database gone, job counters through `RecoveryService` (7). |

### Docs

| File | Purpose |
|---|---|
| `docs/observability.md` | Logs, metric catalogue, health, alerts, and a runbook for every alert. |
| `docs/alerts.yml` | 18 Prometheus alert rules with severity and runbook links. |
| `docs/stages/stage-10-files.md` | This file. |

## Modified

| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | Imports `ObservabilityModule`; request-id and HTTP-metrics middleware on every route; metrics and readiness providers. |
| `apps/api/src/bootstrap.ts` | Uses `JsonLogger` at `LOG_LEVEL`. |
| `apps/api/src/health.controller.ts` | Adds `GET /health/ready` (database check with a deadline, 503 without error text). |
| `apps/api/src/main.ts` | Startup line through the logger. |
| `apps/api/src/payments.service.ts` | Counts claims, processor calls (with duration) and outcomes. |
| `apps/api/src/webhooks.service.ts` | Counts webhooks by result, including rejected signatures. |
| `apps/worker/src/main.ts` | JSON logger; startup text updated. |
| `apps/worker/src/worker.module.ts` | Imports `ObservabilityModule`; wires the HTTP listener. |
| `apps/worker/src/outbox-relay.service.ts` | Counts deliveries and job runs. |
| `apps/worker/src/outbox-relay.int-spec.ts` | Provides `METRICS` and asserts the delivery counters. |
| `apps/worker/src/recovery.service.ts` | Counts sweeper and reconciler runs, actions and findings by kind. |
| `apps/worker/src/recovery-sweeper.ts` | Optional `onFinding` hook. |
| `apps/worker/src/reconciler.ts` | Optional `onFinding` hook. |
| `libs/config/src/env.ts` | `LOG_LEVEL`, `METRICS_TOKEN`, `READINESS_TIMEOUT_MS`, `WORKER_HTTP_PORT`. |
| `libs/config/src/env.spec.ts` | Defaults and rejected values for them. |
| `libs/db/src/index.ts` | Exports `ops-stats`. |
| `.env.example` | The new settings. |
| `README.md` | Stage 10 section, layout, status table (10 done, 11 next), earlier "Stage 10" gap notes updated. |
| `package.json`, `pnpm-lock.yaml` | Add `prom-client`. |
| `tsconfig.json`, `jest.config.js`, `nest-cli.json` | Register the `@app/observability` library. |
