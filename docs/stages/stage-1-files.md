# Stage 1: Schema and constraints. Files affected

Stage 1 moved the core payment invariants into Postgres (SQL migrations, a migration runner, and
tests that attack the schema directly).

**Totals:** 16 added, 7 modified, 0 removed. No dependency changes (`pnpm-lock.yaml` is untouched).
Everything not listed here is unchanged from Stage 0.

Equivalent in git, once this stage is committed: `git show --name-status <stage-1-commit>`.

## Added

### Migrations (`libs/db/migrations`)

| File | Purpose |
|---|---|
| `0001_core_tables.sql` | Generic trigger helpers (`touch_updated_at`, immutability, write-once, append-only); `merchants`, `payment_intents`, `payment_attempts`, `idempotency_keys` with their constraints. Defines custom SQLSTATE codes `PY001` to `PY005`. |
| `0002_status_transitions.sql` | `status_transitions` and `status_initial` reference tables, the single enforcing trigger function, and the trigger that marks an intent `succeeded` when one of its attempts does. |
| `0003_attempt_integrity.sql` | Partial unique index (at most one non-failed attempt per intent), guard that blocks attempts on non-open intents, guard that keeps intent terminal states consistent with their attempts. |
| `0004_ledger.sql` | `ledger_accounts`, `ledger_transactions`, `ledger_entries`; append-only triggers (including `TRUNCATE`); deferred balance and sealing check; `ledger_account_balances` view. |

### Migration runner (`libs/db/src`)

| File | Purpose |
|---|---|
| `migrator.ts` | Applies pending `.sql` files in order: advisory lock, one transaction per file, checksum check, out-of-order detection. |
| `migrate-cli.ts` | Entry point for `pnpm db:migrate`; reads `DATABASE_URL`. |
| `migrator.spec.ts` | Unit tests: file-name rules, ordering, checksums, and that the real migrations are numbered without gaps. |
| `migrator.int-spec.ts` | Integration tests against real Postgres: apply, idempotent re-run, edited-file refusal, rollback on failure, concurrent runs. |

### Schema tests (`libs/db/src`, all integration tests on real Postgres)

| File | Purpose |
|---|---|
| `schema-core.int-spec.ts` | Core tables: amount and currency checks, one intent per order, per-merchant keys, atomic claim with a many-way concurrent race, frozen responses, immutability, write-once charge id. |
| `schema-transitions.int-spec.ts` | The full 7 x 7 attempt transition matrix, initial-state enforcement, the late-event scenarios from Module 5.6, intent machine, success propagation. |
| `schema-integrity.int-spec.ts` | One active attempt per intent (including a concurrent race), `abandoned` blocking new attempts, intent guards, cancel-versus-new-attempt race. |
| `schema-ledger.int-spec.ts` | Balanced postings, refusal of unbalanced ones at commit, sealed transactions, currency matching, one posting per event, append-only behavior, reversing transactions. |

### Test helpers (`libs/testing/src`)

| File | Purpose |
|---|---|
| `seed.ts` | Fixtures: create merchants, intents, attempts and ledger accounts; advance an attempt to a given status; post ledger transactions. |
| `sql-errors.ts` | `PG` error-code constants and `expectSqlState()` for asserting that the database refused something for the right reason. |

### Documentation (`docs/stages`)

| File | Purpose |
|---|---|
| `stage-0-files.md` | File list for Stage 0 (written retroactively, after Stage 1). |
| `stage-1-files.md` | This file. |

## Modified

| File | What changed |
|---|---|
| `libs/db/src/database.types.ts` | From an empty placeholder to full Kysely table and status types matching the migrations. |
| `libs/db/src/create-db.ts` | `bigint` columns are now parsed to JS numbers (throwing if a value exceeds the safe-integer range) instead of arriving as strings. |
| `libs/db/src/index.ts` | Also exports the migrator. |
| `libs/testing/src/postgres.ts` | New `TEST_PG_ADMIN_URL` mode (a fresh database on an existing server, so tests run without Docker) and `startMigratedPostgres()`. |
| `libs/testing/src/index.ts` | Also exports `sql-errors` and `seed`. |
| `package.json` | Added the `db:migrate` script. |
| `README.md` | Stage status table, `pnpm db:migrate` and `TEST_PG_ADMIN_URL` instructions, Node 22.9+ requirement, the database design table, and the two deliberate differences from the lectures. |

## Removed

None.
