# Stage 0: Scaffold. Files affected

Stage 0 created the project: NestJS monorepo, Docker Compose, validated config, and the test harness.
Written retroactively after Stage 1, from the Stage 0 zip.

**Totals:** 43 added, 0 modified, 0 removed (the project did not exist before).

Equivalent in git, once committed: `git show --name-status <stage-0-commit>`.

## Added

### Root configuration

| File | Purpose |
|---|---|
| `package.json` | Dependencies and scripts (`build`, `test`, `test:int`, `lint`, `typecheck`, `db:up`, `start:*`). |
| `pnpm-lock.yaml` | Locked dependency versions (NestJS 11, Kysely 0.28, TypeScript 5.9). |
| `tsconfig.json` | Compiler options and the `@app/*` path aliases for the shared libs. |
| `nest-cli.json` | Nest monorepo definition: three apps, four libs, webpack bundling. |
| `docker-compose.yml` | Postgres 16 and Redis 7 with health checks. |
| `.env.example` | Template for local environment variables. |
| `.gitignore`, `.prettierrc` | Ignore rules and formatting. |
| `eslint.config.mjs` | Lint rules. |
| `jest.config.js` | Unit-test configuration (`*.spec.ts`). |
| `jest.integration.config.js` | Integration-test configuration (`*.int-spec.ts`, 2-minute timeout). |
| `jest.setup-env.js` | Sets test environment variables before any module loads. |
| `README.md` | Project overview, layout and getting-started steps. |

### `apps/api`

| File | Purpose |
|---|---|
| `src/main.ts` | Starts the HTTP server on `API_PORT`. |
| `src/bootstrap.ts` | Creates the Nest app with `rawBody: true` (needed later to verify webhook signatures). |
| `src/app.module.ts` | Root module: config, database, health controller. |
| `src/health.controller.ts` | `GET /health` liveness probe. |
| `src/app.spec.ts` | Tests: the app boots with valid config, and raw request bytes are preserved. |
| `tsconfig.app.json` | App compiler settings. |

### `apps/worker`

| File | Purpose |
|---|---|
| `src/main.ts` | Starts a Nest application context (no HTTP server). |
| `src/worker.module.ts` | Root module: config and database. |
| `tsconfig.app.json` | App compiler settings. |

### `apps/fake-processor`

| File | Purpose |
|---|---|
| `src/main.ts` | Starts the controllable stand-in payment processor on `FAKE_PROCESSOR_PORT`. |
| `src/fake-processor.module.ts` | Root module with a health endpoint (charge endpoint arrives in Stage 4). |
| `tsconfig.app.json` | App compiler settings. |

### `libs/config`

| File | Purpose |
|---|---|
| `src/env.ts` | zod schema and `loadEnv()`; a missing or malformed value stops startup with a clear message. |
| `src/config.module.ts` | Global, validated `ConfigModule`. |
| `src/index.ts` | Exports. |
| `src/env.spec.ts` | Tests: defaults, coercion, required values, minimum secret length. |
| `tsconfig.lib.json` | Library compiler settings. |

### `libs/db`

| File | Purpose |
|---|---|
| `src/create-db.ts` | Builds the Kysely instance over a `pg` pool. |
| `src/db.module.ts` | Nest `DbModule` providing the `DB` token, with clean pool shutdown. |
| `src/database.types.ts` | Placeholder `Database` interface (filled in Stage 1). |
| `src/index.ts` | Exports. |
| `migrations/.gitkeep` | Keeps the migrations folder in git. |
| `tsconfig.lib.json` | Library compiler settings. |

### `libs/payments-core`

| File | Purpose |
|---|---|
| `src/index.ts` | Empty placeholder for the state machine, hashing and posting logic (from Stage 2). |
| `tsconfig.lib.json` | Library compiler settings. |

### `libs/testing`

| File | Purpose |
|---|---|
| `src/postgres.ts` | `startPostgres()`: a throwaway real Postgres 16 via Testcontainers. |
| `src/postgres.int-spec.ts` | Smoke test that the harness can reach Postgres and the atomic-claim SQL works. |
| `src/test-env.ts` | Valid environment values for tests. |
| `src/index.ts` | Exports. |
| `tsconfig.lib.json` | Library compiler settings. |

## Modified

None.

## Removed

None.
