import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { runSeed, main as seedMain } from '../../../src/database/seed.js';
import type { SeedStep } from '../../../src/database/index.js';
import { validEnv } from '../../../src/platform/config/test-env.js';
import {
  cleanup,
  provision,
  renderMigrations,
  runPgDump,
  teardown,
  tryQuery,
  withClient,
} from '../migrations/support/harness.js';
import type { Env } from '../migrations/support/harness.js';
import {
  addMigration,
  appendToMigration,
  checkCleanHistory,
  checkExpandContract,
  checkGrants,
  checkPreviousRelease,
  checkRollback,
  checkSeedRerun,
  checkUpgrade,
  contractViolations,
  dataFingerprint,
  fixturesDir,
  readJournal,
  readPreviousRelease,
  restorePreviousRelease,
  structure,
} from './support/check.js';
import type { PreviousRelease } from './support/check.js';

// TASK-026: `db:check-history` (TC-OPS-03, TC-NFR-05). The real history, the previous release fixture, the rollback
// check and the seed rerun run on real PostgreSQL; the negative probes break one thing each and expect it reported.

const compensating = join(fixturesDir, 'compensating');
const envs: Env[] = [];
const dirs: string[] = [];

async function setUp() {
  const env = await provision();
  envs.push(env);
  const dir = renderMigrations(env);
  dirs.push(dir);
  return { env, dir, migrations: join(dir, 'migrations') };
}

afterAll(async () => {
  dirs.forEach(cleanup);
  for (const env of envs) expect(await teardown(env)).toEqual([]);
});

const seedUrl = (env: Env) => env.urlFor('migrator');
const runReference = (env: Env, steps?: readonly SeedStep[]) => () =>
  runSeed({
    dataset: 'reference',
    appEnv: 'test',
    databaseUrl: seedUrl(env),
    ...(steps === undefined ? {} : { steps }),
  });

