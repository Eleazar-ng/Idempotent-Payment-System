# payments-demo

A demo of an idempotent, double-charge-proof payment system, built stage by stage alongside the
12-module curriculum. Stack: NestJS, PostgreSQL (SQL migrations + Kysely), BullMQ on Redis, and a
controllable fake payment processor.

## Status

| Stage | What | State |
|---|---|---|
| 0 | Scaffold, Docker Compose, config, test harness | **done** |
| 1 | Schema and constraints (SQL migrations + tests that attack the database) | **done** |
| 2 | State machine library (`payments-core`) and the conditional-update helper | **done** |
| 3 | Claim and replay path: canonical request hashing, atomic claim, replay | **done** |
| 4 | Fake processor: charges, idempotency window, failure rules, signed webhooks | **done** |
| 5 | Create-payment API and the outbound processor call | **done** |
| 6 | Ledger posting, atomic with the success transition | next |
| 7 to 12 | Webhooks, outbox, retries, recovery, observability, hardening | planned |

## Layout

```
apps/
  api/              HTTP API: create and read payments (webhook receiver from Stage 7)
  worker/           Background work: outbound calls, outbox relay, sweeper, reconciliation
  fake-processor/   Controllable Stripe-style processor (in memory) used for failure injection
libs/
  config/           zod-validated environment (fails fast on bad config)
  db/               Kysely setup, DbModule, SQL migrations (libs/db/migrations)
  payments-core/    State machines, canonical request hashing, key rules (later: ledger posting)
  testing/          Testcontainers Postgres helper, test env helpers
```

## Getting started

Requirements: Node 22.9+ (the migrate script uses `--env-file-if-exists`), pnpm, Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up            # Postgres 16 + Redis 7 via Docker Compose
pnpm db:migrate       # applies libs/db/migrations to DATABASE_URL (safe to re-run)

pnpm test             # unit tests (no Docker needed)
pnpm test:int         # integration tests against a real Postgres (needs Docker)
pnpm lint
pnpm typecheck
pnpm build

