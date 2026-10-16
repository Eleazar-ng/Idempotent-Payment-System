import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { startPostgres, TestPostgres } from '../../testing/src';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, runMigrations } from './migrator';

describe('runMigrations (real Postgres)', () => {
  let pg: TestPostgres;
  const dirs: string[] = [];

  beforeAll(async () => {
    pg = await startPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
    dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  /** Each test gets its own schema so migrations from different tests cannot interfere. */
  async function freshDatabase(): Promise<string> {
    const { Client } = await import('pg');
    const name = `m_${Math.random().toString(36).slice(2, 10)}`;
    const adminUrl = pg.connectionString;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return url.toString();
  }

  function migrationDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-int-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  async function tableExists(url: string, table: string): Promise<boolean> {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
      return rows[0].t !== null;
    } finally {
      await client.end();
    }
  }

  it('applies every real migration to an empty database and records each one', async () => {
    const url = await freshDatabase();

    const result = await runMigrations(url);

    const expected = loadMigrations(DEFAULT_MIGRATIONS_DIR).map((m) => m.name);
    expect(result.applied).toEqual(expected);
    expect(result.skipped).toEqual([]);
  });

  it('is idempotent: running again applies nothing', async () => {
    const url = await freshDatabase();
    await runMigrations(url);

    const second = await runMigrations(url);

    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it('refuses to continue when an already-applied migration file was edited', async () => {
    const url = await freshDatabase();
    const dir = migrationDir({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    await runMigrations(url, { dir });

    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, extra int);');

    await expect(runMigrations(url, { dir })).rejects.toThrow(/modified after it was applied/);
  });

  it('rejects a new migration that sorts before one already applied', async () => {
    const url = await freshDatabase();
    const dir = migrationDir({ '0002_b.sql': 'CREATE TABLE b (id int);' });
    await runMigrations(url, { dir });

    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');

    await expect(runMigrations(url, { dir })).rejects.toThrow(/sorts before the already-applied/);
  });

  it('rolls a failing migration back completely and does not record it', async () => {
    const url = await freshDatabase();
    const dir = migrationDir({
      '0001_ok.sql': 'CREATE TABLE ok (id int);',
      '0002_bad.sql': 'CREATE TABLE half_done (id int); SELECT 1/0;',
    });

    await expect(runMigrations(url, { dir })).rejects.toThrow(/0002_bad\.sql failed and was rolled back/);

    expect(await tableExists(url, 'ok')).toBe(true);
    expect(await tableExists(url, 'half_done')).toBe(false);

    // The good migration stays applied; only the bad one is retried (and fails again).
    await expect(runMigrations(url, { dir })).rejects.toThrow(/0002_bad\.sql/);
  });

  it('serializes concurrent runs: each migration is applied exactly once and nobody errors', async () => {
    const url = await freshDatabase();
    const dir = migrationDir({
      '0001_a.sql': 'CREATE TABLE a (id int);',
      '0002_b.sql': 'CREATE TABLE b (id int);',
      '0003_c.sql': 'CREATE TABLE c (id int);',
    });

    // Without the advisory lock, two runners would both try CREATE TABLE a and one would fail.
    const results = await Promise.all(Array.from({ length: 5 }, () => runMigrations(url, { dir })));

    const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
    expect(totalApplied).toBe(3);

    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query('SELECT count(*)::int AS n FROM schema_migrations');
    await client.end();
    expect(rows[0].n).toBe(3);
  });

  it('can read back what it recorded through Kysely', async () => {
    const url = await freshDatabase();
    await runMigrations(url);

    const { createDb } = await import('./create-db');
    const db = createDb(url);
    try {
      const { rows } = await sql<{ n: number }>`select count(*) as n from schema_migrations`.execute(db);
      // count(*) is int8: this also proves the bigint-to-number parser is wired up.
      expect(typeof rows[0].n).toBe('number');
      expect(rows[0].n).toBe(loadMigrations(DEFAULT_MIGRATIONS_DIR).length);
    } finally {
      await db.destroy();
    }
  });
});
