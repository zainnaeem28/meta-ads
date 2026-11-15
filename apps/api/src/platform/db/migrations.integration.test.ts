import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMigration } from './generate.js';
import { runSeed } from '../../database/seed.js';
import type { SeedStep } from '../../database/index.js';
import { createTestDatabase } from './test-database.js';

// TC-OPS-03: the migration commands. A fixture config with the same shape as drizzle.config.ts generates into a
// temporary folder through the generate wrapper; the real commands (`drizzle-kit generate`, `drizzle-kit migrate`) run against test databases.

const apiDir = join(import.meta.dirname, '..', '..', '..');
const probeConfig = 'tests/support/fixtures/probe.drizzle.config.ts';
// drizzle-kit reads snapshots relative to the working directory, so the output folder is relative and untracked.
const outRelative = join('reports', `task024-migrations-${Date.now().toString(36)}`);
const out = join(apiDir, outRelative);

function kit(args: string[], env: Record<string, string> = {}) {
  const run = spawnSync('pnpm', ['exec', 'drizzle-kit', ...args, `--config=${probeConfig}`], {
    cwd: apiDir,
    env: { ...process.env, PROBE_OUT: outRelative, ...env },
    encoding: 'utf8',
  });
  return { status: run.status, text: run.stdout + run.stderr };
}

function generate(name: string) {
  process.env['PROBE_OUT'] = outRelative;
  return generateMigration({ name, cwd: apiDir, config: probeConfig, out: outRelative });
}

beforeAll(() => {
  expect(generate('0010_task-024-probe')).toEqual({ generated: true, tag: '0010_task-024-probe' });
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('db:generate', () => {
  it('writes the migration under the exact name given and records it in the journal', () => {
    expect(readdirSync(out).filter((name) => name.endsWith('.sql'))).toEqual([
      '0010_task-024-probe.sql',
    ]);
    const journal = JSON.parse(readFileSync(join(out, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string; idx: number }[];
    };
    expect(journal.entries.map((entry) => entry.tag)).toEqual(['0010_task-024-probe']);
    expect(readFileSync(join(out, '0010_task-024-probe.sql'), 'utf8')).toContain(
      'CREATE TABLE "probe_items"',
    );
  });

  it('is incremental: a second run with an unchanged schema finds nothing, and names are validated', () => {
    expect(generate('0011_task-024-nothing')).toEqual({ generated: false });
    expect(existsSync(join(out, '0011_task-024-nothing.sql'))).toBe(false);
    expect(() => generate('0010_task-024-again')).toThrow(
      'number 0010 is already used by 0010_task-024-probe',
    );
    for (const bad of [
      'task-024-probe',
      '10_task-024-x',
      '0012_audit',
      '0012_task-024-Probe',
      '',
    ]) {
      expect(() => generate(bad)).toThrow('--name must be <NNNN>_<ticket>-<slug>');
    }
  });

  it('ships the real config and scripts, no push script', () => {
    const config = readFileSync(join(apiDir, 'drizzle.config.ts'), 'utf8');
    expect(config).toContain("prefix: 'index'");
    expect(config).toContain("out: './src/database/migrations'");
    const scripts = (
      JSON.parse(readFileSync(join(apiDir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['db:generate']).toBe('pnpm build && node dist/platform/db/generate.js');
    expect(scripts['db:migrate']).toBe('drizzle-kit migrate --config=drizzle.config.ts');
    expect(scripts['db:seed']).toBe('node dist/database/seed.js');
    expect(scripts['jobs:migrate']).toBe('node dist/database/jobs-migrate.js');
    expect(Object.values(scripts).join('\n')).not.toMatch(/drizzle-kit\s+push/);
  });
});

describe('db:migrate on a clean database', () => {
  it('applies the journal, is idempotent and leaves one history row', async () => {
    const database = await createTestDatabase({ label: 'task024mig', migrations: false });
    try {
      for (let run = 0; run < 2; run += 1) {
        const migrated = kit(['migrate'], { MIGRATION_DATABASE_URL: database.url });
        expect(migrated.status, migrated.text).toBe(0);
      }
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      try {
        const table = await client.query("select to_regclass('public.probe_items') as name");
        expect(table.rows[0]).toEqual({ name: 'probe_items' });
        const history = await client.query(
          'select count(*)::int as n from drizzle.__drizzle_migrations',
        );
        expect(history.rows[0]).toEqual({ n: 1 });
      } finally {
        await client.end();
      }
    } finally {
      await database.drop();
    }
  });

  it('is what the shared helper applies for the real migrations folder', async () => {
    const database = await createTestDatabase({ label: 'task024help', migrations: out });
    try {
      expect(database.migrationsApplied).toBe(true);
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      try {
        expect(
          (await client.query("select to_regclass('public.probe_items') as name")).rows[0],
        ).toEqual({
          name: 'probe_items',
        });
      } finally {
        await client.end();
      }
    } finally {
      await database.drop();
    }
  });
});

describe('db:seed', () => {
  const step = (name: string, datasets: SeedStep['datasets'], fail = false): SeedStep => ({
    name,
    datasets,
    run: async (tx) => {
      await tx.execute(
        'create table if not exists seed_probe (k text primary key, v int not null)' as never,
      );
      await tx.execute(
        `insert into seed_probe values ('${name}', 1) on conflict (k) do update set v = 1` as never,
      );
      if (fail) throw new Error('seed step failed');
      return 1;
    },
  });

  it('runs one transaction, counts only, and a rerun changes nothing', async () => {
    const database = await createTestDatabase({ label: 'task024seed', migrations: false });
    try {
      const run = {
        dataset: 'reference' as const,
        appEnv: 'test' as const,
        databaseUrl: database.url,
      };
      const steps = [step('prices', ['reference']), step('users', ['development'])];
      const first = await runSeed({ ...run, steps });
      expect(first).toEqual([{ step: 'prices', count: 1 }]);
      expect(await runSeed({ ...run, steps })).toEqual(first);
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      try {
        expect((await client.query('select k from seed_probe order by k')).rows).toEqual([
          { k: 'prices' },
        ]);
      } finally {
        await client.end();
      }
      await expect(
        runSeed({ ...run, steps: [step('ok', ['reference']), step('bad', ['reference'], true)] }),
      ).rejects.toThrow('seed step failed');
      const after = new pg.Client({ connectionString: database.url });
      await after.connect();
      try {
        expect((await after.query('select k from seed_probe order by k')).rows).toEqual([
          { k: 'prices' },
        ]);
      } finally {
        await after.end();
      }
    } finally {
      await database.drop();
    }
  });

  it('refuses a dataset the environment does not allow and a production-named database', async () => {
    await expect(
      runSeed({
        dataset: 'development',
        appEnv: 'production',
        databaseUrl: 'postgres://u@test-db:5432/x',
        steps: [],
      }),
    ).rejects.toThrow('dataset development runs only with APP_ENV=development');
    const database = await createTestDatabase({ label: 'prod', migrations: false });
    try {
      await expect(
        runSeed({
          dataset: 'development',
          appEnv: 'development',
          databaseUrl: database.url,
          steps: [],
        }),
      ).rejects.toThrow('a production-named database accepts only the reference dataset');
      await expect(
        runSeed({
          dataset: 'reference',
          appEnv: 'production',
          databaseUrl: database.url,
          steps: [],
        }),
      ).resolves.toEqual([]);
    } finally {
      await database.drop();
    }
  });
});
