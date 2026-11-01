# Stage 3: Claim and replay path. Files affected

Stage 3 added canonical, versioned request hashing, strict idempotency-key validation, and the
database operations that claim a key atomically, store its response once, and replay it to duplicates.

**Totals:** 13 added (including this file), 6 modified, 0 removed. No dependency changes
(`pnpm-lock.yaml` is untouched). Everything not listed here is unchanged from Stage 2.

Equivalent in git, once this stage is committed: `git show --name-status <stage-3-commit>`.

## Added

### Hashing and key rules (`libs/payments-core/src`)

| File | Purpose |
|---|---|
| `canonical-json.ts` | `canonicalize()`: one canonical string per JSON value (sorted keys, no whitespace). Refuses values with no single form (`undefined`, `NaN`, `Date`, circular...). |
| `request-hash.ts` | `createRequestHasher()`, `hashV1` (sha256 of canonical `{operation, body}`) and the default `requestHasher`. Hashes carry a version; matching uses the stored row's version. |
| `idempotency-key.ts` | `assertValidIdempotencyKey()`: visible ASCII, 1 to 255 characters. |
| `idempotency-http.ts` | `conflictResponse()`: the 409 (in flight, retryable) and 422 (key reused) responses. |
| `canonical-json.spec.ts` | Unit tests: ordering, formatting independence, lookalike values, escaping, every refused value type, error path. |
| `request-hash.spec.ts` | Unit tests: known-answer vector pinning version 1, sensitivity to every kind of change, operation binding, version upgrade behaviour. |
| `idempotency-key.spec.ts` | Unit tests for key validation and the two conflict responses. |

### Claim and replay (`libs/db/src`)

| File | Purpose |
|---|---|
| `idempotency.ts` | `claimKey()` (one `INSERT ... ON CONFLICT DO NOTHING`, then `claimed` / `replay` / `in_flight` / `mismatch`), `completeKey()` (first write wins, returns the original response on repeats), `releaseClaim()` (only a claim with no attempt and no response). |
| `idempotency.spec.ts` | Unit tests: bad keys, bad bodies and bad statuses are refused before any query. |
| `idempotency.int-spec.ts` | Integration tests on real Postgres: all four outcomes, replay fidelity, scoping per merchant, release rules, hash versioning, claims inside open transactions, vanished-row retry, and the 50-way races. |

### Pool resilience (`libs/db/src`)

| File | Purpose |
|---|---|
| `create-db.int-spec.ts` | Kills a real idle pooled connection and checks the pool reports it (no crash) and recovers; also pins the bigint-to-number parsing and its safe-range refusal. Added after a flaky teardown error surfaced this stage (see Modified). |

### Documentation (`docs/stages`)

| File | Purpose |
|---|---|
| `stage-3-files.md` | This file. |

## Modified

| File | What changed |
|---|---|
| `libs/payments-core/src/errors.ts` | Added `NonCanonicalValueError`, `UnknownHashVersionError`, `InvalidIdempotencyKeyError`. |
| `libs/payments-core/src/index.ts` | Also exports the four new modules. |
| `libs/db/src/index.ts` | Also exports `claimKey`, `completeKey`, `releaseClaim` and their types. |
| `libs/db/src/create-db.ts` | The pool now has an `error` listener (`onPoolError`, default: log). Without one, node-postgres turns a dead idle connection into an unhandled error that crashes the process. Found as a roughly 1-in-5 flaky failure in the Stage 2 race test, caused by dropping a test database while its pool's sockets were still closing. |
| `libs/testing/src/postgres.ts` | Passes a handler that stays quiet during teardown and logs at any other time. |
| `README.md` | Status table; new "Idempotency keys (Stage 3)" section with outcome table, caller rules and deliberate differences from the lectures. |

## Removed

None.
