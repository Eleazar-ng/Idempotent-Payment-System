import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types as pgTypes } from 'pg';
import type { Database } from './database.types';

export interface CreateDbOptions {
  /** Keep the pool small: transactions here are short by design (Module 6.4, 10.2). */
  maxConnections?: number;
}

const INT8_OID = 20;

/**
 * pg returns bigint (int8) as a string by default, because JS numbers cannot hold every int8.
 * Our bigints are ids, counts and minor-unit amounts, so we parse them to numbers, but refuse
 * loudly if one is ever out of the safe range rather than silently losing precision.
 */
function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`bigint value ${value} is outside the safe integer range`);
  }
  return parsed;
}

const typeParsers = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === INT8_OID ? parseInt8 : pgTypes.getTypeParser(oid, format as 'text')) as typeof pgTypes.getTypeParser,
};

export function createDb(connectionString: string, options: CreateDbOptions = {}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: options.maxConnections ?? 10,
        types: typeParsers,
      }),
    }),
  });
}
