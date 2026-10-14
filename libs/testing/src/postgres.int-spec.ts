import { sql } from 'kysely';
import { startPostgres, TestPostgres } from './postgres';

/**
 * Integration smoke test: proves the harness can start a real Postgres 16 and talk to it.
 * Run with `pnpm test:int` (needs Docker).
 */
describe('test harness: real Postgres', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('runs a query against Postgres 16', async () => {
    const { rows } = await sql<{ version: string }>`select version() as version`.execute(pg.db);
    expect(rows[0].version).toMatch(/PostgreSQL 16/);
  });

  it('supports the primitives the whole design depends on', async () => {
    await sql`create table t (k text primary key, n int not null default 0)`.execute(pg.db);

    // First claim wins, the second is a no-op: the atomic-claim pattern from Module 2.
    const first = await sql`insert into t (k) values ('a') on conflict (k) do nothing returning k`.execute(pg.db);
    const second = await sql`insert into t (k) values ('a') on conflict (k) do nothing returning k`.execute(pg.db);

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
  });
});
