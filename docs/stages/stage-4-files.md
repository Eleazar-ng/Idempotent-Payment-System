# Stage 4: Fake processor. Files affected

Stage 4 built a controllable, Stripe-style payment processor (`apps/fake-processor`) to attack the system
with: charges with an idempotency window, composable failure rules, signed webhooks delivered at least once,
and a control API. Webhook signing and verification went into `payments-core` so Stage 7 reuses the same code.

**Totals:** 12 added (including this file), 6 modified, 0 removed. No dependency changes
(`pnpm-lock.yaml` is untouched). Everything not listed here is unchanged from Stage 3.

Equivalent in git, once this stage is committed: `git show --name-status <stage-4-commit>`.

## Added

### Webhook signatures (`libs/payments-core/src`)

| File | Purpose |
|---|---|
| `webhook-signature.ts` | `signWebhook()` and `verifyWebhook()`: HMAC-SHA256 over `"<t>." + raw body`, constant-time compare, timestamp tolerance, secret rotation, typed failure reasons. |
| `webhook-signature.spec.ts` | Unit tests: known-answer vector, tampered body/timestamp, wrong secret, tolerance edges, rotation, every malformed-header shape. |

### Fake processor (`apps/fake-processor/src`)

| File | Purpose |
|---|---|
| `schemas.ts` | zod schemas: charge request, failure rules (outcomes, faults, delays), webhook settings, control payloads. |
| `processor.service.ts` | The processor: charges, 24 h idempotency records (replay / 400 / 409), outcomes, transport faults, rules, resolve, injectable clock. |
| `webhook.service.ts` | Signed webhook delivery: duplicates, retries, hold and flush (reordering), redelivery, event log. |
| `charges.controller.ts` | `POST /v1/charges`, `GET /v1/charges/:id`, `GET /v1/charges?reference=`; kills the socket for the `drop_*` faults. |
| `control.controller.ts` | `/_control/*`: rules, resolve, webhook settings and flush, events, clock, stats, reset. |
| `test-helpers.ts` | Shared test helpers: fake config, a receiver server standing in for our webhook endpoint. |
| `processor.service.spec.ts` | Unit tests: idempotency window, outcomes, rules, faults, resolve, webhook emission, reset. |
| `webhook.service.spec.ts` | Unit tests: signed delivery verified by our own code, duplicates, retries, hold and flush ordering, redelivery. |
| `fake-processor.http.spec.ts` | End-to-end over real sockets: lost responses and client timeouts as the caller experiences them, control API, webhooks. |

### Documentation (`docs/stages`)

| File | Purpose |
|---|---|
| `stage-4-files.md` | This file. |

## Modified

| File | What changed |
|---|---|
| `libs/payments-core/src/index.ts` | Also exports the webhook signature module. |
| `libs/config/src/env.ts` | Optional `FAKE_PROCESSOR_WEBHOOK_URL`. |
| `.env.example` | Documents `FAKE_PROCESSOR_WEBHOOK_URL`. |
| `apps/fake-processor/src/fake-processor.module.ts` | From a health endpoint to the full module (controllers and services). |
| `apps/fake-processor/src/main.ts` | Updated the description comment. |
| `README.md` | Status table; new "Fake processor (Stage 4)" section: API, rules, webhooks, a hand-run demo, deliberate differences. |

## Removed

None.
