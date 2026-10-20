import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types as pgTypes } from 'pg';
import type { Database } from './database.types';

export interface CreateDbOptions {
  /** Keep the pool small: transactions here are short by design (Module 6.4, 10.2). */
  maxConnections?: number;
  /**
   * Called when an IDLE pooled connection fails (the server restarted, a failover, a network cut).
   * It must never crash the process: with no listener, node-postgres turns that event into an
   * unhandled error. The pool discards the dead connection and opens a new one on demand, so
   * logging is the right default.
   */
  onPoolError?: (error: Error) => void;
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
  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    types: typeParsers,
  });
  pool.on('error', options.onPoolError ?? ((error) => console.error('[db] idle connection error:', error.message)));

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