pnpm start:api              # http://localhost:3000/health
pnpm start:fake-processor   # http://localhost:3001/health
pnpm start:worker
```

If pnpm prints a note about ignored dependency build scripts, that is expected and safe to skip.

No Docker? Point the integration tests at any Postgres 16 server instead. Each test file creates
and drops its own uniquely named database, so the role needs `CREATEDB`:

```bash
TEST_PG_ADMIN_URL=postgres://postgres:secret@localhost:5432/postgres pnpm test:int
```

## Database design (Stage 1)

The schema is hand-written SQL in `libs/db/migrations`, applied in order by `libs/db/src/migrator.ts`
(advisory lock, one transaction per file, checksum check so applied files can never be edited).
The rules live in the database, so no code path, script or late-night `psql` session can break them:

| Guarantee | Mechanism |
|---|---|
| One intent per order per merchant | `UNIQUE (merchant_id, order_id)` |
| API-level atomic claim, scoped per merchant | `idempotency_keys` primary key `(merchant_id, idempotency_key)` |
| Replays return exactly the first response | completed `idempotency_keys` rows are frozen by trigger |
| Only legal status moves | `status_transitions` + `status_initial` tables and one trigger function (`PY001`) |
| At most one active attempt per intent (failure mode 2.7) | partial unique index `WHERE status <> 'failed'` |
| Intent is `succeeded` only via a succeeded attempt, and never cancelled with an active attempt | triggers (`PY004`) |
| Processor idempotency key exists before any call, globally unique, never changes | `NOT NULL UNIQUE` + immutability trigger |
| A processor charge belongs to exactly one attempt | `UNIQUE (processor_charge_id)` |
| A retry can rebuild the identical charge request | `payment_source` is `NOT NULL` and immutable (migration 0005) |
| Ledger is append-only | triggers, including `TRUNCATE` (`PY003`) |
| Every ledger transaction balances per currency and is sealed at its declared entry count | deferred constraint trigger, checked at COMMIT (`PY005`) |
| One ledger posting per business event | `UNIQUE (posting_key)` |
| An entry's currency must match its account's | composite foreign key `(account_id, currency)` |

Custom SQLSTATE codes (`PY001` to `PY005`) let application code tell "the database refused this on
purpose" from ordinary failures. Unique violations are the standard `23505`.

## State machines (Stage 2)

The payment state machines exist twice, on purpose, and a test keeps the copies identical:

| Layer | Where | Job |
|---|---|---|
| Application | `libs/payments-core` (`attemptMachine`, `intentMachine`) | Fail fast before any query; answer questions like "which statuses may precede `succeeded`?" |
| Database | `status_transitions` table and trigger (migration 0002) | The guarantee that holds even if application code is wrong or bypassed |

`libs/db/src/state-machine-drift.int-spec.ts` fails if the TypeScript tables, the SQL tables, the
terminal states, or the "one active attempt per intent" rule ever disagree.

`transitionAttempt(db, attemptId, to, { from, ... })` in `libs/db` is the only way application code
should change an attempt's status. It is one `UPDATE ... WHERE status IN (from)` and says what happened:

| Outcome | Meaning |
|---|---|
| `applied` | This call moved the attempt. Exactly one concurrent caller can get this. |
| `already_applied` | It was already in the target status (duplicate webhook, retry or redelivery). Not an error. |
| `stale` | It is in a different status than expected; someone else moved it first. Nothing changed. |
| `not_found` | No such attempt. |

It accepts a transaction as well as a connection, so a status change and its ledger posting can commit
together (Stage 6).

### Two deliberate differences from the lectures

1. **`abandoned` attempts block new attempts** (Module 5.11 excluded them from the unique index).
   `abandoned` means "outcome unknown", and reconciliation may still find it succeeded, so allowing a
   new attempt in the meantime could double charge. The customer waits for reconciliation instead.
2. **`refunded` and `disputed` are not attempt states** (Module 8.8: refunds are their own entity).
   Also added: `calling_processor -> requires_action`, because a processor can ask for 3-D Secure in
   the response to the charge call itself.

## Idempotency keys (Stage 3)

Every request that moves money carries a client `Idempotency-Key`. Two pieces handle it:

| Piece | Where | Job |
|---|---|---|
| Canonical hashing | `libs/payments-core` (`canonicalize`, `requestHasher`) | Same meaning gives the same hash: keys sorted, no whitespace, strict about values with no single form (`undefined`, `NaN`, `Date`...). The hash covers the operation as well as the body, and is stored with its **version**. |
| Claim and replay | `libs/db` (`claimKey`, `completeKey`, `releaseClaim`) | One `INSERT ... ON CONFLICT DO NOTHING` decides who is first. Everyone else is told what happened. |

`claimKey` returns one of four outcomes. Exactly one concurrent caller per key ever gets `claimed`:

| Outcome | Meaning | HTTP |
|---|---|---|
| `claimed` | First time this key is seen; do the work, then `completeKey()` | (continue) |
| `replay` | Same request already finished; return the stored response unchanged | stored status and body |
| `in_flight` | Same request still being processed elsewhere | 409 + Retry-After |
| `mismatch` | Same key, different request (checked first, even after completion) | 422 |

`completeKey` is first-write-wins: a second call changes nothing and returns the original response, which
is the one the caller must send. `releaseClaim` abandons a claim only when no attempt is linked yet.

### Rules for callers

- **Claim on the pool (autocommit), not inside a long transaction.** The claim must be visible to other
  requests immediately. (A test shows what happens otherwise: duplicates block behind the open transaction.)
  `completeKey` is the opposite: pass a transaction so the response commits with the work it describes.
- **Never edit `hashV1`.** Rows already exist that were hashed with it, and a known-answer test pins it.
  To change hashing, add version 2 beside it. **Deploy order matters:** ship builds that can *read*
  version 2 everywhere before any build starts *writing* it, because a build that meets a version it does
  not know throws `UnknownHashVersionError` instead of guessing.
- A claim whose request crashes before `completeKey` stays `in_flight` until recovery (Stage 9) deals with it;
  `in_flight` results carry `created_at` so that stage can recognise a stuck claim.

### Deliberate differences from the lectures

1. The hash covers **operation + body**, not the body alone, so one key cannot be replayed against another
   endpoint that accepts the same body.
2. Key validation is stricter than the database: visible ASCII only, 1 to 255 characters.

## Fake processor (Stage 4)

`apps/fake-processor` (`pnpm start:fake-processor`, port 3001) behaves like a Stripe-style processor and can
be told to misbehave, so every failure from Module 2 can be reproduced on demand. It is in memory and shares
nothing with our database, because it is someone else's system.

**Its public API** (what our payment code calls):

| Request | Behaviour |
|---|---|
| `POST /v1/charges` + `Idempotency-Key` | Creates a charge. Same key and same parameters inside 24 h replays the stored response (`Idempotent-Replayed: true`); same key, different parameters is a 400; same key while the first is still running is a 409. A decline is a 402 and is stored too. |
| `GET /v1/charges/:id` | The charge as it is now. |
| `GET /v1/charges?reference=...` | Lookup by `metadata.reference`: how reconciliation finds a charge whose id we never received. |

Magic `source` values need no setup: `tok_declined`, `tok_insufficient_funds`, `tok_requires_action`, `tok_pending`.

**Failure rules** (`POST /_control/rules`) combine a *match* (`source`, `reference`, `idempotencyKey`) with what to do.
A rule applies once by default (fail once, then recover); `times: null` means forever.

| Field | Effect |
|---|---|
| `outcome` | `succeed`, `decline`, `requires_action`, `pending`. What the charge itself does; used the first time a key is processed. |
| `fault: gateway_error` | 503 before the processor sees anything. No charge. |
| `fault: drop_before` | Connection killed before processing. No charge. |
| `fault: error_after` | Charge made and stored, but the response is a 500. |
| `fault: drop_after` | Charge made and stored, connection closed with no response. The classic double-charge trap. |
| `processingDelayMs` | Slow **before** the charge, key marked in progress (duplicates get 409). |
| `responseDelayMs` | Slow **after** the charge: the client times out although the money moved. |

**Other controls:** `POST /_control/charges/:id/resolve` settles a `pending` / `requires_action` charge;
`POST /_control/clock/advance {ms}` expires idempotency keys; `GET /_control/stats`; `POST /_control/reset`.

**Webhooks** are signed `Processor-Signature: t=<unix>,v1=<hmac-sha256 of "<t>.<raw body>">` using
`PROCESSOR_WEBHOOK_SECRET`, and are delivered at least once. `PUT /_control/webhook` sets the target URL,
`duplicates` (extra copies), `maxRetries` / `retryDelayMs` (re-send after a non-2xx), and `mode: "hold"`, which
keeps events until `POST /_control/webhook/flush {order: "fifo" | "reverse"}` so they can arrive out of order.
`GET /_control/events` shows every event and every delivery attempt; `POST /_control/events/:id/redeliver` resends one.
Signing and verification live in `libs/payments-core` (`signWebhook`, `verifyWebhook`), so the receiver in Stage 7
uses exactly the same code the processor signs with.

Try the worst case by hand:

```bash
curl -s -XPOST localhost:3001/_control/rules -H 'content-type: application/json' -d '{"fault":"drop_after"}'
curl -si -XPOST localhost:3001/v1/charges -H 'idempotency-key: demo-1' -H 'content-type: application/json' \
  -d '{"amount":5000,"currency":"NGN","metadata":{"reference":"ord_1"}}'   # connection reset, no response
