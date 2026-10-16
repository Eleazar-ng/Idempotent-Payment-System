import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import { Client } from 'pg';
import { createDb, runMigrations } from '../../db/src';
import type { Database } from '../../db/src';

export interface TestPostgres {
  connectionString: string;
  db: Kysely<Database>;
  stop: () => Promise<void>;
}

/**
 * Starts an isolated, real Postgres 16 database for integration tests.
 *
 * We deliberately do not mock the database: the guarantees in this project (unique constraints,
 * partial indexes, triggers, row locks) only exist in real Postgres, and a mock would happily
 * pass code that double charges in production (Module 11.1).
 *
 * Two modes:
 * - Default: a throwaway Postgres 16 container via Testcontainers (needs a Docker daemon).
 * - If TEST_PG_ADMIN_URL is set (e.g. postgres://postgres:pw@localhost:5432/postgres): create a
 *   fresh, uniquely named database on that existing server and drop it afterwards. Useful for CI
 *   with a service container, or locally to skip container start-up. The role needs CREATEDB.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  return adminUrl ? startOnExistingServer(adminUrl) : startContainer();
}

/** Like startPostgres(), with every migration already applied. */
export async function startMigratedPostgres(): Promise<TestPostgres> {
  const pg = await startPostgres();
  try {
    await runMigrations(pg.connectionString);
  } catch (error) {
    await pg.stop();
    throw error;
  }
  return pg;
}

async function startContainer(): Promise<TestPostgres> {
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

async function startOnExistingServer(adminUrl: string): Promise<TestPostgres> {
  const dbName = `payments_test_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const connectionString = url.toString();
  const db = createDb(connectionString, { maxConnections: 20 });

  return {
    connectionString,
    db,
    stop: async () => {
      await db.destroy();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
