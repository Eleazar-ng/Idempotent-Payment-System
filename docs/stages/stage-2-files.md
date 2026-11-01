# Stage 2: State machine library and conditional-update helper. Files affected

Stage 2 added the payment state machines as pure TypeScript, a test that keeps them identical to the
database's tables, and `transitionAttempt()`, the one safe way for application code to change an
attempt's status.

**Totals:** 10 added (including this file), 3 modified, 0 removed. No dependency changes
(`pnpm-lock.yaml` is untouched). Everything not listed here is unchanged from Stage 1.

Equivalent in git, once this stage is committed: `git show --name-status <stage-2-commit>`.

## Added

### State machines (`libs/payments-core/src`)

| File | Purpose |
|---|---|
| `state-machine.ts` | `createStateMachine()`: a small immutable state machine builder with `canTransition`, `assertTransition`, `nextStatuses`, `legalPredecessors`, `isTerminal`, `edges`. Validates its own definition at startup (no undeclared targets, no self-transitions). |
| `payment-states.ts` | `attemptMachine` (7 statuses) and `intentMachine` (3 statuses), the `AttemptStatus` / `IntentStatus` types, and `isActiveAttemptStatus()` (the predicate of the one-active-attempt index). |
| `errors.ts` | `InvalidTransitionError`, thrown before any query when a requested move is not legal. |
| `state-machine.spec.ts` | Unit tests: the full 7 x 7 matrix against an independently written expected list, reachability, terminal states, predecessors, the Module 5.6 late-event scenarios, immutability, definition validation. |

### Conditional-update helper (`libs/db/src`)

| File | Purpose |
|---|---|
| `attempts.ts` | `transitionAttempt(db, attemptId, to, { from, ... })`: one `UPDATE ... WHERE status IN (from)` that returns `applied`, `already_applied`, `stale` or `not_found`. Accepts a connection or a transaction. |
| `attempts.spec.ts` | Unit tests for what is refused before any query is sent (illegal moves, missing failure reason, empty `from`), using a database that explodes if touched. |
| `attempts.int-spec.ts` | Integration tests on real Postgres: all four outcomes, the Module 4.3 timeout-job scenario, 25-way duplicate and 30-way conflicting races, database protections underneath, rollback and commit inside a transaction. |

### Drift protection (`libs/db/src`)

| File | Purpose |
|---|---|
| `state-machine-drift.int-spec.ts` | Fails if the TypeScript machines and the SQL tables disagree on moves, initial status, status set or terminal states; asks the real trigger about all 42 off-diagonal attempt pairs; checks `isActiveAttemptStatus` against the real unique index for every status. |
| `status-types.spec.ts` | Compile-time check that the status unions in `payments-core` and in the database types are identical. |

### Documentation (`docs/stages`)

| File | Purpose |
|---|---|
| `stage-2-files.md` | This file. |

## Modified

| File | What changed |
|---|---|
| `libs/payments-core/src/index.ts` | From an empty placeholder to exporting the state machine library. |
| `libs/db/src/index.ts` | Also exports `transitionAttempt` and its types. |
| `README.md` | Stage status table, and a new "State machines (Stage 2)" section describing the two enforcement layers and the four transition outcomes. |

## Removed

None.
