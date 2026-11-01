# Stage 6: Ledger posting, atomic with the success transition. Files affected

Stage 6 books every succeeded payment in the ledger in the same transaction that marks the attempt `succeeded`, and
makes the database refuse either one without the other (migration `0006`, SQLSTATE `PY006`).

**Totals:** 8 added (including this file), 17 modified, 0 removed. No dependency changes. One new migration (`0006`).
Everything not listed here is unchanged from Stage 5.

## Added

| File | Purpose |
|---|---|
| `libs/db/migrations/0006_success_requires_posting.sql` | Two deferred constraint triggers: a succeeded attempt needs a matching posting, and a posting for an attempt needs a succeeded attempt (`PY006`). |
| `libs/payments-core/src/ledger-posting.ts` | Pure posting logic: account codes, `computeFee` (BigInt, half up), `buildAttemptSuccessPosting`, `assertBalanced`. |
| `libs/payments-core/src/ledger-posting.spec.ts` | Unit tests for the above (35). |
| `libs/db/src/ledger.ts` | `ensureAccount`, `postLedger` (idempotent under the posting key), `postAttemptSuccess`, `getMerchantBalances`. |
| `libs/db/src/invariants.ts` | `checkLedgerInvariants`: the books' health questions, run after tests and later in production. |
| `libs/db/src/schema-posting.int-spec.ts` | Attacks migration 0006: success without posting, wrong amount, wrong currency, posting without success, unknown attempt, mismatched source. |
| `libs/db/src/ledger.int-spec.ts` | Account creation races, posting once, fee math end to end, balances, rollback when booking fails, repair of an unbooked success, invariants. |
| `docs/stages/stage-6-files.md` | This file. |

## Modified

| File | Change |
|---|---|
| `libs/db/src/payments.ts` | `applyProcessorOutcome` takes `{ feeBps }` and books the success in the same transaction. |
| `libs/db/src/index.ts` | Exports `ledger` and `invariants`. |
| `libs/db/src/database.types.ts` | Adds the `ledger_account_balances` view type. |
| `libs/payments-core/src/index.ts` | Exports the posting module. |
| `libs/config/src/env.ts`, `env.spec.ts`, `.env.example` | New `PLATFORM_FEE_BPS` (0 to 10000, default 150). |
| `apps/api/src/payments.service.ts` | Passes `feeBps` to settlement; adds `getBalance`. |
| `apps/api/src/payments.controller.ts` | Adds `GET /v1/balance`. |
| `apps/api/src/app.module.ts` | Registers the controller and wires the fee setting. |
| `apps/api/src/payments.int-spec.ts` | Ledger end-to-end tests, balance tests, rollback test; ledger invariants checked after every test. |
| `libs/testing/src/seed.ts` | `setAttemptStatus` books the success; generic ledger helper no longer pretends to be an attempt success. |
| `libs/testing/src/sql-errors.ts` | Adds `PG.POSTING_MISMATCH` (`PY006`). |
| `libs/db/src/payments.int-spec.ts` | Passes `{ feeBps: 0 }` to `applyProcessorOutcome`. |
| `libs/db/src/attempts.int-spec.ts` | Local `transition()` wrapper books the ledger when moving to `succeeded`. |
| `libs/db/src/state-machine-drift.int-spec.ts` | The all-pairs loop books the ledger for legal moves to `succeeded`. |
| `README.md` | Status table and the Stage 6 section. |