curl -s "localhost:3001/v1/charges?reference=ord_1"                          # ...but the charge exists
curl -si -XPOST localhost:3001/v1/charges -H 'idempotency-key: demo-1' -H 'content-type: application/json' \
  -d '{"amount":5000,"currency":"NGN","metadata":{"reference":"ord_1"}}'   # replay: same charge, no second one
```

### Deliberate differences from the lectures

1. Rules apply per HTTP request. A rule's `outcome` only matters the first time a key is processed (a replay returns what
   was stored), but its `fault` can hit replays too, and it counts as one use either way.
2. The replay of a `pending` charge's original request keeps returning `pending` after the charge settles, as a real
   processor does. Only a fresh read or the webhook shows the new status, which is what Stage 9 reconciliation relies on.

## Create-payment flow (Stage 5)

`POST /v1/payments` (headers `X-Merchant-Id` and `Idempotency-Key`; body `order_id`, `amount` in minor units,
`currency`, `source`) and `GET /v1/payments/:id`. `X-Merchant-Id` stands in for real authentication (Stage 11);
every query is already scoped to the merchant.

```
claim the key ──► begin attempt for the order ──► created → calling_processor (committed) ──► call processor
   (Stage 3)            (index: one active)                  (Stage 2)                        (derived key)
                                                                                                   │
                    response stored under the key  ◄── apply outcome, one transaction ◄───────────┘
