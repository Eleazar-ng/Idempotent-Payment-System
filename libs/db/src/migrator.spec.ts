import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from './migrator';

describe('loadMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql = 'SELECT 1;') => writeFileSync(join(dir, name), sql);

  it('returns migrations in numeric order regardless of directory listing order', () => {
    write('0002_second.sql');
    write('0001_first.sql');
    write('0010_tenth.sql');

    expect(loadMigrations(dir).map((m) => m.name)).toEqual([
      '0001_first.sql',
      '0002_second.sql',
      '0010_tenth.sql',
    ]);
  });

  it('computes a checksum that changes when the file changes', () => {
    write('0001_a.sql', 'SELECT 1;');
    const before = loadMigrations(dir)[0].checksum;

    write('0001_a.sql', 'SELECT 2;');
    const after = loadMigrations(dir)[0].checksum;

    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it.each(['1_short.sql', '0001-dashes.sql', '0001_Upper.sql', 'notes.txt', '0001_no_ext'])(
    'rejects the badly named file %s',
    (name) => {
      write(name);
      expect(() => loadMigrations(dir)).toThrow(/Invalid migration file name/);
    },
  );

  it('rejects two migrations that share a number', () => {
    write('0001_a.sql');
    write('0001_b.sql');
    expect(() => loadMigrations(dir)).toThrow(/Duplicate migration number 0001/);
  });

  it('ignores dotfiles such as .gitkeep', () => {
    write('.gitkeep', '');
    write('0001_a.sql');
    expect(loadMigrations(dir)).toHaveLength(1);
  });
});

describe('the real migrations in libs/db/migrations', () => {
  it('load without errors and are numbered 0001, 0002, ... with no gaps', () => {
    const names = loadMigrations(DEFAULT_MIGRATIONS_DIR).map((m) => m.name);

    expect(names.length).toBeGreaterThan(0);
    names.forEach((name, index) => {
      expect(name.slice(0, 4)).toBe(String(index + 1).padStart(4, '0'));
    });
  });
});
