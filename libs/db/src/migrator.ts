import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

/** Default location of the hand-written SQL migrations (libs/db/migrations). */
export const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../migrations');

/** Arbitrary constant: the advisory lock that serializes concurrent migration runs. */
const MIGRATION_LOCK_ID = 7_243_001;

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  /** File name, e.g. `0001_core_tables.sql`. Applied in lexicographic order. */
  name: string;
  sql: string;
  /** sha256 of the file contents, stored when applied so later edits are detected. */
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((file) => !file.startsWith('.'))
    .sort();

  const seenPrefixes = new Set<string>();
  return names.map((name) => {
    const match = MIGRATION_FILE.exec(name);
    if (!match) {
      throw new Error(`Invalid migration file name "${name}": expected NNNN_snake_case.sql`);
    }
    if (seenPrefixes.has(match[1])) {
      throw new Error(`Duplicate migration number ${match[1]} (file "${name}")`);
    }
    seenPrefixes.add(match[1]);

    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * Applies pending SQL migrations. Safe to call repeatedly and from several processes at once.
 *
 * Design choices (each one is a small version of an idea from the lectures):
 * - One session-level advisory lock around the whole run, so two deploys starting together
 *   cannot both try to apply the same migration (Module 6.3).
 * - One transaction per migration file: a failure rolls back that file completely.
 * - A checksum per applied file: editing a migration after it was applied is an error, because
 *   it would silently make environments diverge. Add a new migration instead.
 * - Out-of-order detection: a new file that sorts before an already-applied one is rejected.
 *
 * Uses a dedicated connection (not a pooled one) because session-level advisory locks do not
 * survive transaction pooling (Module 10.2).
 */
export async function runMigrations(
  connectionString: string,
  options: { dir?: string } = {},
): Promise<MigrationResult> {
  const migrations = loadMigrations(options.dir);
  const client = new Client({ connectionString });
  await client.connect();

  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    const latestApplied = rows.length > 0 ? rows[rows.length - 1].name : null;

    for (const migration of migrations) {
      const recordedChecksum = applied.get(migration.name);

      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} was modified after it was applied. ` +
              'Never edit an applied migration; add a new one instead.',
          );
        }
        result.skipped.push(migration.name);
        continue;
      }

      if (latestApplied !== null && migration.name < latestApplied) {
        throw new Error(
          `Migration ${migration.name} is new but sorts before the already-applied ${latestApplied}. ` +
            'Renumber it so it comes last.',
        );
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.name} failed and was rolled back: ${reason}`, {
          cause: error,
        });
      }
      result.applied.push(migration.name);
    }

    return result;
  } finally {
    // Closing the connection also releases the session-level advisory lock.
    await client.end();
  }
}
