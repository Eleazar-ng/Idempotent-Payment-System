# Stage 7: Webhook receiver. Files affected

Stage 7 lets the processor finish a payment after our request has returned. `POST /webhooks/processor` verifies the
signature on the raw bytes, records each event id exactly once, and applies the outcome through the same path as the API
(so a success books the ledger), all in one transaction.

**Totals:** 11 added (including this file), 5 modified, 0 removed. No dependency changes. One new migration (`0007`).
Everything not listed here is unchanged from Stage 6.

## Added

| File | Purpose |
|---|---|
| `libs/db/migrations/0007_webhook_events.sql` | `webhook_events`: unique `(source, event_id)`, verdict column, immutable once received, frozen once handled, partial index of rows needing attention. |
| `libs/payments-core/src/webhook-event.ts` | `parseWebhookEvent`: raw bytes to a typed event (`charge_succeeded`, `charge_failed`, `ignored`); `WebhookPayloadError`. |
| `libs/payments-core/src/webhook-event.spec.ts` | Unit tests for parsing (18). |
| `libs/db/src/webhooks.ts` | `handleWebhookEvent` (claim, find attempt, apply, record, one transaction) and `listWebhookEventsNeedingAttention`. |
| `libs/db/src/webhooks.int-spec.ts` | Handling rules against real Postgres: duplicates, 8-way race, ordering, every attempt state, conflicts, mismatches, unmatched, rollback on failure (26). |
| `libs/db/src/schema-webhooks.int-spec.ts` | Attacks migration 0007: uniqueness, checks, immutability, frozen rows (13). |
| `apps/api/src/webhooks.service.ts` | Verify, parse, handle; 400 for bad signature or body, 200 for everything recorded. `WEBHOOK_OPTIONS`. |
| `apps/api/src/webhooks.controller.ts` | `POST /webhooks/processor`, reads `rawBody` and the `Processor-Signature` header. |
| `apps/api/src/webhooks.int-spec.ts` | End to end with the real fake processor sending signed webhooks (18): pending/requires_action completion, duplicates, resend, reversed order, webhook before API answer, forged/replayed/re-spaced requests, simulated outage then redelivery. |
| `docs/stages/stage-7-files.md` | This file. |

## Modified

| File | Change |
|---|---|
| `libs/db/src/database.types.ts` | Adds `WebhookEventsTable`, `WebhookEventResult`, `WebhookEvent`. |
| `libs/db/src/index.ts` | Exports `webhooks`. |
| `libs/payments-core/src/index.ts` | Exports `webhook-event`. |
| `apps/api/src/app.module.ts` | Registers the controller, service and `WEBHOOK_OPTIONS` (secret and fee from config). |
| `README.md` | Status table and the Stage 7 section. |
