import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startMigratedPostgres, TestPostgres } from '@app/testing';
import { authenticateApiKey } from './api-keys';

const run = promisify(execFile);

/**
 * The operator CLI, run the way `pnpm admin` runs it (a real child process under ts-node with path aliases), against a real
 * database. A unit test of the functions would not notice if the CLI itself could not start.
 */
describe('pnpm admin (real process, real Postgres)', () => {
  let pg: TestPostgres;
  const root = join(__dirname, '../../..');

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  const admin = async (...args: string[]) => {
    try {
      const { stdout } = await run(
        process.execPath,
        ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', join(root, 'libs/db/src/admin-cli.ts'), ...args],
        { cwd: root, env: { ...process.env, DATABASE_URL: pg.connectionString, TS_NODE_TRANSPILE_ONLY: 'true' }, timeout: 60_000 },
      );
      return { code: 0, stdout };
    } catch (error) {
      const e = error as { code?: number; stderr?: string; stdout?: string };
      return { code: e.code ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  const prefixOf = (key: string) => key.slice(3, 15);
  const secretOf = (key: string) => key.slice(16);
  const keyIn = (text: string) => /pk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/.exec(text)?.[0] as string;

  it('creates a merchant with a working key, adds a second, lists both without secrets, and revokes one', async () => {
    const created = await admin('merchant:create', 'Smoke', 'Ltd');
    expect(created.code).toBe(0);
    const merchantId = Number(/merchant (\d+) created/.exec(created.stdout)?.[1]);
    const first = keyIn(created.stdout);
    expect(await authenticateApiKey(pg.db, first)).toMatchObject({ ok: true, merchantId });

    const second = keyIn((await admin('key:create', String(merchantId), 'ci', 'server')).stdout);
    expect(await authenticateApiKey(pg.db, second)).toMatchObject({ ok: true, merchantId });

    const listed = (await admin('key:list', String(merchantId))).stdout;
    expect(listed).toContain(prefixOf(first));
    expect(listed).toContain(prefixOf(second));
    expect(listed).not.toContain(secretOf(first)); // secrets are never shown again
    expect(listed).toContain('ci server');

    const revoked = await admin('key:revoke', prefixOf(first));
    expect(revoked.stdout).toContain('revoked');
    expect((await authenticateApiKey(pg.db, first)).ok).toBe(false);
    expect((await authenticateApiKey(pg.db, second)).ok).toBe(true);
    expect((await admin('key:revoke', prefixOf(first))).stdout).toContain('no active key');
  }, 120_000);

  it.each([[['merchant:create']], [['key:create', 'abc']], [['key:revoke']], [['key:list', '0']], [['nonsense']], [[]]])(
    'refuses bad usage %p with a message and a non-zero exit',
    async (args) => {
      const result = await admin(...(args as string[]));
      expect(result.code).not.toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
