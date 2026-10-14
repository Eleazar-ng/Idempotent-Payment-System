import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './database.types';

export interface CreateDbOptions {
  /** Keep the pool small: transactions here are short by design (Module 6.4, 10.2). */
  maxConnections?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: options.maxConnections ?? 10,
      }),
    }),
  });
}