describe('the history of this release', () => {
  const previous = readPreviousRelease();
  it('has a consistent previous-release fixture (empty at the first release)', () => {
    expect(checkPreviousRelease(previous)).toEqual([]);
    expect(previous.lastMigration).toBe(0);
  });

  it('applies to an empty database, upgrades from the previous release, rolls back on a copy, reruns the seed', async () => {
    const { env, dir, migrations } = await setUp();
    expect(await restorePreviousRelease(env, previous)).toEqual([]);
    const expectedStructure = await structure(env);
    const expectedData = await dataFingerprint(env);
    expect(await checkUpgrade(env, dir, previous)).toEqual([]);
    expect(readJournal(migrations).length).toBeGreaterThan(0);
    expect(await checkGrants(env)).toEqual([]);
    expect(checkExpandContract(migrations, previous)).toEqual([]);
    expect(
      await checkRollback(env, migrations, compensating, previous, expectedStructure, expectedData),
    ).toEqual([]);
    expect(await checkSeedRerun(env, runReference(env))).toEqual([]);
    expect(await tryQuery(env.urlFor('superuser', 'postgres'), 'SELECT 1')).toMatchObject({
      ok: true,
    });
  });

  it('runs the real seed entry point twice against the migrated database without a change', async () => {
    const { env, dir } = await setUp();
    expect(await checkCleanHistory(env, dir)).toEqual([]);
    const saved = { ...process.env };
    delete process.env['DATABASE_URL'];
    Object.assign(process.env, validEnv('release'), {
      APP_ENV: 'development',
      MIGRATION_DATABASE_URL: seedUrl(env),
    });
    try {
      expect(await checkSeedRerun(env, () => seedMain(['--dataset=reference']))).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe('negative probes', () => {
  it('a deliberately broken migration fails the clean-history check', async () => {
    const { env, dir } = await setUp();
    appendToMigration(dir, '0001_task-025-platform.sql', 'CREATE TABL broken (id int);');
    const findings = await checkCleanHistory(env, dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('drizzle-kit migrate failed');
  });

  it('a missing grant fails the grants check', async () => {
    const { env, dir } = await setUp();
    expect(await checkCleanHistory(env, dir)).toEqual([]);
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(`REVOKE SELECT ON rate_limit_buckets FROM "${env.roles.backup}"`),
    );
    expect(await checkGrants(env)).toEqual([
      `app_backup lacks SELECT on public.rate_limit_buckets`,
    ]);
  });

  it('a new table granted to nobody fails the grants check, and a stray write grant does too', async () => {
    const { env, dir } = await setUp();
    addMigration(dir, '0002_task-026-probe', 'CREATE TABLE probe_orphan (id int primary key);');
    expect(await checkCleanHistory(env, dir)).toEqual([]);
    await withClient(env.urlFor('superuser'), (c) =>
      c.query(
        `GRANT INSERT, TRUNCATE ON probe_orphan TO "${env.roles.backup}", "${env.roles.worker}"`,
      ),
    );
    const findings = await checkGrants(env);
    expect(findings).toEqual(
      expect.arrayContaining([
        'app_api lacks SELECT on public.probe_orphan',
        'app_worker lacks SELECT on public.probe_orphan',
        'app_backup holds INSERT on public.probe_orphan',
        'app_backup holds TRUNCATE on public.probe_orphan',
        'app_worker holds TRUNCATE on public.probe_orphan',
      ]),
    );
  });

  it('a non-idempotent seed fails the rerun check, an upsert passes', async () => {
    const { env, dir } = await setUp();
    expect(await checkCleanHistory(env, dir)).toEqual([]);
    const insertEveryTime: SeedStep = {
      name: 'probe-insert',
      datasets: ['reference'],
      run: async (tx) => {
        await tx.execute(
          sql`INSERT INTO rate_limit_buckets (scope, subject, window_start, count) VALUES ('seed', gen_random_uuid()::text, now(), 1)`,
        );
        return 1;
      },
    };
    const upsert: SeedStep = {
      name: 'probe-upsert',
      datasets: ['reference'],
      run: async (tx) => {
        await tx.execute(
          sql`INSERT INTO rate_limit_buckets (scope, subject, window_start, count) VALUES ('seed', 'fixed', date_trunc('day', now()), 1) ON CONFLICT DO NOTHING`,
        );
        return 1;
      },
    };
    expect(await checkSeedRerun(env, runReference(env, [upsert]))).toEqual([]);
    const findings = await checkSeedRerun(env, runReference(env, [insertEveryTime]));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('seed rerun changed data');
  });

  it('rollback reports a missing compensating migration and an incomplete one', async () => {
    const { env, dir, migrations } = await setUp();
    expect(await checkCleanHistory(env, dir)).toEqual([]);
    const previous: PreviousRelease = { tag: null, lastMigration: 0, snapshot: '', synthetic: '' };
    const missing = await checkRollback(env, migrations, join(dir, 'none'), previous, [], '');
    expect(missing).toHaveLength(readJournal(migrations).length);
    expect(missing[0]).toContain('0001_task-025-platform has no compensating migration');
    const partial = join(dir, 'partial');
    mkdirSync(partial);
    writeFileSync(join(partial, '0001.sql'), 'DROP TABLE rate_limit_buckets;');
    copyFileSync(join(compensating, '0010.sql'), join(partial, '0010.sql'));
    const left = await checkRollback(env, migrations, partial, previous, [], '');
    expect(
      left.some((f) => f.startsWith('rollback left structure behind: column idempotency_records')),
    ).toBe(true);
    const broken = join(dir, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '0001.sql'), 'DROP TABLE nonexistent;');
    const failed = await checkRollback(env, migrations, broken, previous, [], '');
    expect(failed[0]).toContain('compensating migration for 0001_task-025-platform failed');
  });

  it('expand/contract: a contracting statement after the previous release is reported', async () => {
    const { dir, migrations } = await setUp();
    addMigration(dir, '0002_task-026-probe', 'ALTER TABLE rate_limit_buckets DROP COLUMN count;');
    const released: PreviousRelease = {
      tag: 'v1',
      lastMigration: 1,
      snapshot: 'x',
      synthetic: 'x',
    };
    const findings = checkExpandContract(migrations, released);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('0002_task-026-probe.sql: drops an object');
    expect(checkExpandContract(migrations, { ...released, lastMigration: 2 })).toEqual([]);
    expect(
      checkExpandContract(migrations, { ...released, tag: null, lastMigration: 0 }),
    ).toHaveLength(1);
  });
});

describe('expand/contract rule', () => {
  it.each([
    ['ALTER TABLE t ADD COLUMN c text;', 0],
    ['CREATE TABLE t (id int);', 0],
    ['CREATE INDEX CONCURRENTLY i ON t (c);', 0],
    ['ALTER TABLE t DROP COLUMN c;', 1],
    ['DROP TABLE t;', 1],
    ['ALTER TABLE t RENAME COLUMN a TO b;', 1],
    ['ALTER TABLE t ALTER COLUMN c SET NOT NULL;', 1],
    ['ALTER TABLE t ALTER COLUMN c TYPE bigint;', 1],
    ['TRUNCATE t;', 1],
    ['DELETE FROM t;', 1],
    ['-- DROP TABLE t (comment only)\nSELECT 1;', 0],
    ['-- contract: TASK-999\nDROP TABLE t;', 0],
  ])('%s', (statement, count) => {
    expect(contractViolations('x.sql', statement)).toHaveLength(count);
  });
});

describe('previous-release fixture', () => {
  it('reports an inconsistent fixture', () => {
    const base = { tag: null, lastMigration: 0, snapshot: '', synthetic: '' };
    expect(checkPreviousRelease({ ...base, lastMigration: 1 })).toHaveLength(1);
    expect(checkPreviousRelease({ ...base, snapshot: 'x' })).toHaveLength(1);
    expect(checkPreviousRelease({ ...base, tag: 'v1' })).toHaveLength(3);
    expect(
      checkPreviousRelease({ tag: 'v1', lastMigration: 1, snapshot: 'x', synthetic: 'y' }),
    ).toEqual([]);
  });

  it('a failing snapshot is reported', async () => {
    const { env } = await setUp();
    const findings = await restorePreviousRelease(env, {
      tag: 'v1',
      lastMigration: 1,
      snapshot: 'CREATE TABL nope;',
      synthetic: 'x',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('previous release snapshot does not load');
    const data = await restorePreviousRelease(env, {
      tag: 'v1',
      lastMigration: 1,
      snapshot: 'CREATE TABLE t (id int);',
      synthetic: 'INSERT INTO nope VALUES (1);',
    });
    expect(data[0]).toContain('previous release synthetic data does not load');
  });

  async function releaseOne(): Promise<PreviousRelease> {
    // Release 1 = the real history, dumped with its ledger; the later release adds a migration.
    const release1 = await setUp();
    expect(await checkCleanHistory(release1.env, release1.dir)).toEqual([]);
    await withClient(release1.env.urlFor('migrator'), (c) =>
      c.query(
        `INSERT INTO rate_limit_buckets (scope, subject, window_start, count) VALUES ('login', 'snap', date_trunc('minute', now()), 7)`,
      ),
    );
    const dump = runPgDump(release1.env, 'migrator', ['--schema=drizzle', '--inserts']);
    expect(dump.status, dump.stderr).toBe(0);
    return {
      tag: 'v1.0.0',
      lastMigration: 1,
      snapshot: dump.dump,
      synthetic: `INSERT INTO rate_limit_buckets (scope, subject, window_start, count) VALUES ('login', 'synthetic', date_trunc('minute', now()), 9);`,
    };
  }

  it('a later release upgrades from the previous release with synthetic data, expand only', async () => {
    const previous = await releaseOne();
    expect(checkPreviousRelease(previous)).toEqual([]);

    const next = await setUp();
    addMigration(
      next.dir,
      '0002_task-026-expand',
      'ALTER TABLE rate_limit_buckets ADD COLUMN note text;\n--> statement-breakpoint\nUPDATE rate_limit_buckets SET note = scope;',
    );
    expect(checkExpandContract(next.migrations, previous)).toEqual([]);
    expect(await checkUpgrade(next.env, next.dir, previous)).toEqual([]);
    const rows = await tryQuery(
      next.env.urlFor('superuser'),
      `SELECT subject, note FROM rate_limit_buckets ORDER BY subject`,
    );
    expect(rows).toMatchObject({
      ok: true,
      rows: [
        { subject: 'snap', note: 'login' },
        { subject: 'synthetic', note: 'login' },
      ],
    });
  });

  it('an upgrade that loses a row of the previous release is reported', async () => {
    const previous = await releaseOne();
    const run = await setUp();
    addMigration(run.dir, '0002_task-026-lossy', 'DELETE FROM rate_limit_buckets;');
    expect(checkExpandContract(run.migrations, previous)).toHaveLength(1);
    const findings = await checkUpgrade(run.env, run.dir, previous);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain('upgrade lost or changed a rate_limit_buckets row');
  });
});
