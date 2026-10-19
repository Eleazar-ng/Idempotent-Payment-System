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
| 3 | Claim and replay path: canonical request hashing, atomic claim, replay | next |
| 4 to 12 | Fake processor, outbound path, ledger posting, webhooks, outbox, retries, recovery, observability, hardening | planned |

## Layout

```
apps/
  api/              HTTP API (claim/replay path, webhook receiver later)
  worker/           Background work: outbound calls, outbox relay, sweeper, reconciliation
  fake-processor/   Controllable Stripe-style processor used for failure injection
libs/
  config/           zod-validated environment (fails fast on bad config)
  db/               Kysely setup, DbModule, SQL migrations (libs/db/migrations)
  payments-core/    State machine, key derivation, hashing, ledger posting (from Stage 2)
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
- **Schema is hand-written SQL** in `libs/db/migrations`; Kysely is only the query layer.
