# Stage 8: Outbox and a real retry policy. Files affected

Stage 8 adds two things. A retry policy (exponential backoff with jitter, a cap and `Retry-After`) replaces the plain
doubling between processor calls. A transactional outbox tells merchants about final payment outcomes: the event row is
written in the same transaction as the status change and ledger posting, and the worker's relay delivers it, signed, at
least once.

**Totals:** 12 added (including this file), 14 modified, 0 removed. No dependency changes. One new migration (`0008`).
Everything not listed here is unchanged from Stage 7.

## Added

### Retry policy and merchant event format (`libs/payments-core/src`)

| File | Purpose |
|---|---|
| `retry-policy.ts` | `retryDelayMs`, `backoffCeilingMs`, `parseRetryAfterMs`, `RetryPolicy` (full, equal or no jitter; cap; multiplier). Pure, random source injectable. |
| `retry-policy.spec.ts` | 36 unit tests: growth, cap, overflow, jitter bounds, `Retry-After` floor and cap, header parsing. |
| `merchant-event.ts` | Signature and event-id header names, `merchantEventId`, `buildMerchantEventBody` (identical bytes on every retry). |
| `merchant-event.spec.ts` | Unit tests for the above. |

### Database (`libs/db`)

| File | Purpose |
|---|---|
| `migrations/0008_outbox.sql` | `merchants.webhook_url` and `webhook_secret` (both or neither); `outbox_events` (unique dedupe key, status, attempts, next attempt, lease, frozen once delivered or skipped). |
| `src/outbox.ts` | `enqueuePaymentEvent`, `claimDueOutboxEvents` (`SKIP LOCKED` plus lease), `markOutboxDelivered/Skipped/Dead`, `scheduleOutboxRetry` (fenced), `requeueDeadOutboxEvent`, `listDeadOutboxEvents`, `findAttemptsMissingOutboxEvent`. |
| `src/outbox.int-spec.ts` | Events written with the change that causes them, rollback, repair, claiming (lease, no double claim, skips held rows), recording results, fencing, requeue (25). |
| `src/schema-outbox.int-spec.ts` | Attacks migration 0008: URL and secret rules, uniqueness, checks, immutability, frozen states (19). |

### Worker (`apps/worker/src`)

| File | Purpose |
|---|---|
| `outbox-relay.ts` | `OutboxRelay.runOnce()`: claim, deliver concurrently with a timeout, sign, classify, schedule retry or park as dead. No redirects. |
| `outbox-relay.service.ts` | Nest loop around the relay: runs while the batch is full, sleeps when idle, finishes the current pass on shutdown. |
| `outbox-relay.int-spec.ts` | Against a real local HTTP merchant: signed delivery verifies, retries and growth, `Retry-After`, timeout, refused connection, redirect, dead-letter and requeue, concurrency, three relays at once, crashed-worker recovery, the worker app itself (18). |

| File | Purpose |
|---|---|
| `docs/stages/stage-8-files.md` | This file. |

## Modified

| File | Change |
|---|---|
| `libs/db/src/payments.ts` | `applyProcessorOutcome` writes the outbox event in the same transaction for success, decline and rejection (`failAndNotify`). |
| `libs/db/src/database.types.ts` | `OutboxEventsTable`, `OutboxStatus`, `OutboxEvent`; merchants gain the webhook columns. |
| `libs/db/src/index.ts` | Exports `outbox`. |
| `libs/payments-core/src/index.ts` | Exports `retry-policy` and `merchant-event`. |
| `libs/config/src/env.ts`, `env.spec.ts`, `.env.example` | `PROCESSOR_RETRY_MAX_DELAY_MS` and the seven `OUTBOX_*` settings, with defaults and bounds. |
| `apps/api/src/payments.service.ts` | Pauses between processor retries come from the jittered policy (`retryMaxDelayMs`, optional `random`). |
| `apps/api/src/app.module.ts` | Passes `retryMaxDelayMs`. |
| `apps/api/src/payments.int-spec.ts` | Jittered pauses test; merchant notification tests; missing-event check after every test. |
| `apps/api/src/webhooks.int-spec.ts` | Option update; missing-event check after every test. |
| `apps/worker/src/worker.module.ts` | Wires the relay and its settings from config. |
| `apps/worker/src/main.ts` | Comment and startup message. |
| `README.md` | Status table and the Stage 8 section. |
