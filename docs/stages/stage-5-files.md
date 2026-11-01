# Stage 5: Create-payment API and the outbound processor call. Files affected

Stage 5 joined the earlier stages into the first end-to-end payment: claim the idempotency key, begin an
attempt for the order, commit `calling_processor`, call the processor with the attempt's derived key
(retrying unknown outcomes), then record the outcome and the response in one transaction.

**Totals:** 13 added (including this file), 16 modified, 0 removed. No dependency changes
(`pnpm-lock.yaml` is untouched). One new migration (`0005`). Everything not listed here is unchanged from Stage 4.

Equivalent in git, once this stage is committed: `git show --name-status <stage-5-commit>`.

## Added

### Meaning of a processor answer (`libs/payments-core/src`)

| File | Purpose |
|---|---|
| `processor-outcome.ts` | `classifyChargeResponse()`: turns an HTTP answer into succeeded / requires_action / processing / declined / rejected / **unknown**. Anything ambiguous is unknown, never a failure. |
| `attempt-keys.ts` | `processorIdempotencyKey(intentId, attemptNumber)`: the derived key sent to the processor. |
| `payment-status.ts` | `derivePaymentStatus()`: the coarse public status. `abandoned` and `calling_processor` show as `processing`, never `failed`. |
| `processor-outcome.spec.ts` | Unit tests for all three. |

### Database steps (`libs/db`)

| File | Purpose |
|---|---|
| `migrations/0005_attempt_payment_source.sql` | `payment_attempts.payment_source` (NOT NULL, no lasting default, immutable) so any retry can rebuild the identical charge request. |
| `src/payments.ts` | `beginAttempt()` (find or create the intent, create the next attempt, link the key; stopped by the one-active-attempt index), `applyProcessorOutcome()`, `getPayment()` (merchant-scoped), `findIntent()`, `findActiveAttempt()`, `getAttempt()`. |
| `src/payments.int-spec.ts` | Integration tests: every `beginAttempt` outcome, the 30-way same-order race, `attachAttempt`, every outcome mapping, stale and duplicate outcomes, rollback. |

### The API (`apps/api/src`)

| File | Purpose |
|---|---|
| `processor.client.ts` | HTTP client for the charge endpoint. Never throws; timeouts, resets and half-read bodies become `unknown`. |
| `payments.service.ts` | The create-payment orchestration, plus `GET`. Claims, begins the attempt, calls with retries, settles in one transaction. |
| `payments.controller.ts` | `POST /v1/payments` and `GET /v1/payments/:id`. |
| `payment-http.ts` | Response shapes: `paymentView`, `paymentResult` (status mapping), `problem`. |
| `payments.int-spec.ts` | End to end: real API, real Postgres, real fake processor. Happy path, replay, validation, declines, lost responses, timeouts, outages, same-key and same-order races, order history, isolation. |

### Documentation (`docs/stages`)

| File | Purpose |
|---|---|
| `stage-5-files.md` | This file. |

## Modified

| File | What changed |
|---|---|
| `libs/db/src/idempotency.ts` | Added `attachAttempt()`: links a claimed key to its attempt; after that `releaseClaim` refuses to delete it. |
| `libs/db/src/index.ts` | Exports `payments`. |
| `libs/db/src/database.types.ts` | `payment_source` on `PaymentAttemptsTable`. |
| `libs/payments-core/src/index.ts` | Exports the three new modules. |
| `libs/config/src/env.ts` | `PROCESSOR_TIMEOUT_MS`, `PROCESSOR_CALL_RETRIES`, `PROCESSOR_RETRY_DELAY_MS`. |
| `libs/config/src/env.spec.ts` | Tests for the new defaults and the retry cap. |
| `.env.example` | Documents the three new settings. |
| `apps/api/src/app.module.ts` | Wires the controller, service, processor client and their options. |
| `apps/fake-processor/src/processor.service.ts` | `stats()` now reports `replays`, so tests can prove the API retried with the same key. |
| `apps/fake-processor/src/processor.service.spec.ts` | Asserts the replay counter. |
| `apps/fake-processor/src/fake-processor.http.spec.ts` | Stats expectation includes `replays`. |
| `libs/testing/src/seed.ts` | `createAttempt` supplies the new `payment_source`. |
| `libs/db/src/schema-core.int-spec.ts` | New column in direct inserts; new test: source required, non-empty, immutable. |
| `libs/db/src/schema-integrity.int-spec.ts` | New column in a direct insert. |
| `libs/db/src/schema-transitions.int-spec.ts` | New column in direct inserts. |
| `README.md` | Status table; the new guarantee in the database table; new "Create-payment flow (Stage 5)" section with the outcome tables, known gaps and deliberate differences. |

## Removed

None.
