import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import { createDb } from '../../db/src';
import type { Database } from '../../db/src';

export interface TestPostgres {
  connectionString: string;
  db: Kysely<Database>;
  stop: () => Promise<void>;
}

/**
 * Starts a throwaway, real Postgres 16 for integration tests.
 *
 * We deliberately do not mock the database: the guarantees in this project (unique constraints,
 * partial indexes, triggers, row locks) only exist in real Postgres, and a mock would happily
 * pass code that double charges in production (Module 11.1).
 *
 * Requires a running Docker daemon.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('payments_test')
    .withUsername('payments')
    .withPassword('payments')
    .start();

  const connectionString = container.getConnectionUri();
  const db = createDb(connectionString, { maxConnections: 20 });

  return {
    connectionString,
    db,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