```

Two different doors stop a double charge. **Same key twice:** the key claim (Stage 3). **Different keys, same order:**
the partial unique index on active attempts, reached through `beginAttempt`. Either way only one request can ever
start an attempt, and the attempt's processor key (`pi_<intent>_a<n>`) is derived and stored before any call.

What the processor's answer means (`classifyChargeResponse`), and what the flow does about it:

| Processor said | Meaning | Attempt becomes | API replies |
|---|---|---|---|
| charge `succeeded` | paid | `succeeded` (database marks the intent paid) | 201 |
| charge `pending` | still working | `processing` | 202 |
| `requires_action` | customer must do something | `requires_action` | 200 |
| 402 / charge `failed` | card refused, money did not move | `failed` | 402, a new attempt is allowed |
| other 4xx | the processor refused **our request** | `failed` (`processor_rejected:...`) | 502 |
| timeout, dropped connection, 5xx, 409, 429, malformed | **we do not know whether money moved** | unchanged | retried with the same key, then 202 |

The last row is the whole point. An unknown outcome is never a failure: failing the attempt would let a customer pay
twice. It is retried (`PROCESSOR_CALL_RETRIES`, default 2, doubling pause) with the identical key, which the processor
collapses into one charge. If it stays unknown the attempt remains `calling_processor`, the API answers `202 processing`,
and the unresolved attempt itself blocks any new payment for the order (409) until recovery resolves it (Stage 9).

| Request outcome | Status | Stored under the key? |
|---|---|---|
| Same key, same request, finished | stored answer + `Idempotent-Replayed: true` | already |
| Same key, still running | 409 + `Retry-After` | no |
| Same key, different request | 422 | no |
| Order busy (another attempt not finished) | 409 `payment_already_in_progress` | **no, the key is released** so a later retry works |
| Order already paid / amount mismatch / canceled | 409 / 422 / 409 | yes (permanent answers) |
| Declined, paid, pending, requires action, outage | as in the table above | yes (a replay returns the same answer; use a **new key** to try again) |

### Known gaps, by design

- A `pending` or `requires_action` attempt stays that way until the webhook handler (Stage 7).
- Success does not post to the ledger yet; `settle()` in `payments.service.ts` is the transaction Stage 6 extends.
- If the process dies after an attempt exists but before the response is stored, the key stays in flight until the
  recovery sweeper (Stage 9). Before an attempt exists the claim is released instead.
- Retry pauses are a plain doubling with no jitter; Stage 8 replaces them with a real policy.

### Deliberate differences from the lectures

1. The payment source is stored on the attempt (migration 0005). The lectures hashed and sent it but never stored it,
   which would make a retry from a worker send a different request than the original.
2. Busy-order answers are not stored, but permanent ones are. The lectures stored every response; doing that for a
   transient 409 would tell a client "in progress" forever.
3. `rejected` (the processor refused our request) is separate from `declined` (the card was refused), because only one
   of them is the customer's problem.

## Why these versions

- **NestJS 11, not 12.** NestJS 12 is ESM-only. That breaks Jest and the `@app/*` path aliases at
  runtime without extra loader tooling, which is noise for a learning project. Revisit later.
- **Kysely 0.28, not 0.29.** 0.29 is ESM-only; 0.28 ships a CommonJS build.
- **TypeScript 5.9, not 7.** TS 7 removed `moduleResolution: node10` and breaks the Nest CLI and
  ts-jest, which both use the TypeScript JS API.

## Conventions that matter for later stages

- **Real Postgres in tests, never mocks.** The guarantees (unique constraints, partial indexes,
  triggers, row locks) only exist in a real database.
- **`rawBody: true`** is set via `NEST_APP_OPTIONS` in `apps/api/src/bootstrap.ts`, so webhook
  signatures can be verified against the exact bytes received (Stage 7). A test guards it.
- **Test env vars** are set in `jest.setup-env.js`, before modules load, because
  `ConfigModule.forRoot()` snapshots `process.env` at import time.
- **The pool never crashes the process.** `createDb` listens for errors on idle connections (`onPoolError`),
  because node-postgres otherwise turns a dead idle connection into an unhandled error.
- **Schema is hand-written SQL** in `libs/db/migrations`; Kysely is only the query layer.
