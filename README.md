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
| 6 | Ledger posting, atomic with the success transition | **done** |
| 7 | Webhook receiver | **done** |
| 8 | Outbox and a real retry policy (with jitter) | **done** |
| 9 | Recovery and reconciliation (stuck attempts, missing webhooks) | **done** |
| 10 | Observability | next |
| 11 to 12 | Hardening, final | planned |

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
- A claim whose request crashes before `completeKey` stays `in_flight` until the recovery sweeper (Stage 9) deals with it:
  it releases a claim that never got an attempt and finishes a key whose attempt has an answer.

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

- A `pending` or `requires_action` attempt is completed by the webhook (Stage 7). If the webhook never comes, the recovery sweeper (Stage 9) asks the processor.
- If the process dies after an attempt exists but before the response is stored, the recovery sweeper (Stage 9) finishes the key. Before an attempt exists the claim is released instead.
- Retries between processor calls use the jittered backoff policy from Stage 8 (`PROCESSOR_RETRY_DELAY_MS` up to `PROCESSOR_RETRY_MAX_DELAY_MS`).

### Deliberate differences from the lectures

1. The payment source is stored on the attempt (migration 0005). The lectures hashed and sent it but never stored it,
   which would make a retry from a worker send a different request than the original.
2. Busy-order answers are not stored, but permanent ones are. The lectures stored every response; doing that for a
   transient 409 would tell a client "in progress" forever.
3. `rejected` (the processor refused our request) is separate from `declined` (the card was refused), because only one
   of them is the customer's problem.

## Ledger posting (Stage 6)

A succeeded payment is booked in the same transaction that marks the attempt `succeeded`. `applyProcessorOutcome`
is the single place that does both, so the API now, the webhook handler (Stage 7) and reconciliation (Stage 9)
all book the same way.

| Line | Account (kind) | Amount for a 5000 payment at 150 bps |
|---|---|---|
| debit | `processor_receivable:CCY` (asset) | 5000 |
| credit | `merchant_payable:<merchant>:CCY` (liability) | 4925 |
| credit | `platform_fee_revenue:CCY` (revenue) | 75 |

The fee is `amount * PLATFORM_FEE_BPS / 10000`, rounded half up in integer arithmetic (default 150). A zero fee
leaves out its line. Accounts are created on first use. The posting key is `attempt:<id>:succeeded`, so booking the
same success twice writes nothing the second time.

**The rule the database enforces (migration 0006, SQLSTATE `PY006`):** an attempt is `succeeded` if and only if
its posting exists and its debits equal the payment amount, in the payment currency. Both sides are deferred
constraint triggers, checked at COMMIT: a success without a posting is refused, and a posting for an attempt
that has not succeeded is refused. The only way to satisfy them is one transaction, in either order.

