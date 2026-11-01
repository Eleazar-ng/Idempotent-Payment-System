# Stage 9: Recovery and reconciliation. Files affected

Stage 9 makes the system repair itself. A pure decision function (`decideRecovery`) says what to do with an attempt given what
the processor reports. A recovery sweeper acts on stuck attempts and dead requests' idempotency keys; a reconciler compares all
attempts with all processor charges, repairs what is unambiguous and records everything else as a finding. The API settle step
now accepts an attempt the sweeper abandoned while the processor was merely slow.

**Totals:** 14 added (including this file), 12 modified, 0 removed. No dependency changes. One new migration (`0009`).
Everything not listed here is unchanged from Stage 8.

## Added

### Decision rules (`libs/payments-core/src`)

| File | Purpose |
|---|---|
| `recovery-decision.ts` | `decideRecovery(attempt, charge, policy)`: pure; returns none, wait, apply, abandon, fail_unreached or finding. Finding kinds and snapshot types. |
| `recovery-decision.spec.ts` | 42 unit tests over the status by charge-status table, thresholds, final states never overwritten. |

### Database (`libs/db`)

| File | Purpose |
|---|---|
| `migrations/0009_reconciliation_findings.sql` | `reconciliation_findings`: dedupe key, kind, source, status open/resolved with a mandatory resolution note, seen count, immutability trigger. |
| `src/payment-response.ts` | `paymentView` and `paymentResult`, moved out of the API so recovery can build the same answer under a key. |
| `src/recovery.ts` | Candidates and reconciliation loaders, `applyRecoveryDecision` (one transaction, conditional), key completion and claim release, findings (`recordFinding`, `resolveFinding`, `resolveFindingsNoLongerObserved`, `listOpenFindings`, webhook ingestion). |
| `src/recovery.int-spec.ts` | Candidate selection, each decision applied, races, key repair, finding stickiness and auto-resolution (30). |
| `src/schema-findings.int-spec.ts` | Attacks migration 0009: resolution rules, uniqueness, immutability. |

### Worker (`apps/worker/src`)

| File | Purpose |
|---|---|
| `processor-lookup.ts` | Read-only processor client: `findByReference`, `listCharges`. Throws on any failure or ambiguity, never returns null for an error. |
| `recovery-sweeper.ts` | `RecoverySweeper.runOnce()`: release stale claims, complete orphaned keys, look up stuck attempts, apply or record. |
| `reconciler.ts` | `Reconciler.runOnce()`: list charges, compare, repair, record findings and orphan charges, auto-close what is gone. |
| `periodic-loop.ts` | Small timer loop that survives failed runs and stops promptly. |
| `recovery.service.ts` | Nest service starting both loops on their own intervals. |
| `recovery.int-spec.ts` | Worker against real Postgres and the real fake processor over HTTP (17). |

### Docs

| File | Purpose |
|---|---|
| `docs/stages/stage-9-files.md` | This file. |

## Modified

| File | Change |
|---|---|
| `apps/api/src/payments.service.ts` | `settle` accepts `abandoned` attempts for succeeded, declined and rejected outcomes. |
| `apps/api/src/payment-http.ts` | Re-exports `paymentResult`/`paymentView` from `@app/db`; 502 also for `never_reached_processor`. |
| `apps/api/src/payments.int-spec.ts` | New test: a slow success settles an abandoned attempt (65 tests in file). |
| `apps/worker/src/worker.module.ts` | Wires the lookup, recovery options and `RecoveryService`. |
| `libs/config/src/env.ts` | Eight `RECOVERY_*` / `RECONCILIATION_*` settings. |
| `libs/config/src/env.spec.ts` | Defaults and rejected values for the new settings. |
| `libs/db/src/database.types.ts` | `reconciliation_findings` table and types. |
| `libs/db/src/index.ts` | Exports `recovery` and `payment-response`. |
| `libs/payments-core/src/index.ts` | Exports `recovery-decision`. |
| `libs/testing/src/seed.ts` | `setAttemptStatus` also queues the merchant event for final states. |
| `.env.example` | The new settings. |
| `README.md` | Stage 9 section; status table; earlier "until Stage 9" gap notes updated. |
