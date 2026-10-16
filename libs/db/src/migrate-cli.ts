import { runMigrations } from './migrator';

/** `pnpm db:migrate`: applies pending migrations to DATABASE_URL. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env first)');
  }

  const { applied, skipped } = await runMigrations(url);
  for (const name of applied) console.log(`applied  ${name}`);
  for (const name of skipped) console.log(`skipped  ${name} (already applied)`);
  console.log(applied.length === 0 ? 'database is up to date' : `applied ${applied.length} migration(s)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
