import { sql } from 'kysely';
import { startPostgres, TestPostgres } from '../../testing/src';
import { createDb } from './create-db';

/**
 * An idle pooled connection that dies (server restart, failover, network cut) must not crash the
 * process. Without a pool error listener node-postgres turns the event into an unhandled error;
 * this test kills a real idle connection and checks the pool reports it and recovers.
 */
describe('createDb: pool resilience (real Postgres)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('reports a killed idle connection to onPoolError and keeps working', async () => {
    const errors: Error[] = [];
    const url = new URL(pg.connectionString);
    url.searchParams.set('application_name', 'pool-resilience-test');
    const db = createDb(url.toString(), { maxConnections: 2, onPoolError: (error) => errors.push(error) });

    try {
      await sql`select 1`.execute(db); // leaves one idle connection in the pool

      await sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where application_name = 'pool-resilience-test'`.execute(pg.db);

      for (let i = 0; i < 40 && errors.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/terminating connection/);

      const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
      expect(rows[0].ok).toBe(1); // the dead connection was discarded and a new one opened
    } finally {
      await db.destroy();
    }
  });

  it('parses bigint as a number, and refuses a value outside the safe integer range', async () => {
    const { rows } = await sql<{ n: number }>`select 9007199254740991::bigint as n`.execute(pg.db);
    expect(rows[0].n).toBe(9007199254740991);
    await expect(sql`select 9007199254740993::bigint as n`.execute(pg.db)).rejects.toThrow(/safe integer/);
  });
});
