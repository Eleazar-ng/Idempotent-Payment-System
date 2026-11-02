# Architecture and guarantees (Stage 12)

One page that answers: what does this system promise, what enforces each promise, and which test would fail if it broke.
Everything named here exists in the repository; what does not exist is listed at the end.

## The shape

```
 client ──POST /v1/payments (Idempotency-Key)──▶ API ──charge (processor idempotency key)──▶ processor
   ▲                                              │  ▲                                          │
   │ replay / poll GET /v1/payments/:id           │  └──── signed webhooks (POST /webhooks/processor) ◀┘
   │                                              ▼
   │                                  Postgres: intents, attempts, idempotency_keys,
   │                                  ledger, webhook_events, outbox_events, findings
   │                                              ▲
 merchant ◀── signed events (x-event-id) ◀── worker: outbox relay · sweeper · reconciler
```

Three independent routes can learn that a charge happened: the API's own call, the processor's webhook, and the worker's
lookup (sweeper and reconciler). All three finish an attempt through the same function (`applyProcessorOutcome`), in one
transaction with the ledger posting and the merchant event, so it does not matter which one gets there first.

## The guarantees

| Promise | What enforces it | Fails if broken |
|---|---|---|
| The same request twice is one request | `idempotency_keys` primary key `(merchant_id, key)`, canonical request hash, stored response (Stage 3) | `idempotency.int-spec`, `payments.int-spec` (20 simultaneous identical requests) |
| The same key with a different request is refused | request hash compared on every replay | `payments.int-spec` (422), chaos "key reused with different details" |
| An order is paid once, whatever keys are used | one active attempt per intent: partial unique index (migration 0003) plus the order-level check | `payments.int-spec` (12 keys, one order), chaos "paying again is refused" |
| A retry never makes a second charge | the processor idempotency key is stored on the attempt and reused on every call and every recovery | chaos "charged at most once", mutation M1 |
| An unknown outcome is not a failure | a timeout or dropped connection leaves the attempt open; only a definitive answer ends it (`processor-outcome.ts`) | `payments.int-spec` (slow, dropped, 500-after), mutation M2 |
| States only move along legal edges | `status_transitions` table enforced by trigger, mirrored and drift-tested in `payments-core` (Stage 1-2) | `schema-transitions.int-spec`, `state-machine-drift.int-spec` |
| Money is booked once and balances | ledger posting key unique; deferred constraint triggers; success and posting must exist together (migrations 0004, 0006) | `ledger.int-spec`, `schema-posting.int-spec`, `checkLedgerInvariants` after every chaos run |
| Duplicate and reordered webhooks are harmless | `(source, event_id)` unique; webhooks go through the same transition function | `webhooks.int-spec` |
| The merchant hears about every final payment | event written in the same transaction as the final status; relay retries with backoff until 2xx; merchants dedupe on `x-event-id` | `outbox.int-spec`, `outbox-relay.int-spec`, chaos "told each final payment", mutations M4 and M6 |
| Lost information is found and repaired | sweeper (stuck attempts) and reconciler (disagreements): repairs what is safe, records findings for what needs a person (Stage 9) | `recovery.int-spec`, chaos "settles" |
| Callers are who they say; destinations are safe | hashed API keys, uniform 401; SSRF policy at registration and at delivery (Stage 11) | `api-keys.int-spec`, `url-policy.spec`, `safe-fetch.spec` |
| You can see it working | JSON logs with request ids, metrics, readiness, alert rules checked by test (Stage 10) | `observability.int-spec`, `observability.spec` |

## The capstone test

`apps/api/src/system-chaos.int-spec.ts` runs everything at once: real API, real worker loops, real Postgres, the fake
processor, and a merchant HTTP server. 36 orders over six card behaviours (success, decline, connection dropped after the
charge, 500 after the charge, reply slower than our timeout, gateway outage), each sent by four concurrent clients with the
same key plus a client that tampers with the amount, every processor webhook delivered three times, the merchant refusing
its first delivery of every third event, and the sweeper, reconciler and relay running against live traffic. Then it asks:

- every order was charged at most once at the processor, and the processor holds no charge we do not know about;
- every order ended where its card dictated (succeeded or failed), however much was lost on the way;
- all clients of an order heard one consistent story; tampered requests were refused every time;
- the ledger invariants hold; every final attempt has a merchant event; every event was delivered; none dead;
- no open reconciliation findings (nothing is waiting for a human);
- one ledger posting per success; paying a paid order again is a 409 and charges nothing.

Mutation checks (each breaks one guarantee, the capstone must go red): processor key changes per try, timeout treated as
a decline, already-paid guard removed, relay never retries, outbox event key made unique per call. All are caught. A sixth
(ledger posting key unique per call) made the run hang until the timeout instead of failing an assertion, so it is not
counted as a clean kill.

Two things the capstone taught that no earlier test had: a client that gets `202 processing` must poll
`GET /v1/payments/:id`, because the stored response for that key is a snapshot taken before the end (documented since
Stage 9; the capstone's own client got it wrong first); and an outage longer than the API's retry budget leaves the attempt
`abandoned` and the order blocked until the grace period passes, by design, rather than risking a second charge.

## Where the twelve modules went

| Module | Where it lives |
|---|---|
| 1 What idempotent means | `idempotency-key.ts`, `request-hash.ts`, `canonical-json.ts`, README Stage 3 |
| 2 Failure modes | `apps/fake-processor` (drop before/after, 500 after, slow, gateway error, duplicates, reordering) and the tests that use it |
| 3 The idempotency key pattern | `libs/db/src/idempotency.ts`, `idempotency-http.ts`, `apps/api/src/payments.service.ts` |
| 4 Database guarantees | `libs/db/migrations/0001-0010`, `schema-*.int-spec.ts` (tests that attack the database with SQL) |
| 5 State machines | `payment-states.ts`, `state-machine.ts`, `status_transitions`, drift test |
| 6 Concurrency control | conditional updates (`transitionAttempt`), unique indexes, `FOR UPDATE SKIP LOCKED` in outbox and recovery claims, concurrency tests |
| 7 Retry semantics | `retry-policy.ts` (exponential backoff, full jitter, cap, Retry-After), outbound retries, outbox retries |
| 8 API vs ledger boundary | `ledger-posting.ts`, `libs/db/src/ledger.ts`; posting is atomic with the success transition |
| 9 Reconciliation | `recovery-decision.ts`, `apps/worker/src/{recovery-sweeper,reconciler}.ts`, `reconciliation_findings` |
| 10 Scaling | stateless API; work distributed with `SKIP LOCKED` leases so workers can be added; see "not built" |
| 11 Production concerns | observability (Stage 10), API keys and SSRF (Stage 11), security headers, redaction, readiness vs liveness |
| 12 Real-world architecture | this page and the capstone |

## Not built (deliberately)

This is a teaching system. Before real money it would also need:

- a real processor adapter (Stripe test mode was planned after the fake; the processor client is the seam);
- refunds, disputes, payouts, subscriptions, multiple currencies per payment, FX;
- Redis/BullMQ queues: the outbox and recovery loops poll Postgres instead, which is simpler and is what this design
  needs at modest volume; very high volume would want partitioned tables, archiving, and read replicas;
- rate limiting and per-merchant quotas, key scopes, audit log of admin actions;
- secrets management and backups, migrations run as a controlled deploy step, a runbook per alert;
- PCI scope decisions (this system never sees card numbers: `source` is a token).