`checkLedgerInvariants(db)` asks the same questions after the fact (plus "debits equal credits" and "one success
per order") and returns the violations. Every API test runs it afterwards. `GET /v1/balance` reports what the
platform owes the merchant, read from the ledger and never from a stored counter.

If booking fails (say an account exists with the wrong kind), the whole settlement rolls back: the attempt stays
`calling_processor`, the customer has been charged exactly once, and the unresolved attempt is left for recovery
(Stage 9). That is deliberate: "paid but not booked" must not exist.

### Deliberate differences from the lectures

1. The success-and-posting pairing is enforced by the database, not just by application code.
2. `already_applied` still calls the (idempotent) posting, so a success that was somehow left unbooked is repaired
   when the same outcome arrives again.
3. Not covered by a test: creating accounts in sorted order to avoid deadlocks. It is in the code, but a deterministic
   test for it was not worth the complexity here.

## Webhook receiver (Stage 7)

`POST /webhooks/processor` is how the processor tells us a payment finished after our request returned (`pending` to
`succeeded`, `requires_action` to `failed`, ...). The processor sends each event **at least once**: duplicates, late
copies and out-of-order delivery are normal, and the receiver is built for them.

```
raw bytes + Processor-Signature ─► verify (HMAC over "<t>.<body>", 5 min tolerance) ─► 400 if not
                                  ─► parse the event                                    ─► 400 if unusable
                                  ─► ONE transaction:  claim event id ─► find attempt ─► applyProcessorOutcome ─► record verdict
                                  ─► 200 (always, once the event is recorded)
```

| Rule | How |
|---|---|
| Only the processor can say a payment succeeded | HMAC over the **raw** request bytes (`rawBody`), constant-time compare, timestamp inside the signed data; re-spaced JSON fails on purpose |
| Same event twice is handled once | `webhook_events` has `UNIQUE (source, event_id)` (migration 0007); the claim is the first statement of the transaction, so a concurrent copy waits and then sees it finished |
| A recorded event is a fully handled event | claim, status change and ledger posting commit together. If handling fails the claim rolls back, the answer is 5xx, and the processor redelivers into a clean slate |
| Success books the ledger | same `applyProcessorOutcome` as the API, so migration 0006 holds on this path too |
| A late or duplicate event is not an error | `already_applied`, acknowledged with 200 |
| `requires_action` can finish as `succeeded` | the handler steps through `processing` first, the only legal route |
| The processor and we disagree | recorded, **not applied**, acknowledged (resending cannot change the answer) |

How an attempt is found: by the charge id once we hold it, otherwise by the `reference` we put in the charge request (the
attempt's processor idempotency key). The second route is what lets a webhook complete a payment whose API response never
arrived.

What each verdict in `webhook_events.result` means:

| Result | Meaning | Needs attention? |
|---|---|---|
| `applied` | moved the attempt to the state the event describes | no |
| `already_applied` | the attempt was already there (API answer or an earlier event) | no |
| `ignored` | an event type we do not act on | no |
| `unmatched` | a charge no attempt of ours explains | yes |
| `mismatch` | amount or currency differ from the payment | yes |
| `conflict` | contradicts a final state (success for a failed attempt and the reverse), or a different charge id | yes |

`listWebhookEventsNeedingAttention(db)` returns the last three kinds; reconciliation (Stage 9) copies them into `reconciliation_findings`, where each has an owner and a resolution.
Rows are immutable once handled (triggers, `PY002` and `PY003`); `DELETE` stays possible for retention.

### Known gaps, by design

- If the processor never sends the webhook (or gives up retrying), the recovery sweeper (Stage 9) asks the processor directly.
- Conflicts and mismatches become findings (Stage 9); nothing alerts on them yet (Stage 10).
- One shared secret, no rotation window wired in (`verifyWebhook` already accepts several; configuration comes in Stage 11).
- Handling runs inside the HTTP request, on purpose: the work is one database transaction, and putting a queue in front of it would add a second place an event can be lost. (The outbox in Stage 8 is for what we send, not for what we receive.)

### Deliberate differences from the lectures

1. The dedup record is written in the same transaction as the effect, not before it. Marking an event "seen" first and
   then failing would make the processor's redelivery a no-op and lose the payment.
2. Disagreements are acknowledged with 200 and stored, not rejected with 4xx, because a 4xx just makes the processor retry
   forever against an answer that cannot change.
3. Looking an attempt up by `reference` as well as by charge id (the lectures matched on charge id only).

## Outbox and retries (Stage 8)

Two separate things arrive in this stage.

### Retry policy

`retryDelayMs(policy, retryNumber)` in `libs/payments-core` is the one place that decides how long to wait before
trying again: exponential growth from a base, capped at a maximum, then **jitter**. Plain doubling makes every client
that failed together retry together; full jitter (the default) picks uniformly between 0 and the ceiling, which
spreads the load while the other side recovers. A `Retry-After` from the other side is honoured as a floor, but never
beyond the policy maximum. The random source is a parameter, so tests pin it. The processor calls (Stage 5) and the
merchant deliveries below both use it.

### Transactional outbox

Telling a merchant "your payment succeeded" has to happen if and only if the payment really did succeed. An HTTP
call inside the transaction cannot promise that (the call can succeed and the commit fail, or the reverse). So the
transaction only **writes a row**, and a separate relay delivers it afterwards.

```
applyProcessorOutcome  ──one transaction──►  attempt status  +  ledger posting  +  outbox_events row
                                                                                        │
worker: claim due rows (FOR UPDATE SKIP LOCKED, lease) ─► POST signed body to merchant ─┘
        2xx ► delivered     else ► retry later (jittered backoff, Retry-After)     max attempts ► dead
```

| Rule | How |
|---|---|
| The event exists exactly when the final status does | written inside `applyProcessorOutcome`, in the same transaction as the status change and the ledger posting; if booking fails, no event |
| One event per fact, whichever path got there | `dedupe_key` such as `payment.succeeded:attempt:12` is unique; the API answer, the webhook and a replay all converge on one row |
| Several workers can run | `FOR UPDATE SKIP LOCKED` hands each row to one claimer without anyone waiting for anyone |
| A crashed worker loses nothing | a claim is a **lease** (`locked_until`); when it runs out the row is due again. The attempt counter goes up at claim time, so a poison event cannot loop forever |
| A slow merchant cannot hold up the rest | a batch is delivered concurrently, and each delivery has a timeout well inside the lease |
| A stale worker cannot overwrite a newer one | retry and dead updates are fenced on the attempt number; a success is always recorded |
| Merchants can deduplicate | the event id (`evt_out_<id>`, header `X-Event-Id`) and the body bytes are identical on every retry |
| Merchants can trust it | body signed with the merchant's own secret, same `t=...,v1=...` scheme as the processor's webhooks, header `Platform-Signature` |
| Redirects are not followed | a signed body must not travel to a URL the merchant never registered |

Statuses: `pending` (waiting, possibly for a retry), `delivered` (2xx), `skipped` (the merchant had no webhook URL when
we got there), `dead` (gave up after `OUTBOX_MAX_ATTEMPTS`; `listDeadOutboxEvents` shows them, `requeueDeadOutboxEvent`
puts one back once the merchant is fixed). Delivered and skipped rows are frozen by trigger; DELETE stays allowed for retention.

`findAttemptsMissingOutboxEvent(db)` asks the invariant question afterwards ("is there a final attempt nobody was told
about?"); API tests run it after every test.

Merchant events: `payment.succeeded` and `payment.failed`, with `payment_id`, `order_id`, `amount`, `currency`,
`attempt_id`, `attempt_number` and `failure_code`. `pending`, `processing` and `requires_action` are not news yet.

### Known gaps, by design

- Merchants cannot set their own webhook URL through the API yet (the columns exist, migration 0008); real
  authentication and merchant management come in Stage 11.
- Nothing stops a merchant registering an internal address as their URL (a server-side request forgery risk). That check belongs to Stage 11.
- Delivery order between events of one merchant is not guaranteed (a retried event can arrive after a later one);
  every event carries `created` and the full payment facts, so the receiver can tell which is newer.
- No alert when events go dead or the queue backs up; Stage 10.

### Deliberate differences from the lectures

1. Postgres is the queue; BullMQ and Redis are not used. The row has to exist in the payment transaction anyway, and a
   second queue would be a second place for an event to be lost or duplicated. A queue can be added later in front of the relay.
2. The attempt counter increments at claim time, not at failure time (so a worker that dies mid-delivery still counts).
3. `Retry-After` is capped by the policy maximum, so a merchant cannot park an event for days.

## Recovery and reconciliation (Stage 9)

Everything before this stage assumed the happy half of "unknown": the call timed out, we asked again, we got the answer.
Stage 9 is for the payments nobody is looking at: the process died mid-call, the webhook never came, the processor
and our books disagree. Two loops run in the worker, both reading the processor and neither guessing.

### The decision function

`decideRecovery(attempt, charge | null, policy)` in `payments-core` is pure and is the only place the rules live.
The sweeper and the reconciler both call it, so they cannot disagree. It answers one of:
`none`, `wait`, `apply {outcome}`, `abandon`, `fail_unreached`, `finding {kind, detail}`.

| Attempt | Processor says | Decision |
|---|---|---|
| `calling_processor`, idle < `RECOVERY_STUCK_AFTER_MS` | anything | `wait` (the request may still be running) |
| `calling_processor`, idle longer | no charge | `abandon` (outcome unknown, still blocks a new payment) |
| `abandoned`, younger than `RECOVERY_ABANDONED_GRACE_MS` | no charge | `wait` |
| `abandoned`, older than the grace | no charge | `fail_unreached` (`never_reached_processor`, 502) |
| non-final | succeeded / failed / pending / requires_action | `apply` the matching outcome, if the move is legal |
| final (`succeeded`, `failed`) | a charge that agrees | `none` |
| final | a charge that contradicts it | `finding`, never an overwrite |
| any | wrong amount/currency, another charge id, a charge for an attempt that never called | `finding` |

Rules the code keeps: an attempt moves only on a **definitive** processor answer; **a lookup that fails changes nothing**
(`ProcessorLookup` throws, it never returns `null` for an error, because `null` means "the processor has no such charge" and
recovery acts on that); a final state is never overwritten; `requires_action` reaches `succeeded` through `processing`.

### Recovery sweeper (`RecoverySweeper`, every `RECOVERY_INTERVAL_MS`)

1. Releases claims older than `RECOVERY_CLAIM_STALE_AFTER_MS` that never got an attempt.
2. Completes keys whose attempt is past `calling_processor` but whose request died (the client's retry now gets the real answer).
3. Looks up each stuck attempt by `metadata.reference` (the processor idempotency key), applies the decision in **one transaction**
   (attempt move, ledger posting, merchant event, key completion), each step conditional on the status it was decided against.
   Several workers, webhooks and API requests can race; one wins and the rest report `stale` or `already_applied`.

### Reconciler (`Reconciler`, every `RECONCILIATION_INTERVAL_MS`)

Lists every processor charge, loads our attempts (everything created within `RECONCILIATION_LOOKBACK_MS`, plus every unresolved
one however old), and runs the same decision for each. What is unambiguous is repaired; everything else is a row in
`reconciliation_findings` (migration 0009), recorded once (`dedupe_key`) with `seen_count` rising when it comes back:

`paid_but_failed`, `failed_but_charge_open`, `succeeded_but_charge_not_succeeded`, `success_without_charge`, `charge_missing`,
`amount_mismatch`, `charge_id_conflict`, `orphan_charge`, `unexpected_charge`, plus `webhook_*` for the Stage 7 events that needed attention.

- A finding closes itself ("no longer observed") only if its **subject was examined in this pass** and not flagged again. A finding about
  something outside the lookback stays open: ageing out of a window is not a fix.
- A finding a **person** resolved stays resolved even if the discrepancy persists (a refunded charge still reads as succeeded);
  one the system closed reopens if it comes back. `resolveFinding(db, id, 'what was done')` requires a non-blank note.
- If the processor cannot be listed the run aborts before touching anything, in particular before closing any finding.

### API change

A slow call that finally succeeds after the sweeper abandoned it still settles the attempt (`abandoned -> succeeded` is legal):
the customer gets their 201 and one posting. `processing` and `requires_action` answers apply only to an attempt still in
`calling_processor`, since `abandoned -> processing` is not a legal move.

### Settings (worker)

`RECOVERY_INTERVAL_MS` 30000, `RECOVERY_STUCK_AFTER_MS` 120000, `RECOVERY_PENDING_AFTER_MS` 900000, `RECOVERY_ABANDONED_GRACE_MS` 90000000 (25 h),
`RECOVERY_CLAIM_STALE_AFTER_MS` 300000, `RECOVERY_BATCH_SIZE` 100, `RECONCILIATION_INTERVAL_MS` 3600000, `RECONCILIATION_LOOKBACK_MS` 172800000.
It also uses `PROCESSOR_BASE_URL`, `PROCESSOR_TIMEOUT_MS` and `PLATFORM_FEE_BPS`.

### Known gaps, by design

- Findings are listed (`listOpenFindings`) but there is no API or alert for them yet (Stage 10 and later).
- When an attempt is abandoned its key is completed with a 202 "processing" answer; that stored answer is **not** rewritten when the attempt
  later settles, so a client replaying the key polls `GET /v1/payments/:id` for the final state.
- The fake processor lists every charge with no pagination; a real processor needs paging in `listCharges`.
- No refund flow yet, so a refunded charge would show as a finding for a person to close.

### Deliberate differences from the lectures

1. Discrepancies on final states are findings, not automatic corrections: moving money state on a guess is worse than a human looking once.
2. The 25 hour grace before an abandoned attempt is failed covers the processor's 24 hour idempotency window plus margin: until then a retry could still replay a charge.
3. The worker has its own small lookup client instead of reusing the API's, so the sweeper can distinguish "no charge" from "could not ask".

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
